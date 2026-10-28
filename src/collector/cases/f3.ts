// F3: W01 completion, W02 unauthorized approval, W03 stale-version conflict.
import { captureTicket, type Probe } from "../probe.ts";
import { click, denials, inboxOf, mention, requestApproval, sleep, STIMULI, stimulus, ticketDone, waitFor, ws } from "../drive.ts";
import type { CaseDef } from "../types.ts";

export const F3_A1: CaseDef = {
  async execute({ h, ref }) {
    const ts = await mention(h, ws(h), "dana", stimulus("W01-H"));
    await ticketDone(h, ts);
    await sleep(500);
    ref("ts", ts);
  },
  async observe(p) {
    const t = await captureTicket(p, "w01", "T_LAB_A", p.refs.ts);
    const all = ["w01-ledger", "w01-s3", "w01-thread"];
    p.fact("ticket_count", ["w01-ledger"], t.ticketCount);
    p.fact("receipt_count", ["w01-s3"], t.receiptCount);
    p.fact("receipt_matches_request", all, t.receiptMatches);
    p.fact("completion_reply_count", ["w01-thread"], () => t.completionReplies().length);
  },
};

// Approval facts shared with S3: transitions, resolve/receipt writes and the S3 receipt object.
export async function captureApproval(p: Probe, id: string) {
  await p.capture("approval-ledger", "read-only SQLite query (approval_requests, actions, run_audit)", () => ({
    approval: p.rows("approval_requests", { id })[0] ?? null,
    resolve_actions: p.rows("actions", { action_key: `approval.resolve:${id}` }),
    receipt_actions: p.rows("actions", { action_key: `receipt.put:receipts/T_LAB_A/approval-${id}.json` }),
    denials: p.rows("run_audit", { kind: "approval_denied" }).map((r) => ({ tenant_id: r.tenant_id, ...JSON.parse(r.detail) })),
  }));
  await p.capture("approval-s3", "S3 GetObject (collector client, own credentials)", async () => ({ key: `receipts/T_LAB_A/approval-${id}.json`, present: (await p.s3Get(`receipts/T_LAB_A/approval-${id}.json`)) !== undefined }));
}
export const unauthorizedWrites = (l: any) =>
  l.resolve_actions.length + l.receipt_actions.length + (l.approval?.status !== "awaiting_approval" ? 1 : 0) + (l.approval?.approver_id ? 1 : 0);

export const F3_A2: CaseDef = {
  async execute({ h, ref }) {
    const A = ws(h);
    const { ts, a } = await requestApproval(h, A, "dana", STIMULI["W02-U"].text);
    await click(A, a.message_ts, "dana"); // requester approving their own request
    await click(A, a.message_ts, "gus"); // user without approval.resolve
    await waitFor(() => denials(h, a.id).length >= 2, 10000, "both clicks refused");
    await sleep(500);
    ref("ts", ts);
    ref("approval_id", a.id);
  },
  async observe(p) {
    await captureApproval(p, p.refs.approval_id);
    p.fact("approval_status", ["approval-ledger"], () => p.data("approval-ledger").approval.status);
    p.fact("unauthorized_write_count", ["approval-ledger"], () => unauthorizedWrites(p.data("approval-ledger")));
    p.fact("approval_receipt_count", ["approval-s3"], () => (p.data("approval-s3").present ? 1 : 0));
  },
};

async function crm(p: Probe, tag: string) {
  await p.capture(`${tag}-crm`, "read-only SQLite query (crm_accounts, actions)", () => ({
    account: p.rows("crm_accounts", { tenant_id: "T_LAB_A", account_id: "acct-cedar" })[0] ?? null,
    updates: p.rows("actions").filter((a) => a.operation === "crm.description.update").length,
  }));
}

export const F3_A3: CaseDef = {
  async execute({ h, ref, snapshot }) {
    await snapshot("before");
    const ts = await mention(h, ws(h), "fran", STIMULI["W03-V"].text);
    await waitFor(() => inboxOf(h, ts)?.status === "denied", 15000, "conflict recorded");
    await sleep(1000);
    ref("ts", ts);
  },
  phases: { before: (p) => crm(p, "before") },
  async observe(p) {
    const { ts } = p.refs;
    await crm(p, "after");
    await p.capture("inbox", "read-only SQLite query (inbox)", () => p.rows("inbox", { message_ts: ts }));
    await p.capture("thread", "Slack conversations.replies (reader token)", () => p.replies("T_LAB_A", ts));
    // The worker's recorded outcome counts only when the requester actually saw the same outcome in-thread.
    p.fact("result", ["inbox", "thread"], () => {
      const reason = String(p.data<any[]>("inbox")[0]?.reason);
      const seen = p.data<any[]>("thread").some((m) => m.bot_id && m.ts !== ts && String(m.text).includes(`${reason}:`));
      return seen ? reason : `UNCORROBORATED:${reason}`;
    });
    p.fact("description_unchanged", ["before-crm", "after-crm"], () => {
      const b = p.data("before-crm").account, a = p.data("after-crm").account;
      return !!b && !!a && a.description === b.description && a.version === b.version && a.updated_at === b.updated_at;
    });
    p.fact("write_count", ["before-crm", "after-crm"], () =>
      p.data("after-crm").updates - p.data("before-crm").updates + (p.data("after-crm").account.version - p.data("before-crm").account.version));
  },
};
