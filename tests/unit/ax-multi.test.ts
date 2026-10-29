// Phase 5 gate of docs/MULTI_CLUSTER_BUILD.md §3: profiles/ax/multi.ts against a recording fake cluster. The fake
// is the runner's one Exec; nothing here reaches a cluster, gcloud, a registry or the network. Local tooling runs
// for real: orchestrate.ts into temp dirs, evaluate_ax.py, and doctor()'s client probe on a stub kubectl.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ROOT } from "../../src/config/run-config.ts";
import { artifactDir } from "../../src/reports/artifacts.ts";
import { verifyChecksums } from "../../src/reports/report.ts";
import { accessLogBlocks } from "../../profiles/ax/egress.ts";
import { buildPlan, Cluster, main, readInfra, Stop, type Call, type Exec, type MultiPlan, type Result } from "../../profiles/ax/multi.ts";
import { manifestObjects } from "../../profiles/ax/run-dir.ts";

const FIXTURE = readFileSync(join(ROOT, "profiles/ax/tests/fixtures/atenet-egress-access-log.yaml"), "utf8");
const LAB_COMMIT = "c".repeat(40);
const SET_ID = "00000000-0000-4000-8000-0000000000aa";
const hex = (ch: string) => ch.repeat(64);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
let seq = 0;
const uuid = () => `${(0x10000000 + ++seq).toString(16)}-0000-4000-8000-${String(seq).padStart(12, "0")}`;
const VERSIONS = {
  gke: { master: "1.36.4-gke.1", nodes: "1.36.4-gke.1" }, kubectl_client: "v1.36.6",
  substrate: { version: "v0.6.0", commit: "d3f2363", kubectl_ate: "kubectl-ate v0.6.0" },
  ax: { commit: "4b7bf6f84cac", ax_server: `registry.example.invalid/ax/ax-server@sha256:${hex("a")}`, client_pins_substrate: "v0.6.0" },
  lab_image: `registry.example.invalid/lab/apl-lab@sha256:${hex("d")}`, lab_commit: LAB_COMMIT,
};

let root: string, runsRoot: string, evidenceRoot: string;
const infra: Record<"a" | "b", string> = { a: "", b: "" };
const saved = { auth: process.env.APL_AX_AUTHORIZED, art: process.env.APL_ARTIFACTS_DIR, terms: process.env.APL_PRIVATE_TERMS };

