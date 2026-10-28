// Worker runtime: claims accepted inbox rows, runs their business step in one transaction that also
// writes the outbox, publishes the outbox, and consumes the SQS job queue. Ambiguous remote outcomes
// become UNKNOWN and are never blindly retried.
import { slackClient, SlackTransportError, type SlackCall } from "../adapters/slack/client.ts";
import { EndpointRejected } from "../config/endpoints.ts";
import { flociClients } from "../adapters/floci/clients.ts";
import { receiveJobs, sendJob } from "../adapters/floci/ops.ts";
import { audit, claimInbox, isRevoked, settleOutbox, type DB } from "../ledger/db.ts";
import { handleEvent, w01, w02 } from "../workflows/index.ts";
import type { Ctx } from "../workflows/context.ts";
import type { Installation } from "../http/slack.ts";
import type { WorkerConfig } from "./config.ts";

export interface InboxRow {
  id: number; run_id: string; tenant_id: string; installation_id: string; event_id: string; actor_id: string;
  channel_id: string; message_ts: string; thread_ts: string | null; text: string; status: string;
}
export interface OutboxRow { id: number; tenant_id: string; installation_id: string; action_key: string; kind: string; payload: string; attempts: number }

export async function createWorker(cfg: WorkerConfig, db: DB) {
  const onReject = (tenant: string | null) => (r: { kind: string }) => audit(db, cfg.run_id, tenant, r.kind, r);
  const slack = new Map<string, SlackCall>(
    cfg.installations.map((i) => [i.installation_id, slackClient({ baseUrl: i.api_url, token: i.bot_token, allowlist: cfg.allowlist, timeoutMs: cfg.slack_timeout_ms, onReject: onReject(i.tenant_id) })]),
  );
  for (const i of cfg.installations) db.prepare("INSERT OR IGNORE INTO installations (installation_id, tenant_id) VALUES (?, ?)").run(i.installation_id, i.tenant_id);
  const floci = cfg.floci
    ? { ...(await flociClients(cfg.floci.endpoint, cfg.allowlist, onReject(null))), queueUrl: cfg.floci.queue_url, bucket: cfg.floci.bucket }
    : undefined;
  const ctx: Ctx = { cfg, db, floci, kick: () => kick(), now: () => Date.now() };

  function processInbox(id: number) {
    try {
      db.transaction(() => {
        if (claimInbox(db, id)) handleEvent(ctx, db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxRow);
      })();
    } catch (e) {
      db.prepare("UPDATE inbox SET status = 'failed', reason = ? WHERE id = ? AND status IN ('received','processing')").run(String((e as Error).message).slice(0, 200), id);
      audit(db, cfg.run_id, null, "inbox_failed", { inbox_id: id });
    }
  }

  async function publish(row: OutboxRow) {
    const settle = (status: "sent" | "failed" | "unknown", result: object) => {
      settleOutbox(db, row.id, status, result);
      if (status !== "sent") audit(db, cfg.run_id, row.tenant_id, `outbox_${status}`, { outbox_id: row.id, action_key: row.action_key, ...result });
    };
    // Only a not-delivered transport failure is retried; an endpoint-policy rejection is final.
    const retryOrFail = (e: unknown, ambiguous: boolean) => {
      if (!ambiguous && !(e instanceof EndpointRejected) && row.attempts < cfg.max_retries) db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(row.id);
      else settle(ambiguous ? "unknown" : "failed", { error: (e as Error).message });
    };
    const payload = JSON.parse(row.payload);
    if (row.kind === "sqs.send") {
      if (!floci) return settle("failed", { error: "floci_not_configured" });
      // Re-sending after an ambiguous SendMessage is safe: the consumer dedupes on the ticket action key.
      try {
        const r = await sendJob(floci!, floci!.queueUrl, row.payload);
        settle("sent", { message_id: r.MessageId });
      } catch (e) {
        retryOrFail(e, false);
      }
      return;
    }
    if (isRevoked(db, row.installation_id)) return settle("failed", { error: "installation_revoked" });
    const { meta, ...message } = payload;
    try {
      const r = await slack.get(row.installation_id)!("chat.postMessage", message);
      // A provider refusal (e.g. missing_scope) is final: there is no broader credential to escalate to.
      settle(r.ok ? "sent" : "failed", r.ok ? { ts: r.ts, channel: r.channel } : { error: r.error, needed: r.needed ?? null });
      if (r.ok && meta?.approval_id) w02.onButtonPosted(ctx, meta, r.ts);
    } catch (e) {
      // Sent but no response (timeout/5xx) is UNKNOWN: the reply may exist, so it is never re-posted.
      retryOrFail(e, e instanceof SlackTransportError && e.ambiguous);
    }
  }

  let draining = false;
  let again = false;
  async function drain() {
    if (draining) return void (again = true);
    draining = true;
    try {
      do {
        again = false;
        for (const { id } of db.prepare("SELECT id FROM inbox WHERE status = 'received' ORDER BY id").all() as { id: number }[]) processInbox(id);
        for (const row of db.prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id").all() as OutboxRow[]) await publish(row);
      } while (again);
    } finally {
      draining = false;
    }
  }
  const kick = () => void drain().catch((e) => audit(db, cfg.run_id, null, "drain_error", { error: String(e) }));
  const timer = setInterval(kick, 250);

  let stopped = false;
  async function consume() {
    while (!stopped && floci) {
      try {
        for (const msg of await receiveJobs(floci, floci.queueUrl)) await w01.onJob(ctx, msg);
      } catch (e) {
        audit(db, cfg.run_id, null, "consume_error", { error: (e as Error).name });
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async function start() {
    if (floci) {
      await w01.recover(ctx);
      await w02.recover(ctx);
    }
    kick();
    void consume();
  }

  const onBlockAction = (inst: Installation, payload: Record<string, any>) => w02.onBlockAction(ctx, inst, payload);
  return { start, kick, onAccepted: kick, onBlockAction, stop: () => ((stopped = true), clearInterval(timer)) };
}
