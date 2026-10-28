// F2: signed events, thread replies, bot loops and signed retries.
import { simulate } from "../../adapters/slack/emulator.ts";
import type { Probe } from "../probe.ts";
import { inboxOf, mention, post, sleep, STIMULI, stimulus, ticketDone, waitFor, ws } from "../drive.ts";
import type { CaseDef } from "../types.ts";

const completion = (m: Record<string, any>) => m.bot_id && /Ticket #\d+ created/.test(String(m.text));

export const F2_A1: CaseDef = {
  async execute({ h, ref }) {
    const A = ws(h);
    const ts = await mention(h, A, "dana", stimulus("W01-H"));
    await ticketDone(h, ts);
    // Bot-loop stimulus: the bot's own mention (posted with the bot token by the test coordinator).
    const botTs = await post(h, A, A.tokens.worker, { text: `<@${A.bot_user_id}> ${STIMULI["W01-B"].text}` });
    await waitFor(() => inboxOf(h, botTs), 10000, "bot event recorded");
    await sleep(1000);
    ref("ts", ts);
    ref("bot_ts", botTs);
  },
  async observe(p) {
    const { ts, bot_ts } = p.refs;
    const bot = p.ws("T_LAB_A").bot_user_id;
    await p.capture("inbox", "read-only SQLite query (inbox)", () => p.rows("inbox", { tenant_id: "T_LAB_A" }));
    await p.capture("thread", "Slack conversations.replies (reader token)", () => p.replies("T_LAB_A", ts));
    await p.capture("history", "Slack conversations.history (reader token)", () => p.history("T_LAB_A"));
    await p.capture("bot-loop", "read-only SQLite query (inbox, outbox, tickets)", () => {
      const row = p.rows("inbox", { message_ts: bot_ts })[0] ?? null;
      return {
        bot_inbox: row, bot_requested_tickets: p.rows("tickets", { requester_id: bot }),
        bot_jobs: row ? p.rows("outbox", { kind: "sqs.send" }).filter((o) => String(o.payload).includes(row.event_id)) : [],
      };
    });
    p.fact("accepted_event_count", ["inbox"], () => p.data<any[]>("inbox").filter((r) => ["received", "processing", "done"].includes(r.status)).length);
    p.fact("completion_reply_count", ["thread"], () => p.data<any[]>("thread").filter((m) => m.ts !== ts && completion(m)).length);
    p.fact("reply_in_original_thread", ["thread", "history"], () => {
      const replies = p.data<any[]>("thread").filter((m) => m.ts !== ts && completion(m));
      const topLevel = p.data<any[]>("history").filter((m) => completion(m) && (!m.thread_ts || m.thread_ts === m.ts));
      return replies.length > 0 && replies.every((m) => m.thread_ts === ts) && topLevel.length === 0;
    });
    p.fact("bot_loop_job_count", ["bot-loop", "inbox"], () => {
      const b = p.data("bot-loop");
      const botAccepted = p.data<any[]>("inbox").filter((r) => r.actor_id === bot && r.status !== "ignored").length;
      if (!b.bot_inbox) throw new Error("bot stimulus never reached the ledger");
      return b.bot_jobs.length + b.bot_requested_tickets.length + botAccepted;
    });
  },
};

async function snapshot(p: Probe, tag: string) {
  const { ts } = p.refs;
  await p.capture(`${tag}-ledger`, "read-only SQLite query (inbox, tickets, actions, outbox, approval_requests)", () => ({
    inbox: p.rows("inbox", { message_ts: ts }).map((r) => ({ id: r.id, event_id: r.event_id, delivery_count: r.delivery_count, last_retry_num: r.last_retry_num, status: r.status })),
    business_records: { tickets: p.rows("tickets").length, actions: p.rows("actions").length, outbox: p.rows("outbox").length, approval_requests: p.rows("approval_requests").length },
  }));
  await p.capture(`${tag}-s3`, "S3 ListObjectsV2 (collector client, own credentials)", () => p.s3Keys());
  await p.capture(`${tag}-thread`, "Slack conversations.replies (reader token)", () => p.replies("T_LAB_A", ts));
}
const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

export const F2_A2: CaseDef = {
  async execute({ h, ref, snapshot }) {
    const A = ws(h);
    const ts = await mention(h, A, "dana", stimulus("W01-H"));
    await ticketDone(h, ts);
    await sleep(500);
    ref("ts", ts);
    await snapshot("before");
    const inbox = inboxOf(h, ts)!;
    const r = await simulate(A, "event-retry", { event_id: inbox.event_id, reason: "http_timeout" });
    if (!r.ok) throw new Error(`event-retry simulate failed: ${r.error}`);
    await waitFor(() => inboxOf(h, ts)?.delivery_count === 2, 10000, "signed retry delivered");
    await sleep(1500);
  },
  phases: { before: (p) => snapshot(p, "before") },
  async observe(p) {
    await snapshot(p, "after");
    const all = ["before-ledger", "before-s3", "after-ledger", "after-s3"];
    p.fact("additional_business_records", all, () =>
      total(p.data("after-ledger").business_records) + p.data<string[]>("after-s3").length - total(p.data("before-ledger").business_records) - p.data<string[]>("before-s3").length);
    p.fact("additional_completion_replies", ["before-thread", "after-thread"], () =>
      p.data<any[]>("after-thread").filter(completion).length - p.data<any[]>("before-thread").filter(completion).length);
    p.fact("same_request_identity", ["before-ledger", "after-ledger"], () => {
      const [b] = p.data("before-ledger").inbox, [a] = p.data("after-ledger").inbox;
      return p.data("before-ledger").inbox.length === 1 && p.data("after-ledger").inbox.length === 1 &&
        a.id === b.id && a.event_id === b.event_id && a.delivery_count === b.delivery_count + 1 && a.last_retry_num === 1;
    });
  },
};
