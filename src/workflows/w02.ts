// W02 operations approval: requested → awaiting_approval → approved | rejected | expired (one terminal step).
// Authority is re-checked when the button is clicked: current grant, not the requester, same tenant,
// unexpired, and the button's request digest must equal the current request. No payment is ever executed.
import { audit, finishInbox } from "../ledger/db.ts";
import { ContractError } from "../contracts/validate.ts";
import { envelope } from "../policy/index.ts";
import type { Installation } from "../http/slack.ts";
import type { InboxRow } from "../worker/worker.ts";
import { canonical, denyRequest, putWithRetries, receiptBody, recordAction, reply, sha256, type Ctx } from "./context.ts";

export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

interface Approval {
  id: string; tenant_id: string; installation_id: string; requester_id: string; item: string; amount_cents: number; request_digest: string;
  version: number; status: string; channel_id: string; thread_ts: string; message_ts: string | null; expires_at: string | null;
  approver_id: string | null; action_id: string | null; receipt_status: string | null;
}

const digest = (a: Pick<Approval, "id" | "tenant_id" | "requester_id" | "item" | "amount_cents" | "version">) =>
  sha256(canonical({ id: a.id, tenant_id: a.tenant_id, requester_id: a.requester_id, item: a.item, amount_cents: a.amount_cents, version: a.version }));
const get = (ctx: Ctx, id: string, tenant: string) => ctx.db.prepare("SELECT * FROM approval_requests WHERE id = ? AND tenant_id = ?").get(id, tenant) as Approval | undefined;

function postButtons(ctx: Ctx, a: Approval) {
  const value = `${a.id}:${a.request_digest}`;
  const text = `Approval requested by <@${a.requester_id}>: ${a.item}, ${a.amount_cents} cents. Request ${a.id} v${a.version}. No payment will be executed.`;
  reply(ctx, a, `reply:approval:${a.id}:v${a.version}`, {
    channel: a.channel_id, thread_ts: a.thread_ts, text, meta: { approval_id: a.id, version: a.version },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [
        { type: "button", action_id: "approval.approve", text: { type: "plain_text", text: "Approve" }, value },
        { type: "button", action_id: "approval.reject", text: { type: "plain_text", text: "Reject" }, value },
      ] },
    ],
  });
}

