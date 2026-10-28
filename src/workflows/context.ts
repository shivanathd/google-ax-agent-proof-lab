// What every workflow step receives from the worker runtime, plus the shared receipt and reply helpers.
import { createHash } from "node:crypto";
import { audit, enqueueOutbox, finishInbox, type DB } from "../ledger/db.ts";
import { envelope, SYSTEM_ACTOR, type ActionEnvelope } from "../policy/index.ts";
import { getObjectText, putReceipt } from "../adapters/floci/ops.ts";
import type { FlociClients } from "../adapters/floci/clients.ts";
import type { WorkerConfig } from "../worker/config.ts";
import type { InboxRow } from "../worker/worker.ts";
import { DRIVER } from "./scripted.ts";

export interface Ctx {
  cfg: WorkerConfig;
  db: DB;
  floci?: FlociClients & { queueUrl: string; bucket: string };
  kick: () => void;
  now: () => number;
}

export interface ReplyPayload { channel: string; thread_ts: string; text: string; blocks?: object[]; meta?: Record<string, unknown> }
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Stable JSON (sorted keys) so a receipt hash depends only on content.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// Replies are outbox rows written in the caller's transaction; the publisher sends them later.
export function reply(ctx: Ctx, t: { tenant_id: string; installation_id: string }, actionKey: string, p: ReplyPayload) {
  enqueueOutbox(ctx.db, { run_id: ctx.cfg.run_id, tenant_id: t.tenant_id, installation_id: t.installation_id, action_key: actionKey, kind: "slack.reply", payload: { ...p, text: `[${DRIVER.mode}] ${p.text}` } });
}

export function recordAction(ctx: Ctx, env: ActionEnvelope, result: object) {
  return ctx.db
    .prepare("INSERT INTO actions (run_id, tenant_id, action_key, action_id, operation, envelope, result, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .run(env.run_id, env.tenant_id, env.idempotency_key, env.action_id, env.operation, JSON.stringify(env), JSON.stringify(result), env.requested_at).changes === 1;
}

// Receipt body binds the subject action id and a hash of its input; the receipt hash covers both.
export function receiptBody(ctx: Ctx, r: { kind: string; tenant_id: string; subject_action_id: string; subject_id: string; input: object }) {
  const body = canonical({ schema_version: 1, mode: DRIVER.mode, run_id: ctx.cfg.run_id, ...r, input_sha256: sha256(canonical(r.input)) });
  return { body, sha: sha256(body), key: `receipts/${r.tenant_id}/${r.kind}-${r.subject_id}.json` };
}

// Bounded retries of an idempotent PUT (same key, same bytes). After a failure we read back first, so an
// ambiguous write that actually landed is recognised instead of being blindly repeated.
export async function putWithRetries(ctx: Ctx, tenant_id: string, subject_action_id: string, key: string, body: string): Promise<ActionEnvelope | undefined> {
  const f = ctx.floci!;
  const { env } = envelope(ctx.db, {
    run_id: ctx.cfg.run_id, tenant_id, actor_id: SYSTEM_ACTOR, connection_ref: "local:floci", operation: "receipt.put",
    idempotency_key: `receipt.put:${key}`, input: { bucket: f.bucket, key, sha256: sha256(body), subject_action_id },
  });
  for (let attempt = 1; attempt <= ctx.cfg.max_retries + 1; attempt++) {
    try {
      await putReceipt(f, env, body);
      return env;
    } catch (e) {
      audit(ctx.db, ctx.cfg.run_id, tenant_id, "receipt_put_failed", { key, attempt, error: (e as Error).name });
      const existing = await getObjectText(f, f.bucket, key).catch(() => undefined);
      if (existing !== undefined && sha256(existing) === sha256(body)) {
        audit(ctx.db, ctx.cfg.run_id, tenant_id, "receipt_reconciled", { key });
        return env;
      }
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  return undefined;
}

// A refused or invalid request: audit why, tell the requester in-thread, change nothing else.
export function denyRequest(ctx: Ctx, row: InboxRow, operation: string, reason: string) {
  audit(ctx.db, row.run_id, row.tenant_id, "request_denied", { inbox_id: row.id, operation, reason });
  reply(ctx, row, `reply:deny:${row.id}`, { channel: row.channel_id, thread_ts: row.thread_ts ?? row.message_ts, text: `Not performed (${operation}): ${reason}. Nothing was changed.` });
  finishInbox(ctx.db, row.id, "denied", reason);
}
