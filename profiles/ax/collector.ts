// Independent AX-lane collector. Runs in a plain Pod in the lab namespace, never inside the sandbox, with its own
// read-only Slack token (channels:history/read) and its own S3 credentials, from APL_AX_COLLECTOR.
//   result  --task T --atespace A [--wait-ms N]          poll the runner's GET :80/apl/result through the router
//   observe --case ID --task T --atespace A --run-id UUID --out DIR [--ax-phase-file F] [--run-facts F]
//                                                        write a C4 bundle (profile "ax") for one task
//   observe --run --case MT-W01|MT-ISO --atespace A --run-id UUID --out DIR --foreign-markers-file F [--run-facts F]
//           [--task T --targets-file F --egress-log-file F --disclosure-file F]
//                                                        a run-level bundle; MT-ISO names its probing task with --task
// AX's task phase is copied into the bundle as `ax_task_phase` so it can be compared, and is never an
// assertion: profiles/ax/cases.ax.json lists it under recorded_not_asserted (L-006), as it lists the run facts.
// One process per call (docs/MULTI_CLUSTER_BUILD.md §6): the environment comes from `node --env-file`, so it is
// set before allowlist.ts installs its address rule at import. APL_CANDIDATE_REVISION comes from the image only.
// Every IP address is replaced by its role (redactAddresses()) before anything is written.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { ROOT, fixtureSha256 } from "../../src/config/run-config.ts";
import { assertContract } from "../../src/contracts/validate.ts";
import { Probe, captureTicket, sha256 } from "../../src/collector/probe.ts";
import { stimulus } from "../../src/collector/drive.ts";
import { parseAxAllowlist, toEndpoints } from "./allowlist.ts";
import { crossTenantUpstreams, foreignMarkerCount, redactAddresses, type EgressExtract, type Fact as MultiFact, type ForeignRun } from "./multi-facts.ts";

interface CollectorEnv {
  run_id: string;
  slack: { url: string; reader_token: string; channel: string };
  floci: { endpoint: string; credentials: { accessKeyId: string; secretAccessKey: string } };
  router_url: string;
  // Substrate v0.6.0 serves actors only over mTLS to allowlisted SPIFFE IDs (L-045): the collector's own pod
  // certificate (podidentity signer) and the servicedns CA that signs the router's serving certificate.
  router_tls?: { credential_bundle: string; ca: string };
}

const { positionals: [mode], values: a } = parseArgs({
  allowPositionals: true,
  options: { case: { type: "string" }, task: { type: "string" }, atespace: { type: "string" }, out: { type: "string" }, "ax-phase-file": { type: "string" }, "wait-ms": { type: "string" },
    "run-id": { type: "string" }, "run-facts": { type: "string" }, run: { type: "boolean" }, "foreign-markers-file": { type: "string" },
    "targets-file": { type: "string" }, "egress-log-file": { type: "string" }, "disclosure-file": { type: "string" } },
});
if (!process.env.APL_AX_COLLECTOR || !process.env.APL_AX_ALLOWLIST) {
  throw new Error("APL_AX_COLLECTOR and APL_AX_ALLOWLIST must be set before the process starts: node --env-file=<f> --import tsx profiles/ax/collector.ts ...");
}
// node --env-file never overrides a variable the image set, so an env file that sets the revision is refused
// rather than trusted whenever the image did not set it.
for (const [i, arg] of process.execArgv.entries()) {
  const f = arg.startsWith("--env-file=") ? arg.slice(11) : arg === "--env-file" ? process.execArgv[i + 1] : undefined;
  if (f && "APL_CANDIDATE_REVISION" in parseEnv(readFileSync(f, "utf8"))) throw new Error(`env file ${f} sets APL_CANDIDATE_REVISION; it comes from the image only`);
}
const env = JSON.parse(process.env.APL_AX_COLLECTOR ?? "null") as CollectorEnv;
const allowlist = toEndpoints(parseAxAllowlist(process.env.APL_AX_ALLOWLIST ?? "[]"));
const target = `${a.atespace}/${a.task}`;

