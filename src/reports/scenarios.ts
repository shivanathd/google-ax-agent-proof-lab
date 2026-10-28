// Console scenarios (Task 6.1) and the fixed expectations each one is judged against. Pure data: most reuse a
// supplied evaluator case; W02-H uses the CASEBOOK row because the supplied cases have no W02 happy path.
// W01-F is deliberately judged against the W01 completion definition, so its injected fault shows as FAIL.
export interface ScenarioMeta {
  id: string;
  title: string;
  summary: string;
  expected_from?: string;                                   // supplied case id in evals/cases.json
  expected?: Record<string, boolean | number | string>;     // only when no supplied case covers it
  expected_source: string;
  layers: { execution: string; emulation: string; authorization: string; evidence: string };
  injected_fault?: string;
}

const EXEC = "Local scripted worker process (no model, no AX)";
const W01_EMU = "Emulate Slack (signed callback + Web API reply), Floci SQS job + S3 receipt, SQLite ledger";

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: "W01-H", title: "Service request", summary: "Dana asks LabBot to log an offline printer; expect one ticket, one S3 receipt and one reply in the same thread.",
    expected_from: "F3-A1", expected_source: "supplied case F3-A1 (CASEBOOK W01-H)",
    layers: { execution: EXEC, emulation: W01_EMU, authorization: "ticket.create grant for the requester, checked again at job time", evidence: "Collector: ledger (read-only), S3 GetObject, conversations.replies" },
  },
  {
    id: "W01-D", title: "Duplicate delivery", summary: "After a completed request, the emulator re-delivers the same signed event; expect no new business record or reply.",
    expected_from: "F2-A2", expected_source: "supplied case F2-A2 (CASEBOOK W01-D)",
    layers: { execution: EXEC, emulation: `${W01_EMU}; Emulate simulate/event-retry`, authorization: "Idempotency keyed by installation + event id", evidence: "Collector: before/after ledger counts, S3 key list, thread replies" },
  },
  {
    id: "W02-H", title: "Approval by a second person", summary: "Dana requests a purchase; Eli (granted approver) approves; expect one approved transition and a matching receipt.",
    expected: { approval_status: "approved", approved_transition_count: 1, approval_receipt_count: 1, approval_receipt_matches: true },
    expected_source: "CASEBOOK W02-H (no supplied evaluator case)",
    layers: { execution: EXEC, emulation: "Emulate Slack buttons (simulate/block-actions), Floci S3 receipt, SQLite ledger", authorization: "approval.resolve grant, approver ≠ requester, request digest + expiry", evidence: "Collector: approval row, audit, S3 receipt hash" },
  },
  {
    id: "W02-U", title: "Self-approval denied", summary: "Dana clicks Approve on her own request, then Gus (no grant) tries; expect both refused and the request unchanged.",
    expected_from: "F3-A2", expected_source: "supplied case F3-A2 (CASEBOOK W02-U)",
    layers: { execution: EXEC, emulation: "Emulate Slack buttons (simulate/block-actions), Floci S3, SQLite ledger", authorization: "Deterministic policy: requester cannot approve; ungranted user refused", evidence: "Collector: approval row, resolve/receipt writes, S3 receipt absence" },
  },
  {
    id: "W03-V", title: "Stale CRM version", summary: "Fran updates a synthetic account with an old expected version; expect CONFLICT and no overwrite.",
    expected_from: "F3-A3", expected_source: "supplied case F3-A3 (CASEBOOK W03-V)",
    layers: { execution: EXEC, emulation: "Emulate Slack, local CRM contract double (not Salesforce)", authorization: "crm.description.update grant + compare-and-set on version", evidence: "Collector: CRM row before/after (read-only), thread reply" },
  },
  {
    id: "W01-F", title: "Missing receipt (injected fault)", summary: "Same as W01-H, but the test coordinator deletes the S3 receipt after the worker reports success; the W01 completion check must FAIL.",
    expected_from: "F3-A1", expected_source: "supplied case F3-A1 completion definition, applied to a run with an injected fault",
    injected_fault: "receipt object deleted from S3 by the test coordinator after the worker committed it",
    layers: { execution: EXEC, emulation: W01_EMU, authorization: "ticket.create grant for the requester", evidence: "Collector finds no receipt object, so receipt checks fail despite the worker's reply" },
  },
];

export const scenario = (id: string) => SCENARIOS.find((s) => s.id === id);
