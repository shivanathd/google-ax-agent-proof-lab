// In-sandbox side of the AX lane: `apl-case <mode>` runs as the AX Task's spec.command under the custom runner.
//   W01-H      coordinator + worker for the F3-A1 stimulus against the namespace-local Emulate and Floci
//   isolation  tries destinations outside the egress policy (run 3's probes plus APL_AX_PROBES), prints one JSON
//              line each, and writes them as its self-report to apl-evidence/<task>/isolation.json in its own Floci
// The command's exit code reaches result.json through the runner; it is a recorded fact, never the outcome:
// the outcome is judged by the collector (profiles/ax/collector.ts) from Emulate and Floci state (L-006).
import "./allowlist.ts"; // installs the AX address rule from APL_AX_ALLOWLIST before any request
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { connect, isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ROOT, type Endpoint } from "../../src/config/run-config.ts";
import { guardedFetch } from "../../src/config/endpoints.ts";
import { ensureRunResources, flociClients, resourceNames } from "../../src/adapters/floci/clients.ts";
import { loadSlackFixture, setupWorkspace, type WorkspaceSecrets } from "../../src/adapters/slack/emulator.ts";
import { slackClient } from "../../src/adapters/slack/client.ts";
import { startWorkerSlackProxy } from "../../src/adapters/slack/worker-proxy.ts";
import { seedLedger } from "../../src/ledger/seed.ts";
import { openReadOnly, rows } from "../../src/ledger/read.ts";
import { stimulus } from "../../src/collector/drive.ts";
import { workerConfig, workerEnv } from "../../src/worker/config.ts";
import { parseAxAllowlist, toEndpoints, type AxEndpoint } from "./allowlist.ts";
import { ISOLATION } from "./multi-facts.ts";

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

type Delivery = { seq: number; path: string; headers: Record<string, string>; body: string };
const deliveries = async (mailbox: string, allowlist: Endpoint[], after: number) =>
  (await (await guardedFetch(`${mailbox}/_apl/events?after=${after}`, { allowlist, signal: AbortSignal.timeout(3000) })).json()) as Delivery[];

// Emulate's mailbox keeps every delivery of the tenant run (emulate/server.mjs), and the worker accepts a replayed
// earlier mention inside the signature window, so a task reads the highest seq once before posting its own mention.
export async function relayBaseline(mailbox: string, allowlist: Endpoint[]): Promise<number> {
  return Math.max(0, ...(await deliveries(mailbox, allowlist, 0)).map((e) => e.seq));
}

