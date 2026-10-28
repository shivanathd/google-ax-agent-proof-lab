// Independent AX-lane collector. Runs in a plain Pod in the lab namespace, never inside the sandbox, with its own
// read-only Slack token (channels:history/read) and its own S3 credentials, from APL_AX_COLLECTOR.
//   result  --task T --atespace A [--wait-ms N]          poll the runner's GET :80/apl/result through the router
//   observe --case ID --task T --atespace A --out DIR [--ax-phase-file F]   write a C4 bundle (profile "ax")
// AX's task phase is copied into the bundle as `ax_task_phase` so it can be compared, and is never an
// assertion: profiles/ax/cases.ax.json lists it under recorded_not_asserted (L-006).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, fixtureSha256 } from "../../src/config/run-config.ts";
import { assertContract } from "../../src/contracts/validate.ts";
import { Probe, captureTicket, sha256 } from "../../src/collector/probe.ts";
import { stimulus } from "../../src/collector/drive.ts";
import { parseAxAllowlist, toEndpoints } from "./allowlist.ts";

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
  options: { case: { type: "string" }, task: { type: "string" }, atespace: { type: "string" }, out: { type: "string" }, "ax-phase-file": { type: "string" }, "wait-ms": { type: "string" } },
});
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

if (mode !== "observe" || !a.case || !a.task || !a.out) throw new Error("usage: observe --case ID --task T --atespace A --out DIR");
const bucket = `${a.task}-receipts`; // resourceNames(task) in src/adapters/floci/clients.ts
const p = new Probe(
  {
    case_id: a.case, output: join(a.out, "observations.json"), artifacts_dir: a.out, manifest_path: "", mutation: "none", allowlist,
    slack: [{ tenant_id: "T_LAB_A", installation_id: "A", url: env.slack.url, reader_token: env.slack.reader_token, channel_id: "", bot_user_id: "U_LABBOT", users: {} }],
    floci: { endpoint: env.floci.endpoint, bucket, queue_url: "", credentials: env.floci.credentials },
  },
  join(a.out, "evidence"),
);

await p.capture("ax-result", "HTTP GET /apl/result via atenet-router (collector pod, own pod certificate)", getResult);
p.fact("command_exit_code", ["ax-result"], () => p.data("ax-result").body.exit_code);
if (a["ax-phase-file"]) {
  await p.capture("ax-phase", "ax get task (operator CLI, recorded before collection; never an assertion)", () => JSON.parse(readFileSync(a["ax-phase-file"]!, "utf8")));
  p.fact("ax_task_phase", ["ax-phase"], () => p.data("ax-phase").phase);
}

if (a.case === "F3-A1") {
  // The root message is found independently: the reader token lists the channel and its history.
  const channel = await p.capture("w01-channel", "Slack conversations.list (reader token)", async () =>
    ((await p.slack("T_LAB_A", "conversations.list")).channels as { id: string; name: string }[]).find((c) => c.name === env.slack.channel)!.id);
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

const bundle = assertContract("observation-bundle", {
  schema_version: 1, case_id: a.case, run_id: env.run_id, profile: "ax", mode: "scripted", execution: "EXECUTED",
  candidate_revision: process.env.APL_CANDIDATE_REVISION ?? "unknown", fixture_sha256: fixtureSha256(),
  dependencies_sha256: sha256(readFileSync(join(ROOT, "package-lock.json"), "utf8")), seed: 0, mutation: "none",
  collector: `apl-ax-collector pid=${process.pid} (plain Pod outside the sandbox; reader Slack token, own S3 credentials, router GET /apl/result)`,
  collector_methods: [...p.methods].sort(), observed_at: new Date().toISOString(),
  observations: p.observations, unobserved: p.unobserved, evidence: p.evidence,
});
mkdirSync(a.out, { recursive: true });
writeFileSync(join(a.out, "observations.json"), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(JSON.stringify({ done: true, observed: p.observations, unobserved: p.unobserved }));
p.close();
