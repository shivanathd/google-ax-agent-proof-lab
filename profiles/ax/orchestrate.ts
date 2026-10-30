// Operator-side generator for an authorized AX lane run (laptop; never inside the cluster). Writes into the
// gitignored run dir: per-run fake Slack secrets, the in-cluster Emulate seed, the collector's environment and
// one AX manifest (Workspace + Task) per task, and the tenant's namespace manifest. No identifiers are read from
// tracked files.
//   orchestrate.ts init      --dir D --run-id ID
//   orchestrate.ts manifests --tenant --dir D --set-id UUID --cluster a|b --tenant-role t1|t2|t3|t4
//   orchestrate.ts manifests --dir D --task NAME --mode W01-H|isolation|fail|term|term-ignore --image REF \
//                            --emulate-ip IP --floci-ip IP --set-id UUID --cluster a|b --tenant-role t1|t2|t3|t4 \
//                            [--probes FILE]
// --tenant reads APL_EMULATE_IMAGE and optionally APL_FLOCI_IMAGE (default FLOCI_IMAGE), both digest-pinned.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadSlackFixture, workspaceSecrets, workspaceSeed } from "../../src/adapters/slack/emulator.ts";
import type { AxEndpoint } from "./allowlist.ts";
import type { AxCaseConfig } from "./case.ts";
import { DIGEST_PINNED, FLOCI_IMAGE, render } from "./index.ts";

// The shared collector's namespace on both clusters (design section 5); tenant NetworkPolicies admit it.
const COLLECTOR_NS = "apl-ax-6882d106";
const { positionals: [cmd], values: a } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: "string" }, "run-id": { type: "string" }, task: { type: "string" }, mode: { type: "string" }, image: { type: "string" },
    "emulate-ip": { type: "string" }, "floci-ip": { type: "string" }, probes: { type: "string" }, tenant: { type: "boolean" },
    "set-id": { type: "string" }, cluster: { type: "string" }, "tenant-role": { type: "string" } },
});
const dir = a.dir!;
const fx = loadSlackFixture();
const wsA = fx.workspaces.find((w) => w.installation_id === "A")!;
const tenantKeys = () => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a["set-id"] ?? "")) throw new Error("--set-id must be a UUID");
  if (!/^[ab]$/.test(a.cluster ?? "")) throw new Error("--cluster must be a or b");
  if (!/^t[1-4]$/.test(a["tenant-role"] ?? "")) throw new Error("--tenant-role must be t1 to t4");
  return { "apl-set": a["set-id"]!, "apl-cluster": a.cluster!, "apl-tenant": a["tenant-role"]! };
};