// The router is outside the lab allowlist on purpose: it is the collector's own read path, not the worker's.
async function getResult() {
  const { status, body } = env.router_tls ? await mtlsGet(`${env.router_url}/apl/result`, env.router_tls) : await plainGet(`${env.router_url}/apl/result`);
  return { http_status: status, body: status === 200 ? JSON.parse(body) : body.slice(0, 200) };
}
async function plainGet(url: string) {
  const r = await fetch(url, { headers: { "ate-target-actor": target }, signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: await r.text() };
}
// Files are re-read per request: the kubelet rotates the pod certificate in place.
function mtlsGet(url: string, t: { credential_bundle: string; ca: string }) {
  const bundle = readFileSync(t.credential_bundle);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { key: bundle, cert: bundle, ca: readFileSync(t.ca), headers: { "ate-target-actor": target }, timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c: string) => (body += c)).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout"))).on("error", reject).end();
  });
}

if (mode === "result") {
  const end = Date.now() + Number(a["wait-ms"] ?? 0);
  for (;;) {
    const r = await getResult().catch((e) => ({ http_status: 0, body: String((e as Error).message) }));
    if (r.http_status === 200 || Date.now() > end) {
      console.log(JSON.stringify({ observed_at: new Date().toISOString(), target, ...r }));
      process.exit(r.http_status === 200 ? 0 : 3);
    }
    await new Promise((res) => setTimeout(res, 250));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_CASES = ["MT-W01", "MT-ISO"];
const usage = "usage: observe [--run] --case ID --atespace A --run-id UUID --out DIR ... (see the header of profiles/ax/collector.ts)";
if (mode !== "observe" || !a.case || !a.out || !a.atespace || !UUID.test(a["run-id"] ?? "")) throw new Error(usage);
if (a.run ? !RUN_CASES.includes(a.case) || !a["foreign-markers-file"] || (a.case === "MT-ISO" && !a.task) : !a.task || RUN_CASES.includes(a.case)) throw new Error(usage);
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
// One environment per bundle: a run-level bundle is refused unless the atespace, the markers file and this env
// file all name the same tenant run.
const markers = a.run ? (readJson(a["foreign-markers-file"]!) as { tenant_run_id: string; foreign: ForeignRun[] }) : undefined;
if (markers && (a.atespace !== `apl-ax-${env.run_id.slice(0, 8)}` || markers.tenant_run_id !== env.run_id)) {
  throw new Error("--atespace, the markers file and the env file name different tenant runs");
}
type Target = { role: string; address: string; port: number; host?: string; own?: boolean };
const targets: Target[] = a["targets-file"] ? readJson(a["targets-file"]) : [];
const redact = (s: string) => redactAddresses(s, targets).text;
const fromFact = <T extends boolean | number>(f: MultiFact<T>) => {
  if ("absent" in f) throw new Error(f.absent);
  return f.value;
};

const bucket = a.task ? `${a.task}-receipts` : ""; // resourceNames(task) in src/adapters/floci/clients.ts
const p = new Probe(
  {
    case_id: a.case, output: join(a.out, "observations.json"), artifacts_dir: a.out, manifest_path: "", mutation: "none", allowlist,
    slack: [{ tenant_id: "T_LAB_A", installation_id: "A", url: env.slack.url, reader_token: env.slack.reader_token, channel_id: "", bot_user_id: "U_LABBOT", users: {} }],
    floci: { endpoint: env.floci.endpoint, bucket, queue_url: "", credentials: env.floci.credentials },
  },
  join(a.out, "evidence"),
);
p.redact = redact;
// The channel is found independently: the reader token lists the channel and its history.
const channelId = async () => ((await p.slack("T_LAB_A", "conversations.list")).channels as { id: string; name: string }[]).find((c) => c.name === env.slack.channel)!.id;

if (!a.run) {
  await p.capture("ax-result", "HTTP GET /apl/result via atenet-router (collector pod, own pod certificate)", getResult);
  p.fact("command_exit_code", ["ax-result"], () => p.data("ax-result").body.exit_code);
  if (a["ax-phase-file"]) {
    await p.capture("ax-phase", "ax get task (operator CLI, recorded before collection; never an assertion)", () => JSON.parse(readFileSync(a["ax-phase-file"]!, "utf8")));
    p.fact("ax_task_phase", ["ax-phase"], () => p.data("ax-phase").phase);
  }
}

// Context for the report (design 6.5): absent with a reason when the file or a key is missing, never 0.
await p.capture("run-facts", "--run-facts: step, concurrency and task counts from the operator's plan (recorded, not asserted)", () => {
  if (!a["run-facts"]) throw new Error("no --run-facts file");
  return readJson(a["run-facts"]);
});
for (const k of ["step", "concurrency", "tasks_planned", "tasks_timed"]) {
  p.fact(k, ["run-facts"], () => {
    const v = p.data("run-facts")[k];
    if (v === undefined) throw new Error(`no ${k} in the run facts`);
    return v;
  });
}

if (a.case === "F3-A1") {
  const channel = await p.capture("w01-channel", "Slack conversations.list (reader token)", channelId);
  if (channel) p.cfg.slack[0]!.channel_id = channel;
  const text = stimulus("W01-H", a.task);
  const root = await p.capture("w01-root", "Slack conversations.history (reader token)", async () => {
    const m = (await p.history("T_LAB_A")).filter((x) => String(x.text).endsWith(text));
    if (m.length !== 1) throw new Error(`expected one root message for this task, found ${m.length}`);
    return m[0];
  });
  const t = await captureTicket(p, "w01", "T_LAB_A", root?.ts ?? "", {
    source: "S3 GetObject of the in-sandbox coordinator's ledger export (collector client, own credentials)",
    read: async () => {
      const body = await p.s3Get(`apl-evidence/${a.task}/ledger-w01.json`);
      if (body === undefined) throw new Error("ledger export absent");
      const l = JSON.parse(body);
      if (l.ts !== root?.ts) throw new Error("ledger export is for a different message");
      return { inbox: l.inbox, tickets: l.tickets, actions: l.actions };
    },
  });
  const all = ["w01-ledger", "w01-s3", "w01-thread"];
  p.fact("ticket_count", ["w01-ledger"], t.ticketCount);
  p.fact("receipt_count", ["w01-s3"], t.receiptCount);
  p.fact("receipt_matches_request", all, t.receiptMatches);
  p.fact("completion_reply_count", ["w01-thread"], () => t.completionReplies().length);
}

if (a.run) {
  // foreign_marker_count (design 6.3): every message in this tenant's own channel and every object in its own
  // Floci, the MT-ISO task's own isolation.json (in its own bucket) excluded.
  await p.capture("foreign-markers", "--foreign-markers-file: run IDs, task names and token hashes of the other registered tenant runs", () => markers);
  const channel = await p.capture("own-channel", "Slack conversations.list (reader token)", channelId);
  if (channel) p.cfg.slack[0]!.channel_id = channel;
  await p.capture("own-slack", "Slack conversations.history and conversations.replies (reader token)", async () => {
    const h = await p.slack("T_LAB_A", "conversations.history", { channel, limit: 200 });
    if (h.has_more) throw new Error("channel history truncated"); // a partial list would read as fewer markers
    const all = new Map<string, Record<string, unknown>>();
    for (const m of h.messages as Record<string, any>[]) for (const x of [m, ...(await p.replies("T_LAB_A", m.ts))]) all.set(x.ts, x);
    return [...all.values()];
  });
  await p.capture("own-floci", "S3 ListBuckets, ListObjectsV2 and GetObject (collector client, own credentials)", async () => {
    const out: Record<string, string> = {};
    for (const b of await p.s3Buckets()) for (const k of await p.s3Keys(b)) out[`${b}/${k}`] = (await p.s3Get(k, b)) ?? "";
    return out;
  });
  await p.capture("foreign-marker-hits", "foreignMarkerCount() over own-slack and own-floci (profiles/ax/multi-facts.ts)", () => {
    const items: Record<string, string> = {
      ...Object.fromEntries((p.data("own-slack") as Record<string, unknown>[]).map((m) => [`slack:${m.ts}`, JSON.stringify(m)])),
      ...Object.fromEntries(Object.entries(p.data("own-floci") as Record<string, string>).map(([k, v]) => [`s3:${k}`, v])),
    };
    return foreignMarkerCount(items, markers!.foreign, a.case === "MT-ISO" ? [`s3:${bucket}/apl-evidence/${a.task}/isolation.json`] : []);
  });
  p.fact("foreign_marker_count", ["foreign-markers", "own-slack", "own-floci", "foreign-marker-hits"], () => fromFact(p.data("foreign-marker-hits")));

  // An operator value (rule 7): recorded, never asserted.
  await p.capture("disclosure", "--disclosure-file: operator string search of ax get task, count only (recorded, not asserted)", () => {
    if (!a["disclosure-file"]) throw new Error("no --disclosure-file");
    const d = readJson(a["disclosure-file"]);
    if (d.tenant_run_id !== env.run_id) throw new Error("disclosure file is for another tenant run");
    return d;
  });
  p.fact("foreign_secret_in_task_count", ["disclosure"], () => {
    const d = p.data("disclosure");
    if (d.foreign_secret_in_task_count === undefined) throw new Error(d.absent ?? "no foreign_secret_in_task_count in the disclosure file");
    return d.foreign_secret_in_task_count;
  });
}

if (a.case === "MT-ISO") {
  // cross_tenant_upstream_count and allowed_control_reached from the gateway log (design 6.3, 6.4; build §9.4).
  // Facts use the verbatim extract in memory; the bundle keeps only the copy with addresses replaced by roles.
  const ownRoles = new Set(targets.filter((t) => t.own).map((t) => t.role));
  const own = (re: RegExp) => targets.filter((t) => t.own && re.test(t.role)).map((t) => t.address);
  await p.capture("targets", "--targets-file: probe targets and their roles, the tenant's own included", () => {
    if (!a["targets-file"]) throw new Error("no --targets-file");
    return targets;
  });
  await p.capture("iso-self-report", "S3 GetObject of the probe's isolation.json (collector client, own credentials; the subject's self-report)", async () => {
    const body = await p.s3Get(`apl-evidence/${a.task}/isolation.json`, bucket);
    if (body === undefined) throw new Error("isolation.json absent");
    return JSON.parse(body);
  });
  // The self-report's count of foreign targets reached (own targets excluded), as the mismatch rule reads it.
  const foreignReached = () => (p.data("iso-self-report") as { probe?: string; reached?: boolean }[]).filter((r) => r.reached === true && !ownRoles.has(r.probe ?? "")).length;
  p.fact("probe_self_report_reached_count", ["targets", "iso-self-report"], foreignReached);
  let extract: EgressExtract | undefined;
  await p.capture("egress-log", "gateway access-log extract (--egress-log-file, copied verbatim by the operator), every address replaced by its role", () => {
    if (!a["egress-log-file"]) throw new Error("no --egress-log-file");
    const text = readFileSync(a["egress-log-file"], "utf8");
    extract = JSON.parse(text);
    const r = redactAddresses(text, targets);
    return { ...JSON.parse(r.text), unlisted_address_count: r.unlisted };
  });
  const from = ["targets", "iso-self-report", "egress-log"];
  const verdict = () => crossTenantUpstreams(extract!, { emulate: own(/emulate/), floci: own(/floci/) }, foreignReached());
  // Recorded, not asserted (build §10): whether the next tenant's term-mode target ran beside the prober. If it did
  // not, the router and worker probes had no running target, so a count of 0 is absent; a count above 0 stands.
  const targetRan = (() => { try { return p.data("run-facts").target_ran; } catch { return undefined; } })();
  p.fact("target_ran", ["run-facts"], () => {
    if (typeof targetRan !== "boolean") throw new Error("no target_ran in the run facts");
    return targetRan;
  });
  p.fact("cross_tenant_upstream_count", from, () => {
    const n = fromFact(verdict().cross_tenant_upstream_count);
    if (n === 0 && targetRan === false) throw new Error("the router and worker target task did not run, so those probes tested no running target");
    return n;
  });
  p.fact("allowed_control_reached", from, () => fromFact(verdict().allowed_control_reached));
}

const bundle = assertContract("observation-bundle", {
  schema_version: 1, case_id: a.case, run_id: a["run-id"], profile: "ax", mode: "scripted", execution: "EXECUTED",
  candidate_revision: process.env.APL_CANDIDATE_REVISION ?? "unknown", fixture_sha256: fixtureSha256(),
  dependencies_sha256: sha256(readFileSync(join(ROOT, "package-lock.json"), "utf8")), seed: 0, mutation: "none",
  collector: `apl-ax-collector pid=${process.pid} (plain Pod outside the sandbox; reader Slack token, own S3 credentials, router GET /apl/result)`,
  collector_methods: [...p.methods].sort(), observed_at: new Date().toISOString(),
  observations: p.observations, unobserved: p.unobserved, evidence: p.evidence,
});
mkdirSync(a.out, { recursive: true });
writeFileSync(join(a.out, "observations.json"), redact(`${JSON.stringify(bundle, null, 2)}\n`));
console.log(redact(JSON.stringify({ done: true, observed: p.observations, unobserved: p.unobserved })));
p.close();
