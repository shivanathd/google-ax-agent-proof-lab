// S3 authorization (public challenge): self-approval, an ungranted user, a revoked approver and a button copied
// into another workspace all try to approve one request. Zero writes, nothing disclosed to the other tenant.
import { openLedger } from "../../ledger/db.ts";
import { setGrant } from "../../policy/index.ts";
import { click, denials, post, requestApproval, sleep, waitFor, ws } from "../drive.ts";
import { captureApproval, unauthorizedWrites } from "./f3.ts";
import type { CaseDef } from "../types.ts";

const ITEM = "purchase-request 12500 conference speakerphone";

export const S3: CaseDef = {
  async execute({ h, ref }) {
    const A = ws(h), B = ws(h, "T_LAB_B");
    const { ts, a } = await requestApproval(h, A, "dana", ITEM);
    await click(A, a.message_ts, "dana");
    await click(A, a.message_ts, "gus");
    // Policy administrator (test coordinator) revokes eli's grant before eli clicks.
    const admin = openLedger(h.manifest.db_path);
    setGrant(admin, "T_LAB_A", A.users.eli!, "approval.resolve", false);
    admin.close();
    await click(A, a.message_ts, "eli");
    // The same button value, copied into workspace B and clicked by B's approver.
    const copy = await post(h, B, B.tokens.worker, {
      text: "copied approval",
      blocks: [{ type: "actions", elements: [{ type: "button", action_id: "approval.approve", text: { type: "plain_text", text: "Approve" }, value: `${a.id}:${a.request_digest}` }] }],
    });
    await click(B, copy, "hana");
    await waitFor(() => denials(h, a.id).length >= 3, 10000, "A-side denials");
    await sleep(1500);
    ref("ts", ts);
    ref("approval_id", a.id);
    ref("copy_ts", copy);
  },
  async observe(p) {
    const { approval_id, copy_ts } = p.refs;
    await captureApproval(p, approval_id);
    await p.capture("tenant-b-slack", "Slack conversations.history + replies in workspace B (B reader token)", async () => ({
      history: await p.history("T_LAB_B"), copy_thread: await p.replies("T_LAB_B", copy_ts),
    }));
    await p.capture("tenant-b-audit", "read-only SQLite query (run_audit for T_LAB_B)", () =>
      p.rows("run_audit", { tenant_id: "T_LAB_B" }).map((r) => ({ kind: r.kind, ...JSON.parse(r.detail) })));
    const eli = p.ws("T_LAB_A").users.eli;
    p.fact("unauthorized_write_count", ["approval-ledger"], () => unauthorizedWrites(p.data("approval-ledger")));
    p.fact("cross_tenant_disclosure_count", ["approval-ledger", "tenant-b-slack", "tenant-b-audit"], () => {
      const { approval } = p.data("approval-ledger");
      const leaks = (m: any) => m.bot_id && m.ts !== copy_ts && [approval.id, approval.item, "T_LAB_A", approval.request_digest].some((s) => JSON.stringify(m).includes(s));
      const b = p.data("tenant-b-slack");
      const msgs = new Map([...b.history, ...b.copy_thread].map((m: any) => [m.ts, m]));
      return [...msgs.values()].filter(leaks).length + p.data<any[]>("tenant-b-audit").filter((r) => r.approval_id).length;
    });
    p.fact("approval_receipt_count", ["approval-s3"], () => (p.data("approval-s3").present ? 1 : 0));
    p.fact("revoked_approver_denied", ["approval-ledger"], () =>
      p.data("approval-ledger").denials.some((d: any) => d.approval_id === approval_id && d.actor_id === eli && d.reason === "no_grant"));
  },
};
