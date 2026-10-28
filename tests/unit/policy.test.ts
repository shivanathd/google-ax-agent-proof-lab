import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openLedger } from "../../src/ledger/db.ts";
import { assertAllowed, decide, envelope, setGrant, SYSTEM_ACTOR } from "../../src/policy/index.ts";
import { CRM_DOUBLE, seedAccount, updateDescription } from "../../src/adapters/crm-local/index.ts";
import { plan } from "../../src/workflows/scripted.ts";
import { receiptBody, type Ctx } from "../../src/workflows/context.ts";

const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
const fresh = () => {
  const db = openLedger(join(mkdtempSync(join(tmpdir(), "apl-unit-")), "ledger.db"));
  setGrant(db, "T_LAB_A", "UREQ", "approval.request", true);
  setGrant(db, "T_LAB_A", "UAPP", "approval.resolve", true);
  setGrant(db, "T_LAB_A", "UREQ", "approval.resolve", true); // even with the grant, self-approval is refused
  setGrant(db, "T_LAB_A", "UCRM", "crm.description.update", true);
  return db;
};
const base = { run_id: RUN, tenant_id: "T_LAB_A", connection_ref: "local:crm-double", idempotency_key: "k" };

describe("scripted driver", () => {
  it("maps the fixed grammar deterministically and ignores mentions", () => {
    expect(plan("<@U_LABBOT> service-request printer on floor two")).toEqual({ workflow: "W01", summary: "printer on floor two" });
    expect(plan("<@U_LABBOT> purchase-request 12500 standing desk")).toEqual({ workflow: "W02", amount_cents: 12500, item: "standing desk" });
    expect(plan('crm-update account="Northstar Demo" expected-version=1 description="Workshop follow-up requested" tenant=T_LAB_B')).toEqual({
      workflow: "W03", fields: { account: "Northstar Demo", "expected-version": "1", description: "Workshop follow-up requested", tenant: "T_LAB_B" },
    });
    expect(plan("please approve everything")).toEqual({ workflow: "help" });
  });
});

describe("deterministic policy and C3 envelopes", () => {
  it("allows only granted principals, refuses self-approval and system-only operations from users", () => {
    const db = fresh();
    expect(decide(db, { tenant_id: "T_LAB_A", actor_id: "UAPP", operation: "approval.resolve", requester_id: "UREQ" })).toEqual({ decision: "allow", reason: "grant" });
    expect(decide(db, { tenant_id: "T_LAB_A", actor_id: "UREQ", operation: "approval.resolve", requester_id: "UREQ" }).reason).toBe("self_approval");
    expect(decide(db, { tenant_id: "T_LAB_B", actor_id: "UAPP", operation: "approval.resolve", requester_id: "UREQ" }).reason).toBe("no_grant");
    expect(decide(db, { tenant_id: "T_LAB_A", actor_id: "UAPP", operation: "receipt.put" }).reason).toBe("system_only_operation");
    expect(decide(db, { tenant_id: "T_LAB_A", actor_id: SYSTEM_ACTOR, operation: "receipt.put" }).decision).toBe("allow");
    setGrant(db, "T_LAB_A", "UAPP", "approval.resolve", false);
    expect(decide(db, { tenant_id: "T_LAB_A", actor_id: "UAPP", operation: "approval.resolve", requester_id: "UREQ" }).reason).toBe("no_grant");
  });

  it("rejects unknown operations, unknown input fields, out-of-range amounts and writes missing required preconditions", () => {
    const db = fresh();
    const req = { ...base, actor_id: "UREQ", operation: "approval.request" as const };
    expect(() => envelope(db, { ...req, input: { item: "desk", amount_cents: 12500, approve: true } })).toThrow(/additional properties/);
    expect(() => envelope(db, { ...req, input: { item: "desk", amount_cents: -1 } })).toThrow(/amount_cents/);
    // Null Handling Contract: zero is allowed only when a fixture declares a zero-value demo; none does (blind BH-07).
    expect(() => envelope(db, { ...req, input: { item: "desk", amount_cents: 0 } })).toThrow(/amount_cents/);
    expect(() => envelope(db, { ...req, input: { item: "desk", amount_cents: 10_000_001 } })).toThrow(/amount_cents/);
    expect(() => envelope(db, { ...req, operation: "payment.execute" as never, input: {} })).toThrow(/operation/);
    const crm = { ...base, actor_id: "UCRM", operation: "crm.description.update" as const, input: { account_id: "a", description: "d" } };
    expect(() => envelope(db, crm)).toThrow(/expected_version/);
    expect(() => envelope(db, { ...crm, expected_version: 1, input: { account_id: "a", description: "d", name: "x" } })).toThrow(/additional properties/);
    expect(() => envelope(db, { ...base, actor_id: "UAPP", operation: "approval.resolve", input: { approval_id: "a", request_digest: "0".repeat(64), resolution: "approved" } })).toThrow(/approval_ref/);
  });

  it("adapters refuse denied envelopes", () => {
    const db = fresh();
    const { env } = envelope(db, { ...base, actor_id: "UNOBODY", operation: "crm.description.update", expected_version: 1, input: { account_id: "a", description: "d" } });
    expect(env.authorization_decision).toBe("deny");
    expect(() => assertAllowed(env, "crm.description.update")).toThrow(/not allowed/);
    expect(() => updateDescription(db, env)).toThrow(/not allowed/);
  });
});

