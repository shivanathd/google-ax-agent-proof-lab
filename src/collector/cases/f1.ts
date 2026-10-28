// F1: local stack and forbidden endpoints.
import { readFileSync } from "node:fs";
import { isLoopbackHost } from "../../config/run-config.ts";
import { captureTicket, sha256, type Probe } from "../probe.ts";
import { click, mention, q, requestApproval, sleep, stimulus, ticketDone, waitFor, ws } from "../drive.ts";
import type { CaseDef } from "../types.ts";

const hostOf = (u: string) => new URL(u).hostname;

// The run's declared configuration, without paths: allowlist, connection reference, profile.
async function captureConfig(p: Probe) {
  return p.capture("run-config", "run manifest (read-only file) + read-only SQLite query (actions.connection_ref)", () => {
    const c = JSON.parse(readFileSync(p.cfg.manifest_path, "utf8")).config;
    const refs = [...new Set(p.rows("actions").map((a) => String(JSON.parse(a.envelope).connection_ref)))].sort();
    return {
      profile: c.profile, connection_ref: c.connection_ref ?? null, endpoint_allowlist: c.endpoint_allowlist, action_connection_refs: refs,
      collector_targets: [...p.cfg.slack.map((s) => s.url), ...(p.cfg.floci ? [p.cfg.floci.endpoint] : [])],
    };
  });
}

export const F1_A1: CaseDef = {
  async execute({ h, ref }) {
    const A = ws(h);
    const w01 = await mention(h, A, "dana", stimulus("W01-H"));
    await ticketDone(h, w01);
    const { ts: w02, a } = await requestApproval(h, A, "dana", stimulus("W02-H"));
    await click(A, a.message_ts, "eli");
    await waitFor(() => q(h, "approval_requests", { id: a.id })[0]?.receipt_status === "committed" && q(h, "outbox", { action_key: `reply:approval-resolved:${a.id}` })[0]?.status === "sent", 15000, "approval receipt and reply");
    const w03 = await mention(h, A, "fran", stimulus("W03-H", 1));
    await waitFor(() => q(h, "outbox", { action_key: `reply:crm:${q(h, "inbox", { message_ts: w03 })[0]?.id}` })[0]?.status === "sent", 15000, "crm reply");
    await sleep(300);
    ref("w01_ts", w01);
    ref("w02_ts", w02);
    ref("w02_id", a.id);
    ref("w03_ts", w03);
  },
  async observe(p) {
    const { w01_ts, w02_ts, w02_id, w03_ts } = p.refs;
    await p.capture("emulators", "Slack conversations.list per workspace (reader token)", async () =>
      Promise.all(p.cfg.slack.map(async (s) => ({ tenant_id: s.tenant_id, ok: (await p.slack(s.tenant_id, "conversations.list")).ok === true }))));
    await p.capture("floci", "S3 HeadBucket + SQS GetQueueAttributes (collector clients, own credentials)", async () => ({ bucket_reachable: await p.s3Reachable(), queue: await p.queueDepth() }));
    p.fact("emulate_running", ["emulators"], () => p.data("emulators").length === 2 && p.data("emulators").every((e: any) => e.ok));
    p.fact("floci_running", ["floci"], () => p.data("floci").bucket_reachable === true && Number.isFinite(p.data("floci").queue.visible));

    const w01 = await captureTicket(p, "w01", "T_LAB_A", w01_ts);
    await p.capture("w02-ledger", "read-only SQLite query (approval_requests, actions)", () => ({
      approval: p.rows("approval_requests", { id: w02_id })[0] ?? null, resolve_actions: p.rows("actions", { action_key: `approval.resolve:${w02_id}` }),
    }));
    await p.capture("w02-s3", "S3 GetObject (collector client, own credentials)", async () => ({ body: (await p.s3Get(`receipts/T_LAB_A/approval-${w02_id}.json`)) ?? null }));
    await p.capture("w02-thread", "Slack conversations.replies (reader token)", () => p.replies("T_LAB_A", w02_ts));
    await p.capture("w03-ledger", "read-only SQLite query (crm_accounts, actions)", () => ({
      account: p.rows("crm_accounts", { tenant_id: "T_LAB_A", account_id: "acct-northstar" })[0] ?? null,
      updates: p.rows("actions").filter((a) => a.operation === "crm.description.update"),
    }));
    await p.capture("w03-thread", "Slack conversations.replies (reader token)", () => p.replies("T_LAB_A", w03_ts));
    await captureConfig(p);

    p.fact("workflow_count", ["w01-ledger", "w01-s3", "w01-thread", "w02-ledger", "w02-s3", "w02-thread", "w03-ledger", "w03-thread"], () => {
      const w01Done = w01.ticketCount() === 1 && w01.receiptCount() === 1 && w01.receiptMatches() && w01.completionReplies().length === 1;
      const { approval, resolve_actions } = p.data("w02-ledger");
      const body = p.data("w02-s3").body as string | null;
      const w02Done = approval?.status === "approved" && resolve_actions.length === 1 && !!body && sha256(body) === approval.receipt_sha256 &&
        (p.data("w02-thread") as any[]).filter((m) => m.bot_id && String(m.text).includes("approved by")).length === 1;
      const { account, updates } = p.data("w03-ledger");
      const w03Done = account?.version === 2 && updates.length === 1 &&
        (p.data("w03-thread") as any[]).filter((m) => m.bot_id && String(m.text).includes("updated in the local CRM contract double")).length === 1;
      return [w01Done, w02Done, w03Done].filter(Boolean).length;
    });
    // Accounts the run needed: any connection that is not a local emulator/double, plus a configured connection.
    p.fact("required_external_accounts", ["run-config"], () => {
      const c = p.data("run-config");
      return c.action_connection_refs.filter((r: string) => !r.startsWith("local:")).length + (c.connection_ref ? 1 : 0);
    });
    p.fact("non_loopback_endpoint_count", ["run-config"], () => {
      const c = p.data("run-config");
      return [...c.endpoint_allowlist.map((e: any) => e.host), ...c.collector_targets.map(hostOf)].filter((x: string) => !isLoopbackHost(x)).length;
    });
  },
};

