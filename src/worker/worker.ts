// Worker runtime: claims accepted inbox rows, runs their business step in one transaction that also
// writes the outbox, then publishes the outbox. Ambiguous remote outcomes become UNKNOWN, never retried.
import { slackClient, SlackTransportError, type SlackCall } from "../adapters/slack/client.ts";
import { audit, claimInbox, enqueueOutbox, finishInbox, isRevoked, settleOutbox, type DB } from "../ledger/db.ts";
import type { Installation } from "../http/slack.ts";
import type { WorkerConfig } from "./config.ts";

export interface InboxRow {
  id: number; run_id: string; tenant_id: string; installation_id: string; event_id: string; actor_id: string;
  channel_id: string; message_ts: string; thread_ts: string | null; text: string; status: string;
}
export interface OutboxRow { id: number; tenant_id: string; installation_id: string; action_key: string; kind: string; payload: string; attempts: number }

export function createWorker(cfg: WorkerConfig, db: DB) {
  const slack = new Map<string, SlackCall>(
    cfg.installations.map((i) => [i.installation_id, slackClient({
      baseUrl: i.api_url, token: i.bot_token, allowlist: cfg.allowlist, timeoutMs: cfg.slack_timeout_ms,
      onReject: (r) => audit(db, cfg.run_id, i.tenant_id, r.kind, r),
    })]),
  );
  for (const i of cfg.installations) {
    db.prepare("INSERT OR IGNORE INTO installations (installation_id, tenant_id) VALUES (?, ?)").run(i.installation_id, i.tenant_id);
  }

  // Business step for one accepted event; runs inside the claim transaction.
  function handleEvent(row: InboxRow) {
    enqueueOutbox(db, {
      run_id: row.run_id, tenant_id: row.tenant_id, installation_id: row.installation_id, action_key: `ack:${row.id}`, kind: "slack.reply",
      payload: { channel: row.channel_id, thread_ts: row.thread_ts ?? row.message_ts, text: `Request received (ref ${row.event_id.slice(-8)}).` },
    });
    finishInbox(db, row.id, "done");
  }

  function processInbox(id: number) {
    const step = db.transaction(() => {
      if (!claimInbox(db, id)) return;
      handleEvent(db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxRow);
    });
    try {
      step();
    } catch (e) {
      db.prepare("UPDATE inbox SET status = 'failed', reason = ? WHERE id = ? AND status IN ('received','processing')").run(String((e as Error).message).slice(0, 200), id);
      audit(db, cfg.run_id, null, "inbox_failed", { inbox_id: id });
    }
    kick();
  }

  async function publish(row: OutboxRow) {
    const settle = (status: "sent" | "failed" | "unknown", result: object) => {
      settleOutbox(db, row.id, status, result);
      if (status !== "sent") audit(db, cfg.run_id, row.tenant_id, `outbox_${status}`, { outbox_id: row.id, action_key: row.action_key, ...result });
    };
    if (isRevoked(db, row.installation_id)) return settle("failed", { error: "installation_revoked" });
    const call = slack.get(row.installation_id)!;
    try {
      const r = await call("chat.postMessage", JSON.parse(row.payload));
      // A provider refusal (e.g. missing_scope) is final: there is no broader credential to escalate to.
      settle(r.ok ? "sent" : "failed", r.ok ? { ts: r.ts, channel: r.channel } : { error: r.error, needed: r.needed ?? null });
    } catch (e) {
      if (e instanceof SlackTransportError && !e.ambiguous && row.attempts < cfg.max_retries) {
        db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(row.id); // not delivered: safe to retry
      } else {
        settle(e instanceof SlackTransportError && e.ambiguous ? "unknown" : "failed", { error: (e as Error).message });
      }
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
        for (const id of (db.prepare("SELECT id FROM inbox WHERE status = 'received' ORDER BY id").all() as { id: number }[])) processInbox(id.id);
        for (const row of db.prepare("SELECT * FROM outbox WHERE status = 'pending' AND kind = 'slack.reply' ORDER BY id").all() as OutboxRow[]) await publish(row);
      } while (again);
    } finally {
      draining = false;
    }
  }
  const kick = () => void drain();
  const timer = setInterval(kick, 250);

  async function onBlockAction(inst: Installation, _payload: Record<string, any>) {
    audit(db, cfg.run_id, inst.tenant_id, "block_action_unhandled", {});
  }

  return { kick, onAccepted: kick, onBlockAction, stop: () => clearInterval(timer) };
}
