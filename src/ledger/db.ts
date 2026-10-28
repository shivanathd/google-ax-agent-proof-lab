// Worker-owned SQLite ledger (one file per run). WAL mode lets a separate read-only connection observe it.
// Inbox and outbox give application-local atomicity; remote systems stay at-least-once and are reconciled.
import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL, tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL, team_id TEXT NOT NULL,
  event_id TEXT NOT NULL, event_type TEXT NOT NULL, actor_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL, thread_ts TEXT, text TEXT NOT NULL, raw_body_sha256 TEXT NOT NULL,
  verified_signature INTEGER NOT NULL CHECK (verified_signature = 1), received_at TEXT NOT NULL,
  delivery_count INTEGER NOT NULL DEFAULT 1, last_retry_num INTEGER,
  status TEXT NOT NULL CHECK (status IN ('received','processing','done','ignored','denied','failed')),
  reason TEXT,
  UNIQUE (installation_id, team_id, event_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL, tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL, action_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('slack.reply','sqs.send')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (run_id, tenant_id, action_key)
);
CREATE TABLE IF NOT EXISTS installations (
  installation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS run_audit (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, tenant_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
);
`;

export function openLedger(path: string, extraSchema = ""): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA + extraSchema);
  return db;
}

export const nowIso = () => new Date().toISOString();

export function audit(db: DB, runId: string, tenantId: string | null, kind: string, detail: object = {}) {
  db.prepare("INSERT INTO run_audit (run_id, tenant_id, at, kind, detail) VALUES (?,?,?,?,?)").run(runId, tenantId, nowIso(), kind, JSON.stringify(detail));
}

export interface InboxEvent {
  run_id: string; tenant_id: string; installation_id: string; team_id: string; event_id: string; event_type: string;
  actor_id: string; channel_id: string; message_ts: string; thread_ts?: string; text: string; raw_body_sha256: string;
  verified_signature: true; received_at: string; retry_num?: number;
}

// Durable accept; a redelivery of the same installation/team/event id only bumps delivery_count.
export function acceptEvent(db: DB, e: InboxEvent, status: "received" | "ignored" | "denied" = "received", reason?: string) {
  const row = db
    .prepare(
      `INSERT INTO inbox (run_id, tenant_id, installation_id, team_id, event_id, event_type, actor_id, channel_id, message_ts,
         thread_ts, text, raw_body_sha256, verified_signature, received_at, last_retry_num, status, reason)
       VALUES (@run_id,@tenant_id,@installation_id,@team_id,@event_id,@event_type,@actor_id,@channel_id,@message_ts,
         @thread_ts,@text,@raw_body_sha256,1,@received_at,@retry_num,@status,@reason)
       ON CONFLICT (installation_id, team_id, event_id)
         DO UPDATE SET delivery_count = delivery_count + 1, last_retry_num = excluded.last_retry_num
       RETURNING id, delivery_count`,
    )
    .get({ ...e, thread_ts: e.thread_ts ?? null, retry_num: e.retry_num ?? null, status, reason: reason ?? null }) as { id: number; delivery_count: number };
  return { inbox_id: row.id, duplicate: row.delivery_count > 1 };
}

// Compare-and-set claim: only one processor can move a row out of 'received'.
export const claimInbox = (db: DB, id: number) =>
  db.prepare("UPDATE inbox SET status = 'processing' WHERE id = ? AND status = 'received'").run(id).changes === 1;

export const finishInbox = (db: DB, id: number, status: "done" | "denied" | "failed", reason?: string) =>
  db.prepare("UPDATE inbox SET status = ?, reason = ? WHERE id = ? AND status = 'processing'").run(status, reason ?? null, id);

export function enqueueOutbox(db: DB, o: { run_id: string; tenant_id: string; installation_id: string; action_key: string; kind: "slack.reply" | "sqs.send"; payload: object }) {
  const t = nowIso();
  return db
    .prepare(
      `INSERT INTO outbox (run_id, tenant_id, installation_id, action_key, kind, payload, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'pending',?,?) ON CONFLICT (run_id, tenant_id, action_key) DO NOTHING`,
    )
    .run(o.run_id, o.tenant_id, o.installation_id, o.action_key, o.kind, JSON.stringify(o.payload), t, t).changes === 1;
}

export const settleOutbox = (db: DB, id: number, status: "sent" | "failed" | "unknown", result: object) =>
  db.prepare("UPDATE outbox SET status = ?, result = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(status, JSON.stringify(result), nowIso(), id);

export const isRevoked = (db: DB, installationId: string) =>
  !!(db.prepare("SELECT revoked_at FROM installations WHERE installation_id = ?").get(installationId) as { revoked_at: string | null } | undefined)?.revoked_at;
