// Task 3.1: every CASEBOOK W01–W03 row against real Emulate Slack, a per-run Floci container (SQS + S3)
// and the worker process. Outcomes are observed independently: Slack through a read-only token, S3/SQS
// through the coordinator's own SDK clients, the ledger through a read-only SQLite connection.
// Faults (W01-S/Q/T) are injected by a loopback proxy and are labelled simulated faults.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startRun, type RunHandle } from "../../src/config/lifecycle.ts";
import { runDir } from "../../src/config/manifest.ts";
import { ROOT } from "../../src/config/run-config.ts";
import { flociClients, type FlociClients } from "../../src/adapters/floci/clients.ts";
import { getObjectText } from "../../src/adapters/floci/ops.ts";
import { simulate, type Workspace } from "../../src/adapters/slack/emulator.ts";
import { startFaultProxy, type FaultProxy } from "../../src/adapters/faults/proxy.ts";
import { openLedger } from "../../src/ledger/db.ts";
import { setGrant } from "../../src/policy/index.ts";
import { canonical, sha256 } from "../../src/workflows/context.ts";
import { api, botReplies, ledger, mention, settle, waitFor } from "./helpers.ts";

const CASES = JSON.parse(readFileSync(join(ROOT, "fixtures/cases/cases.json"), "utf8"));
const text = (id: string, n = 1) => String(CASES[id].text).replace("{n}", String(n));

interface Env { h: RunHandle; A: Workspace; B: Workspace; L: ReturnType<typeof ledger>; s3: FlociClients }
async function setup(opts: Parameters<typeof startRun>[0] = { slack: true }): Promise<Env> {
  const h = await startRun(opts);
  const [A, B] = h.workspaces as [Workspace, Workspace];
  return { h, A, B, L: ledger(h), s3: await flociClients(h.flociEndpoint, h.manifest.config.endpoint_allowlist) };
}
const inboxOf = (e: Env, ts: string) => e.L.rows("inbox", { message_ts: ts })[0];
const repliesWith = async (e: Env, ws: Workspace, ts: string, needle: string) => (await botReplies(e.h, ws, ts)).filter((m) => String(m.text).includes(needle));

// What the receipt must say, derived from the fixture stimulus and the emulator's users.list alone (not from
// the worker's rows): the scripted grammar's first token is the command word, the rest is the summary.
const expectedTicket = (e: Env, stimulus: string, user = "dana") => ({ summary: stimulus.slice(stimulus.indexOf(" ") + 1), requester_id: e.A.users[user]! });

// Independent W01 observation: ledger ticket + S3 object + Slack thread must all agree with the stimulus.
async function observeTicket(e: Env, ts: string, stimulus: string) {
  const want = expectedTicket(e, stimulus);
  const inbox = inboxOf(e, ts)!;
  const tickets = e.L.rows("tickets", { inbox_id: inbox.id });
  const t = tickets[0] as Record<string, any> | undefined;
  const object = t?.receipt_key ? await getObjectText(e.s3, e.h.floci!.bucket, t.receipt_key) : undefined;
  const receipt = object ? JSON.parse(object) : undefined;
  const action = t ? e.L.rows("actions", { action_key: t.action_key })[0] : undefined;
  const completion = t ? await repliesWith(e, e.A, ts, `Ticket #${t.id} created`) : [];
  return {
    ticket_count: tickets.length,
    receipt_status: t?.receipt_status,
    receipt_count: object === undefined ? 0 : 1,
    receipt_matches_request:
      !!receipt && !!t && sha256(object!) === t.receipt_sha256 && receipt.subject_action_id === t.action_id && receipt.subject_action_id === action?.action_id &&
      receipt.input_sha256 === sha256(canonical(receipt.input)) && receipt.input.summary === t.summary && receipt.input.requester_id === inbox.actor_id &&
      receipt.tenant_id === "T_LAB_A" && receipt.input.summary === want.summary && receipt.input.requester_id === want.requester_id,
    completion_reply_count: completion.length,
    // F3-R4: the reply read back through the reader token carries the scripted-mode label.
    completion_reply_scripted: completion.length > 0 && completion.every((m) => String(m.text).startsWith("[scripted] ") && String(m.text).includes(want.summary)),
    ticket: t,
  };
}

