// Phase 3 gate of docs/MULTI_CLUSTER_BUILD.md: templates, run dirs, the egress policy and the probe. No cluster
// call: orchestrate.ts runs on placeholder inputs, teardown.sh only with --dry-run, and the probes dial a local
// Floci (Docker, as the lifecycle tests use), profiles/ax/emulate/server.mjs and a local stub, all on 127.0.0.1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { FLOCI_IMAGE, render } from "../../profiles/ax/index.ts";
import { manifestObjects, ownedResources, ownedResourcesErrors, recordOwned } from "../../profiles/ax/run-dir.ts";
import { egressPolicy, gatewayConfigDiff } from "../../profiles/ax/egress.ts";
import { parseAxAllowlist } from "../../profiles/ax/allowlist.ts";
import { parseProbes, probe, relayBaseline, saveIsolation, startRelay } from "../../profiles/ax/case.ts";
import { flociClients } from "../../src/adapters/floci/clients.ts";
import { loadSlackFixture, workspaceSecrets, workspaceSeed } from "../../src/adapters/slack/emulator.ts";
import { startRun, type RunHandle } from "../../src/config/lifecycle.ts";
import { ROOT } from "../../src/config/run-config.ts";

const AX = join(ROOT, "profiles/ax");
const K8S = join(AX, "manifests/k8s");
const SET_ID = "00000000-0000-4000-8000-0000000000aa";
const TENANTS = ["1a2b3c4d-0000-4000-8000-000000000001", "5e6f7a8b-0000-4000-8000-000000000002"];
const EMULATE_IMAGE = `registry.example.invalid/lab/emulate@sha256:${"b".repeat(64)}`;
const LABELS = ["apl-run", "apl-set", "apl-cluster", "apl-tenant", "apl-role"];
const placeholders = (t: string) => [...new Set([...t.matchAll(/\$\{(APL_[A-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
const docs = (yaml: string) => yaml.split(/^---$/m).filter((d) => /^kind:/m.test(d));
const docOf = (yaml: string, kind: string, name: string) => docs(yaml).find((d) => d.includes(`kind: ${kind}\n`) && d.includes(`  name: ${name}\n`))!;
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

function orchestrate(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(AX, "orchestrate.ts"), ...args], {
    cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", APL_EMULATE_IMAGE: EMULATE_IMAGE },
  });
  if (r.status !== 0) throw new Error(`orchestrate ${args[0]} exited ${r.status}: ${r.stderr}`);
  return r;
}

// One tenant run dir per tenant, as multi.ts will produce them: init, manifests --tenant, one --task.
const tenantDirs = TENANTS.map((runId, i) => {
  const dir = mkdtempSync(join(tmpdir(), "apl-ax-tenant-"));
  const probes = join(dir, "probes.json");
  writeFileSync(probes, JSON.stringify([{ role: "t2-emulate-clusterip", address: "10.0.0.9", port: 8080, host: "emulate.apl-ax-5e6f7a8b.svc.cluster.local", path: "/_apl/missing" }]));
  const tenant = ["--set-id", SET_ID, "--cluster", "a", "--tenant-role", `t${i + 1}`];
  orchestrate("init", "--dir", dir, "--run-id", runId);
  orchestrate("manifests", "--tenant", "--dir", dir, ...tenant);
  orchestrate("manifests", "--dir", dir, "--task", `apl-${runId.slice(0, 8)}-01`, "--mode", "isolation", "--image", EMULATE_IMAGE,
    "--emulate-ip", "10.0.0.1", "--floci-ip", "10.0.0.2", ...tenant, "--probes", probes);
  return { dir, runId, ns: `apl-ax-${runId.slice(0, 8)}`, tenantYaml: readFileSync(join(dir, "tenant.yaml"), "utf8"), taskYaml: readFileSync(join(dir, `task-apl-${runId.slice(0, 8)}-01.yaml`), "utf8") };
});
const t1 = tenantDirs[0]!;
const collectorVars = {
  APL_RUN_ID: "6882d106-0000-4000-8000-000000000003", APL_SHORT_ID: "6882d106", APL_POOL_REPLICAS: "3",
  APL_LAB_IMAGE: `registry.example.invalid/lab/apl-lab@sha256:${"d".repeat(64)}`,
  APL_WORKER_IMAGE: `registry.example.invalid/lab/ateworker-gvisor@sha256:${"e".repeat(64)}`,
};
const collectorYaml = render(readFileSync(join(K8S, "collector.yaml"), "utf8"), collectorVars);

describe("templates and placeholders (section 5)", () => {
  it("tenant.yaml and collector.yaml use exactly their placeholders, every one filled, and refuse a missing one", () => {
    const tenantTpl = readFileSync(join(K8S, "tenant.yaml"), "utf8");
    expect(placeholders(tenantTpl)).toEqual(["APL_CLUSTER", "APL_COLLECTOR_NS", "APL_EMULATE_IMAGE", "APL_EMULATE_SEED", "APL_FLOCI_IMAGE", "APL_RUN_ID", "APL_SET_ID", "APL_SHORT_ID", "APL_TENANT"]);
    expect(placeholders(readFileSync(join(K8S, "collector.yaml"), "utf8"))).toEqual(Object.keys(collectorVars).sort());
    for (const y of [t1.tenantYaml, collectorYaml]) expect(y).not.toContain("${");
    const { APL_POOL_REPLICAS: _, ...missing } = collectorVars;
    expect(() => render(readFileSync(join(K8S, "collector.yaml"), "utf8"), missing)).toThrow(/APL_POOL_REPLICAS/);
    expect(() => render("x: ${APL_NOPE}", collectorVars)).toThrow(/APL_NOPE/);
  });

  it("tenant.yaml: every object labelled; requests and emulators.yaml's limits; L-032 settings; digest-pinned images", () => {
    const all = docs(t1.tenantYaml);
    expect(manifestObjects(t1.tenantYaml).map((o) => `${o.kind}/${o.name}`)).toEqual([
      `Namespace/${t1.ns}`, "Secret/emulate-seed", "Deployment/floci", "Service/floci", "Deployment/emulate", "Service/emulate", "NetworkPolicy/emulators-ingress",
    ]);
    for (const d of all) {
      for (const l of LABELS) expect(d).toMatch(new RegExp(`^ {2}labels: \\{[^}]*\\b${l}: `, "m"));
      expect(d).toContain(`apl-run: "${t1.runId}"`);
      expect(d).toContain(`apl-set: "${SET_ID}"`);
      expect(d).toContain('apl-cluster: "a"');
      expect(d).toContain('apl-tenant: "t1"');
    }
    const floci = docOf(t1.tenantYaml, "Deployment", "floci"), emulate = docOf(t1.tenantYaml, "Deployment", "emulate");
    expect(floci).toContain('requests: { cpu: "100m", memory: "256Mi" }\n            limits: { cpu: "500m", memory: "768Mi" }');
    expect(emulate).toContain('requests: { cpu: "100m", memory: "256Mi" }\n            limits: { cpu: "500m", memory: "512Mi" }');
    const frozen = readFileSync(join(K8S, "emulators.yaml"), "utf8");
    expect(frozen).toContain('limits: { cpu: "500m", memory: "768Mi" }');
    expect(frozen).toContain('limits: { cpu: "500m", memory: "512Mi" }');
    for (const d of [floci, emulate]) {
      expect(d).toContain("enableServiceLinks: false");
      expect(d).toContain("automountServiceAccountToken: false");
    }
    expect(floci).toContain(`image: "${FLOCI_IMAGE}"`);
    expect(emulate).toContain(`image: "${EMULATE_IMAGE}"`);
  });

  it("tenant.yaml: emulate-seed holds the run dir's seed, and the NetworkPolicy admits only atenet-egress and the collector", () => {
    const seed = /^ {2}seed: (.+)$/m.exec(docOf(t1.tenantYaml, "Secret", "emulate-seed"))![1]!;
    expect(JSON.parse(seed)).toBe(readFileSync(join(t1.dir, "emulate-seed.json"), "utf8"));
    const np = docOf(t1.tenantYaml, "NetworkPolicy", "emulators-ingress");
    const from = np.slice(np.indexOf("    - from:"));
    expect(from).toBe([
      "    - from:",
      "        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ate-system } }",
      "          podSelector: { matchLabels: { app: atenet-egress } }",
      '        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: "apl-ax-6882d106" } }',
      "          podSelector: { matchLabels: { app: apl-collector } }",
      "",
    ].join("\n"));
  });

  it("the tenant namespace has the form allowlist.ts requires for its Services", () => {
    expect(t1.ns).toMatch(/^apl-ax-[a-f0-9]{8}$/);
    for (const svc of ["emulate", "floci"]) {
      expect(() => parseAxAllowlist(JSON.stringify([{ scheme: "http", host: `${svc}.${t1.ns}.svc.cluster.local`, port: 8080, addresses: ["10.0.0.1"] }]))).not.toThrow();
    }
  });

  it("collector.yaml: pool at 3 replicas, the Secret mounted whole and optional, no ingress, L-032 settings", () => {
    expect(manifestObjects(collectorYaml).map((o) => `${o.kind}/${o.name}`)).toEqual([
      "Namespace/apl-ax-6882d106", "WorkerPool/apl-ax-pool", "ServiceAccount/apl-collector", "Pod/apl-collector", "NetworkPolicy/collector-no-ingress",
    ]);
    expect(docOf(collectorYaml, "WorkerPool", "apl-ax-pool")).toMatch(/^ {2}replicas: 3$/m);
    const pod = docOf(collectorYaml, "Pod", "apl-collector");
    expect(pod).toContain("- { name: collector-env, mountPath: /etc/apl/collector-env, readOnly: true }");
    expect(pod).toContain("secret: { secretName: collector-env-tenants, optional: true }");
    expect(collectorYaml).not.toContain("subPath");
    expect(pod).not.toContain("envFrom");
    for (const k of ["automountServiceAccountToken: false", "enableServiceLinks: false", "restartPolicy: Never", `image: "${collectorVars.APL_LAB_IMAGE}"`]) expect(pod).toContain(k);
    const np = docOf(collectorYaml, "NetworkPolicy", "collector-no-ingress");
    expect(np).toContain("policyTypes: [Ingress]");
    expect(np).not.toContain("ingress:");
  });
});

describe("policy, run dirs and schema (sections 8 and 9)", () => {
  it("the egress policy has the shape of section 9.1, and the planted control adds one foreign Emulate rule", () => {
    const own = [
      { http: { hostnames: [`emulate.${t1.ns}.svc.cluster.local`], ports: { numbers: [8080, 8081] } } },
      { http: { hostnames: [`floci.${t1.ns}.svc.cluster.local`], ports: { numbers: [4566] } } },
    ];
    expect(egressPolicy(t1.ns)).toEqual({ rules: own });
    expect(egressPolicy(t1.ns, "apl-ax-5e6f7a8b")).toEqual({ rules: [...own, { http: { hostnames: ["emulate.apl-ax-5e6f7a8b.svc.cluster.local"], ports: { numbers: [8080] } } }] });
    expect(() => egressPolicy("10.0.0.1")).toThrow(/not a tenant namespace/);
  });

  it("manifestObjects() reads the JSON documents orchestrate.ts writes, which carry the set, cluster and tenant", () => {
    const task = `apl-${t1.runId.slice(0, 8)}-01`;
    expect(manifestObjects(t1.taskYaml)).toEqual([
      { kind: "Workspace", name: `ws-${task}`, atespace: t1.ns },
      { kind: "Task", name: task, atespace: t1.ns },
    ]);
    const [ws, t] = t1.taskYaml.split(/^---$/m).map((d) => JSON.parse(d));
    const keys = { "apl-run": t1.runId, mode: "isolation", "apl-set": SET_ID, "apl-cluster": "a", "apl-tenant": "t1" };
    expect(t.spec.config).toEqual(keys);
    expect(JSON.parse(ws.spec.files[0].content)).toEqual({ ...keys, task });
    const env = Object.fromEntries(t.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(parseProbes(env.APL_AX_PROBES)).toHaveLength(1);
  });

  it("ownedResources() takes two atespaces and refuses an AX object in neither", () => {
    const o = { runId: SET_ID, kubeContext: "apl-fixture-context", atespaces: tenantDirs.map((t) => t.ns), axCli: "/opt/example/ax",
      k8sYaml: tenantDirs.map((t) => t.tenantYaml).join("---\n"), axYaml: tenantDirs.map((t) => t.taskYaml).join("\n---\n") };
    const owned = ownedResources(o);
    expect(owned.substrate).toEqual(tenantDirs.map((t) => ({ kind: "atespace", name: t.ns, created_by: "ax apply" })));
    expect(owned.ax.map((x) => `${x.atespace}/${x.kind}`)).toEqual(tenantDirs.flatMap((t) => [`${t.ns}/workspace`, `${t.ns}/task`]));
    expect(owned.kubernetes.filter((k) => k.kind === "Namespace").map((k) => k.name)).toEqual(tenantDirs.map((t) => t.ns));
    expect(() => ownedResources({ ...o, atespaces: [t1.ns] })).toThrow(/not in one of the run's atespaces/);
  });

  it("recordOwned() appends a valid entry and refuses one the schema rejects, leaving the file unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "apl-ax-step-"));
    const base = { run_id: SET_ID, kube_context: "apl-fixture-context", ax: [], substrate: [], kubernetes: [], cluster_scoped: [], scaled: [], scaled_namespaces: [] };
    writeFileSync(join(dir, "owned-resources.json"), JSON.stringify(base));
    recordOwned(dir, "substrate", { kind: "actor", atespace: t1.ns, name: "apl-1a2b3c4d-01" });
    const after = readFileSync(join(dir, "owned-resources.json"), "utf8");
    expect(JSON.parse(after).substrate).toEqual([{ kind: "actor", atespace: t1.ns, name: "apl-1a2b3c4d-01" }]);
    expect(() => recordOwned(dir, "substrate", { kind: "actor-template", name: "apl-1a2b3c4d-01" })).toThrow(/rejected by run-dir.schema.json/);
    expect(readFileSync(join(dir, "owned-resources.json"), "utf8")).toBe(after);
    expect(readdirSync(dir)).toEqual(["owned-resources.json"]);
  });

  it("schema (section 8.3): actor kinds need an atespace, atespaces carry none, removed_at and node_pool are accepted", () => {
    const base = { run_id: SET_ID, kube_context: "c", ax: [], kubernetes: [], cluster_scoped: [], scaled: [], scaled_namespaces: [] };
    const sub = (...substrate: object[]) => ownedResourcesErrors({ ...base, substrate });
    for (const kind of ["actor", "actor-template", "egress-policy"]) {
      expect(sub({ kind, atespace: t1.ns, name: "n", removed_at: "2026-10-29T00:00:00Z" })).toEqual([]);
      expect(sub({ kind, name: "n" })).not.toEqual([]);
    }
    expect(sub({ kind: "atespace", name: t1.ns })).toEqual([]);
    expect(sub({ kind: "atespace", atespace: t1.ns, name: t1.ns })).not.toEqual([]);
    expect(sub({ kind: "actor", atespace: t1.ns, name: "n", removed_at: 1 })).not.toEqual([]);
    expect(sub({ kind: "pod", atespace: t1.ns, name: "n" })).not.toEqual([]);
    const cluster = { ...base, substrate: [], project: "example-project", gke_cluster: { name: "example-cluster", location: "zone-b", node_pool: "default-pool" } };
    expect(ownedResourcesErrors(cluster)).toEqual([]);
    expect(ownedResourcesErrors({ ...cluster, gke_cluster: { ...cluster.gke_cluster, node_pool: "Not A Name" } })).not.toEqual([]);
  });

  const hasKubectl = spawnSync("kubectl", ["version", "--client"], { env: { PATH: process.env.PATH ?? "", KUBECONFIG: "/dev/null" } }).status === 0;
  it.skipIf(!hasKubectl)("teardown.sh --dry-run deletes recorded leftovers, actor before template, and skips removed_at rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "apl-ax-step-"));
    const ctx = "apl-fixture-context";
    writeFileSync(join(dir, "owned-resources.json"), JSON.stringify({
      run_id: SET_ID, kube_context: ctx, ax: [], kubernetes: [], cluster_scoped: [], scaled: [], scaled_namespaces: [],
      substrate: [
        { kind: "egress-policy", atespace: t1.ns, name: "apl-1a2b3c4d-01" },
        { kind: "actor", atespace: t1.ns, name: "left-actor" },
        { kind: "actor", atespace: t1.ns, name: "gone-actor", removed_at: "2026-10-29T00:00:00Z" },
        { kind: "actor-template", atespace: t1.ns, name: "left-template" },
        { kind: "atespace", name: t1.ns },
      ],
    }));
    writeFileSync(join(dir, "pre-snapshot.json"), JSON.stringify({ namespaces: [], scaled: {}, cluster_scoped: {} }));
    const kubeconfig = join(dir, "fixture-kubeconfig");
    writeFileSync(kubeconfig, JSON.stringify({ apiVersion: "v1", kind: "Config", "current-context": ctx,
      clusters: [{ name: "c", cluster: { server: "https://kube.invalid" } }], users: [{ name: "u", user: { token: "fixture-not-a-token" } }],
      contexts: [{ name: ctx, context: { cluster: "c", user: "u" } }] }));
    const r = spawnSync("bash", [join(AX, "teardown.sh"), dir, "--dry-run"], { encoding: "utf8", env: { ...process.env, KUBECONFIG: kubeconfig } });
    expect(r.status).toBe(0);
    const ate = r.stdout.split("\n").filter((l) => l.startsWith("+ kubectl ate"));
    expect(ate).toEqual([
      `+ kubectl ate delete actor left-actor -a ${t1.ns}`,
      `+ kubectl ate delete actor-template left-template -a ${t1.ns}`,
      `+ kubectl ate delete atespace ${t1.ns}`,
    ]);
  });

  it("the gateway ConfigMap comparison (section 9.3) accepts the fixture's blocks and refuses one changed field", () => {
    const fixture = readFileSync(join(AX, "tests/fixtures/atenet-egress-access-log.yaml"), "utf8");
    // A synthetic envoy.yaml holding every vendored block nested deeper than in the fixture, as the source nests them.
    const legs = fixture.slice(fixture.indexOf("legs:\n")).split("\n").slice(1);
    const envoy = ["static_resources:", ...legs.map((l) => (/^ {2}#/.test(l) ? l : `      ${l}`))].join("\n");
    expect(gatewayConfigDiff({ data: { "envoy.yaml": envoy } }, fixture)).toEqual([]);
    const at = envoy.indexOf("leg: mitm");
    const changed = envoy.slice(0, at) + envoy.slice(at).replace('upstream: "%UPSTREAM_HOST%"', 'upstream: "%UPSTREAM_REMOTE_ADDRESS%"');
    expect(changed).not.toBe(envoy);
    expect(gatewayConfigDiff({ data: { "envoy.yaml": changed } }, fixture)).toEqual(["mitm"]);
    expect(gatewayConfigDiff({ data: { "envoy.yaml": envoy.replace("default_value: 400", "default_value: 0") } }, fixture)).toEqual(["mitm"]);
    expect(gatewayConfigDiff({ data: {} }, fixture)).toEqual(["connect", "clienthello", "mitm", "cleartext", "passthrough"]);
  });
});

describe("relay and probes (section 10)", () => {
  const servers: Server[] = [];
  let emulate: ChildProcess | undefined;
  let run: RunHandle | undefined;
  afterAll(async () => {
    for (const s of servers) s.close();
    emulate?.kill("SIGTERM");
    await run?.stop();
  });

  it("the relay starts from the highest seq it found and skips the mailbox's earlier deliveries", async () => {
    const box = [1, 2].map((seq) => ({ seq, path: "/events", headers: { "content-type": "application/json" }, body: `{"earlier":${seq}}` }));
    const mailbox = createServer((req, res) => {
      const after = Number(new URL(req.url!, "http://m").searchParams.get("after"));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(box.filter((e) => e.seq > after)));
    });
    const got: string[] = [];
    const worker = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c)).on("end", () => (got.push(`${req.url} ${body}`), res.writeHead(200).end()));
    });
    servers.push(mailbox, worker);
    const mport = await listen(mailbox), wport = await listen(worker);
    const allowlist = [{ scheme: "http" as const, host: "127.0.0.1", port: mport }];
    const after = await relayBaseline(`http://127.0.0.1:${mport}`, allowlist);
    expect(after).toBe(2);
    const relay = startRelay(`http://127.0.0.1:${mport}`, allowlist, `http://127.0.0.1:${wport}`, after);
    box.push({ seq: 3, path: "/events", headers: { "content-type": "application/json" }, body: '{"own":3}' });
    const end = Date.now() + 5000;
    while (relay.relayed() < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    await relay.stop();
    expect(got).toEqual(['/slack/A/events {"own":3}']);
  });

  it("probes send their Host and extra headers; a raw TCP probe connects; malformed probes are refused", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const stub = createServer((req, res) => (seen.push(req.headers), res.writeHead(req.url === "/apl/missing" ? 404 : 200).end()));
    servers.push(stub);
    const port = await listen(stub);
    const r = await probe({ role: "router", address: "127.0.0.1", port, host: "atenet-router.ate-system.svc", path: "/apl/missing", headers: { "ate-target-actor": "apl-ax-5e6f7a8b/apl-5e6f7a8b-tgt" } });
    expect(r).toMatchObject({ probe: "router", outcome: "http_response", status: 404, reached: true });
    expect(seen[0]).toMatchObject({ host: "atenet-router.ate-system.svc", "ate-target-actor": "apl-ax-5e6f7a8b/apl-5e6f7a8b-tgt" });
    expect(await probe({ role: "worker-1-80", address: "127.0.0.1", port, tcp: true })).toMatchObject({ outcome: "closed" });
    expect(() => parseProbes('[{"role":"x","address":"emulate.apl-ax-5e6f7a8b.svc.cluster.local","port":8080}]')).toThrow(/IP address/);
    expect(() => parseProbes('[{"role":"x","address":"10.0.0.1","port":80,"tcp":true,"path":"/"}]')).toThrow(/raw TCP/);
  });

  it("emulate/server.mjs answers 404 on both ports' probe path with the tenant's Host", async () => {
    // server.mjs binds 8080-8082; a preload maps them to free ports so the test does not need those ports free.
    const free = await Promise.all([0, 1, 2].map(async () => {
      const s = createServer();
      const p = await listen(s);
      await new Promise((r) => s.close(r));
      return p;
    }));
    const dir = mkdtempSync(join(tmpdir(), "apl-ax-emulate-"));
    const remap = join(dir, "remap.mjs");
    writeFileSync(remap, `import net from "node:net";
const map = JSON.parse(process.env.APL_TEST_PORT_MAP);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) {
  if (typeof a[0] === "number" && map[a[0]]) a[0] = map[a[0]];
  else if (a[0] && typeof a[0] === "object" && map[a[0].port]) a[0] = { ...a[0], port: map[a[0].port] };
  return listen.apply(this, a);
};\n`);
    const fx = loadSlackFixture();
    const wsA = fx.workspaces.find((w) => w.installation_id === "A")!;
    const seed = workspaceSeed(fx, wsA, workspaceSecrets(wsA), { eventsUrl: "http://127.0.0.1:8082/events", interactionsUrl: "http://127.0.0.1:8082/interactions" });
    emulate = spawn(process.execPath, ["--import", remap, join(AX, "emulate/server.mjs")], {
      cwd: ROOT, stdio: ["ignore", "pipe", "inherit"],
      env: { PATH: process.env.PATH ?? "", APL_EMULATE_SEED: JSON.stringify(seed), APL_EMULATE_BASE_URL: `http://emulate.${t1.ns}.svc.cluster.local:8080`,
        APL_TEST_PORT_MAP: JSON.stringify({ 8080: free[0], 8081: free[1], 8082: free[2] }) },
    });
    await new Promise<void>((resolve, reject) => {
      let out = "";
      emulate!.stdout!.on("data", (d) => ((out += d), out.includes('"ready":true') && resolve()));
      emulate!.once("exit", (c) => reject(new Error(`server.mjs exited ${c}`)));
    });
    for (const [role, port] of [["emulate-8080", free[0]!], ["emulate-8081", free[1]!]] as const) {
      expect(await probe({ role, address: "127.0.0.1", port, host: `emulate.${t1.ns}.svc.cluster.local`, path: "/_apl/missing" }))
        .toMatchObject({ outcome: "http_response", status: 404, reached: true });
    }
  });

  it("a local Floci answers 404 for an object in a missing bucket, and isolation.json lands in <task>-receipts", async () => {
    run = await startRun({ floci: true, slack: false, worker: false });
    const port = Number(new URL(run.flociEndpoint).port);
    expect(await probe({ role: "t2-floci-clusterip", address: "127.0.0.1", port, host: `floci.${t1.ns}.svc.cluster.local`, path: "/apl-missing-bucket/apl-missing-object" }))
      .toMatchObject({ outcome: "http_response", status: 404, reached: true });
    const task = `apl-${t1.runId.slice(0, 8)}-iso`;
    const allowlist = run.manifest.config.endpoint_allowlist;
    const results = [{ probe: "t2-floci-clusterip", outcome: "http_response", status: 404, reached: true }];
    const cfg = { run_id: t1.runId, task, slack: { url: "", mailbox: "", secrets: workspaceSecrets(loadSlackFixture().workspaces[0]!) }, floci: { endpoint: run.flociEndpoint, project: task } };
    await saveIsolation(cfg, allowlist, results);
    await saveIsolation(cfg, allowlist, results); // the bucket exists now; still written
    const c = await flociClients(run.flociEndpoint, allowlist);
    const obj = await c.s3.send(new GetObjectCommand({ Bucket: `${task}-receipts`, Key: `apl-evidence/${task}/isolation.json` }));
    expect(JSON.parse(await obj.Body!.transformToString())).toEqual(results);
  });

  it("no --probe-ips or APL_AX_PROBE_IPS is left in the AX lane's code", () => {
    for (const f of readdirSync(AX).filter((f) => /\.(ts|mjs|sh|json|yaml)$/.test(f))) {
      const src = readFileSync(join(AX, f), "utf8");
      expect(src, f).not.toContain("probe-ips");
      expect(src, f).not.toContain("APL_AX_PROBE_IPS");
    }
  });
});
