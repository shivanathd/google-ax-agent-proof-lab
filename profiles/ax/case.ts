// In-sandbox side of the AX lane: `apl-case <mode>` runs as the AX Task's spec.command under the custom runner.
//   W01-H      coordinator + worker for the F3-A1 stimulus against the namespace-local Emulate and Floci
//   isolation  tries destinations outside the egress policy and prints what happened (one JSON line each)
// The command's exit code reaches result.json through the runner; it is a recorded fact, never the outcome:
// the outcome is judged by the collector (profiles/ax/collector.ts) from Emulate and Floci state (L-006).
import "./allowlist.ts"; // installs the AX address rule from APL_AX_ALLOWLIST before any request
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { ROOT } from "../../src/config/run-config.ts";
import { guardedFetch } from "../../src/config/endpoints.ts";
import { ensureRunResources, flociClients } from "../../src/adapters/floci/clients.ts";
import { loadSlackFixture, setupWorkspace, type WorkspaceSecrets } from "../../src/adapters/slack/emulator.ts";
import { slackClient } from "../../src/adapters/slack/client.ts";
import { startWorkerSlackProxy } from "../../src/adapters/slack/worker-proxy.ts";
import { seedLedger } from "../../src/ledger/seed.ts";
import { openReadOnly, rows } from "../../src/ledger/read.ts";
import { stimulus } from "../../src/collector/drive.ts";
import { workerConfig, workerEnv } from "../../src/worker/config.ts";
import { parseAxAllowlist, toEndpoints, type AxEndpoint } from "./allowlist.ts";

export interface AxCaseConfig {
  run_id: string;
  task: string;
  slack: { url: string; mailbox: string; secrets: WorkspaceSecrets };
  floci: { endpoint: string; project: string };
}

