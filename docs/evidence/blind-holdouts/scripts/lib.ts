// Blind-holdout harness helpers. Drives the frozen candidate only through its run handle, signed HTTP,
// emulator Web API, Floci SDK clients (own creds) and a read-only SQLite connection.
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const C = `${process.env.APL_BLIND_CANDIDATE ?? "candidate"}/src`; // frozen candidate worktree
export const BLIND = process.env.APL_BLIND_DIR ?? "."; // where expectations.json and results/ live
const lc = await import(`${C}/config/lifecycle.ts`);
const sig = await import(`${C}/adapters/slack/signature.ts`);
const client = await import(`${C}/adapters/slack/client.ts`);
const read = await import(`${C}/ledger/read.ts`);
const emu = await import(`${C}/adapters/slack/emulator.ts`);
const s3m = await import(`${C}/../node_modules/@aws-sdk/client-s3/dist-cjs/index.js`);
const sqsm = await import(`${C}/../node_modules/@aws-sdk/client-sqs/dist-cjs/index.js`);
export const faults = await import(`${C}/adapters/faults/proxy.ts`);
export { lc };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms: number, what: string): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(150);
  }
}

export const start = (o: any = {}) => lc.startRun({ slack: true, ...o });
export const W = (h: any, t = "T_LAB_A") => h.workspaces.find((w: any) => w.tenant_id === t);

// Read-only ledger, fresh connection per query.
export function q(h: any, table: string, where: Record<string, any> = {}) {
  const db = read.openReadOnly(h.manifest.db_path);
  try { return read.rows(db, table, where) as any[]; } finally { db.close(); }
}
export const audits = (h: any, kind?: string) => q(h, "run_audit").filter((r) => !kind || r.kind === kind).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

// Emulator Web API as a fictional user / reader.
export const api = (h: any, w: any, token: string) => client.slackClient({ baseUrl: w.url, token, allowlist: h.manifest.config.endpoint_allowlist });
export async function postAs(h: any, w: any, user: string, text: string, thread_ts?: string) {
  const r = await api(h, w, w.tokens.users[user])("chat.postMessage", { channel: w.channel_id, text, ...(thread_ts ? { thread_ts } : {}) });
  if (!r.ok) throw new Error(`postMessage ${r.error}`);
  return r.ts as string;
}
export const mention = (h: any, w: any, user: string, text: string, thread_ts?: string) => postAs(h, w, user, `<@${w.bot_user_id}> ${text}`, thread_ts);
export async function replies(h: any, w: any, ts: string) {
  const r = await api(h, w, w.tokens.reader)("conversations.replies", { channel: w.channel_id, ts });
  return (r.messages ?? []) as any[];
}
export async function history(h: any, w: any) {
  const r = await api(h, w, w.tokens.reader)("conversations.history", { channel: w.channel_id, limit: 200 });
  return (r.messages ?? []) as any[];
}
export const botReplies = async (h: any, w: any, ts: string) => (await replies(h, w, ts)).filter((m) => m.bot_id && m.ts !== ts);

export async function clickAs(w: any, message_ts: string, user: string, action_id: string) {
  return emu.simulate(w, "block-actions", { channel: w.channel_id, message_ts, action_id, user });
}

// Signed Events API delivery straight to the worker's receiver.
export const workerUrl = (h: any, inst: string, kind = "events") => `http://127.0.0.1:${h.manifest.ports.worker}/slack/${inst}/${kind}`;
export function eventBody(w: any, user: string, ts: string, text: string, event_id = `EvBH${randomBytes(6).toString("hex").toUpperCase()}`, extra: object = {}) {
  return { token: "x", team_id: w.team_id, api_app_id: w.api_app_id, type: "event_callback", event_id, event_time: Math.floor(Date.now() / 1000),
    event: { type: "app_mention", user: w.users[user], channel: w.channel_id, ts, text: `<@${w.bot_user_id}> ${text}`, event_ts: ts }, ...extra };
}
export async function deliver(url: string, raw: string, secret: string, o: { ts?: number; retry?: string } = {}) {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": sig.sign(secret, ts, raw) };
  if (o.retry) { headers["x-slack-retry-num"] = o.retry; headers["x-slack-retry-reason"] = "http_timeout"; }
  const r = await fetch(url, { method: "POST", headers, body: raw });
  return { status: r.status, body: await r.text() };
}

// Collector-equivalent Floci clients with their own fake creds.
export function floci(h: any) {
  const cfg = { endpoint: h.flociEndpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "blind-reader", secretAccessKey: "blind-reader" }, maxAttempts: 1 };
  const s3 = new s3m.S3Client(cfg);
  const sqs = new sqsm.SQSClient(cfg);
  return {
    keys: async () => ((await s3.send(new s3m.ListObjectsV2Command({ Bucket: h.floci.bucket }))).Contents ?? []).map((o: any) => o.Key as string).sort(),
    get: async (key: string) => { try { return await (await s3.send(new s3m.GetObjectCommand({ Bucket: h.floci.bucket, Key: key }))).Body.transformToString(); } catch (e: any) { if (e.name === "NoSuchKey") return undefined; throw e; } },
    depth: async () => (await sqs.send(new sqsm.GetQueueAttributesCommand({ QueueUrl: h.floci.queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }))).Attributes,
    close: () => { s3.destroy(); sqs.destroy(); },
  };
}

export async function ticketDone(h: any, ts: string, ms = 30000) {
  return waitFor(() => {
    const inbox = q(h, "inbox", { message_ts: ts })[0];
    const t = inbox && q(h, "tickets", { inbox_id: inbox.id })[0];
    const rep = t && q(h, "outbox", { action_key: `reply:ticket:${t.id}` })[0];
    return t?.receipt_status === "committed" && rep && rep.status !== "pending" ? t : undefined;
  }, ms, "ticket done");
}
export async function approvalPosted(h: any, ts: string, ms = 15000) {
  return waitFor(() => {
    const inbox = q(h, "inbox", { message_ts: ts })[0];
    const a = inbox && q(h, "approval_requests", { inbox_id: inbox.id })[0];
    return a?.status === "awaiting_approval" && a.message_ts ? a : undefined;
  }, ms, "approval posted");
}
export const inboxSettled = (h: any, ts: string, ms = 10000) => waitFor(() => { const i = q(h, "inbox", { message_ts: ts })[0]; return i && !["received", "processing"].includes(i.status) ? i : undefined; }, ms, "inbox settled");

export interface Result { id: string; observed: Record<string, unknown>; verdict: "PASS" | "FAIL" | "INCONCLUSIVE"; note?: string }
export function save(r: Result) {
  writeFileSync(`${BLIND}/results/${r.id}.json`, `${JSON.stringify({ ...r, observed_at: new Date().toISOString() }, null, 2)}\n`);
  console.log(JSON.stringify({ id: r.id, verdict: r.verdict, note: r.note }));
}
