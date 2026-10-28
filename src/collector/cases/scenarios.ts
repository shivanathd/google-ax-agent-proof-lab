// Teaching-console scenarios as collect-case entries (`lab collect-case --case W01-H`). Most reuse an existing
// case's stimulus and collector half; W02-H and W01-F are composed here. Expectations live outside src/collector.
import { click, q, requestApproval, sleep, STIMULI, waitFor, ws } from "../drive.ts";
import { sha256 } from "../probe.ts";
import type { CaseDef } from "../types.ts";
import { F2_A2 } from "./f2.ts";
import { F3_A1, F3_A2, F3_A3 } from "./f3.ts";
import { F4_A1 } from "./f4.ts";

const W02_H: CaseDef = {
  async execute({ h, ref }) {
    const A = ws(h);
    const { ts, a } = await requestApproval(h, A, "dana", String(STIMULI["W02-H"].text).replace("{n}", "1"));
    await click(A, a.message_ts, "eli");
    await waitFor(() => q(h, "approval_requests", { id: a.id })[0]?.receipt_status === "committed", 15000, "approval receipt committed");
    await sleep(500);
    ref("ts", ts);
    ref("approval_id", a.id);
  },
  async observe(p) {
    const id = p.refs.approval_id as string;
    await p.capture("approval-ledger", "read-only SQLite query (approval_requests, run_audit)", () => ({
      approval: p.rows("approval_requests", { id })[0] ?? null,
      resolved: p.rows("run_audit", { kind: "approval_resolved" }).map((r) => JSON.parse(r.detail)).filter((d) => d.approval_id === id),
    }));
    await p.capture("approval-s3", "S3 GetObject (collector client, own credentials)", async () => {
      const key = p.data("approval-ledger").approval?.receipt_key;
      const body = key ? await p.s3Get(key) : undefined;
      return { key: key ?? null, present: body !== undefined, body: body ?? null };
    });
    p.fact("approval_status", ["approval-ledger"], () => p.data("approval-ledger").approval.status);
    p.fact("approved_transition_count", ["approval-ledger"], () => p.data("approval-ledger").resolved.filter((d: any) => d.resolution === "approved").length);
    p.fact("approval_receipt_count", ["approval-s3"], () => (p.data("approval-s3").present ? 1 : 0));
    p.fact("approval_receipt_matches", ["approval-ledger", "approval-s3"], () => {
      const a = p.data("approval-ledger").approval, s3 = p.data("approval-s3");
      if (!a || !s3.present) return false;
      const r = JSON.parse(s3.body);
      return sha256(s3.body) === a.receipt_sha256 && r.input?.approval_id === a.id && r.input?.approver_id === a.approver_id &&
        r.input?.requester_id === a.requester_id && a.approver_id !== a.requester_id && r.input?.request_digest === a.request_digest;
    });
  },
};

// W01-F: F4-A1's stimulus (receipt deleted after the worker's success reply) observed with the plain W01 facts.
const W01_F: CaseDef = { execute: F4_A1.execute, observe: F3_A1.observe };

export const SCENARIO_CASES: Record<string, CaseDef> = {
  "W01-H": F3_A1, "W01-D": F2_A2, "W02-H": W02_H, "W02-U": F3_A2, "W03-V": F3_A3, "W01-F": W01_F,
};