function makeInfra(id: "a" | "b") {
  const dir = join(root, `infra-${id}`), bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, "axhome"));
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh\necho '{"clientVersion":{"minor":"36","gitVersion":"v1.36.6"}}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "ax"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(dir, "kubeconfig"), `ctx-${id}\n`); // the fake reads the context from the file
  const owned = {
    run_id: id === "a" ? "41dc91c3-0000-4000-8000-000000000001" : "34c8957e-0000-4000-8000-000000000002", kube_context: `ctx-${id}`, project: "project-test",
    ...(id === "a" ? { zone: "zone-a", cluster: "cluster-a" } : { zone: "zone-b", cluster: "cluster-b", gke_cluster: { name: "cluster-b", location: "zone-b", node_pool: "pool-b" } }),
    ax: [], substrate: [], kubernetes: [], cluster_scoped: [], scaled: [], scaled_namespaces: [],
    images: [
      { name: "registry.example.invalid/lab/apl-emulate", digest: `sha256:${hex("b")}`, source: "profiles/ax/emulate/Dockerfile" },
      { name: "registry.example.invalid/sub/ateapi:v0.6.0", digest: `sha256:${hex("e")}`, source: "Substrate v0.6.0 d3f2363 release" },
      { name: "registry.example.invalid/sub/ateworker-gvisor:v0.6.0", digest: `sha256:${hex("f")}`, source: "Substrate v0.6.0 d3f2363 release" },
      { name: "registry.example.invalid/ax/ax-server", digest: `sha256:${hex("a")}`, source: "google/ax@4b7bf6f84cac" },
    ],
    local: { bin, ax_cli: join(bin, "ax"), kubectl: join(bin, "kubectl") },
  };
  writeFileSync(join(dir, "owned-resources.json"), JSON.stringify(owned));
  writeFileSync(join(dir, "versions.json"), JSON.stringify({ cluster: `cluster-${id}`, ...VERSIONS }));
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "apl-multi-"));
  runsRoot = join(root, "private-runs");
  evidenceRoot = join(root, "evidence");
  mkdirSync(runsRoot);
  infra.a = makeInfra("a");
  infra.b = makeInfra("b");
  process.env.APL_AX_AUTHORIZED = "1";
  process.env.APL_ARTIFACTS_DIR = join(root, "artifacts");
  writeFileSync(join(root, "private-terms.txt"), "zz-no-private-term-here\n");
  process.env.APL_PRIVATE_TERMS = join(root, "private-terms.txt");
});
afterAll(() => {
  for (const [k, v] of [["APL_AX_AUTHORIZED", saved.auth], ["APL_ARTIFACTS_DIR", saved.art], ["APL_PRIVATE_TERMS", saved.terms]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// A C4 bundle as the collector would write it, passing evaluate_ax.py for its case.
function writeBundle(dir: string, kase: string, runId: string) {
  mkdirSync(join(dir, "evidence"), { recursive: true });
  const obs = kase === "F3-A1" ? { ticket_count: 1, receipt_count: 1, receipt_matches_request: true, completion_reply_count: 1, command_exit_code: 0 } : { foreign_marker_count: 0 };
  const result = `${JSON.stringify({ http_status: 200, body: { exit_code: 0, started_at: "2026-10-30T10:00:00.000Z", ended_at: "2026-10-30T10:00:08.400Z" } })}\n`;
  const facts = `${JSON.stringify(obs)}\n`;
  writeFileSync(join(dir, "evidence", "ax-result.json"), result);
  writeFileSync(join(dir, "evidence", "facts.json"), facts);
  writeFileSync(join(dir, "observations.json"), JSON.stringify({
    schema_version: 1, case_id: kase, run_id: runId, profile: "ax", mode: "scripted", execution: "EXECUTED", candidate_revision: LAB_COMMIT, tree_sha: LAB_COMMIT, dirty: false,
    fixture_sha256: "0".repeat(64), mutation: "none", collector: "fake collector", collector_methods: ["fake"], observed_at: new Date().toISOString(), observations: obs, unobserved: {},
    evidence: [{ path: "evidence/facts.json", sha256: sha(facts), source: "fake", observations: Object.keys(obs) }, { path: "evidence/ax-result.json", sha256: sha(result), source: "fake", observations: [] }],
  }));
}

interface FakeOpts { actorNever?: string; exhaustedOn?: string; attachFails?: string; resumeFails?: string; noResult?: string; observeFails?: string; deleteFails?: string;
  leftovers?: boolean; leftoverDeleteFails?: boolean; pfDies?: number; context?: string; versions?: { nodes?: string } }

// The recording fake cluster. It also checks, at each create, that the object is already in owned-resources.json.
function fake(o: FakeOpts = {}) {
  const calls: Call[] = [], violations: string[] = [];
  const actors = new Set<string>(), resumed: string[] = [], pending = new Map<string, string>();
  const left: Record<string, Record<string, string[]>> = {};
  let pfs = 0;
  const ok = (stdout: unknown = "", code = 0, stderr = ""): Result => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });
  const exec: Exec = async (c) => {
    calls.push(c);
    const a = c.args, s = ` ${a.join(" ")} `;
    const owned = () => readJson(join(dirname(c.env.KUBECONFIG!), "owned-resources.json"));
    const need = (pred: (ow: any) => boolean, what: string) => { if (!pred(owned())) violations.push(`${what} created before it was recorded`); };
    if (c.cmd === "bash") return ok("teardown: done");
    if (c.background) { const n = ++pfs; return { ...ok(), alive: () => !(o.pfDies && n <= o.pfDies), stop: () => {} }; }
    if (s.includes(" config current-context ")) return ok(`${o.context ?? readFileSync(a[a.indexOf("--kubeconfig") + 1]!, "utf8").trim()}\n`);
    if (c.cmd === "gcloud") return ok({ currentMasterVersion: VERSIONS.gke.master, currentNodeVersion: o.versions?.nodes ?? VERSIONS.gke.nodes });
    if (basename(c.cmd) === "kubectl-ate") return ok("kubectl-ate v0.6.0\n");
    if (basename(c.cmd) === "ax") {
      const verb = a[2], task = a[4]!;
      if (verb === "apply") {
        const file = a[a.indexOf("-f") + 1]!;
        const objs = manifestObjects(readFileSync(file, "utf8"));
        need((ow) => objs.every((x) => ow.ax.some((r: any) => r.kind === x.kind.toLowerCase() && r.name === x.name)), `AX ${objs.map((x) => x.name).join(",")}`);
        actors.add(basename(file).replace(/^task-|\.yaml$/g, ""));
        return ok("applied");
      }
      if (verb === "resume") {
        if (task === o.exhaustedOn) return ok("", 1, "rpc error: code = ResourceExhausted desc = no worker has room");
        if (task === o.resumeFails) return ok("", 1, "rpc error: code = Unavailable desc = injected");
        resumed.push(task);
        return ok();
      }
      if (verb === "get" && a[3] === "tasks") return ok(`NAME ATESPACE PHASE\n${[...actors].map((t) => `${t} ${a[5]} Running`).join("\n")}\n`);
      if (verb === "get") return ok("{}");
      if (verb === "delete") {
        if (task === o.deleteFails) return ok("", 1, "rpc error: code = Internal desc = injected");
        actors.delete(task);
        const ns = a[6]!;
        if (o.leftovers && !left[ns]) left[ns] = { actor: [`golden-${ns}`], "actor-template": [`tpl-${ns}`] };
        return ok();
      }
    }
    if (a[0] === "ate") {
      const [verb, kind, name] = [a[3], a[4], a[5]!];
      const ns = a[a.indexOf("-a") + 1]!;
      if (verb === "get" && kind === "actor") return name === o.actorNever || !actors.has(name) ? ok("", 1, "not found")
        : ok({ metadata: { name }, status: { state: "ACTOR_STATE_RUNNING", workerAssignment: { worker: "worker-0" } } });
      if (verb === "create") {
        need((ow) => ow.substrate.some((r: any) => r.kind === "egress-policy" && r.name === name), `egress policy ${name}`);
        return name === o.attachFails ? ok("", 1, "injected") : ok();
      }
      if (verb === "get") {
        const live = kind === "actors" ? [...actors].filter((t) => `apl-ax-${t.slice(4, 12)}` === ns) : [];
        return ok({ items: [...live, ...(left[ns]?.[kind!.replace(/s$/, "")] ?? [])].map((n) => ({ metadata: { name: n }, status: { state: "ACTOR_STATE_IDLE", workerAssignment: { worker: "worker-1" } } })) });
      }
      if (verb === "delete") {
        if (o.leftoverDeleteFails) return ok("", 1, "injected");
        if (left[ns]?.[kind!]) left[ns]![kind!] = left[ns]![kind!]!.filter((x) => x !== name);
        return ok();
      }
    }
    const k = a.slice(2); // after --kubeconfig <file>
    if (k[0] === "apply" && k[2] !== "-") {
      const objs = manifestObjects(readFileSync(k[2]!, "utf8"));
      need((ow) => objs.every((x) => ow.kubernetes.some((r: any) => r.kind === x.kind && r.name === x.name)), "tenant objects");
      return ok();
    }
    if (k[0] === "apply") { need((ow) => ow.kubernetes.some((r: any) => r.name === "collector-env-tenants"), "Secret collector-env-tenants"); return ok(); }
    if (s.includes(" get svc,endpoints ")) {
      const n = Number.parseInt(k[1]!.slice(-2), 16);
      return ok({ items: [["emulate", 1], ["floci", 2]].flatMap(([name, i]) => [
        { kind: "Service", metadata: { name }, spec: { clusterIP: `10.96.${n}.${i}` } }, { kind: "Endpoints", metadata: { name }, subsets: [{ addresses: [{ ip: `10.244.${n}.${i}` }] }] }]) });
    }
    if (s.includes(" get cm atenet-egress ")) return ok({ data: { "envoy.yaml": Object.values(accessLogBlocks(FIXTURE)).map((b) => b.join("\n")).join("\n") } });
    if (s.includes(" get deployments ")) return ok({ items: [{ spec: { template: { spec: { containers: [{ image: `registry.example.invalid/sub/ateapi@sha256:${hex("e")}` }] } } } }] });
    if (s.includes(" get deployment ax-server ")) return ok({ spec: { template: { spec: { containers: [{ image: VERSIONS.ax.ax_server }] } } } });
    if (s.includes(" version --client ")) return ok({ clientVersion: { gitVersion: "v1.36.6" } });
    if (s.includes("/collector.ts ")) {
      const task = a[a.indexOf("--task") + 1] ?? "";
      if (s.includes(" result ")) return task === o.noResult ? ok({ http_status: 0 }, 3) : ok({ http_status: 200 });
      if (task === o.observeFails) return ok("", 2, "injected");
      pending.set(a[a.indexOf("--run-id") + 1]!, a[a.indexOf("--case") + 1]!);
      return ok();
    }
    if (k[0] === "cp") {
      const id = /\/tmp\/apl\/([^/]+)\/bundle$/.exec(k[1]!)![1]!;
      if (pending.has(id)) writeBundle(k[2]!, pending.get(id)!, id);
      return ok();
    }
    if (s.includes(" logs deployment/ax-server ")) {
      return ok(resumed.flatMap((t) => [`time=2026-10-30T10:00:00.000Z level=INFO msg="resuming actor on Substrate worker" actor=${t}`,
        `time=2026-10-30T10:00:02.100Z level=INFO msg="task successfully reconciled and running" actor=${t} workspaceReady=true`]).join("\n"));
    }
    return ok();
  };
  return { exec, calls, violations };
}

// A one-cluster plan on A: `kind` probe (no warm-up) or configuration (warm-up 00 plus counted tasks).
function smallPlan(kind: "probe" | "configuration", c: number, tasks: number): string {
  const tenant_runs = Array.from({ length: c }, (_, i) => {
    const id = uuid(), tr8 = id.slice(0, 8);
    const ts = kind === "probe" ? [`apl-${tr8}-p1`, `apl-${tr8}-p2`] : Array.from({ length: tasks }, (_, n) => `apl-${tr8}-${String(n).padStart(2, "0")}`);
    return { kind, tenant: `t${i + 1}`, tenant_run_id: id, tr8, tasks: ts,
      bundles: [...ts.map((t) => ({ run_id: uuid(), case: "F3-A1", task: t })), ...(kind === "configuration" ? [{ run_id: uuid(), case: "MT-W01", task: null }] : [])] };
  });
  const setId = uuid();
  const plan: MultiPlan = {
    set_id: setId, step: 1, created_at: new Date().toISOString(), clusters: { a: { infra_run_dir: infra.a, context: "ctx-a", step_run_id: uuid() } },
    configurations: [{ kind, cluster: "a", c, rounds: kind === "probe" ? 2 : tasks - 1, warmup: kind === "configuration", tenant_runs }], controls: [],
  };
  const dir = join(runsRoot, "sets", setId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  return join(dir, "plan.json");
}

async function runStep(planFile: string, o: FakeOpts = {}, extra: string[] = []) {
  const f = fake(o), lines: string[] = [];
  const code = await main(["run-step", "--plan", planFile, "--cluster", "a", ...extra], { exec: f.exec, runsRoot, evidenceRoot, sleep: async () => {}, log: (l) => lines.push(l), uuid });
  const plan: MultiPlan = readJson(planFile);
  const stepDir = join(runsRoot, plan.clusters.a!.step_run_id), setDir = join(runsRoot, "sets", plan.set_id);
  const stopped = existsSync(join(stepDir, "stopped.json")) ? readJson(join(stepDir, "stopped.json")) : [];
  const bundles = plan.configurations.flatMap((cfg) => cfg.tenant_runs.flatMap((t) => t.bundles));
  return { ...f, code, lines, plan, stepDir, setDir, stopped, bundles, owned: () => readJson(join(stepDir, "owned-resources.json")) };
}
const argsOf = (c: Call) => c.args.join(" ");

describe("the plan (design 6.1, §7)", () => {
  it("step 1: bundles per tenant-run kind, no MT-W01 for the probe run, controls kept out of the bundles", () => {
    const p = buildPlan({ step: 1, setId: SET_ID, clusters: {}, registry: [], uuid });
    const [probe, c1, c2, c4, iso] = p.configurations;
    expect(p.configurations.map((c) => [c.kind, c.c])).toEqual([["probe", 1], ["configuration", 1], ["configuration", 2], ["configuration", 4], ["mt-iso", 2]]);
    expect(probe!.tenant_runs[0]!.bundles.map((b) => b.case)).toEqual(["F3-A1", "F3-A1"]);
    expect(probe!.tenant_runs[0]!.tasks.map((t) => t.slice(-3))).toEqual(["-p1", "-p2"]);
    for (const [cfg, tenants, counted] of [[c1, 1, 30], [c2, 2, 15], [c4, 4, 8]] as const) {
      expect(cfg!.tenant_runs).toHaveLength(tenants);
      for (const tr of cfg!.tenant_runs) {
        expect(tr.tasks[0]).toBe(`apl-${tr.tr8}-00`); // the warm-up
        expect(tr.bundles.filter((b) => b.case === "F3-A1")).toHaveLength(counted + 1);
        expect(tr.bundles.filter((b) => b.case === "MT-W01")).toEqual([expect.objectContaining({ task: null })]);
      }
    }
    expect(iso!.tenant_runs.map((t) => t.bundles.map((b) => [b.case, b.task!.slice(-4)]))).toEqual([[["MT-ISO", "-iso"]], [["MT-ISO", "-iso"]], [["MT-ISO", "-iso"]], [["MT-ISO", "-iso"]]]);
    expect(iso!.tenant_runs[0]!.tasks.slice(-1)[0]).toMatch(/-ctl$/);
    const planned = new Set(p.configurations.flatMap((c) => c.tenant_runs.flatMap((t) => t.bundles.map((b) => b.run_id))));
    expect(p.controls.map((c) => [c.kind, planned.has(c.run_id)])).toEqual([["marker", false], ["egress", false]]);
    expect(p.controls[0]!.tenant_run_id).toBe(c1!.tenant_runs[0]!.tenant_run_id);
    const tr8s = p.configurations.flatMap((c) => c.tenant_runs.map((t) => t.tr8));
    expect(new Set(tr8s).size).toBe(tr8s.length);
  });

  it("refuses a <tr8> equal to the collector's or to a registered one", () => {
    const ids = (first: string) => { let n = 0; return () => (n++ === 0 ? first : uuid()); };
    expect(() => buildPlan({ step: 1, setId: SET_ID, clusters: {}, registry: [], uuid: ids("6882d106-0000-4000-8000-000000000009") })).toThrow(/refusing tenant run <tr8> 6882d106/);
    expect(() => buildPlan({ step: 1, setId: SET_ID, clusters: {}, registry: [{ tr8: "5e6f7a8b" }], uuid: ids("5e6f7a8b-0000-4000-8000-000000000009") })).toThrow(/refusing tenant run <tr8> 5e6f7a8b/);
  });

  it("step 2 (§4.6): reuses A's step 1 c = 1 half when A's versions are unchanged, else plans A first and lists the differences", async () => {
    const step1 = "00000000-0000-4000-8000-000000000001";
    const plan = async (setId: string, o: FakeOpts) => {
      const f = fake(o), lines: string[] = [];
      const code = await main(["plan", "--step", "2", "--set-id", setId, "--infra-a", infra.a, "--infra-b", infra.b, "--step1-set-id", step1], { exec: f.exec, runsRoot, sleep: async () => {}, log: (l) => lines.push(l), uuid });
      expect(code, lines.join("\n")).toBe(0);
      expect(f.calls.every((c) => c.env.KUBECONFIG === join(infra.a, "kubeconfig"))).toBe(true); // read-only queries on A only
      expect(existsSync(join(runsRoot, "sets", setId, "versions-a-step2.json"))).toBe(true);
      return readJson(join(runsRoot, "sets", setId, "plan.json")) as MultiPlan;
    };
    const same = await plan("00000000-0000-4000-8000-000000000002", {});
    expect(same.a).toEqual({ reused: { set_id: step1, c: 1 } });
    expect(same.configurations.map((c) => [c.cluster, c.kind, c.c, c.tenant_runs.length])).toEqual([["b", "configuration", 1, 1]]);
    expect(same.controls.map((c) => [c.kind, c.cluster])).toEqual([["marker", "b"]]);
    const moved = await plan("00000000-0000-4000-8000-000000000003", { versions: { nodes: "1.36.5-gke.2" } });
    expect(moved.a).toEqual({ rerun: { differences: ["gke.nodes"] } });
    expect(moved.configurations.map((c) => [c.cluster, c.c, c.rounds, c.tenant_runs[0]!.tasks.length])).toEqual([["a", 1, 30, 31], ["b", 1, 30, 31]]);
  });
});

describe("the context guard (§8.4)", () => {
  it("refuses another cluster's kubeconfig, ax port or gcloud cluster", async () => {
    const f = fake();
    const d = { exec: f.exec, sleep: async () => {}, log: () => {}, runsRoot, evidenceRoot, uuid };
    const a = new Cluster("a", "ctx-a", infra.a, readInfra(infra.a), d, false);
    await a.checkContext();
    const kubectl = join(infra.a, "bin/kubectl"), axCli = join(infra.a, "bin/ax");
    const env = a.env(), envB = { ...env, KUBECONFIG: join(infra.b, "kubeconfig") };
    const refused = (c: Call) => { try { a.guard(c); return null; } catch (e) { expect(e).toBeInstanceOf(Stop); expect((e as Stop).scope).toBe("set"); return (e as Error).message; } };
    expect(refused({ cmd: kubectl, args: ["--kubeconfig", a.kubeconfig, "get", "ns"], env })).toBeNull();
    expect(refused({ cmd: kubectl, args: ["--kubeconfig", join(infra.b, "kubeconfig"), "get", "ns"], env })).toMatch(/stop rule 2: .*--kubeconfig/);
    expect(refused({ cmd: kubectl, args: ["--kubeconfig", a.kubeconfig, "get", "ns"], env: envB })).toMatch(/KUBECONFIG/);
    expect(refused({ cmd: axCli, args: ["--server", "http://127.0.0.1:18481", "get", "tasks"], env })).toMatch(/port-forward/);
    expect(refused({ cmd: axCli, args: ["--server", "http://127.0.0.1:18480", "get", "tasks"], env })).toBeNull();
    const describe = (name: string, loc = "zone-a") => ({ cmd: "gcloud", args: ["container", "clusters", "describe", name, "--project", "project-test", "--location", loc, "--format=json"], env });
    expect(refused(describe("cluster-a"))).toBeNull();
    expect(refused(describe("cluster-b"))).toMatch(/gcloud names another cluster/);
    expect(refused(describe("cluster-a", "zone-b"))).toMatch(/--location/);
    expect(refused({ cmd: "/usr/bin/curl", args: [], env })).toMatch(/not a guarded tool/);
    // A kubeconfig changed after its context was checked is refused too.
    const b = new Cluster("a", "ctx-a", infra.a, readInfra(infra.a), d, false);
    expect(() => b.guard({ cmd: kubectl, args: ["--kubeconfig", b.kubeconfig, "get", "ns"], env })).toThrow(/was not checked/);
  });

  it("sets KUBECONFIG to the run dir's kubeconfig in every subprocess, and --kubeconfig on every kubectl call", async () => {
    const r = await runStep(smallPlan("probe", 1, 2));
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.calls.length).toBeGreaterThan(40);
    const kc = join(r.stepDir, "kubeconfig");
    expect(r.calls.filter((c) => c.env.KUBECONFIG !== kc)).toEqual([]);
    expect(r.calls.filter((c) => basename(c.cmd) === "kubectl" && c.args[c.args.indexOf("--kubeconfig") + 1] !== kc)).toEqual([]);
    expect(r.calls.filter((c) => basename(c.cmd) === "ax").every((c) => c.args[1] === "http://127.0.0.1:18480" && c.env.AX_HOME === join(r.stepDir, "axhome"))).toBe(true);
  });
});

describe("run-step against the recording fake", () => {
  it("sets up a tenant run in §4.2 order, each object recorded before its create; observes, copies and checksums each bundle", async () => {
    const r = await runStep(smallPlan("configuration", 2, 2));
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.violations).toEqual([]);
    const order = ["--snapshot", "get cm atenet-egress", "port-forward", "tenant.yaml", "wait --for=condition=Available", "get svc,endpoints", "apply -f -", "test -f /etc/apl/collector-env/", "task-"];
    const idx = (frag: string, from = 0) => r.calls.findIndex((c, i) => i >= from && argsOf(c).includes(frag));
    let last = -1;
    for (const frag of order) { const i = idx(frag, last + 1); expect(i, frag).toBeGreaterThan(last); last = i; }
    const t1 = r.plan.configurations[0]!.tenant_runs[0]!;
    const own = r.owned();
    expect(own.kubernetes.map((k: any) => `${k.kind}/${k.name}`)).toEqual(expect.arrayContaining(["Namespace/apl-ax-" + t1.tr8, "Secret/emulate-seed", "Deployment/floci", "Secret/collector-env-tenants"]));
    expect(own.substrate.filter((s: any) => s.kind === "atespace").map((s: any) => s.name)).toEqual(r.plan.configurations[0]!.tenant_runs.map((t) => `apl-ax-${t.tr8}`));
    expect(own.ax.filter((x: any) => x.kind === "task")).toHaveLength(4);
    // Every planned bundle observed, copied to artifacts/runs/<run_id>/ and checksummed there.
    expect(r.stopped).toEqual([]);
    for (const b of r.bundles) expect(verifyChecksums(artifactDir(b.run_id)).ok, b.task ?? "MT-W01").toBe(true);
    expect(readJson(join(r.setDir, "timing-raw.json")).rounds.map((x: any) => x.resume_spread_ms)).toEqual([0, 0]);
    expect(readJson(join(r.setDir, "timing-raw.json")).tasks[0]).toMatchObject({ server_resume_to_running_ms: 2100, command_duration_ms: 8400 });
    expect(existsSync(join(r.stepDir, "teardown.json"))).toBe(true);
    expect(argsOf(r.calls.at(-1)!)).toBe(`${join(ROOT, "profiles/ax/teardown.sh")} ${r.stepDir}`);
  });

  it("reads each task's worker from its actor after the results and before observe (R5-1)", async () => {
    const r = await runStep(smallPlan("probe", 1, 2));
    const rows = readJson(join(r.setDir, "timing-raw.json")).tasks;
    expect(rows.map((x: any) => x.worker)).toEqual(["worker-0", "worker-0"]);
    const task = r.plan.configurations[0]!.tenant_runs[0]!.tasks[0]!;
    const i = (frag: string) => r.calls.findIndex((c) => argsOf(c).includes(frag));
    expect(i(`get actor ${task} -a apl-ax-${task.slice(4, 12)} -o json`)).toBeGreaterThan(i(`result --task ${task}`));
    expect(i(`get actor ${task} -a apl-ax-${task.slice(4, 12)} -o json`)).toBeLessThan(i(`observe --case F3-A1 --task ${task}`));
    expect(i(`observe --case F3-A1 --task ${task}`)).toBeLessThan(i(`delete task ${task}`));
  });

  it("records a leftover actor and template, deletes them actor first, and marks them removed_at after the round", async () => {
    const r = await runStep(smallPlan("probe", 1, 2), { leftovers: true });
    const rows = r.owned().substrate.filter((s: any) => s.kind === "actor" || s.kind === "actor-template");
    const ns = rows[0].atespace;
    expect(rows.map((s: any) => [s.kind, s.name, typeof s.removed_at])).toEqual([["actor", `golden-${ns}`, "string"], ["actor-template", `tpl-${ns}`, "string"]]);
    const del = (k: string) => r.calls.findIndex((c) => argsOf(c).includes(`delete ${k} `));
    expect(del("actor")).toBeLessThan(del("actor-template"));
    const facts = readJson(join(r.setDir, "run-step-a.json"));
    expect(facts.leftovers[0].found[0]).toMatchObject({ kind: "actor", worker: "worker-1" });
    expect(facts.actor_probe[0]).toMatchObject({ G: 0, L: 1, leftover_holds_worker: true }); // §4.5, recorded before step 6 removes it
    const kept = await runStep(smallPlan("probe", 1, 2), { leftovers: true, leftoverDeleteFails: true });
    expect(kept.owned().substrate.filter((s: any) => s.kind.startsWith("actor")).every((s: any) => !s.removed_at)).toBe(true);
  });

  describe("each row of the §4.4 failure table", () => {
    const reasons = (r: Awaited<ReturnType<typeof runStep>>) => Object.fromEntries(r.stopped.map((s: any) => [s.run_id, `${s.execution}: ${s.reason}`]));
    const observed = (id: string) => existsSync(join(artifactDir(id), "observations.json"));

    it("actor not listed within 120 s: stop rule 4, every unobserved bundle NOT_RUN, teardown runs", async () => {
      const plan = smallPlan("probe", 1, 2);
      const task = (readJson(plan) as MultiPlan).configurations[0]!.tenant_runs[0]!.tasks[0]!;
      const r = await runStep(plan, { actorNever: task });
      expect(r.code).toBe(1);
      expect(Object.values(reasons(r))).toEqual([expect.stringMatching(/^NOT_RUN: stop rule 4: actor .* not listed within 120 s/), expect.stringMatching(/^NOT_RUN: stop rule 4/)]);
      expect(r.calls.filter((c) => argsOf(c).includes(`get actor ${task} `)).length).toBe(241); // every 0.5 s for 120 s
      expect(r.calls.at(-1)!.cmd).toBe("bash");
    });

    it("ResourceExhausted from any call: stop rule 4", async () => {
      const plan = smallPlan("probe", 1, 2);
      const r = await runStep(plan, { exhaustedOn: (readJson(plan) as MultiPlan).configurations[0]!.tenant_runs[0]!.tasks[1]! });
      expect(r.code).toBe(1);
      const [first, second] = r.bundles;
      expect(observed(first!.run_id)).toBe(true); // bundles already observed stand
      expect(reasons(r)[second!.run_id]).toMatch(/^NOT_RUN: stop rule 4: ResourceExhausted from ax resume task/);
    });

    it("egress policy attach fails: that task is not resumed and is BLOCKED; the round continues", async () => {
      const plan = smallPlan("configuration", 2, 2);
      const p: MultiPlan = readJson(plan);
      const bad = p.configurations[0]!.tenant_runs[0]!.tasks[1]!, good = p.configurations[0]!.tenant_runs[1]!.tasks[1]!;
      const r = await runStep(plan, { attachFails: bad });
      expect(r.code).toBe(0);
      expect(r.calls.some((c) => argsOf(c).includes(`resume task ${bad} `))).toBe(false);
      const ref = (t: string) => r.bundles.find((b) => b.task === t)!.run_id;
      expect(reasons(r)[ref(bad)]).toBe("BLOCKED: egress policy not attached");
      expect(observed(ref(good))).toBe(true);
    });

    it("ax resume fails: that bundle BLOCKED with the code; the round continues", async () => {
      const plan = smallPlan("probe", 1, 2);
      const [t1, t2] = (readJson(plan) as MultiPlan).configurations[0]!.tenant_runs[0]!.tasks;
      const r = await runStep(plan, { resumeFails: t1 });
      expect(reasons(r)[r.bundles[0]!.run_id]).toBe("BLOCKED: resume failed: Unavailable");
      expect(r.calls.some((c) => argsOf(c).includes(`observe --case F3-A1 --task ${t1}`))).toBe(false);
      expect(observed(r.bundles.find((b) => b.task === t2)!.run_id)).toBe(true);
    });

    it("result not served within 120 s: observed anyway", async () => {
      const plan = smallPlan("probe", 1, 2);
      const t1 = (readJson(plan) as MultiPlan).configurations[0]!.tenant_runs[0]!.tasks[0]!;
      const r = await runStep(plan, { noResult: t1 });
      expect(r.stopped).toEqual([]);
      expect(observed(r.bundles[0]!.run_id)).toBe(true);
      expect(readJson(join(r.setDir, "timing-raw.json")).tasks[0].unobserved.submit_to_result_ms).toBe("result not served within 120 s");
    });

    it("observe exits nonzero: a stopped.json entry NOT_RUN (collector exited <code>); the round and step continue", async () => {
      const plan = smallPlan("probe", 1, 2);
      const t1 = (readJson(plan) as MultiPlan).configurations[0]!.tenant_runs[0]!.tasks[0]!;
      const r = await runStep(plan, { observeFails: t1 });
      expect(r.code).toBe(0);
      expect(r.stopped).toEqual([expect.objectContaining({ run_id: r.bundles[0]!.run_id, case: "F3-A1", execution: "NOT_RUN", reason: "collector exited 2" })]);
      expect(observed(r.bundles[1]!.run_id)).toBe(true);
    });

    it("task delete fails: recorded in the set dir, and the task stays listed for teardown", async () => {
      const plan = smallPlan("probe", 1, 2);
      const t1 = (readJson(plan) as MultiPlan).configurations[0]!.tenant_runs[0]!.tasks[0]!;
      const r = await runStep(plan, { deleteFails: t1 });
      expect(r.code).toBe(0);
      expect(readJson(join(r.setDir, "run-step-a.json")).errors).toEqual([expect.objectContaining({ task: t1, error: expect.stringMatching(/ax delete task failed: Internal/) })]);
      expect(r.owned().ax).toContainEqual({ kind: "task", atespace: `apl-ax-${t1.slice(4, 12)}`, name: t1 });
      expect(r.owned().substrate.some((s: any) => s.kind === "actor")).toBe(false); // its actor is AX's, not a leftover
    });

    it("leftover actor delete fails: the entry keeps no removed_at (teardown deletes it)", async () => {
      const r = await runStep(smallPlan("probe", 1, 2), { leftovers: true, leftoverDeleteFails: true });
      const rows = r.owned().substrate.filter((s: any) => s.kind === "actor");
      expect(rows).toHaveLength(1);
      expect(rows[0].removed_at).toBeUndefined();
    });

    it("port-forward dies twice: the step stops and the remaining bundles are BLOCKED (AX API unreachable)", async () => {
      const r = await runStep(smallPlan("probe", 1, 2), { pfDies: 2 });
      expect(r.code).toBe(1);
      expect(r.calls.filter((c) => c.background)).toHaveLength(2); // reopened once
      expect(Object.values(reasons(r))).toEqual(["BLOCKED: AX API unreachable", "BLOCKED: AX API unreachable"]);
    });

    it("context mismatch: stop rule 2; no other call is made, so there is nothing to tear down", async () => {
      const r = await runStep(smallPlan("probe", 1, 2), { context: "ctx-b" });
      expect(r.code).toBe(1);
      expect(r.calls.map(argsOf)).toEqual([expect.stringContaining("config current-context")]);
      expect(Object.values(reasons(r)).every((x) => /^BLOCKED: stop rule 2/.test(x as string))).toBe(true);
      expect(existsSync(join(r.stepDir, "teardown.json"))).toBe(false);
    });
  });

  it("report: stopped.json becomes §11.3 stop bundles, checksummed; per-bundle reports agree with evaluate_ax.py; the set aggregate is written", async () => {
    const plan = smallPlan("probe", 1, 2);
    const t1 = (readJson(plan) as MultiPlan).configurations[0]!.tenant_runs[0]!.tasks[0]!;
    const r = await runStep(plan, { observeFails: t1 });
    const lines: string[] = [];
    const code = await main(["report", "--plan", plan], { exec: fake().exec, runsRoot, evidenceRoot, log: (l) => lines.push(l) });
    expect(code, lines.join("\n")).toBe(0);
    const stopDir = artifactDir(r.bundles[0]!.run_id);
    expect(readJson(join(stopDir, "observations.json"))).toMatchObject({
      schema_version: 1, case_id: "F3-A1", run_id: r.bundles[0]!.run_id, profile: "ax", mode: "scripted", execution: "NOT_RUN", reason: "collector exited 2",
      candidate_revision: LAB_COMMIT, seed: 0, mutation: "none", collector: "multi.ts report (not observed: stopped)", collector_methods: [], observations: {}, unobserved: {}, evidence: [],
    });
    expect(verifyChecksums(stopDir).ok).toBe(true);
    expect(readJson(join(stopDir, "report.json")).status).toBe("NOT_RUN");
    expect(readJson(join(artifactDir(r.bundles[1]!.run_id), "report.json")).status).toBe("PASS");
    const agg = readJson(join(evidenceRoot, r.plan.set_id, "aggregate.json"));
    expect(agg.line).toBe("all clusters: NOT_RUN (A NOT_RUN, 2 reports)");
    expect(existsSync(join(evidenceRoot, r.bundles[1]!.run_id, "report.json"))).toBe(true);
  });
});

describe("--dry-run", () => {
  it("prints every planned call of a step 1 plan, makes none, and asserts the resolved context", async () => {
    const setId = uuid();
    const f = fake(), lines: string[] = [];
    const deps = { exec: f.exec, runsRoot, evidenceRoot, sleep: async () => {}, log: (l: string) => lines.push(l), uuid };
    expect(await main(["plan", "--step", "1", "--set-id", setId, "--infra-a", infra.a], deps)).toBe(0);
    const planFile = join(runsRoot, "sets", setId, "plan.json");
    const before = existsSync(join(runsRoot, "tenant-runs.json")) ? readFileSync(join(runsRoot, "tenant-runs.json"), "utf8") : null;
    expect(await main(["run-step", "--plan", planFile, "--cluster", "a", "--dry-run"], deps), lines.join("\n")).toBe(0);
    expect(f.calls.map(argsOf)).toEqual([expect.stringContaining("config current-context")]); // the only executed call
    expect(lines).toContainEqual("[a] resolved context: ctx-a; plan: ctx-a; match");
    const dry = lines.filter((l) => l.startsWith("DRY [a] "));
    const plan: MultiPlan = readJson(planFile);
    for (const cfg of plan.configurations) for (const tr of cfg.tenant_runs) {
      for (const t of tr.tasks) {
        expect(dry.some((l) => l.includes(`apply -f `) && l.includes(`task-${t}.yaml`)), t).toBe(true);
        expect(dry.some((l) => l.includes(`resume task ${t} `)), t).toBe(true);
        expect(dry.some((l) => l.includes(`delete task ${t} `)), t).toBe(true);
      }
      for (const b of tr.bundles) {
        const want = b.case === "F3-A1" ? `observe --case F3-A1 --task ${b.task}` : b.case === "MT-W01" ? "observe --run --case MT-W01" : `observe --run --case MT-ISO --task ${b.task}`;
        expect(dry.some((l) => l.includes(want) && l.includes(`--run-id ${b.run_id}`)), `${b.case} ${b.task}`).toBe(true);
      }
    }
    expect(dry.at(-1)).toMatch(/bash .*teardown\.sh /);
    expect(existsSync(join(runsRoot, plan.clusters.a!.step_run_id))).toBe(false); // run dirs went to a temp dir
    expect(existsSync(join(runsRoot, "tenant-runs.json")) ? readFileSync(join(runsRoot, "tenant-runs.json"), "utf8") : null).toBe(before);
    // A kubeconfig that resolves to another context fails the dry run before any call is printed.
    const g = fake({ context: "ctx-b" }), out: string[] = [];
    expect(await main(["run-step", "--plan", planFile, "--cluster", "a", "--dry-run"], { ...deps, exec: g.exec, log: (l) => out.push(l) })).toBe(1);
    expect(out.some((l) => l.startsWith("DRY ["))).toBe(false);
    expect(out.join("\n")).toMatch(/MISMATCH[\s\S]*stop rule 2/);
  });
});
