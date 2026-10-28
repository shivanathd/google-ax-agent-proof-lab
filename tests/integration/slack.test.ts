// Task 2.1 against real Emulate Slack instances and a separately spawned worker process.
// Every assertion about Slack state uses conversations.history/replies with a separate read-only token.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRun, type RunHandle } from "../../src/config/lifecycle.ts";
import { simulate, type Workspace } from "../../src/adapters/slack/emulator.ts";
import { BODY_LIMIT_BYTES } from "../../src/http/slack.ts";
import { api, botReplies, eventBody, eventsUrl, history, interactionsUrl, ledger, mention, settle, signedPost, thread, waitFor } from "./helpers.ts";

describe("signed events, threads, dedupe, bot loops and tenant binding", () => {
  let h: RunHandle;
  let A: Workspace;
  let B: Workspace;
  let L: ReturnType<typeof ledger>;
  let first: { ts: string; event_id: string; inbox_id: number };
  beforeAll(async () => {
    h = await startRun({ floci: false, slack: true });
    [A, B] = h.workspaces as [Workspace, Workspace];
    L = ledger(h);
  });
  afterAll(async () => {
    L?.close();
    await h?.stop();
  });
  const inboxFor = (ts: string) => L.rows("inbox", { message_ts: ts });

  it("F2-A1: one accepted event and one bot reply in the original thread", async () => {
    const ts = await mention(h, A, "dana", "service-request printer offline on floor two");
    const replies = await waitFor(async () => ((await botReplies(h, A, ts)).length ? botReplies(h, A, ts) : undefined), 10000, "bot reply");
    await settle();
    const inbox = inboxFor(ts);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ tenant_id: "T_LAB_A", installation_id: "A", status: "done", verified_signature: 1, actor_id: A.users.dana, delivery_count: 1 });
    expect(inbox[0]!.raw_body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ bot_id: "B_LABBOT", thread_ts: ts });
    // The bot's own reply produced no new job.
    expect(L.rows("inbox").filter((r) => r.actor_id === A.bot_user_id)).toHaveLength(0);
    expect(L.rows("inbox")).toHaveLength(1);
    first = { ts, event_id: inbox[0]!.event_id, inbox_id: inbox[0]!.id };
  });

  it("replies into the parent thread when the mention is itself a thread reply", async () => {
    const root = await mention(h, A, "fran", "starting a thread");
    await waitFor(async () => (await botReplies(h, A, root)).length === 1, 10000, "root reply");
    const child = await mention(h, A, "fran", "service-request projector in room 4", root);
    await waitFor(async () => (await botReplies(h, A, root)).length === 2, 10000, "threaded reply");
    expect(inboxFor(child)[0]).toMatchObject({ thread_ts: root });
    const top = await history(h, A);
    expect(top.filter((m) => m.bot_id && !m.thread_ts)).toHaveLength(0); // never a new top-level message
  });

  it("F2-A2: a signed retry of a processed event adds no business record and no reply", async () => {
    const outboxBefore = L.rows("outbox").length;
    const r = await simulate(A, "event-retry", { event_id: first.event_id, reason: "http_timeout" });
    expect(r).toMatchObject({ ok: true, retry_num: 1, success: true });
    await waitFor(() => inboxFor(first.ts)[0]?.delivery_count === 2, 5000, "retry delivery");
    await settle();
    const inbox = inboxFor(first.ts);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ id: first.inbox_id, event_id: first.event_id, last_retry_num: 1, status: "done" });
    expect(L.rows("outbox")).toHaveLength(outboxBefore);
    expect(await botReplies(h, A, first.ts)).toHaveLength(1);
    expect(L.rows("run_audit").filter((a) => a.kind === "duplicate_delivery")).toHaveLength(1);
  });

  it("ignores the bot's own mention (bot loop) and records why", async () => {
    const r = await api(h, A, A.tokens.worker)("chat.postMessage", { channel: A.channel_id, text: `<@${A.bot_user_id}> echo from LabBot` });
    expect(r.ok).toBe(true);
    const row = await waitFor(() => inboxFor(r.ts)[0], 5000, "bot event recorded");
    await settle();
    expect(row).toMatchObject({ status: "ignored", reason: "own_bot_message" });
    expect(L.rows("outbox").filter((o) => o.action_key === `ack:${row.id}`)).toHaveLength(0);
    expect(await botReplies(h, A, r.ts)).toHaveLength(0);
  });

  it("G-SIG: forged or tampered signatures are rejected before anything is stored", async () => {
    const before = L.rows("inbox").length;
    const body = eventBody(A, A.users.dana!, "forged request");
    expect((await signedPost(eventsUrl(h, A), "not-the-secret", body)).status).toBe(401);
    const good = await signedPost(eventsUrl(h, A), A.signing_secret, eventBody(A, A.users.dana!, "probe"), { signature: "v0=deadbeef" });
    expect(good.status).toBe(401);
    const ts = Math.floor(Date.now() / 1000);
    const { sign } = await import("../../src/adapters/slack/signature.ts");
    const tampered = await signedPost(eventsUrl(h, A), A.signing_secret, body.replace("forged", "f0rged"), { ts, signature: sign(A.signing_secret, ts, body) });
    expect(tampered.status).toBe(401);
    expect(L.rows("inbox")).toHaveLength(before);
    expect(L.rows("run_audit").filter((a) => a.kind === "signature_rejected" && JSON.parse(a.detail).reason === "bad_signature").length).toBe(3);
  });

  it("G-OLD: a valid signature with a stale timestamp is rejected", async () => {
    const before = L.rows("inbox").length;
    const res = await signedPost(eventsUrl(h, A), A.signing_secret, eventBody(A, A.users.dana!, "old"), { ts: Math.floor(Date.now() / 1000) - 6 * 60 });
    expect(res.status).toBe(401);
    expect(L.rows("inbox")).toHaveLength(before);
    expect(L.rows("run_audit").some((a) => a.kind === "signature_rejected" && JSON.parse(a.detail).reason === "stale_timestamp")).toBe(true);
  });

  it(`rejects bodies over ${BODY_LIMIT_BYTES} bytes before parsing`, async () => {
    const before = L.rows("inbox").length;
    const big = eventBody(A, A.users.dana!, "x".repeat(BODY_LIMIT_BYTES + 1));
    expect((await signedPost(eventsUrl(h, A), A.signing_secret, big)).status).toBe(413);
    expect(L.rows("inbox")).toHaveLength(before);
  });

  it("binds tenant to the verified installation: cross-workspace copies and mismatched apps are denied", async () => {
    const ts = await mention(h, B, "ivan", "service-request ladder for warehouse");
    await waitFor(async () => (await botReplies(h, B, ts)).length === 1, 10000, "B reply");
    expect(inboxFor(ts)[0]).toMatchObject({ tenant_id: "T_LAB_B", installation_id: "B" });
    // Nothing from B's conversation appears in A.
    expect((await history(h, A)).some((m) => m.ts === ts)).toBe(false);

    const before = L.rows("inbox").length;
    // B's correctly signed body replayed at A's endpoint fails A's signature check.
    const copied = eventBody(B, B.users.ivan!, "copied across workspaces");
    expect((await signedPost(eventsUrl(h, A), B.signing_secret, copied)).status).toBe(401);
    // Signed with A's secret but claiming another app is refused as an installation mismatch.
    expect((await signedPost(eventsUrl(h, A), A.signing_secret, eventBody(A, A.users.dana!, "x", { api_app_id: "A_OTHER" }))).status).toBe(403);
    expect((await signedPost(`http://127.0.0.1:${h.manifest.ports.worker}/slack/Z/events`, A.signing_secret, copied)).status).toBe(404);
    expect(L.rows("inbox")).toHaveLength(before);
  });

  it("accepts signed block-action interactions and rejects forged ones", async () => {
    const msg = await api(h, A, A.tokens.worker)("chat.postMessage", {
      channel: A.channel_id, text: "Probe button",
      blocks: [{ type: "actions", elements: [{ type: "button", action_id: "probe", text: { type: "plain_text", text: "Probe" }, value: "p" }] }],
    });
    const r = await simulate(A, "block-actions", { channel: A.channel_id, message_ts: msg.ts, action_id: "probe", user: "eli" });
    expect(r.ok).toBe(true);
    await waitFor(() => L.rows("run_audit").some((a) => a.kind === "block_action_unhandled"), 5000, "interaction audit");
    const forged = await signedPost(interactionsUrl(h, A), "wrong", `payload=${encodeURIComponent(JSON.stringify(r.payload))}`, { contentType: "application/x-www-form-urlencoded" });
    expect(forged.status).toBe(401);
  });

  it("every thread observed through the read-only token matches the ledger", async () => {
    for (const row of L.rows("inbox").filter((r) => r.status === "done")) {
      const ws = row.installation_id === "A" ? A : B;
      const msgs = await thread(h, ws, row.thread_ts ?? row.message_ts);
      expect(msgs.some((m) => m.ts === row.message_ts)).toBe(true);
    }
  });
});