if (cmd === "init") {
  if (existsSync(join(dir, "secrets.json"))) throw new Error("secrets.json exists; refusing to regenerate");
  const short = a["run-id"]!.slice(0, 8);
  const ns = `apl-ax-${short}`;
  const s = workspaceSecrets(wsA);
  const collectorS3 = { accessKeyId: `apl-collector-${randomBytes(6).toString("hex")}`, secretAccessKey: randomBytes(18).toString("hex") };
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ run_id: a["run-id"], ns, slack: s, collector_s3: collectorS3 }, null, 2), { mode: 0o600 });
  // Event URLs are replaced by the loopback mailbox inside the Emulate pod (emulate/server.mjs).
  writeFileSync(join(dir, "emulate-seed.json"), JSON.stringify(workspaceSeed(fx, wsA, s, { eventsUrl: "http://127.0.0.1:8082/events", interactionsUrl: "http://127.0.0.1:8082/interactions" })), { mode: 0o600 });
  console.log(JSON.stringify({ ns, written: ["secrets.json", "emulate-seed.json"] }));
} else if (cmd === "manifests" && a.tenant) {
  const sec = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"));
  const keys = tenantKeys();
  const images = { APL_FLOCI_IMAGE: process.env.APL_FLOCI_IMAGE ?? FLOCI_IMAGE, APL_EMULATE_IMAGE: process.env.APL_EMULATE_IMAGE ?? "" };
  for (const [k, v] of Object.entries(images)) if (!DIGEST_PINNED.test(v)) throw new Error(`${k} must be pinned by digest`);
  const tpl = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "manifests/k8s/tenant.yaml"), "utf8");
  const yaml = render(tpl, {
    APL_RUN_ID: sec.run_id, APL_SHORT_ID: sec.run_id.slice(0, 8), APL_SET_ID: keys["apl-set"], APL_CLUSTER: keys["apl-cluster"],
    APL_TENANT: keys["apl-tenant"], ...images, APL_COLLECTOR_NS: COLLECTOR_NS,
    APL_EMULATE_SEED: JSON.stringify(readFileSync(join(dir, "emulate-seed.json"), "utf8")),
  });
  writeFileSync(join(dir, "tenant.yaml"), yaml, { mode: 0o600 });
  console.log(JSON.stringify({ written: ["tenant.yaml"] }));
} else if (cmd === "manifests") {
  const sec = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"));
  const keys = tenantKeys();
  const ns: string = sec.ns;
  const emulate = `emulate.${ns}.svc.cluster.local`, floci = `floci.${ns}.svc.cluster.local`;
  const allow: AxEndpoint[] = [
    { scheme: "http", host: emulate, port: 8080, addresses: [a["emulate-ip"]!] },
    { scheme: "http", host: emulate, port: 8081, addresses: [a["emulate-ip"]!] },
    { scheme: "http", host: floci, port: 4566, addresses: [a["floci-ip"]!] },
  ];
  // The sandbox gets the coordinator's and worker's secrets only; never the reader token (collector's).
  const slackForSandbox = { ...sec.slack, tokens: { ...sec.slack.tokens, reader: "" } };
  const caseCfg: AxCaseConfig = {
    run_id: sec.run_id, task: a.task!,
    slack: { url: `http://${emulate}:8080`, mailbox: `http://${emulate}:8081`, secrets: slackForSandbox },
    floci: { endpoint: `http://${floci}:4566`, project: a.task! },
  };
  const command: Record<string, string[]> = {
    "W01-H": ["/usr/local/bin/apl-case", "W01-H"],
    isolation: ["/usr/local/bin/apl-case", "isolation"],
    fail: ["/bin/sh", "-c", "echo apl-fail-case; exit 3"],
    term: ["/bin/sh", "-c", "echo \"boot pid=$$ prepared=$(cat .apl/prepared)\"; trap 'echo got SIGTERM; exit 42' TERM; while :; do sleep 1; done"],
    "term-ignore": ["/bin/sh", "-c", "echo \"boot pid=$$ prepared=$(cat .apl/prepared)\"; trap '' TERM; while :; do sleep 1; done"],
  };
  if (!command[a.mode!]) throw new Error(`unknown mode ${a.mode}`);
  const env = [
    { name: "APL_RUN_ID", value: sec.run_id }, { name: "APL_PROFILE", value: "ax" },
    { name: "APL_AX_CASE", value: JSON.stringify(caseCfg) }, { name: "APL_AX_ALLOWLIST", value: JSON.stringify(allow) },
    // The probe list (docs/MULTI_CLUSTER_BUILD.md section 10); case.ts validates each entry.
    ...(a.probes ? [{ name: "APL_AX_PROBES", value: JSON.stringify(JSON.parse(readFileSync(a.probes, "utf8"))) }] : []),
  ];
  const docs = [
    { apiVersion: "ax.io/v1alpha1", kind: "Workspace", metadata: { name: `ws-${a.task}`, atespace: ns },
      spec: { files: [{ path: ".apl/run.json", content: JSON.stringify({ "apl-run": sec.run_id, task: a.task, mode: a.mode, ...keys }) }] } },
    { apiVersion: "ax.io/v1alpha1", kind: "Task", metadata: { name: a.task, atespace: ns },
      spec: { image: a.image, command: command[a.mode!], env, config: { "apl-run": sec.run_id, mode: a.mode, ...keys }, resources: { limits: { cpu: "1", memory: "1Gi" } }, workspace: { name: `ws-${a.task}` }, debug: false } },
  ];
  const yaml = docs.map((d) => JSON.stringify(d, null, 2)).join("\n---\n");
  if (Buffer.byteLength(yaml) > 30 * 1024) throw new Error("rendered task exceeds the 31 KiB AX limit");
  writeFileSync(join(dir, `task-${a.task}.yaml`), `${yaml}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "collector-env.json"), JSON.stringify({
    APL_AX_COLLECTOR: JSON.stringify({ run_id: sec.run_id, slack: { url: `http://${emulate}:8080`, reader_token: sec.slack.tokens.reader, channel: wsA.channel },
      floci: { endpoint: `http://${floci}:4566`, credentials: sec.collector_s3 }, router_url: "https://atenet-router.ate-system.svc",
      router_tls: { credential_bundle: "/run/podidentity/credential-bundle.pem", ca: "/run/servicedns-ca/trust-bundle.pem" } }),
    APL_AX_ALLOWLIST: JSON.stringify(allow.filter((e) => e.port !== 8081)),
  }), { mode: 0o600 });
  console.log(JSON.stringify({ written: [`task-${a.task}.yaml`, "collector-env.json"], bytes: Buffer.byteLength(yaml) }));
} else {
  throw new Error("usage: orchestrate.ts init|manifests ...");
}
