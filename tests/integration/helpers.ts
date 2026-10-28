// Test-coordinator helpers. Observations go through the emulator's Web API with a separate read-only
// token and through a read-only ledger connection, never through the worker's own claims.
import { randomBytes } from "node:crypto";
import { slackClient } from "../../src/adapters/slack/client.ts";
import { sign } from "../../src/adapters/slack/signature.ts";
import { openReadOnly, rows } from "../../src/ledger/read.ts";
import type { RunHandle } from "../../src/config/lifecycle.ts";
import type { Workspace } from "../../src/adapters/slack/emulator.ts";

export const api = (h: RunHandle, ws: Workspace, token: string) => slackClient({ baseUrl: ws.url, token, allowlist: h.manifest.config.endpoint_allowlist });

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
export const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

export function ledger(h: RunHandle) {
  const db = openReadOnly(h.manifest.db_path);
  return { db, rows: (t: Parameters<typeof rows>[1], w: Record<string, string | number> = {}) => rows(db, t, w), close: () => db.close() };
}

export async function mention(h: RunHandle, ws: Workspace, user: string, text: string, thread_ts?: string) {
  const r = await api(h, ws, ws.tokens.users[user]!)("chat.postMessage", { channel: ws.channel_id, text: `<@${ws.bot_user_id}> ${text}`, ...(thread_ts ? { thread_ts } : {}) });
  if (!r.ok) throw new Error(`mention failed: ${r.error}`);
  return r.ts as string;
}

export async function thread(h: RunHandle, ws: Workspace, ts: string) {
  const r = await api(h, ws, ws.tokens.reader)("conversations.replies", { channel: ws.channel_id, ts });
  if (!r.ok) throw new Error(`replies failed: ${r.error}`);
  return r.messages as Record<string, any>[];
}
export const botReplies = async (h: RunHandle, ws: Workspace, ts: string) => (await thread(h, ws, ts)).filter((m) => m.bot_id && m.ts !== ts);

export async function history(h: RunHandle, ws: Workspace) {
  const r = await api(h, ws, ws.tokens.reader)("conversations.history", { channel: ws.channel_id, limit: 200 });
  if (!r.ok) throw new Error(`history failed: ${r.error}`);
  return r.messages as Record<string, any>[];
}

// A signed request exactly as the emulator would send it; `ts` lets tests send stale timestamps.
export function signedPost(url: string, secret: string, raw: string, o: { ts?: number; contentType?: string; signature?: string } = {}) {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  return fetch(url, {
    method: "POST", body: raw,
    headers: { "content-type": o.contentType ?? "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": o.signature ?? sign(secret, ts, raw) },
  });
}

export function eventBody(ws: Workspace, actor: string, text: string, extra: Record<string, unknown> = {}) {
  const ts = `${Math.floor(Date.now() / 1000)}.${randomBytes(3).readUIntBE(0, 3)}`;
  return JSON.stringify({
    type: "event_callback", team_id: ws.team_id, api_app_id: ws.api_app_id, event_id: `Ev${randomBytes(12).toString("hex").toUpperCase()}`,
    event: { type: "app_mention", user: actor, channel: ws.channel_id, ts, text: `<@${ws.bot_user_id}> ${text}` }, ...extra,
  });
}
export const eventsUrl = (h: RunHandle, ws: Workspace) => `http://127.0.0.1:${h.manifest.ports.worker}/slack/${ws.installation_id}/events`;
export const interactionsUrl = (h: RunHandle, ws: Workspace) => `http://127.0.0.1:${h.manifest.ports.worker}/slack/${ws.installation_id}/interactions`;