// G-NET: installation A's Slack API endpoint is overridden to a loopback sinkhole the collector owns and that
// is NOT in the run allowlist. Any request that escapes the guard lands in the sinkhole and is counted there.
export const F1_A2: CaseDef = {
  needs: { sinkhole: true },
  worker: (_h, info) => ({ overrides: { A: { api_url: `http://127.0.0.1:${info.sinkhole_port}` } } }),
  async execute({ h, ref }) {
    const ts = await mention(h, ws(h), "dana", stimulus("W01-H"));
    await waitFor(() => {
      const inbox = q(h, "inbox", { message_ts: ts })[0];
      const t = inbox && q(h, "tickets", { inbox_id: inbox.id })[0];
      const reply = t && q(h, "outbox", { action_key: `reply:ticket:${t.id}` })[0];
      return reply && reply.status !== "pending";
    }, 30000, "completion reply attempt settled");
    await sleep(300);
    ref("ts", ts);
  },
  async observe(p) {
    await p.capture("guard-audit", "read-only SQLite query (run_audit endpoint_rejected, outbox)", () => ({
      rejections: p.rows("run_audit", { kind: "endpoint_rejected" }).map((r) => ({ at: r.at, tenant_id: r.tenant_id, ...JSON.parse(r.detail) })),
      replies: p.rows("outbox", { kind: "slack.reply" }).map((o) => ({ action_key: o.action_key, status: o.status, attempts: o.attempts })),
    }));
    await p.capture("sinkhole", "collector-owned loopback sinkhole request log", () => ({ port: p.sinkhole!.port, hits: [...p.sinkhole!.hits] }));
    // Liveness control: the sinkhole must count a request when one actually reaches it.
    await p.capture("sinkhole-liveness", "collector self-request to its own sinkhole", async () => {
      const before = p.sinkhole!.hits.length;
      await fetch(`http://127.0.0.1:${p.sinkhole!.port}/__collector_liveness`).catch(() => undefined);
      return { counted: p.sinkhole!.hits.length === before + 1 };
    });
    const origin = `http://127.0.0.1:${p.sinkhole!.port}`;
    // The app's own audit only says a rejection was recorded; "before network" is judged by the sinkhole count.
    p.fact("rejected_before_network", ["guard-audit", "sinkhole", "sinkhole-liveness"], () => {
      const r = p.data("guard-audit").rejections.filter((x: any) => x.target === origin);
      return p.data("sinkhole-liveness").counted && r.length > 0 && p.data("sinkhole").hits.length === 0;
    });
    p.fact("outbound_request_count", ["sinkhole", "sinkhole-liveness"], () => {
      if (!p.data("sinkhole-liveness").counted) throw new Error("sinkhole did not count its liveness request");
      return p.data("sinkhole").hits.length;
    });
  },
};