const log = (o: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORKER_PORT = 18080;
const PROXY_PORT = 18081;

async function until<T>(what: string, ms: number, fn: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

async function w01(cfg: AxCaseConfig, ax: AxEndpoint[]) {
  const allowlist = toEndpoints(ax);
  const t0 = Date.now();
  // Egress policy is attached after the actor exists, so the first attempts may be refused (L-010).
  await until("emulator mailbox reachable through the egress policy", 120_000, async () =>
    (await guardedFetch(`${cfg.slack.mailbox}/_apl/health`, { allowlist, signal: AbortSignal.timeout(3000) })).ok);
  log({ step: "egress_ready", wait_ms: Date.now() - t0 });

  const floci = await until("floci resources", 60_000, async () => ensureRunResources(await flociClients(cfg.floci.endpoint, allowlist), cfg.floci.project));
  const fx = loadSlackFixture();
  const ws = await setupWorkspace(fx, fx.workspaces.find((w) => w.installation_id === "A")!, cfg.slack.url, cfg.slack.secrets, allowlist);
  const dbPath = "/workspace/.apl/ledger.db";
  seedLedger(dbPath, { [ws.tenant_id]: ws.users });

  // Same process split as the local lane: the worker knows only its loopback Slack proxy and Floci.
  const proxy = await startWorkerSlackProxy(PROXY_PORT, ws.url);
  const flociEntry = ax.find((e) => `http://${e.host}:${e.port}` === cfg.floci.endpoint)!;
  const workerAx: AxEndpoint[] = [{ scheme: "http", host: "127.0.0.1", port: PROXY_PORT }, flociEntry];
  const wcfg = workerConfig(
    { run_id: cfg.run_id, db_path: dbPath, http_port: WORKER_PORT, allowlist: toEndpoints(workerAx), floci: { endpoint: cfg.floci.endpoint, queue_url: floci.queueUrl, bucket: floci.bucket } },
    [{ ...ws, close: async () => {} }], { A: { api_url: proxy.url } },
  );
  const worker = spawn(process.execPath, ["--import", "tsx", "--import", join(ROOT, "profiles/ax/allowlist.ts"), "src/worker/main.ts", "--run-id", cfg.run_id], {
    cwd: ROOT, env: { ...workerEnv(wcfg), APL_AX_ALLOWLIST: JSON.stringify(workerAx) }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    worker.stdout!.on("data", (d) => ((out += d), out.includes('"ready":true') && resolve()));
    worker.once("exit", (code) => reject(new Error(`worker exited ${code} before ready`)));
  });
  log({ step: "worker_ready" });

  // Relay Emulate's deliveries from the mailbox to the worker, byte for byte (see emulate/server.mjs).
  let after = 0, relayed = 0, stop = false;
  const relay = (async () => {
    while (!stop) {
      try {
        const r = await guardedFetch(`${cfg.slack.mailbox}/_apl/events?after=${after}`, { allowlist, signal: AbortSignal.timeout(3000) });
        for (const e of (await r.json()) as { seq: number; path: string; headers: Record<string, string>; body: string }[]) {
          const kind = e.path.endsWith("/interactions") ? "interactions" : "events";
          const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/slack/A/${kind}`, { method: "POST", headers: e.headers, body: e.body });
          after = e.seq;
          relayed++;
          log({ step: "relayed", seq: e.seq, kind, status: res.status });
        }
      } catch (err) {
        log({ step: "relay_error", error: (err as Error).message });
      }
      await sleep(200);
    }
  })();

  const dana = slackClient({ baseUrl: ws.url, token: ws.tokens.users.dana!, allowlist });
  const posted = await dana("chat.postMessage", { channel: ws.channel_id, text: `<@${ws.bot_user_id}> ${stimulus("W01-H", cfg.task)}` });
  if (!posted.ok) throw new Error(`chat.postMessage failed: ${posted.error}`);
  const ts = posted.ts as string;
  log({ step: "mentioned", ts });

  // Coordinator waits on the ledger through a fresh read-only handle, as drive.ts does locally.
  const read = () => {
    const db = openReadOnly(dbPath);
    try {
      const inbox = rows(db, "inbox", { message_ts: ts });
      const tickets = inbox.length ? rows(db, "tickets", { inbox_id: inbox[0]!.id }) : [];
      const actions = tickets.flatMap((t) => rows(db, "actions", { action_key: t.action_key }));
      const reply = tickets[0] && rows(db, "outbox", { action_key: `reply:ticket:${tickets[0].id}` })[0];
      return { inbox, tickets, actions, reply };
    } finally {
      db.close();
    }
  };
  const done = await until("ticket receipt committed and completion reply published", 60_000, () => {
    const l = read();
    return l.tickets[0]?.receipt_status === "committed" && l.reply && l.reply.status !== "pending" ? l : undefined;
  });
  log({ step: "ticket_done", ticket_id: done.tickets[0]!.id, relayed });

  // Ledger export for the collector, which cannot open the sandbox's SQLite file (RESULTS.md: weaker than local).
  const { inbox, tickets, actions } = done;
  const c = await flociClients(cfg.floci.endpoint, allowlist);
  await c.s3.send(new PutObjectCommand({ Bucket: floci.bucket, Key: `apl-evidence/${cfg.task}/ledger-w01.json`, Body: JSON.stringify({ ts, inbox, tickets, actions }), ContentType: "application/json" }));
  log({ step: "ledger_exported" });

  stop = true;
  await relay;
  worker.kill("SIGTERM");
  await new Promise((r) => worker.once("exit", r));
  await proxy.close();
}

// Each probe bypasses the lab's own endpoint guard: the subject here is the sandbox, not the guard.
async function isolation(cfg: AxCaseConfig) {
  const http = async (name: string, url: string, headers: Record<string, string> = {}) => {
    const t = Date.now();
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      log({ probe: name, url, outcome: "http_response", status: r.status, ms: Date.now() - t });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause;
      log({ probe: name, url, outcome: "error", error: cause?.code ?? (e as Error).name, ms: Date.now() - t });
    }
  };
  const tcp = (name: string, host: string, port: number) => new Promise<void>((resolve) => {
    const t = Date.now();
    const s = connect({ host, port, timeout: 8000 });
    let bytes = 0;
    s.on("connect", () => s.write("GET / HTTP/1.0\r\n\r\n"));
    s.on("data", (d) => (bytes += d.length));
    s.on("timeout", () => (log({ probe: name, target: `${host}:${port}`, outcome: "timeout", ms: Date.now() - t }), s.destroy(), resolve()));
    s.on("error", (e) => (log({ probe: name, target: `${host}:${port}`, outcome: "error", error: (e as { code?: string }).code, ms: Date.now() - t }), resolve()));
    s.on("close", () => (log({ probe: name, target: `${host}:${port}`, outcome: "closed", bytes, ms: Date.now() - t }), resolve()));
  });
  await sleep(15_000); // give the egress policy time to apply, so the allowed control probe is meaningful
  await http("allowed_control_emulate", `${cfg.slack.url}/api/api.test`);
  await http("gce_metadata_ip", "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", { "Metadata-Flavor": "Google" });
  await http("gce_metadata_name", "http://metadata.google.internal/computeMetadata/v1/", { "Metadata-Flavor": "Google" });
  await http("public_https", "https://example.com/");
  await http("public_http", "http://example.com/");
  await http("kubernetes_api_name", "https://kubernetes.default.svc/version");
  await http("substrate_api_name", "https://api.ate-system.svc:443/");
  await http("ax_server_name", "http://ax-server.ax-system.svc.cluster.local:8080/healthz");
  await http("emulate_unlisted_port", `${cfg.slack.url.replace(/:8080$/, ":8082")}/events`);
  for (const t of (process.env.APL_AX_PROBE_IPS ?? "").split(",").filter(Boolean)) {
    const [host, port] = t.split(":");
    await tcp(`raw_tcp_${host}`, host!, Number(port));
  }
}

const mode = process.argv[2];
const cfg = JSON.parse(process.env.APL_AX_CASE ?? "null") as AxCaseConfig | null;
const ax = parseAxAllowlist(process.env.APL_AX_ALLOWLIST ?? "[]");
if (!cfg) {
  log({ error: "APL_AX_CASE missing" });
  process.exit(2);
}
try {
  if (mode === "W01-H") await w01(cfg, ax);
  else if (mode === "isolation") await isolation(cfg);
  else throw new Error(`unknown mode ${mode}`);
  log({ done: mode });
  process.exit(0);
} catch (e) {
  log({ failed: mode, error: (e as Error).message });
  process.exit(1);
}
