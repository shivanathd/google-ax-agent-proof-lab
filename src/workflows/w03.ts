// W03 CRM follow-up: update one allowlisted field (description) with an expected version, against the
// local contract double. The tenant is the verified installation's; text cannot choose another one.
import { audit, finishInbox } from "../ledger/db.ts";
import { envelope } from "../policy/index.ts";
import { CRM_DOUBLE, findAccount, updateDescription } from "../adapters/crm-local/index.ts";
import type { InboxRow } from "../worker/worker.ts";
import { denyRequest, recordAction, reply, type Ctx } from "./context.ts";

const FIELDS = new Set(["account", "expected-version", "description"]);

export function onRequest(ctx: Ctx, row: InboxRow, fields: Record<string, string>) {
  if ("tenant" in fields) audit(ctx.db, row.run_id, row.tenant_id, "tenant_hint_ignored", { inbox_id: row.id });
  const unsupported = Object.keys(fields).filter((k) => !FIELDS.has(k) && k !== "tenant");
  if (unsupported.length) return denyRequest(ctx, row, "crm.description.update", `unsupported_field:${unsupported.join(",")}`);
  const version = fields["expected-version"];
  if (!fields.account || !version || !/^\d{1,9}$/.test(version)) return denyRequest(ctx, row, "crm.description.update", "missing_target_or_expected_version");
  const account = findAccount(ctx.db, row.tenant_id, fields.account);
  if (!account) return denyRequest(ctx, row, "crm.description.update", "account_not_found_in_bound_tenant");

  const { env, decision } = envelope(ctx.db, {
    run_id: row.run_id, tenant_id: row.tenant_id, actor_id: row.actor_id, connection_ref: "local:crm-double", operation: "crm.description.update",
    idempotency_key: `crm.update:${row.installation_id}:${row.event_id}`, expected_version: Number(version),
    input: { account_id: account.account_id, description: fields.description ?? "" },
  });
  if (decision.decision === "deny") return denyRequest(ctx, row, "crm.description.update", decision.reason);
  const r = updateDescription(ctx.db, env);
  const where = { channel: row.channel_id, thread_ts: row.thread_ts ?? row.message_ts };
  if (r.result === "UPDATED") {
    recordAction(ctx, env, { ...r, double: CRM_DOUBLE.name });
    reply(ctx, row, `reply:crm:${row.id}`, { ...where, text: `${account.name} description updated in the local CRM contract double: version ${env.expected_version} → ${r.version}.` });
    finishInbox(ctx.db, row.id, "done");
  } else {
    audit(ctx.db, row.run_id, row.tenant_id, "crm_conflict", { account_id: account.account_id, expected_version: env.expected_version, ...r });
    reply(ctx, row, `reply:crm:${row.id}`, { ...where, text: `CONFLICT: ${account.name} is at version ${r.result === "CONFLICT" ? r.stored_version : "?"}, not ${env.expected_version}. Nothing was changed.` });
    finishInbox(ctx.db, row.id, "denied", "CONFLICT");
  }
}
