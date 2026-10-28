// Operator-side generator for an authorized AX lane run (laptop; never inside the cluster). Writes into the
// gitignored run dir: per-run fake Slack secrets, the in-cluster Emulate seed, the collector's environment and
// one AX manifest (Workspace + Task) per task. No identifiers are read from tracked files.
//   orchestrate.ts init      --dir D --run-id ID
//   orchestrate.ts manifests --dir D --task NAME --mode W01-H|isolation|fail|term|term-ignore --image REF \
//                            --emulate-ip IP --floci-ip IP [--probe-ips host:port,...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSlackFixture, workspaceSecrets, workspaceSeed } from "../../src/adapters/slack/emulator.ts";
import type { AxEndpoint } from "./allowlist.ts";
import type { AxCaseConfig } from "./case.ts";

const { positionals: [cmd], values: a } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: "string" }, "run-id": { type: "string" }, task: { type: "string" }, mode: { type: "string" }, image: { type: "string" },
    "emulate-ip": { type: "string" }, "floci-ip": { type: "string" }, "probe-ips": { type: "string" } },
});
const dir = a.dir!;
const fx = loadSlackFixture();
const wsA = fx.workspaces.find((w) => w.installation_id === "A")!;

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
} else if (cmd === "manifests") {
  const sec = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"));
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
    ...(a["probe-ips"] ? [{ name: "APL_AX_PROBE_IPS", value: a["probe-ips"] }] : []),
  ];
  const docs = [
    { apiVersion: "ax.io/v1alpha1", kind: "Workspace", metadata: { name: `ws-${a.task}`, atespace: ns },
      spec: { files: [{ path: ".apl/run.json", content: JSON.stringify({ "apl-run": sec.run_id, task: a.task, mode: a.mode }) }] } },
    { apiVersion: "ax.io/v1alpha1", kind: "Task", metadata: { name: a.task, atespace: ns },
      spec: { image: a.image, command: command[a.mode!], env, config: { "apl-run": sec.run_id, mode: a.mode }, resources: { limits: { cpu: "1", memory: "1Gi" } }, workspace: { name: `ws-${a.task}` }, debug: false } },
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
