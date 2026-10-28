// Coordinator-side seeding of synthetic grants and CRM accounts (fixtures/cases/seed.json). Grants name
// fictional users; their per-run Slack IDs come from users.list. Idempotent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config/run-config.ts";
import { openLedger } from "./db.ts";
import { setGrant } from "../policy/index.ts";
import { seedAccount, type Account } from "../adapters/crm-local/index.ts";

interface Seed { grants: Record<string, Record<string, string[]>>; crm_accounts: Account[] }
export const loadSeed = (): Seed => JSON.parse(readFileSync(join(ROOT, "fixtures/cases/seed.json"), "utf8"));

// usersByTenant: tenant_id -> (user name -> Slack user id)
export function seedLedger(dbPath: string, usersByTenant: Record<string, Record<string, string>>) {
  const seed = loadSeed();
  const db = openLedger(dbPath);
  try {
    db.transaction(() => {
      for (const [tenant, users] of Object.entries(seed.grants)) {
        for (const [name, perms] of Object.entries(users)) {
          const id = usersByTenant[tenant]?.[name];
          if (!id) throw new Error(`seed: no Slack id for ${name} in ${tenant}`);
          for (const p of perms) setGrant(db, tenant, id, p, true);
        }
      }
      for (const a of seed.crm_accounts) seedAccount(db, a);
    })();
  } finally {
    db.close();
  }
}
