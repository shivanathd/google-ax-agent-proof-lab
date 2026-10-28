// Read-only observation of a run's ledger, for tests and the later independent collector.
// better-sqlite3 ignores `file:...?mode=ro` URIs, so the connection uses SQLITE_OPEN_READONLY instead.
import Database from "better-sqlite3";
import type { DB } from "./db.ts";

export const openReadOnly = (path: string): DB => new Database(path, { readonly: true, fileMustExist: true });

const TABLES = ["inbox", "outbox", "installations", "run_audit", "tickets", "approval_requests", "crm_accounts", "actions", "grants"] as const;
export type Table = (typeof TABLES)[number];

export function rows<T = Record<string, any>>(db: DB, table: Table, where: Record<string, string | number> = {}): T[] {
  if (!TABLES.includes(table)) throw new Error(`unknown table ${table}`);
  const keys = Object.keys(where);
  if (keys.some((k) => !/^[a-z_]+$/.test(k))) throw new Error("invalid column");
  const clause = keys.length ? ` WHERE ${keys.map((k) => `${k} = @${k}`).join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM ${table}${clause} ORDER BY rowid`).all(where) as T[];
}

export const count = (db: DB, table: Table, where: Record<string, string | number> = {}) => rows(db, table, where).length;

// Whole-run snapshot for the independent collector (Task 4.1): every business table, read-only.
export function observeRun(db: DB, runId: string) {
  const r = (t: Table) => rows(db, t, { run_id: runId });
  return {
    inbox: r("inbox"), outbox: r("outbox"), tickets: r("tickets"), approval_requests: r("approval_requests"),
    actions: r("actions"), run_audit: r("run_audit"), crm_accounts: rows(db, "crm_accounts"),
  };
}
