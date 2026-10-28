// F4: forged worker success (receipt missing) and a selected optional lane without credentials.
// Both judge the worker through the report generator fed only with collector facts.
import { readFileSync } from "node:fs";
import { flociClients } from "../../adapters/floci/clients.ts";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { laneStatuses } from "../../config/profiles.ts";
import { buildReport, W01_COMPLETION, type Bundle } from "../../reports/report.ts";
import { captureTicket, type Probe } from "../probe.ts";
import { mention, sleep, stimulus, ticketDone, ws } from "../drive.ts";
import type { CaseDef } from "../types.ts";

async function w01Facts(p: Probe) {
  const t = await captureTicket(p, "w01", "T_LAB_A", p.refs.ts);
  p.fact("ticket_count", ["w01-ledger"], t.ticketCount);
  p.fact("receipt_count", ["w01-s3"], t.receiptCount);
  p.fact("receipt_matches_request", ["w01-ledger", "w01-s3", "w01-thread"], t.receiptMatches);
  p.fact("completion_reply_count", ["w01-thread"], () => t.completionReplies().length);
  return t;
}

// A C4 view of the facts collected so far, judged against the W01 completion definition.
function report(p: Probe, optional: Parameters<typeof buildReport>[0]["optional"] = {}) {
  const m = JSON.parse(readFileSync(p.cfg.manifest_path, "utf8"));
  const keys = Object.keys(W01_COMPLETION);
  const bundle: Bundle = {
    schema_version: 1, case_id: "W01-H", run_id: m.config.run_id, profile: "local", mode: m.config.mode, execution: "EXECUTED",
    candidate_revision: m.config.candidate_revision, tree_sha: m.tree_sha, dirty: m.config.dirty, fixture_sha256: m.config.fixture_sha256,
    mutation: p.cfg.mutation, collector: `apl-collector pid=${process.pid}`, observed_at: new Date().toISOString(),
    observations: Object.fromEntries(Object.entries(p.observations).filter(([k]) => keys.includes(k))),
    unobserved: Object.fromEntries(Object.entries(p.unobserved).filter(([k]) => keys.includes(k))),
    evidence: p.evidence.map((e) => ({ ...e, observations: [...e.observations] })),
  };
  return buildReport({ bundle, expected: { ...W01_COMPLETION }, optional });
}

export const F4_A1: CaseDef = {
  async execute({ h, ref, fault }) {
    const ts = await mention(h, ws(h), "dana", stimulus("W01-H"));
    const t = await ticketDone(h, ts);
    // Test-only fault: remove the receipt after the worker committed it and announced completion.
    const s3 = await flociClients(h.flociEndpoint, h.manifest.config.endpoint_allowlist);
    await s3.s3.send(new DeleteObjectCommand({ Bucket: h.floci!.bucket, Key: t.receipt_key }));
    fault("receipt object deleted from S3 by the test coordinator after the worker committed it (simulated fault)");
    await sleep(300);
    ref("ts", ts);
  },
  async observe(p) {
    const t = await w01Facts(p);
    p.fact("worker_claimed_success", ["w01-ledger", "w01-thread"], () => p.data("w01-ledger").tickets[0]?.receipt_status === "committed" && t.completionReplies().length > 0);
    p.fact("receipt_present", ["w01-s3"], () => p.data("w01-s3").present === true);
    await p.capture("report", "report generator over collector facts (src/reports)", () => report(p));
    p.fact("required_assertion_failed", ["report"], () => p.data("report").assertions.some((a: any) => a.required && a.status === "FAIL"));
    p.fact("overall_success_banner", ["report"], () => p.data("report").banner.green);
  },
};

export const F4_A2: CaseDef = {
  selected_profiles: ["salesforce"],
  async execute({ h, ref }) {
    const ts = await mention(h, ws(h), "dana", stimulus("W01-H"));
    await ticketDone(h, ts);
    await sleep(300);
    ref("ts", ts);
  },
  async observe(p) {
    await w01Facts(p);
    // The collector's env carries no Salesforce configuration, so the selected lane has no credentials.
    await p.capture("lanes", "profile doctor (local configuration only, zero external calls)", () => laneStatuses(["salesforce"], process.env));
    await p.capture("report", "report generator over collector facts (src/reports)", () => report(p, p.data("lanes")));
    p.fact("salesforce_status", ["report"], () => p.data("report").lanes.salesforce.status);
    p.fact("salesforce_parity", ["report"], () => {
      const parity = p.data("report").lanes.salesforce.parity;
      if (typeof parity !== "string") throw new Error("parity not reported");
      return parity;
    });
    p.fact("local_results_separate", ["report"], () => {
      const r = p.data("report");
      const local = r.assertions.filter((a: any) => a.id in W01_COMPLETION);
      return r.lanes.local.status === r.status && local.length === Object.keys(W01_COMPLETION).length && local.length === r.counts.required &&
        typeof r.all_lanes_status === "string" && r.lanes.salesforce.selected === true;
    });
  },
};
