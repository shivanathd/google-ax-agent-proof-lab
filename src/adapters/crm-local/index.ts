// Local CRM CONTRACT DOUBLE. It implements one narrow operation (account description update with an
// expected version) over the run ledger. It is NOT a Salesforce emulator and proves nothing about platform
// parity, sharing rules, CRUD/FLS or triggers; the optional Salesforce lane exists for that (ADR-5, F3-R6).
import { nowIso, type DB } from "../../ledger/db.ts";
import { assertAllowed, type ActionEnvelope } from "../../policy/index.ts";

export const CRM_DOUBLE = { kind: "contract-double", name: "crm-local", is_salesforce_emulator: false } as const;

export interface Account { tenant_id: string; account_id: string; name: string; description: string; version: number }
export type UpdateResult = { result: "UPDATED"; version: number } | { result: "CONFLICT"; stored_version: number } | { result: "NOT_FOUND" };

// Lookup is always scoped to the bound tenant; a name from another tenant simply does not exist here.
export const findAccount = (db: DB, tenant: string, name: string) =>
  db.prepare("SELECT * FROM crm_accounts WHERE tenant_id = ? AND name = ?").get(tenant, name) as Account | undefined;

// Compare-and-set: the write happens only if the stored version still equals the expected version.
export function updateDescription(db: DB, env: ActionEnvelope): UpdateResult {
  assertAllowed(env, "crm.description.update");
  const { account_id, description } = env.input as { account_id: string; description: string };
  const changed = db
    .prepare("UPDATE crm_accounts SET description = ?, version = version + 1, updated_at = ? WHERE tenant_id = ? AND account_id = ? AND version = ?")
    .run(description, nowIso(), env.tenant_id, account_id, env.expected_version!).changes;
  const row = db.prepare("SELECT version FROM crm_accounts WHERE tenant_id = ? AND account_id = ?").get(env.tenant_id, account_id) as { version: number } | undefined;
  if (!row) return { result: "NOT_FOUND" };
  return changed === 1 ? { result: "UPDATED", version: row.version } : { result: "CONFLICT", stored_version: row.version };
}

export function seedAccount(db: DB, a: Account) {
  db.prepare("INSERT OR IGNORE INTO crm_accounts (tenant_id, account_id, name, description, version, updated_at) VALUES (?,?,?,?,?,?)")
    .run(a.tenant_id, a.account_id, a.name, a.description, a.version, nowIso());
}
