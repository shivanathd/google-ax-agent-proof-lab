// S2 recovery (public challenge): the worker is SIGKILLed after the ticket commit and before the receipt
// (the receipt PUT is stalled by a test-only loopback proxy), then restarted. One ticket, one reply, explicit
// recovery evidence, nothing duplicated, and no completion claim while the receipt is missing.
import { readFileSync } from "node:fs";
import { startFaultProxy } from "../../adapters/faults/proxy.ts";
import { captureTicket, type Probe } from "../probe.ts";
import { inboxOf, mention, q, sleep, stimulus, ticketDone, waitFor, ws } from "../drive.ts";
import type { CaseDef } from "../types.ts";

const tickets = new Map<string, Awaited<ReturnType<typeof captureTicket>>>();
const snap = async (p: Probe, tag: string) => void tickets.set(tag, await captureTicket(p, tag, "T_LAB_A", p.refs.ts));

export const S2: CaseDef = {
  stack: { extraPorts: ["fault_floci"] },
  worker: false,
  async execute({ h, ref, fault, snapshot }) {
    const proxy = await startFaultProxy(h.manifest.ports.fault_floci!, h.flociEndpoint);
    try {
      proxy.rules.push({ name: "receipt-stall", action: "stall", match: (r) => r.method === "PUT" && r.url.includes("/receipts/") });
      await h.startWorker({ floci_endpoint: proxy.url });
      const ts = await mention(h, ws(h), "dana", stimulus("W01-H"));
      ref("ts", ts);
      await waitFor(() => {
        const inbox = inboxOf(h, ts);
        return inbox && q(h, "tickets", { inbox_id: inbox.id })[0] && proxy.hits["receipt-stall"];
      }, 30000, "ticket committed and receipt PUT in flight");
      const worker = h.worker!;
      const gone = new Promise((r) => worker.once("exit", r));
      worker.kill("SIGKILL");
      await gone;
      fault("receipt PUT stalled by a test-only loopback proxy; worker SIGKILLed after the ticket commit (simulated crash)");
      await sleep(1500); // the unacknowledged SQS job becomes visible again meanwhile
      await snapshot("killed");
      proxy.clear();
      await h.startWorker({ floci_endpoint: proxy.url });
      await ticketDone(h, ts, 30000);
      await sleep(2500); // allow any redelivery to be processed before observing
    } finally {
      await h.stopWorker();
      await proxy.close();
    }
  },
  phases: { killed: (p) => snap(p, "killed") },
  async observe(p) {
    await snap(p, "final");
    const killed = tickets.get("killed")!, final = tickets.get("final")!;
    await p.capture("recovery", "read-only SQLite query (run_audit, actions) + run manifest worker processes", () => {
      const t = p.data("final-ledger").tickets[0];
      const audit = p.rows("run_audit").map((r) => ({ kind: r.kind, ...JSON.parse(r.detail) })).filter((r) => r.ticket_id === t?.id);
      const workers = JSON.parse(readFileSync(p.cfg.manifest_path, "utf8")).config.owned_resources.filter((r: any) => r.kind === "process" && r.role === "worker").length;
      return { ticket_id: t?.id ?? null, audit, worker_processes_started: workers, receipt_put_actions: t ? p.rows("actions", { action_key: `receipt.put:${t.receipt_key}` }).length : 0 };
    });
    const all = ["killed-ledger", "killed-s3", "killed-thread", "final-ledger", "final-s3", "final-thread"];
    p.fact("ticket_count", ["final-ledger"], final.ticketCount);
    p.fact("completion_reply_count", ["final-thread"], () => final.completionReplies().length);
    // A completion reply visible while its receipt is absent or does not match is a false success.
    p.fact("false_success_count", all, () =>
      [killed, final].filter((t) => t.completionReplies().length > 0 && !(t.receiptCount() === 1 && t.receiptMatches())).length);
    p.fact("recovery_evidence_present", [...all, "recovery"], () => {
      const r = p.data("recovery");
      return killed.ticketCount() === 1 && killed.receiptCount() === 0 && r.worker_processes_started >= 2 &&
        r.audit.some((a: any) => a.kind === "receipt_recovery") && final.receiptCount() === 1 && final.receiptMatches();
    });
    p.fact("duplicate_after_restart_count", ["final-ledger", "final-thread", "recovery"], () => {
      const key = p.data("final-ledger").tickets[0]?.action_key;
      const sameKey = p.rows("tickets").filter((t) => t.action_key === key).length;
      return Math.max(0, sameKey - 1) + Math.max(0, final.completionReplies().length - 1) + Math.max(0, p.data("recovery").receipt_put_actions - 1);
    });
  },
};
