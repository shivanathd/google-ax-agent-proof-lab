// Read-only views for the teaching console. The transcript comes from Emulate's own state through the
// observer's reader token (conversations.history/replies only); state comes from a read-only ledger handle
// and an S3 listing with the collector's reader credentials. Output is a sanitized projection: names,
// text, timestamps and button labels — never tokens, signing secrets, auth records or simulator routes.
import { existsSync } from "node:fs";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { guardAwsClient } from "../config/endpoints.ts";
import type { RunHandle } from "../config/lifecycle.ts";
import { slackClient } from "../adapters/slack/client.ts";
import { openReadOnly, rows } from "../ledger/read.ts";
import { COLLECTOR_AWS } from "../evaluator/collect-case.ts";

export interface TranscriptMessage { ts: string; thread_ts: string | null; author: string; bot: boolean; text: string; buttons: string[]; replies: TranscriptMessage[] }
export interface Transcript { workspace: string; channel: string; read_via: string; messages: TranscriptMessage[] }

const names = (h: RunHandle) => {
  const out = new Map<string, string>();
  for (const w of h.workspaces) for (const [name, id] of Object.entries(w.users)) out.set(id, name);
  return out;
};

function project(m: Record<string, any>, who: Map<string, string>, bot: string): Omit<TranscriptMessage, "replies"> {
  const isBot = Boolean(m.bot_id) || m.user === bot;
  const author = isBot ? "LabBot (scripted worker)" : who.get(m.user) ?? "unknown user";
  const text = String(m.text ?? "").replace(/<@([A-Z0-9_]+)>/g, (_, id: string) => `@${id === bot ? "LabBot" : who.get(id) ?? "user"}`);
  const buttons = (m.blocks ?? []).flatMap((b: any) => (b.elements ?? []).filter((e: any) => e.type === "button").map((e: any) => String(e.text?.text ?? "button")));
  return { ts: String(m.ts), thread_ts: m.thread_ts ? String(m.thread_ts) : null, author, bot: isBot, text, buttons };
}

// Workspace A's channel, oldest first, with each thread's replies nested under its root.
export async function readTranscript(h: RunHandle, tenant = "T_LAB_A"): Promise<Transcript> {
  const w = h.workspaces.find((x) => x.tenant_id === tenant);
  if (!w) throw new Error(`no workspace ${tenant}`);
  const call = slackClient({ baseUrl: w.url, token: w.tokens.reader, allowlist: h.manifest.config.endpoint_allowlist, timeoutMs: 3000 });
  const hist = await call("conversations.history", { channel: w.channel_id, limit: 200 });
  if (!hist.ok) throw new Error(`conversations.history: ${hist.error}`);
  const who = names(h);
  const roots = (hist.messages as any[]).filter((m) => !m.thread_ts || m.thread_ts === m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
  const messages: TranscriptMessage[] = [];
  for (const m of roots) {
    const r = await call("conversations.replies", { channel: w.channel_id, ts: m.ts });
    const replies = r.ok ? (r.messages as any[]).filter((x) => x.ts !== m.ts).sort((a, b) => Number(a.ts) - Number(b.ts)) : [];
    messages.push({ ...project(m, who, w.bot_user_id), replies: replies.map((x) => ({ ...project(x, who, w.bot_user_id), replies: [] })) });
  }
  return { workspace: "Lab Alpha (fictional)", channel: "#lab-ops", read_via: "observer reader token: conversations.history + conversations.replies", messages };
}

export interface StateSnapshot { label: string; rows: { key: string; value: string }[] }

// Business state the scenarios touch, read without write access.
export async function readState(h: RunHandle, label: string): Promise<StateSnapshot> {
  const out: { key: string; value: string }[] = [];
  if (existsSync(h.manifest.db_path)) {
    const db = openReadOnly(h.manifest.db_path);
    try {
      const tickets = rows(db, "tickets");
      out.push({ key: "Tickets", value: String(tickets.length) });
      out.push({ key: "Ticket receipts committed (ledger)", value: String(tickets.filter((t) => t.receipt_status === "committed").length) });
      const inbox = rows(db, "inbox");
      out.push({ key: "Accepted Slack events (inbox)", value: String(inbox.length) });
      out.push({ key: "Event deliveries (incl. retries)", value: String(inbox.reduce((n, r) => n + Number(r.delivery_count ?? 1), 0)) });
      const approvals = rows(db, "approval_requests");
      out.push({ key: "Approval requests", value: approvals.length ? approvals.map((a) => a.status).join(", ") : "none" });
      out.push({ key: "Business actions recorded", value: String(rows(db, "actions").length) });
      const cedar = rows(db, "crm_accounts", { tenant_id: "T_LAB_A", account_id: "acct-cedar" })[0];
      if (cedar) out.push({ key: "CRM Cedar Grove Demo (version)", value: `v${cedar.version}` });
    } finally {
      db.close();
    }
  }
  if (h.workspaces.length) {
    const t = await readTranscript(h);
    out.push({ key: "LabBot replies (emulator, reader token)", value: String(t.messages.flatMap((m) => [m, ...m.replies]).filter((m) => m.bot).length) });
  }
  if (h.floci) {
    const s3 = guardAwsClient(new S3Client({ endpoint: h.flociEndpoint, region: "us-east-1", forcePathStyle: true, credentials: COLLECTOR_AWS, maxAttempts: 1 }), h.manifest.config.endpoint_allowlist);
    try {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: h.floci.bucket }));
      out.push({ key: "S3 receipt objects", value: String(r.Contents?.length ?? 0) });
    } finally {
      s3.destroy();
    }
  }
  return { label, rows: out };
}
