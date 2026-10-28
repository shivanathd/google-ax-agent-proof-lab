// Deterministic policy boundary (C3). Decisions use the verified tenant, the current grants table and the
// request state at the moment the action is attempted — never message text or planner output.
import { randomUUID } from "node:crypto";
import { assertContract } from "../contracts/validate.ts";
import { nowIso, type DB } from "../ledger/db.ts";

export const POLICY_VERSION = "lab-policy-2026-10-28.1";
export type Operation = "ticket.create" | "receipt.put" | "approval.request" | "approval.resolve" | "crm.description.update" | "slack.reply";
export const SYSTEM_ACTOR = "system:worker";

// Which grant each user-initiated operation needs; receipt.put and slack.reply only follow committed actions.
const REQUIRED_GRANT: Partial<Record<Operation, string>> = {
  "ticket.create": "ticket.create",
  "approval.request": "approval.request",
  "approval.resolve": "approval.resolve",
  "crm.description.update": "crm.description.update",
};

export interface Decision { decision: "allow" | "deny"; reason: string }

export const hasGrant = (db: DB, tenant: string, user: string, permission: string) =>
  !!db.prepare("SELECT 1 FROM grants WHERE tenant_id = ? AND user_id = ? AND permission = ? AND active = 1").get(tenant, user, permission);

export function decide(db: DB, r: { tenant_id: string; actor_id: string; operation: Operation; requester_id?: string }): Decision {
  const grant = REQUIRED_GRANT[r.operation];
  if (!grant) return r.actor_id === SYSTEM_ACTOR ? { decision: "allow", reason: "system_followup" } : { decision: "deny", reason: "system_only_operation" };
  if (r.operation === "approval.resolve" && r.actor_id === r.requester_id) return { decision: "deny", reason: "self_approval" };
  return hasGrant(db, r.tenant_id, r.actor_id, grant) ? { decision: "allow", reason: "grant" } : { decision: "deny", reason: "no_grant" };
}

export interface ActionEnvelope {
  run_id: string; action_id: string; tenant_id: string; actor_id: string; connection_ref: string; operation: Operation;
  idempotency_key: string; input: Record<string, unknown>; authorization_decision: "allow" | "deny"; policy_version: string;
  requested_at: string; expected_version?: number; approval_ref?: string;
}

// Builds and validates the envelope; the decision is computed here, not supplied by the caller.
export function envelope(
  db: DB,
  e: Omit<ActionEnvelope, "action_id" | "authorization_decision" | "policy_version" | "requested_at"> & { requester_id?: string },
): { env: ActionEnvelope; decision: Decision } {
  const { requester_id, ...rest } = e;
  const decision = decide(db, { tenant_id: e.tenant_id, actor_id: e.actor_id, operation: e.operation, requester_id });
  const env = assertContract<ActionEnvelope>("action-envelope", {
    ...rest, action_id: randomUUID(), authorization_decision: decision.decision, policy_version: POLICY_VERSION, requested_at: nowIso(),
  });
  return { env, decision };
}

// Adapters call this before any effect: only a valid, allowed envelope may proceed.
export function assertAllowed(env: ActionEnvelope, operation: Operation) {
  assertContract("action-envelope", env);
  if (env.operation !== operation || env.authorization_decision !== "allow") throw new Error(`policy: ${operation} not allowed`);
}

// Policy administration (test coordinator / seed only; the worker never calls these).
export function setGrant(db: DB, tenant: string, user: string, permission: string, active: boolean) {
  db.prepare(
    "INSERT INTO grants (tenant_id, user_id, permission, active) VALUES (?,?,?,?) ON CONFLICT (tenant_id, user_id, permission) DO UPDATE SET active = excluded.active",
  ).run(tenant, user, permission, active ? 1 : 0);
}