async function waitTicketDone(e: Env, ts: string, stimulus: string) {
  return waitFor(async () => {
    const o = await observeTicket(e, ts, stimulus);
    return o.completion_reply_count === 1 && o.receipt_count === 1 ? o : undefined;
  }, 20000, "ticket, receipt and completion reply");
}

// W02 helpers: request through Slack, click through the emulator's block-actions simulator.
async function requestApproval(e: Env, user: string, body: string) {
  const ts = await mention(e.h, e.A, user, body);
  const a = await waitFor(() => {
    const inbox = inboxOf(e, ts);
    const row = inbox && e.L.rows("approval_requests", { inbox_id: inbox.id })[0];
    return row?.status === "awaiting_approval" && row.message_ts ? row : undefined;
  }, 10000, "approval button posted");
  return { ts, a };
}
const click = (ws: Workspace, message_ts: string, user: string, action_id = "approval.approve") =>
  simulate(ws, "block-actions", { channel: ws.channel_id, message_ts, action_id, user });
const approval = (e: Env, id: string) => e.L.rows("approval_requests", { id })[0]!;
const resolveActions = (e: Env, id: string) => e.L.rows("actions", { action_key: `approval.resolve:${id}` });
const denials = (e: Env, id: string) => e.L.rows("run_audit").filter((r) => r.kind === "approval_denied" && JSON.parse(r.detail).approval_id === id).map((r) => JSON.parse(r.detail).reason);
const approvalReceipt = (e: Env, a: Record<string, any>) => getObjectText(e.s3, e.h.floci!.bucket, `receipts/${a.tenant_id}/approval-${a.id}.json`);

