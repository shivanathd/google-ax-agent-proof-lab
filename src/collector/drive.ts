// Coordinator-side stimulus helpers (test coordinator role): post as fictional users, click buttons through the
// emulator simulator, and wait on the ledger through a read-only connection. Never used by the collector.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "../config/run-config.ts";
import { slackClient } from "../adapters/slack/client.ts";
import { simulate, type Workspace } from "../adapters/slack/emulator.ts";
import { openReadOnly, rows, type Table } from "../ledger/read.ts";
import type { RunHandle } from "../config/lifecycle.ts";

export const STIMULI = JSON.parse(readFileSync(join(ROOT, "fixtures/cases/cases.json"), "utf8"));
export const stimulus = (id: string, n: number | string = 1) => String(STIMULI[id].text).replace("{n}", String(n));

export const ws = (h: RunHandle, tenant = "T_LAB_A") => h.workspaces.find((w) => w.tenant_id === tenant)!;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export async function post(h: RunHandle, w: Workspace, token: string, body: object) {
  const r = await slackClient({ baseUrl: w.url, token, allowlist: h.manifest.config.endpoint_allowlist })("chat.postMessage", { channel: w.channel_id, ...body });
  if (!r.ok) throw new Error(`chat.postMessage failed: ${r.error}`);
  return r.ts as string;
}
export const mention = (h: RunHandle, w: Workspace, user: string, text: string, thread_ts?: string) =>
  post(h, w, w.tokens.users[user]!, { text: `<@${w.bot_user_id}> ${text}`, ...(thread_ts ? { thread_ts } : {}) });

export const click = async (w: Workspace, message_ts: string, user: string, action_id = "approval.approve") => {
  const r = await simulate(w, "block-actions", { channel: w.channel_id, message_ts, action_id, user });
  if (!r.ok) throw new Error(`block-actions simulate failed: ${r.error}`);
};

// Fresh read-only connection per query: the coordinator never holds a writable ledger handle here.
export function q(h: RunHandle, table: Table, where: Record<string, string | number> = {}) {
  const db = openReadOnly(h.manifest.db_path);
  try {
    return rows(db, table, where);
  } finally {
    db.close();
  }
}
export const inboxOf = (h: RunHandle, ts: string) => q(h, "inbox", { message_ts: ts })[0];

export async function ticketDone(h: RunHandle, ts: string, ms = 30000) {
  return waitFor(() => {
    const inbox = inboxOf(h, ts);
    const t = inbox && q(h, "tickets", { inbox_id: inbox.id })[0];
    const reply = t && q(h, "outbox", { action_key: `reply:ticket:${t.id}` })[0];
    return t?.receipt_status === "committed" && reply && reply.status !== "pending" ? t : undefined;
  }, ms, "ticket receipt committed and completion reply published");
}

export async function requestApproval(h: RunHandle, w: Workspace, user: string, text: string) {
  const ts = await mention(h, w, user, text);
  const a = await waitFor(() => {
    const inbox = inboxOf(h, ts);
    const row = inbox && q(h, "approval_requests", { inbox_id: inbox.id })[0];
    return row?.status === "awaiting_approval" && row.message_ts ? row : undefined;
  }, 15000, "approval button posted");
  return { ts, a };
}

export const denials = (h: RunHandle, id: string) =>
  q(h, "run_audit").filter((r) => r.kind === "approval_denied" && JSON.parse(r.detail).approval_id === id).map((r) => JSON.parse(r.detail).reason as string);

// Runs this repository's CLI as a child process and returns its exit code and stdout (one JSON document).
export function lab(args: string[], env: Record<string, string>, cwd = ROOT): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...args], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout }));
  });
}
