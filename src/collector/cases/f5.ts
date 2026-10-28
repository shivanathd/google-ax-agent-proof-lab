// F5: optional lanes through the real CLI, with provider CLIs shadowed by collector-owned PATH shims and all
// HTTP(S) egress routed to the collector's sinkhole, so any external call attempt is counted outside the app.
import { readFileSync } from "node:fs";
import { childEnv } from "../../config/env.ts";
import type { Probe } from "../probe.ts";
import { lab, mention, q, sleep, stimulus, waitFor, ws } from "../drive.ts";
import type { CaseDef, CollectorInfo } from "../types.ts";

const OPTIONAL = ["salesforce", "coderabbit", "ax", "live-model"];

function cliEnv(info: CollectorInfo, extra: Record<string, string> = {}) {
  const proxy = `http://127.0.0.1:${info.sinkhole_port}`;
  const env = childEnv(process.env, {
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NODE_USE_ENV_PROXY: "1",
    // Ambient decoys that the CLI must ignore (fictional values).
    SF_TARGET_ORG: "fictional-default-org", OPENAI_API_KEY: "fictional-ambient-key", ...extra,
  }, { docker: true });
  return { ...env, PATH: `${info.shim_dir}:${(env as Record<string, string>).PATH ?? ""}` };
}

async function egress(p: Probe) {
  await p.capture("shim-log", "collector-owned PATH shims (provider CLI invocation log)", () =>
    readFileSync(p.shims!.log, "utf8").split("\n").filter(Boolean));
  await p.capture("sinkhole", "collector-owned loopback sinkhole (HTTP(S) proxy for the CLI)", () => ({ hits: [...p.sinkhole!.hits] }));
}
// `sf --version` is a local version read, not a provider call.
const externalCalls = (p: Probe) => p.data<string[]>("shim-log").filter((l) => l.trim() !== "sf --version").length + p.data("sinkhole").hits.length;

export const F5_A1: CaseDef = {
  stack: { floci: false, slack: false },
  needs: { sinkhole: true, shims: true },
  worker: false,
  async execute({ info, ref }) {
    const r = await lab(["doctor", "--profile", ...OPTIONAL], cliEnv(info));
    ref("doctor", r);
  },
  async observe(p) {
    await p.capture("doctor-output", "`lab doctor --profile ...` stdout (child process)", () => ({ exit_code: p.refs.doctor.code, result: JSON.parse(p.refs.doctor.stdout) }));
    await egress(p);
    const lanes = () => OPTIONAL.map((n) => p.data("doctor-output").result.lanes[n]);
    p.fact("blocked_optional_profile_count", ["doctor-output"], () => lanes().filter((l) => l?.status === "BLOCKED").length);
    p.fact("external_resource_create_count", ["shim-log", "sinkhole"], () => externalCalls(p));
    // Actionable means the lane's own prerequisites; an "adapter not installed" placeholder does not count.
    p.fact("prerequisites_reported", ["doctor-output"], () =>
      lanes().every((l) => l && (l.status !== "BLOCKED" ||
        l.prerequisites.some((x: any) => !x.satisfied && !String(x.id).endsWith(".adapter") && String(x.description).length > 10))));
  },
};

async function localResult(p: Probe, tag: string) {
  await p.capture(`${tag}-local`, "read-only SQLite query (crm_accounts, actions) + Slack conversations.replies (reader token)", async () => ({
    account: p.rows("crm_accounts", { tenant_id: "T_LAB_A", account_id: "acct-northstar" })[0] ?? null,
    crm_updates: p.rows("actions").filter((a) => a.operation === "crm.description.update").map((a) => a.action_id),
    replies: (await p.replies("T_LAB_A", p.refs.ts)).filter((m) => m.bot_id && m.ts !== p.refs.ts).map((m) => ({ ts: m.ts, text: m.text })),
  }));
}

export const F5_A2: CaseDef = {
  needs: { sinkhole: true, shims: true },
  async execute({ h, info, ref, snapshot }) {
    const ts = await mention(h, ws(h), "fran", stimulus("W03-H", 1));
    await waitFor(() => q(h, "outbox", { action_key: `reply:crm:${q(h, "inbox", { message_ts: ts })[0]?.id}` })[0]?.status === "sent", 15000, "local W03 reply");
    await sleep(300);
    ref("ts", ts);
    await snapshot("before");
    // Configured-looking Salesforce lane (fictional alias, shimmed `sf`), but no --authorized flag.
    const r = await lab(["profile", "run", "salesforce", "--case", "W03-SF"], cliEnv(info, { APL_SF_DEVHUB_ALIAS: "apl-fictional-devhub", APL_SF_OWNER_APPROVED: "yes" }));
    ref("profile_run", r);
  },
  phases: { before: (p) => localResult(p, "before") },
  async observe(p) {
    await p.capture("profile-run", "`lab profile run salesforce` stdout (child process)", () => ({ exit_code: p.refs.profile_run.code, result: JSON.parse(p.refs.profile_run.stdout) }));
    await egress(p);
    await localResult(p, "after");
    p.fact("external_call_count", ["shim-log", "sinkhole"], () => externalCalls(p));
    p.fact("authorization_rejected", ["profile-run"], () => {
      const r = p.data("profile-run").result;
      return r.status === "BLOCKED" && /authorization required/i.test(r.reason) && r.prerequisites.every((x: any) => x.satisfied) && r.external_calls === 0;
    });
    p.fact("local_result_preserved", ["before-local", "after-local"], () => {
      const b = p.data("before-local"), a = p.data("after-local");
      return b.account !== null && b.crm_updates.length === 1 && b.replies.length === 1 && JSON.stringify(a) === JSON.stringify(b);
    });
  },
};