export function onRequest(ctx: Ctx, row: InboxRow, p: { amount_cents: number; item: string }) {
  const { env, decision } = envelope(ctx.db, {
    run_id: row.run_id, tenant_id: row.tenant_id, actor_id: row.actor_id, connection_ref: `local:slack:${row.installation_id}`,
    operation: "approval.request", idempotency_key: `approval.request:${row.installation_id}:${row.event_id}`, input: { item: p.item, amount_cents: p.amount_cents },
  });
  if (decision.decision === "deny") return denyRequest(ctx, row, "approval.request", decision.reason);
  const a = {
    id: `apr-${sha256(`${row.installation_id}:${row.event_id}`).slice(0, 12)}`, tenant_id: row.tenant_id, installation_id: row.installation_id,
    requester_id: row.actor_id, item: p.item, amount_cents: p.amount_cents, version: 1, status: "requested",
    channel_id: row.channel_id, thread_ts: row.thread_ts ?? row.message_ts,
  };
  const full = { ...a, request_digest: digest(a), message_ts: null, expires_at: null, approver_id: null, action_id: env.action_id, receipt_status: null };
  ctx.db.prepare(
    `INSERT INTO approval_requests (id, run_id, tenant_id, installation_id, inbox_id, requester_id, item, amount_cents, request_digest, version, status, channel_id, thread_ts, action_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(a.id, row.run_id, a.tenant_id, a.installation_id, row.id, a.requester_id, a.item, a.amount_cents, full.request_digest, 1, "requested", a.channel_id, a.thread_ts, env.action_id, env.requested_at);
  recordAction(ctx, env, { approval_id: a.id });
  postButtons(ctx, full);
  finishInbox(ctx.db, row.id, "done");
}

// Requester edits the amount: version and digest change, so any earlier button is stale (W02-C).
export function onEdit(ctx: Ctx, row: InboxRow, p: { ref: string; amount_cents: number }) {
  const a = get(ctx, p.ref, row.tenant_id);
  if (!a) return denyRequest(ctx, row, "approval.request", "not_found");
  if (a.requester_id !== row.actor_id) return denyRequest(ctx, row, "approval.request", "not_requester");
  if (a.status !== "requested" && a.status !== "awaiting_approval") return denyRequest(ctx, row, "approval.request", "not_pending");
  const { decision } = envelope(ctx.db, {
    run_id: row.run_id, tenant_id: row.tenant_id, actor_id: row.actor_id, connection_ref: `local:slack:${row.installation_id}`,
    operation: "approval.request", idempotency_key: `approval.edit:${row.installation_id}:${row.event_id}`, input: { item: a.item, amount_cents: p.amount_cents },
  });
  if (decision.decision === "deny") return denyRequest(ctx, row, "approval.request", decision.reason);
  const next = { ...a, amount_cents: p.amount_cents, version: a.version + 1 };
  next.request_digest = digest(next);
  const changed = ctx.db
    .prepare("UPDATE approval_requests SET amount_cents = ?, version = ?, request_digest = ? WHERE id = ? AND version = ? AND status IN ('requested','awaiting_approval')")
    .run(next.amount_cents, next.version, next.request_digest, a.id, a.version).changes;
  if (changed !== 1) return denyRequest(ctx, row, "approval.request", "concurrent_change");
  audit(ctx.db, row.run_id, row.tenant_id, "approval_edited", { approval_id: a.id, old_digest: a.request_digest, new_digest: next.request_digest });
  postButtons(ctx, next);
  finishInbox(ctx.db, row.id, "done");
}

// Called once the button message is confirmed posted; the expiry clock starts here.
export function onButtonPosted(ctx: Ctx, meta: { approval_id: string; version: number }, ts: string) {
  const ttl = ctx.cfg.approval_ttl_ms ?? DEFAULT_APPROVAL_TTL_MS;
  ctx.db.prepare(
    "UPDATE approval_requests SET status = 'awaiting_approval', message_ts = ?, expires_at = ? WHERE id = ? AND version = ? AND status IN ('requested','awaiting_approval')",
  ).run(ts, new Date(ctx.now() + ttl).toISOString(), meta.approval_id, meta.version);
}

export function onBlockAction(ctx: Ctx, inst: Installation, payload: Record<string, any>) {
  const action = payload.actions?.[0];
  if (!action || !/^approval\.(approve|reject)$/.test(action.action_id)) return audit(ctx.db, ctx.cfg.run_id, inst.tenant_id, "block_action_unhandled", {});
  const actor = String(payload.user?.id ?? "");
  const [id = "", clickedDigest = ""] = String(action.value ?? "").split(":");
  // Lookup is scoped to the verified installation's tenant: another workspace's request does not exist here.
  const a = get(ctx, id, inst.tenant_id);
  const deny = (reason: string) => {
    audit(ctx.db, ctx.cfg.run_id, inst.tenant_id, "approval_denied", { approval_id: a ? a.id : null, actor_id: actor, reason });
    if (a) reply(ctx, a, `reply:approval-denied:${a.id}:${action.action_ts}`, { channel: a.channel_id, thread_ts: a.thread_ts, text: `Approval action by <@${actor}> refused: ${reason}. Status unchanged.` });
    ctx.kick();
  };
  if (!a) return deny("not_found"); // no reply: nothing about other tenants is disclosed
  const resolution = action.action_id === "approval.approve" ? "approved" : "rejected";
  let env, decision;
  try {
    ({ env, decision } = envelope(ctx.db, {
      run_id: ctx.cfg.run_id, tenant_id: inst.tenant_id, actor_id: actor, connection_ref: `local:slack:${inst.installation_id}`,
      operation: "approval.resolve", idempotency_key: `approval.resolve:${a.id}`, approval_ref: a.id, requester_id: a.requester_id,
      input: { approval_id: a.id, request_digest: clickedDigest, resolution },
    }));
  } catch (e) {
    if (e instanceof ContractError) return deny("invalid_input");
    throw e;
  }
  if (decision.decision === "deny") return deny(decision.reason);
  if (a.status !== "awaiting_approval") return deny("not_pending");
  if (!a.expires_at || ctx.now() > Date.parse(a.expires_at)) {
    const expired = ctx.db.prepare("UPDATE approval_requests SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'awaiting_approval'").run(new Date(ctx.now()).toISOString(), a.id).changes;
    audit(ctx.db, ctx.cfg.run_id, a.tenant_id, "approval_expired", { approval_id: a.id, actor_id: actor });
    if (expired) reply(ctx, a, `reply:approval-expired:${a.id}`, { channel: a.channel_id, thread_ts: a.thread_ts, text: `Request ${a.id} expired before it was approved. Nothing was approved.` });
    return ctx.kick();
  }
  if (clickedDigest !== a.request_digest) return deny("stale_request_digest");
  const won = ctx.db.transaction(() => {
    const changed = ctx.db
      .prepare("UPDATE approval_requests SET status = ?, approver_id = ?, resolved_at = ?, action_id = ?, receipt_status = 'pending' WHERE id = ? AND status = 'awaiting_approval' AND request_digest = ?")
      .run(resolution, actor, env.requested_at, env.action_id, a.id, a.request_digest).changes;
    if (changed !== 1) return false;
    recordAction(ctx, env, { approval_id: a.id, resolution });
    audit(ctx.db, ctx.cfg.run_id, a.tenant_id, "approval_resolved", { approval_id: a.id, resolution, approver_id: actor });
    return true;
  })();
  if (!won) return deny("not_pending");
  void ensureReceipt(ctx, a.id, a.tenant_id);
}

const inFlight = new Set<string>();

export async function ensureReceipt(ctx: Ctx, id: string, tenant: string) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const a = get(ctx, id, tenant);
    if (!a || a.receipt_status === "committed" || (a.status !== "approved" && a.status !== "rejected")) return;
    const r = receiptBody(ctx, {
      kind: "approval", tenant_id: a.tenant_id, subject_action_id: a.action_id!, subject_id: a.id,
      input: { approval_id: a.id, request_digest: a.request_digest, resolution: a.status, approver_id: a.approver_id, requester_id: a.requester_id, item: a.item, amount_cents: a.amount_cents },
    });
    const env = await putWithRetries(ctx, a.tenant_id, a.action_id!, r.key, r.body);
    ctx.db.transaction(() => {
      if (!env) {
        ctx.db.prepare("UPDATE approval_requests SET receipt_status = 'failed', receipt_attempts = receipt_attempts + 1 WHERE id = ? AND receipt_status = 'pending'").run(a.id);
        return audit(ctx.db, ctx.cfg.run_id, a.tenant_id, "receipt_incomplete", { approval_id: a.id });
      }
      const ok = ctx.db
        .prepare("UPDATE approval_requests SET receipt_status = 'committed', receipt_key = ?, receipt_sha256 = ?, receipt_attempts = receipt_attempts + 1 WHERE id = ? AND receipt_status = 'pending'")
        .run(r.key, r.sha, a.id).changes === 1;
      if (!ok) return;
      recordAction(ctx, env, { approval_id: a.id, receipt_sha256: r.sha });
      reply(ctx, a, `reply:approval-resolved:${a.id}`, {
        channel: a.channel_id, thread_ts: a.thread_ts, text: `Request ${a.id} ${a.status} by <@${a.approver_id}>. Receipt ${r.sha.slice(0, 12)}. No payment was executed.`,
      });
    })();
  } finally {
    inFlight.delete(id);
    ctx.kick();
  }
}

export async function recover(ctx: Ctx) {
  for (const { id, tenant_id } of ctx.db.prepare("SELECT id, tenant_id FROM approval_requests WHERE status IN ('approved','rejected') AND receipt_status IN ('pending','failed')").all() as { id: string; tenant_id: string }[]) {
    ctx.db.prepare("UPDATE approval_requests SET receipt_status = 'pending' WHERE id = ? AND receipt_status = 'failed'").run(id);
    audit(ctx.db, ctx.cfg.run_id, tenant_id, "receipt_recovery", { approval_id: id });
    await ensureReceipt(ctx, id, tenant_id);
  }
}
