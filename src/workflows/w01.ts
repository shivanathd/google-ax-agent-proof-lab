// W01 service request: Slack mention → SQS job → one ticket → S3 receipt → completion reply.
// The completion reply is written only in the transaction that marks the receipt committed.
import type { Message } from "@aws-sdk/client-sqs";
import { audit, enqueueOutbox, finishInbox } from "../ledger/db.ts";
import { assertAllowed, envelope, type ActionEnvelope } from "../policy/index.ts";
import { deleteJob } from "../adapters/floci/ops.ts";
import type { InboxRow } from "../worker/worker.ts";
import { denyRequest, putWithRetries, receiptBody, recordAction, reply, type Ctx } from "./context.ts";

interface Job { envelope: ActionEnvelope; installation_id: string; inbox_id: number; channel: string; thread_ts: string }
interface Ticket {
  id: number; tenant_id: string; installation_id: string; action_key: string; action_id: string; requester_id: string;
  summary: string; channel_id: string; thread_ts: string; receipt_status: string; created_at: string; inbox_id: number;
}

export function onRequest(ctx: Ctx, row: InboxRow, summary: string) {
  const { env, decision } = envelope(ctx.db, {
    run_id: row.run_id, tenant_id: row.tenant_id, actor_id: row.actor_id, connection_ref: "local:floci", operation: "ticket.create",
    idempotency_key: `ticket.create:${row.installation_id}:${row.event_id}`, input: { summary, source_event_id: row.event_id },
  });
  if (decision.decision === "deny") return denyRequest(ctx, row, "ticket.create", decision.reason);
  const job: Job = { envelope: env, installation_id: row.installation_id, inbox_id: row.id, channel: row.channel_id, thread_ts: row.thread_ts ?? row.message_ts };
  enqueueOutbox(ctx.db, { run_id: row.run_id, tenant_id: row.tenant_id, installation_id: row.installation_id, action_key: `sqs.send:${env.idempotency_key}`, kind: "sqs.send", payload: job });
  audit(ctx.db, row.run_id, row.tenant_id, "job_enqueued", { inbox_id: row.id, action_key: env.idempotency_key });
  finishInbox(ctx.db, row.id, "done");
}

// SQS consumer step. A redelivered job finds its ticket by the unique action key and creates nothing new.
export async function onJob(ctx: Ctx, msg: Message) {
  const job = JSON.parse(msg.Body!) as Job;
  const env = job.envelope;
  assertAllowed(env, "ticket.create");
  const ticketId = ctx.db.transaction(() => {
    const ins = ctx.db
      .prepare(
        `INSERT INTO tickets (run_id, tenant_id, installation_id, action_key, action_id, inbox_id, requester_id, summary, channel_id, thread_ts, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'open',?) ON CONFLICT (run_id, tenant_id, action_key) DO NOTHING RETURNING id`,
      )
      .get(env.run_id, env.tenant_id, job.installation_id, env.idempotency_key, env.action_id, job.inbox_id, env.actor_id,
        (env.input as { summary: string }).summary, job.channel, job.thread_ts, env.requested_at) as { id: number } | undefined;
    if (ins) {
      recordAction(ctx, env, { ticket_id: ins.id });
      audit(ctx.db, env.run_id, env.tenant_id, "ticket_created", { ticket_id: ins.id, action_key: env.idempotency_key });
      return ins.id;
    }
    const existing = ctx.db.prepare("SELECT id FROM tickets WHERE run_id = ? AND tenant_id = ? AND action_key = ?").get(env.run_id, env.tenant_id, env.idempotency_key) as { id: number };
    audit(ctx.db, env.run_id, env.tenant_id, "duplicate_job", { ticket_id: existing.id, receive_count: Number(msg.Attributes?.ApproximateReceiveCount ?? 0) || null });
    return existing.id;
  })();
  await ensureReceipt(ctx, ticketId);
  try {
    await deleteJob(ctx.floci!, ctx.floci!.queueUrl, msg.ReceiptHandle!);
  } catch (e) {
    // The message becomes visible again and is redelivered; the unique action key absorbs it (W01-Q).
    audit(ctx.db, env.run_id, env.tenant_id, "ack_failed", { ticket_id: ticketId, error: (e as Error).name });
  }
}

const inFlight = new Set<number>();

export async function ensureReceipt(ctx: Ctx, ticketId: number) {
  if (inFlight.has(ticketId)) return;
  inFlight.add(ticketId);
  try {
    const t = ctx.db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId) as Ticket | undefined;
    if (!t || t.receipt_status === "committed") return;
    const r = receiptBody(ctx, {
      kind: "ticket", tenant_id: t.tenant_id, subject_action_id: t.action_id, subject_id: String(t.id),
      input: { summary: t.summary, requester_id: t.requester_id, action_key: t.action_key, created_at: t.created_at },
    });
    const env = await putWithRetries(ctx, t.tenant_id, t.action_id, r.key, r.body);
    ctx.db.transaction(() => {
      if (!env) {
        ctx.db.prepare("UPDATE tickets SET receipt_status = 'failed', receipt_attempts = receipt_attempts + 1 WHERE id = ? AND receipt_status = 'pending'").run(t.id);
        audit(ctx.db, ctx.cfg.run_id, t.tenant_id, "receipt_incomplete", { ticket_id: t.id, recovery: "retried on worker restart" });
        return;
      }
      const won = ctx.db
        .prepare("UPDATE tickets SET receipt_status = 'committed', receipt_key = ?, receipt_sha256 = ?, receipt_attempts = receipt_attempts + 1 WHERE id = ? AND receipt_status = 'pending'")
        .run(r.key, r.sha, t.id).changes === 1;
      if (!won) return;
      recordAction(ctx, env, { ticket_id: t.id, receipt_sha256: r.sha });
      reply(ctx, t, `reply:ticket:${t.id}`, { channel: t.channel_id, thread_ts: t.thread_ts, text: `Ticket #${t.id} created: ${t.summary}. Receipt ${r.sha.slice(0, 12)}.` });
    })();
  } finally {
    inFlight.delete(ticketId);
    ctx.kick();
  }
}

// Explicit recovery (worker start): incomplete receipts are retried; the reply still waits for the commit.
export async function recover(ctx: Ctx) {
  for (const { id, tenant_id } of ctx.db.prepare("SELECT id, tenant_id FROM tickets WHERE receipt_status IN ('pending','failed')").all() as { id: number; tenant_id: string }[]) {
    ctx.db.prepare("UPDATE tickets SET receipt_status = 'pending' WHERE id = ? AND receipt_status = 'failed'").run(id);
    audit(ctx.db, ctx.cfg.run_id, tenant_id, "receipt_recovery", { ticket_id: id });
    await ensureReceipt(ctx, id);
  }
}