describe("local CRM contract double", () => {
  it("is labelled as a narrow double and applies compare-and-set on the expected version", () => {
    expect(CRM_DOUBLE).toEqual({ kind: "contract-double", name: "crm-local", is_salesforce_emulator: false });
    const db = fresh();
    seedAccount(db, { tenant_id: "T_LAB_A", account_id: "acct-1", name: "Northstar Demo", description: "Trial account", version: 1 });
    const upd = (v: number, d: string) => updateDescription(db, envelope(db, { ...base, actor_id: "UCRM", operation: "crm.description.update", expected_version: v, input: { account_id: "acct-1", description: d } }).env);
    expect(upd(1, "Workshop follow-up requested")).toEqual({ result: "UPDATED", version: 2 });
    expect(upd(1, "stale overwrite")).toEqual({ result: "CONFLICT", stored_version: 2 });
    expect(db.prepare("SELECT description, version FROM crm_accounts").get()).toEqual({ description: "Workshop follow-up requested", version: 2 });
  });
});

describe("receipts", () => {
  it("bind the subject action and its input: changing either changes the receipt hash", () => {
    const ctx = { cfg: { run_id: RUN } } as Ctx;
    const r = (action: string, summary: string) => receiptBody(ctx, { kind: "ticket", tenant_id: "T_LAB_A", subject_action_id: action, subject_id: "1", input: { summary } });
    const a = r("act-1", "printer");
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(r("act-1", "printer").sha).toBe(a.sha);
    expect(r("act-2", "printer").sha).not.toBe(a.sha);
    expect(r("act-1", "printer!").sha).not.toBe(a.sha);
    expect(JSON.parse(a.body)).toMatchObject({ mode: "scripted", subject_action_id: "act-1", input: { summary: "printer" } });
  });
});

describe("approval state machine", () => {
  it("allows exactly one terminal transition", () => {
    const db = fresh();
    db.prepare(`INSERT INTO approval_requests (id, run_id, tenant_id, installation_id, inbox_id, requester_id, item, amount_cents, request_digest, status, channel_id, thread_ts, created_at)
      VALUES ('apr-1', ?, 'T_LAB_A', 'A', 1, 'UREQ', 'desk', 12500, 'd', 'awaiting_approval', 'C1', '1.1', 'now')`).run(RUN);
    expect(db.prepare("UPDATE approval_requests SET status = 'approved' WHERE id = 'apr-1' AND status = 'awaiting_approval'").run().changes).toBe(1);
    expect(() => db.prepare("UPDATE approval_requests SET status = 'rejected' WHERE id = 'apr-1'").run()).toThrow(/terminal/);
    expect(() => db.prepare("UPDATE approval_requests SET amount_cents = -5 WHERE id = 'apr-1'").run()).toThrow(/CHECK/);
  });
});