describe("W01–W03 on the local stack", () => {
  let e: Env;
  const reps: { W01: any[]; W02: any[]; W03: any[] } = { W01: [], W02: [], W03: [] };
  beforeAll(async () => {
    e = await setup();
  });
  afterAll(async () => {
    if (e) writeFileSync(join(runDir(e.h.manifest.config.run_id), "happy-reps.json"), JSON.stringify(reps, null, 2));
    e?.L.close();
    await e?.h.stop();
  });

  let w01First: { ts: string; ticketId: number; stimulus: string };
  it("W01-H ×5: one ticket, one matching S3 receipt and one completion reply each (all outcomes kept)", async () => {
    for (let n = 1; n <= 5; n++) {
      const t0 = performance.now();
      const stimulus = text("W01-H", n);
      const ts = await mention(e.h, e.A, "dana", stimulus);
      const o = await waitTicketDone(e, ts, stimulus).catch(() => observeTicket(e, ts, stimulus));
      reps.W01.push({ rep: n, ms_to_verified: Math.round(performance.now() - t0), ...o, ticket: undefined });
      if (n === 1) w01First = { ts, ticketId: o.ticket?.id, stimulus };
    }
    await settle();
    for (const r of reps.W01 as any[]) {
      expect(r).toMatchObject({ ticket_count: 1, receipt_count: 1, receipt_matches_request: true, completion_reply_count: 1, completion_reply_scripted: true, receipt_status: "committed" });
    }
  });

  it("W01-D: a signed retry of the same event adds no ticket, receipt or reply", async () => {
    const inbox = inboxOf(e, w01First.ts)!;
    const tickets = e.L.rows("tickets").length;
    const outbox = e.L.rows("outbox").length;
    const r = await simulate(e.A, "event-retry", { event_id: inbox.event_id, reason: "http_timeout" });
    expect(r).toMatchObject({ ok: true, success: true });
    await waitFor(() => inboxOf(e, w01First.ts)!.delivery_count === 2, 5000, "retry recorded");
    await settle(1500);
    expect(e.L.rows("tickets")).toHaveLength(tickets);
    expect(e.L.rows("outbox")).toHaveLength(outbox);
    expect(await observeTicket(e, w01First.ts, w01First.stimulus)).toMatchObject({ ticket_count: 1, receipt_count: 1, completion_reply_count: 1 });
  });

  it("W01-B: the bot's own service-request mention creates no job", async () => {
    const tickets = e.L.rows("tickets").length;
    const r = await api(e.h, e.A, e.A.tokens.worker)("chat.postMessage", { channel: e.A.channel_id, text: `<@${e.A.bot_user_id}> ${CASES["W01-B"].text}` });
    const row = await waitFor(() => inboxOf(e, r.ts), 5000, "bot event");
    await settle(1000);
    expect(row).toMatchObject({ status: "ignored", reason: "own_bot_message" });
    expect(e.L.rows("tickets")).toHaveLength(tickets);
    expect(e.L.rows("outbox").filter((o) => o.kind === "sqs.send" && o.payload.includes(row.event_id))).toHaveLength(0);
  });

  let approved: Record<string, any>;
  it("W02-H ×5: an authorized second person approves; one transition and a request-bound receipt each", async () => {
    for (let n = 1; n <= 5; n++) {
      const t0 = performance.now();
      const { ts, a } = await requestApproval(e, "dana", text("W02-H", n));
      expect((await click(e.A, a.message_ts, "eli")).ok).toBe(true);
      const done = await waitFor(async () => (await repliesWith(e, e.A, ts, "approved by")).length === 1 && approval(e, a.id).receipt_status === "committed", 15000, "approval receipt").catch(() => false);
      const row = approval(e, a.id);
      const object = await approvalReceipt(e, row);
      const receipt = object ? JSON.parse(object) : undefined;
      reps.W02.push({
        rep: n, ms_to_verified: Math.round(performance.now() - t0), done, status: row.status, approver_is_eli: row.approver_id === e.A.users.eli,
        resolve_actions: resolveActions(e, a.id).length,
        receipt_matches_request: !!receipt && sha256(object!) === row.receipt_sha256 && receipt.input.request_digest === row.request_digest &&
          receipt.input.approver_id === e.A.users.eli && receipt.subject_action_id === row.action_id && receipt.input.amount_cents === 12500 &&
          receipt.input_sha256 === sha256(canonical(receipt.input)),
        approved_replies: (await repliesWith(e, e.A, ts, "approved by")).length,
        no_payment_notice: (await repliesWith(e, e.A, ts, "No payment was executed")).length === 1,
      });
      if (n === 1) approved = { ...row, ts };
    }
    for (const r of reps.W02 as any[]) {
      expect(r).toMatchObject({ done: true, status: "approved", approver_is_eli: true, resolve_actions: 1, receipt_matches_request: true, approved_replies: 1, no_payment_notice: true });
    }
  });

  it("W02-R: replaying the same approval adds no second transition or receipt", async () => {
    const sha = approval(e, approved.id).receipt_sha256;
    expect((await click(e.A, approved.message_ts, "eli")).ok).toBe(true);
    await waitFor(() => denials(e, approved.id).includes("not_pending"), 5000, "replay refused");
    await settle();
    expect(approval(e, approved.id)).toMatchObject({ status: "approved", receipt_sha256: sha });
    expect(resolveActions(e, approved.id)).toHaveLength(1);
    expect(e.L.rows("actions", { action_key: `receipt.put:receipts/${approved.tenant_id}/approval-${approved.id}.json` })).toHaveLength(1);
    expect(await repliesWith(e, e.A, approved.ts, "approved by")).toHaveLength(1);
  });

  // A signed event-retry of an already processed request: nothing new anywhere, and the inbox row keeps its status.
  async function retryAddsNothing(ts: string) {
    const inbox = inboxOf(e, ts)!;
    const snap = async () => ({
      approvals: e.L.rows("approval_requests").length, tickets: e.L.rows("tickets").length, actions: e.L.rows("actions").length,
      outbox: e.L.rows("outbox").length, crm: JSON.stringify(e.L.rows("crm_accounts")), replies: (await botReplies(e.h, e.A, ts)).length,
    });
    const before = await snap();
    expect(await simulate(e.A, "event-retry", { event_id: inbox.event_id, reason: "http_timeout" })).toMatchObject({ ok: true, success: true });
    await waitFor(() => inboxOf(e, ts)!.delivery_count === inbox.delivery_count + 1, 5000, "retry recorded");
    await settle(1500);
    expect(await snap()).toEqual(before);
    expect(inboxOf(e, ts)).toMatchObject({ status: "done", reason: inbox.reason });
  }

  it("W02 dedupe: a signed retry of the request event adds no approval, action, outbox row or reply", async () => {
    await retryAddsNothing(approved.ts);
  });

  it("W02-U / F3-A2: the requester or an ungranted user cannot approve; status stays awaiting_approval", async () => {
    const { a } = await requestApproval(e, "dana", CASES["W02-U"].text);
    // The requester holds approval.resolve, so only the self-approval rule can refuse her own click.
    expect(e.L.rows("grants", { tenant_id: "T_LAB_A", user_id: e.A.users.dana!, permission: "approval.resolve" })[0]).toMatchObject({ active: 1 });
    await click(e.A, a.message_ts, "dana");
    await settle();
    expect(approval(e, a.id)).toMatchObject({ status: "awaiting_approval", approver_id: null, receipt_status: null });
    expect(resolveActions(e, a.id)).toHaveLength(0);
    expect(await approvalReceipt(e, a)).toBeUndefined();
    await waitFor(() => denials(e, a.id).length === 1, 5000, "self-approval refused");
    await click(e.A, a.message_ts, "gus");
    await waitFor(() => denials(e, a.id).length === 2, 5000, "denials recorded");
    expect(denials(e, a.id)).toEqual(["self_approval", "no_grant"]);
    expect(approval(e, a.id).status).toBe("awaiting_approval");
    expect(resolveActions(e, a.id)).toHaveLength(0);
    expect(await approvalReceipt(e, a)).toBeUndefined();
  });

  it("W02-C: editing the request invalidates the earlier approval button", async () => {
    const { ts, a } = await requestApproval(e, "dana", CASES["W02-C"].text);
    await mention(e.h, e.A, "dana", CASES["W02-C"].edit.replace("{ref}", a.id), ts);
    const edited = await waitFor(() => {
      const r = approval(e, a.id);
      return r.version === 2 && r.message_ts !== a.message_ts ? r : undefined;
    }, 10000, "edited request re-posted");
    expect(edited.request_digest).not.toBe(a.request_digest);
    await click(e.A, a.message_ts, "eli"); // old button, old digest
    await waitFor(() => denials(e, a.id).includes("stale_request_digest"), 5000, "stale click refused");
    expect(approval(e, a.id).status).toBe("awaiting_approval");
    expect(await approvalReceipt(e, a)).toBeUndefined();
    await click(e.A, edited.message_ts, "eli"); // current button
    await waitFor(() => approval(e, a.id).receipt_status === "committed", 10000, "current approval committed");
    const receipt = JSON.parse((await approvalReceipt(e, a))!);
    expect(receipt.input).toMatchObject({ request_digest: edited.request_digest, amount_cents: 15000 });
  });

  it("W02-P: an approver whose permission was revoked before the click is denied by current policy", async () => {
    const { a } = await requestApproval(e, "dana", CASES["W02-P"].text);
    const admin = openLedger(e.h.manifest.db_path); // test coordinator acting as policy administrator
    setGrant(admin, "T_LAB_A", e.A.users.eli!, "approval.resolve", false);
    await click(e.A, a.message_ts, "eli");
    await waitFor(() => denials(e, a.id).includes("no_grant"), 5000, "revoked approver refused");
    setGrant(admin, "T_LAB_A", e.A.users.eli!, "approval.resolve", true);
    admin.close();
    expect(approval(e, a.id).status).toBe("awaiting_approval");
    expect(resolveActions(e, a.id)).toHaveLength(0);
  });

  it("W02-F: an interaction copied into another workspace causes no cross-tenant action or disclosure", async () => {
    const { ts, a } = await requestApproval(e, "dana", "purchase-request 12500 cross-tenant probe");
    const aReplies = (await botReplies(e.h, e.A, ts)).length;
    const value = `${a.id}:${a.request_digest}`;
    const copy = await api(e.h, e.B, e.B.tokens.worker)("chat.postMessage", {
      channel: e.B.channel_id, text: "copied approval",
      blocks: [{ type: "actions", elements: [{ type: "button", action_id: "approval.approve", text: { type: "plain_text", text: "Approve" }, value }] }],
    });
    expect((await click(e.B, copy.ts, "hana")).ok).toBe(true);
    await waitFor(() => e.L.rows("run_audit", { tenant_id: "T_LAB_B" }).some((r) => r.kind === "approval_denied" && JSON.parse(r.detail).reason === "not_found"), 5000, "B denial");
    await settle();
    expect(approval(e, a.id).status).toBe("awaiting_approval");
    expect(resolveActions(e, a.id)).toHaveLength(0);
    expect(await botReplies(e.h, e.B, copy.ts)).toHaveLength(0); // nothing disclosed in B
    expect((await botReplies(e.h, e.A, ts)).length).toBe(aReplies);
    expect(e.L.rows("run_audit", { tenant_id: "T_LAB_B" }).filter((r) => r.kind === "approval_denied").every((r) => JSON.parse(r.detail).approval_id === null)).toBe(true);
  });

  it("the worker's own Slack client and token cannot reach the simulator; a forged approval is refused at the proxy", async () => {
    const { a } = await requestApproval(e, "dana", "purchase-request 12500 forged approval probe");
    const inst = e.h.workerConfig!.installations.find((i) => i.installation_id === "A")!;
    const forge = (method: string, path: string, body?: object) => fetch(`${inst.api_url}${path}`, {
      method, headers: { authorization: `Bearer ${inst.bot_token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const r = await forge("POST", "/_slack/simulate/block-actions", { channel: e.A.channel_id, message_ts: a.message_ts, action_id: "approval.approve", user: "eli" });
    await settle();
    expect(approval(e, a.id)).toMatchObject({ status: "awaiting_approval", approver_id: null });
    expect(resolveActions(e, a.id)).toHaveLength(0);
    expect(await approvalReceipt(e, a)).toBeUndefined();
    expect(r.status).toBe(403);
    expect((await forge("POST", "/_slack/simulate/event-retry", { event_id: inboxOf(e, w01First.ts)!.event_id })).status).toBe(403);
    expect((await forge("GET", "/_emulate")).status).toBe(403);
    expect((await forge("POST", "/api/conversations.history", { channel: e.A.channel_id })).status).toBe(403);
    // The worker is configured with the proxy only: no emulator URL, and no emulator port on its allowlist.
    const emulatorPorts = e.h.workspaces.map((w) => Number(new URL(w.url).port));
    for (const i of e.h.workerConfig!.installations) expect(emulatorPorts).not.toContain(Number(new URL(i.api_url).port));
    expect(e.h.workerConfig!.allowlist.filter((x) => emulatorPorts.includes(x.port))).toEqual([]);
  });

  let w03Last: string;
  it("W03-H ×5: authorized update with matching version changes only the description and advances the version", async () => {
    for (let n = 1; n <= 5; n++) {
      const t0 = performance.now();
      const ts = (w03Last = await mention(e.h, e.A, "fran", text("W03-H", n)));
      const done = await waitFor(async () => (await repliesWith(e, e.A, ts, `version ${n} → ${n + 1}`)).length === 1, 10000, "crm reply").catch(() => false);
      const acct = e.L.rows("crm_accounts", { tenant_id: "T_LAB_A", account_id: "acct-northstar" })[0]!;
      reps.W03.push({
        rep: n, ms_to_verified: Math.round(performance.now() - t0), done, version: acct.version, description: acct.description, name: acct.name,
        actions: e.L.rows("actions").filter((x) => x.operation === "crm.description.update").length,
      });
    }
    (reps.W03 as any[]).forEach((r, i) =>
      expect(r).toMatchObject({ done: true, version: i + 2, description: "Workshop follow-up requested", name: "Northstar Demo", actions: i + 1 }));
  });

  it("W03 dedupe: a signed retry of an applied update event changes no version, action, outbox row or reply", async () => {
    await retryAddsNothing(w03Last);
  });

  it("W03-V / F3-A3: a stale expected version is a CONFLICT and nothing is overwritten", async () => {
    const before = e.L.rows("crm_accounts", { account_id: "acct-cedar" })[0]!;
    const writes = e.L.rows("actions").length;
    const ts = await mention(e.h, e.A, "fran", CASES["W03-V"].text);
    await waitFor(async () => (await repliesWith(e, e.A, ts, "CONFLICT")).length === 1, 10000, "conflict reply");
    expect(e.L.rows("crm_accounts", { account_id: "acct-cedar" })[0]).toMatchObject({ version: 2, description: before.description, updated_at: before.updated_at });
    expect(e.L.rows("actions")).toHaveLength(writes);
    expect(inboxOf(e, ts)).toMatchObject({ status: "denied", reason: "CONFLICT" });
  });

  it("W03-U: an actor without write authority changes nothing", async () => {
    const before = e.L.rows("crm_accounts", { account_id: "acct-northstar" })[0]!;
    const ts = await mention(e.h, e.A, "gus", CASES["W03-U"].text);
    await waitFor(() => inboxOf(e, ts)?.status === "denied", 10000, "denied");
    expect(inboxOf(e, ts)!.reason).toBe("no_grant");
    expect(e.L.rows("crm_accounts", { account_id: "acct-northstar" })[0]).toEqual(before);
  });

  it("W03-W: naming another tenant's account keeps the bound tenant and is denied", async () => {
    const harbor = e.L.rows("crm_accounts", { tenant_id: "T_LAB_B" })[0]!;
    const ts = await mention(e.h, e.A, "fran", CASES["W03-W"].text);
    await waitFor(() => inboxOf(e, ts)?.status === "denied", 10000, "denied");
    expect(inboxOf(e, ts)).toMatchObject({ tenant_id: "T_LAB_A", reason: "account_not_found_in_bound_tenant" });
    expect(e.L.rows("crm_accounts", { tenant_id: "T_LAB_B" })[0]).toEqual(harbor);
    expect(e.L.rows("run_audit").some((r) => r.kind === "tenant_hint_ignored" && JSON.parse(r.detail).inbox_id === inboxOf(e, ts)!.id)).toBe(true);
  });

  it("W03-N: a missing target, missing expected version or unsupported field is invalid input with no write", async () => {
    const snapshot = JSON.stringify(e.L.rows("crm_accounts"));
    const writes = e.L.rows("actions").length;
    const reasons: string[] = [];
    for (const t of CASES["W03-N"].texts as string[]) {
      const ts = await mention(e.h, e.A, "fran", t);
      reasons.push((await waitFor(() => (inboxOf(e, ts)?.status === "denied" ? inboxOf(e, ts) : undefined), 10000, "invalid")).reason);
    }
    expect(reasons).toEqual(["missing_target_or_expected_version", "missing_target_or_expected_version", "unsupported_field:name"]);
    expect(JSON.stringify(e.L.rows("crm_accounts"))).toBe(snapshot);
    expect(e.L.rows("actions")).toHaveLength(writes);
  });

  it("W02-X: an approval that expires before the click is expired, with no approval receipt", async () => {
    await e.h.stopWorker();
    await e.h.startWorker({ approval_ttl_ms: CASES["W02-X"].approval_ttl_ms });
    const { ts, a } = await requestApproval(e, "dana", CASES["W02-X"].text);
    await settle(CASES["W02-X"].approval_ttl_ms + 400);
    await click(e.A, a.message_ts, "eli");
    await waitFor(() => approval(e, a.id).status === "expired", 5000, "expired");
    await waitFor(async () => (await repliesWith(e, e.A, ts, "expired")).length === 1, 5000, "expiry feedback");
    expect(approval(e, a.id).approver_id).toBeNull();
    expect(resolveActions(e, a.id)).toHaveLength(0);
    expect(await approvalReceipt(e, a)).toBeUndefined();
  });
});

// Each fault case gets its own fresh run (Floci, emulators, proxies, ledger), so one case's leftover rule,
// ticket or worker state cannot make another fail. Each case installs its rules, then starts the worker.
describe("W01 faults through the loopback fault proxy (simulated faults)", () => {
  let e: Env;
  let slackProxy: FaultProxy;
  let flociProxy: FaultProxy;
  const workerOpts = () => ({ overrides: { A: { api_url: slackProxy.url } }, floci_endpoint: flociProxy.url, slack_timeout_ms: 1500 });
  beforeEach(async () => {
    e = await setup({ slack: true, worker: false, extraPorts: ["fault_slack", "fault_floci"] });
    slackProxy = await startFaultProxy(e.h.manifest.ports.fault_slack!, e.A.url);
    flociProxy = await startFaultProxy(e.h.manifest.ports.fault_floci!, e.h.flociEndpoint);
  });
  afterEach(async () => {
    e?.L.close();
    await e?.h.stop();
    await slackProxy?.close();
    await flociProxy?.close();
  });
  const auditFor = (kind: string, pred: (d: any) => boolean = () => true) => e.L.rows("run_audit").filter((r) => r.kind === kind && pred(JSON.parse(r.detail)));

  it("W01-S: S3 failure keeps the ticket, withholds completion, and an explicit recovery finishes it once", async () => {
    flociProxy.rules.push({ name: "s3-put-500", action: "http500", match: (r) => r.method === "PUT" && r.url.includes("/receipts/") });
    await e.h.startWorker(workerOpts());
    const ts = await mention(e.h, e.A, "dana", CASES["W01-S"].text);
    const t = await waitFor(() => {
      const inbox = inboxOf(e, ts);
      const row = inbox && e.L.rows("tickets", { inbox_id: inbox.id })[0];
      return row?.receipt_status === "failed" ? row : undefined;
    }, 20000, "receipt marked failed");
    await settle(1000);
    const key = `receipts/T_LAB_A/ticket-${t.id}.json`;
    expect(auditFor("receipt_put_failed", (d) => d.key === key)).toHaveLength(3); // max_retries=2 → 3 bounded attempts
    expect(auditFor("receipt_incomplete", (d) => d.ticket_id === t.id)).toHaveLength(1);
    expect(await observeTicket(e, ts, CASES["W01-S"].text)).toMatchObject({ ticket_count: 1, receipt_count: 0, completion_reply_count: 0 });

    flociProxy.clear();
    await e.h.stopWorker();
    await e.h.startWorker(workerOpts()); // explicit recovery path: restart retries incomplete receipts
    const o = await waitTicketDone(e, ts, CASES["W01-S"].text);
    expect(o).toMatchObject({ ticket_count: 1, receipt_count: 1, receipt_matches_request: true, completion_reply_count: 1 });
    expect(auditFor("receipt_recovery", (d) => d.ticket_id === t.id)).toHaveLength(1);
  });

  it("W01-Q: a redelivered queue message is recognised and creates no duplicate ticket", async () => {
    flociProxy.rules.push({
      name: "sqs-delete-500", action: "http500", times: 1,
      match: (r) => r.headers["x-amz-target"] === "AmazonSQS.DeleteMessage" || r.body.includes("Action=DeleteMessage"),
    });
    await e.h.startWorker(workerOpts());
    const ts = await mention(e.h, e.A, "dana", CASES["W01-Q"].text);
    const o = await waitTicketDone(e, ts, CASES["W01-Q"].text);
    await waitFor(() => auditFor("duplicate_job", (d) => d.ticket_id === o.ticket!.id).length >= 1, 15000, "redelivery recognised");
    await settle(1500);
    expect(flociProxy.hits["sqs-delete-500"]).toBe(1);
    expect(auditFor("ack_failed", (d) => d.ticket_id === o.ticket!.id)).toHaveLength(1);
    expect(await observeTicket(e, ts, CASES["W01-Q"].text)).toMatchObject({ ticket_count: 1, receipt_count: 1, completion_reply_count: 1 });
    expect(e.L.rows("tickets").filter((x) => x.action_key === o.ticket!.action_key)).toHaveLength(1);
  });

  it("W01-T: a reply accepted by Slack whose response times out is UNKNOWN and is never re-posted", async () => {
    slackProxy.rules.push({ name: "reply-held", action: "hold-response", times: 1, match: (r) => r.url === "/api/chat.postMessage" && r.body.includes("Ticket #") });
    await e.h.startWorker(workerOpts());
    const ts = await mention(e.h, e.A, "dana", CASES["W01-T"].text);
    const reply = await waitFor(() => e.L.rows("outbox", { kind: "slack.reply" }).find((x) => x.status === "unknown"), 20000, "reply outcome unknown");
    await settle(2500);
    expect(slackProxy.hits["reply-held"]).toBe(1);
    expect(e.L.rows("outbox", { id: reply.id })[0]).toMatchObject({ status: "unknown", attempts: 1 });
    expect(auditFor("outbox_unknown", (d) => d.outbox_id === reply.id)).toHaveLength(1);
    // Slack really has the one reply; the worker neither duplicated it nor announced anything else.
    expect(await observeTicket(e, ts, CASES["W01-T"].text)).toMatchObject({ ticket_count: 1, receipt_count: 1, receipt_matches_request: true, completion_reply_count: 1 });
    expect(slackProxy.seen.filter((s) => s.url === "/api/chat.postMessage").length).toBe(
      e.L.rows("outbox", { kind: "slack.reply" }).filter((x) => x.installation_id === "A" && x.status !== "pending").length,
    );
  });

  it("W01 job-time authority: a grant revoked between request and SQS job creates no ticket and is denied explicitly", async () => {
    // Hold the job in the queue (every ReceiveMessage fails) until the grant has been revoked.
    flociProxy.rules.push({ name: "sqs-receive-500", action: "http500", match: (r) => r.headers["x-amz-target"] === "AmazonSQS.ReceiveMessage" || r.body.includes("Action=ReceiveMessage") });
    await e.h.startWorker(workerOpts());
    const ts = await mention(e.h, e.A, "dana", "service-request coffee machine leaking");
    await waitFor(() => {
      const inbox = inboxOf(e, ts);
      return inbox && e.L.rows("outbox", { kind: "sqs.send" }).some((o) => o.status === "sent" && o.payload.includes(inbox.event_id));
    }, 10000, "job queued");
    const admin = openLedger(e.h.manifest.db_path); // test coordinator acting as policy administrator
    setGrant(admin, "T_LAB_A", e.A.users.dana!, "ticket.create", false);
    admin.close();
    flociProxy.clear();
    await waitFor(async () => (await repliesWith(e, e.A, ts, "Not performed (ticket.create)")).length === 1, 15000, "job-time denial reply");
    await settle(1500);
    expect(e.L.rows("tickets")).toHaveLength(0);
    expect(e.L.rows("actions", { operation: "ticket.create" })).toHaveLength(0);
    expect(auditFor("job_denied", (d) => d.reason === "no_grant")).toHaveLength(1);
    expect(await repliesWith(e, e.A, ts, "created")).toHaveLength(0);
    expect(await botReplies(e.h, e.A, ts)).toHaveLength(1);
  });
});