describe("G-SCOPE: a token without chat:write is never escalated", () => {
  let h: RunHandle;
  beforeAll(async () => {
    h = await startRun({ floci: false, slack: true, worker: { overrides: { A: { token: "narrow" } } } });
  });
  afterAll(async () => h?.stop());

  it("records missing_scope, retries nothing and posts nothing", async () => {
    const A = h.workspaces[0]!;
    expect(h.workerConfig!.installations[0]!.bot_token).toBe(A.tokens.narrow);
    expect(JSON.stringify(h.workerConfig)).not.toContain(A.tokens.worker);
    const L = ledger(h);
    const ts = await mention(h, A, "dana", "service-request stapler");
    const out = await waitFor(() => L.rows("outbox").find((o) => o.status !== "pending"), 10000, "outbox settled");
    await settle();
    expect(out).toMatchObject({ status: "failed", attempts: 1 });
    expect(JSON.parse(out.result)).toMatchObject({ error: "missing_scope", needed: "chat:write" });
    expect(L.rows("outbox")).toHaveLength(1);
    expect(await botReplies(h, A, ts)).toHaveLength(0);
    L.close();
  });
});

describe("G-REVOKE: no provider action succeeds after the app is uninstalled", () => {
  let h: RunHandle;
  beforeAll(async () => {
    h = await startRun({ floci: false, slack: true });
  });
  afterAll(async () => h?.stop());

  it("marks the installation revoked, denies later deliveries and cannot post with the revoked token", async () => {
    const A = h.workspaces[0]!;
    const L = ledger(h);
    const ts = await mention(h, A, "dana", "service-request before revoke");
    await waitFor(async () => (await botReplies(h, A, ts)).length === 1, 10000, "baseline reply");

    const un = await api(h, A, A.tokens.setup)("apps.uninstall", { client_id: A.client_id, client_secret: A.client_secret });
    expect(un.ok).toBe(true);
    await waitFor(() => L.rows("installations", { installation_id: "A" })[0]?.revoked_at, 5000, "revocation recorded");
    const direct = await api(h, A, A.tokens.worker)("chat.postMessage", { channel: A.channel_id, text: "after revoke" });
    expect(direct).toMatchObject({ ok: false, error: "token_revoked" });

    const before = (await history(h, A)).length;
    const late = eventBody(A, A.users.dana!, "service-request arriving after revoke");
    expect((await signedPost(eventsUrl(h, A), A.signing_secret, late)).status).toBe(200);
    await settle();
    const row = L.rows("inbox").find((r) => r.event_id === JSON.parse(late).event_id);
    expect(row).toMatchObject({ status: "denied", reason: "installation_revoked" });
    expect(L.rows("outbox")).toHaveLength(1); // only the pre-revocation reply
    expect((await history(h, A)).length).toBe(before);
    L.close();
  });
});