// Relays Emulate's deliveries after `after` from the mailbox to the worker, byte for byte.
export function startRelay(mailbox: string, allowlist: Endpoint[], workerUrl: string, after: number) {
  let relayed = 0, stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        for (const e of await deliveries(mailbox, allowlist, after)) {
          const kind = e.path.endsWith("/interactions") ? "interactions" : "events";
          const res = await fetch(`${workerUrl}/slack/A/${kind}`, { method: "POST", headers: e.headers, body: e.body });
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
  return { relayed: () => relayed, stop: async () => ((stop = true), await loop) };
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
  seedLedger(dbPath, { [ws.tenant_id]: ws.users }, [ws.tenant_id]);

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

  // Relay only deliveries newer than this task's start: the mailbox keeps the tenant run's earlier tasks' mentions.
  const relay = startRelay(cfg.slack.mailbox, allowlist, `http://127.0.0.1:${WORKER_PORT}`, await relayBaseline(cfg.slack.mailbox, allowlist));
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
  log({ step: "ticket_done", ticket_id: done.tickets[0]!.id, relayed: relay.relayed() });

  // Ledger export for the collector, which cannot open the sandbox's SQLite file (RESULTS.md: weaker than local).
  const { inbox, tickets, actions } = done;
  const c = await flociClients(cfg.floci.endpoint, allowlist);
  await c.s3.send(new PutObjectCommand({ Bucket: floci.bucket, Key: `apl-evidence/${cfg.task}/ledger-w01.json`, Body: JSON.stringify({ ts, inbox, tickets, actions }), ContentType: "application/json" }));
  log({ step: "ledger_exported" });

  await relay.stop();
  worker.kill("SIGTERM");
  await new Promise((r) => worker.once("exit", r));
  await proxy.close();
}

// One APL_AX_PROBES entry (docs/MULTI_CLUSTER_BUILD.md section 10): HTTP, or raw TCP with `tcp: true`. Every probe
// dials an address, because names outside the egress policy fail DNS in the sandbox (L-049).
export interface Probe { role: string; address: string; port: number; host?: string; path?: string; tls?: boolean; headers?: Record<string, string>; tcp?: boolean }

export function parseProbes(raw: string): Probe[] {
  const list = JSON.parse(raw) as Probe[];
  if (!Array.isArray(list)) throw new Error("APL_AX_PROBES must be a JSON list");
  for (const p of list) {
    if (typeof p.role !== "string" || !isIP(p.address) || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) {
      throw new Error(`probe ${p.role}: needs a role, an IP address and a port`);
    }
    if (p.tcp && (p.host || p.path || p.tls || p.headers)) throw new Error(`probe ${p.role}: a raw TCP probe takes no HTTP fields`);
  }
  return list;
}

// Each probe bypasses the lab's own endpoint guard: the subject here is the sandbox, not the guard.
const tcp = (role: string, host: string, port: number) => new Promise<object>((resolve) => {
  const t = Date.now(), target = `${host}:${port}`;
  let bytes = 0;
  const s = connect({ host, port, timeout: ISOLATION.probeMs });
  s.on("connect", () => s.write("GET / HTTP/1.0\r\n\r\n"));
  s.on("data", (d) => (bytes += d.length));
  s.on("timeout", () => (resolve({ probe: role, target, outcome: "timeout", ms: Date.now() - t }), s.destroy()));
  s.on("error", (e) => resolve({ probe: role, target, outcome: "error", error: (e as { code?: string }).code, ms: Date.now() - t }));
  s.on("close", () => resolve({ probe: role, target, outcome: "closed", bytes, ms: Date.now() - t }));
});

// An HTTP probe sends the target's Service name as Host and asks for a path the target answers with 404, the
// status the egress gateway logs (build plan section 9.3). The self-report counts the target as reached on that 404.
export function probe(p: Probe): Promise<object> {
  if (p.tcp) return tcp(p.role, p.address, p.port);
  const t = Date.now(), target = `${p.address}:${p.port}`, base = { probe: p.role, target, host: p.host, path: p.path };
  return new Promise((resolve) => {
    const req = (p.tls ? https : http).request({
      host: p.address, port: p.port, path: p.path ?? "/", agent: false, timeout: ISOLATION.probeMs,
      headers: { ...(p.host ? { host: p.host } : {}), ...p.headers },
      // A reachability probe, not a trusted client: the sandbox holds no CA for in-cluster names.
      ...(p.tls ? { servername: p.host, rejectUnauthorized: false } : {}),
    }, (res) => {
      res.resume();
      res.on("close", () => resolve({ ...base, outcome: "http_response", status: res.statusCode, reached: res.statusCode === 404, ms: Date.now() - t }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => resolve({ ...base, outcome: "error", error: (e as { code?: string }).code ?? e.message, ms: Date.now() - t }));
    req.end();
  });
}

// The self-report goes to the task's own bucket (<task>-receipts), created if absent; the collector reads it there.
export async function saveIsolation(cfg: AxCaseConfig, allowlist: Endpoint[], results: object[]) {
  const c = await flociClients(cfg.floci.endpoint, allowlist);
  const { bucket } = resourceNames(cfg.floci.project);
  await c.s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((e) => {
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(e?.name))) throw e;
  });
  await c.s3.send(new PutObjectCommand({ Bucket: bucket, Key: `apl-evidence/${cfg.task}/isolation.json`, Body: JSON.stringify(results), ContentType: "application/json" }));
}

async function isolation(cfg: AxCaseConfig, ax: AxEndpoint[]) {
  const probes = parseProbes(process.env.APL_AX_PROBES ?? "[]");
  const results: object[] = [];
  const record = (r: object) => (log(r), results.push(r));
  // Run 3's probes (ISOLATION.fixedProbes counts them: multi.ts sizes the result wait from it); the by-name ones
  // fail DNS and stay in the self-report only.
  const get = async (name: string, url: string, headers: Record<string, string> = {}) => {
    const t = Date.now();
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(ISOLATION.probeMs) });
      record({ probe: name, url, outcome: "http_response", status: r.status, ms: Date.now() - t });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause;
      record({ probe: name, url, outcome: "error", error: cause?.code ?? (e as Error).name, ms: Date.now() - t });
    }
  };
  await sleep(ISOLATION.settleMs); // give the egress policy time to apply, so the allowed control probe is meaningful
  await get("allowed_control_emulate", `${cfg.slack.url}/api/api.test`);
  await get("gce_metadata_ip", "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", { "Metadata-Flavor": "Google" });
  await get("gce_metadata_name", "http://metadata.google.internal/computeMetadata/v1/", { "Metadata-Flavor": "Google" });
  await get("public_https", "https://example.com/");
  await get("public_http", "http://example.com/");
  await get("kubernetes_api_name", "https://kubernetes.default.svc/version");
  await get("substrate_api_name", "https://api.ate-system.svc:443/");
  await get("ax_server_name", "http://ax-server.ax-system.svc.cluster.local:8080/healthz");
  await get("emulate_unlisted_port", `${cfg.slack.url.replace(/:8080$/, ":8082")}/events`);
  for (const p of probes) record(await probe(p));
  await saveIsolation(cfg, toEndpoints(ax), results);
  log({ step: "isolation_saved", probes: results.length });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const cfg = JSON.parse(process.env.APL_AX_CASE ?? "null") as AxCaseConfig | null;
  const ax = parseAxAllowlist(process.env.APL_AX_ALLOWLIST ?? "[]");
  if (!cfg) {
    log({ error: "APL_AX_CASE missing" });
    process.exit(2);
  }
  try {
    if (mode === "W01-H") await w01(cfg, ax);
    else if (mode === "isolation") await isolation(cfg, ax);
    else throw new Error(`unknown mode ${mode}`);
    log({ done: mode });
    process.exit(0);
  } catch (e) {
    log({ failed: mode, error: (e as Error).message });
    process.exit(1);
  }
}

