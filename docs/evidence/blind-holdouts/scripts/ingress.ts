// BH-01 BH-02 BH-03 BH-10 BH-04 BH-05 BH-12 on one isolated run.
import { audits, botReplies, deliver, eventBody, floci, mention, postAs, q, save, sleep, start, ticketDone, W, waitFor, workerUrl, inboxSettled } from "./lib.ts";

const h = await start();
const A = W(h), B = W(h, "T_LAB_B");
const fl = floci(h);
const inboxBy = (eid: string) => q(h, "inbox", { event_id: eid });
const ticketsFor = (eid: string) => { const i = inboxBy(eid)[0]; return i ? q(h, "tickets", { inbox_id: i.id }) : []; };
try {
  // ---------- BH-01 timestamp window ----------
  {
    const obs: Record<string, any> = {};
    for (const [label, off] of [["minus300", -300], ["minus301", -301], ["plus301", 301]] as const) {
      // align to the start of a second so the receiver's clock cannot tick past the boundary
      while (Date.now() % 1000 > 50) await sleep(5);
      const base = await postAs(h, A, "dana", `bh01 anchor ${label}`);
      while (Date.now() % 1000 > 50) await sleep(5);
      const now = Math.floor(Date.now() / 1000);
      const b = eventBody(A, "dana", base, `service-request bh01 ${label}`);
      const r = await deliver(workerUrl(h, "A"), JSON.stringify(b), A.signing_secret, { ts: now + off });
      await sleep(1500);
      obs[label] = { http: r.status, inbox_rows: inboxBy(b.event_id).length, tickets: ticketsFor(b.event_id).length,
        stale_audit: audits(h, "signature_rejected").some((a) => a.detail.reason === "stale_timestamp") };
    }
    const pass = obs.minus300.http === 200 && obs.minus300.inbox_rows === 1 && [obs.minus301, obs.plus301].every((o) => o.http === 401 && o.inbox_rows === 0 && o.tickets === 0);
    save({ id: "BH-01", observed: obs, verdict: pass ? "PASS" : "FAIL" });
  }

  // ---------- BH-02 body size boundary ----------
  {
    const obs: Record<string, any> = {};
    for (const size of [65536, 65537]) {
      const base = await postAs(h, A, "dana", `bh02 anchor ${size}`);
      const b: any = eventBody(A, "dana", base, `service-request bh02 size ${size}`, undefined, { padding: "" });
      const len0 = Buffer.byteLength(JSON.stringify(b));
      b.padding = "p".repeat(size - len0);
      const raw = JSON.stringify(b);
      const r = await deliver(workerUrl(h, "A"), raw, A.signing_secret);
      await sleep(1500);
      obs[size] = { bytes: Buffer.byteLength(raw), http: r.status, inbox_rows: inboxBy(b.event_id).length };
    }
    const pass = obs[65536].bytes === 65536 && obs[65536].http === 200 && obs[65536].inbox_rows === 1 && obs[65537].http === 413 && obs[65537].inbox_rows === 0;
    save({ id: "BH-02", observed: obs, verdict: pass ? "PASS" : "FAIL" });
  }

  // ---------- BH-03 unknown installation / cross-installation ----------
  {
    const base = await postAs(h, A, "dana", "bh03 anchor");
    const a = eventBody(A, "dana", base, "service-request bh03 unknown install");
    const r1 = await deliver(workerUrl(h, "Z"), JSON.stringify(a), A.signing_secret);
    const bBody = eventBody(B, "ivan", base, "service-request bh03 B body on A url"); bBody.event.channel = A.channel_id;
    const r2 = await deliver(workerUrl(h, "A"), JSON.stringify(bBody), A.signing_secret);
    const a3 = eventBody(A, "dana", base, "service-request bh03 B secret");
    const r3 = await deliver(workerUrl(h, "A"), JSON.stringify(a3), B.signing_secret);
    await sleep(2000);
    const ids = [a.event_id, bBody.event_id, a3.event_id];
    const obs = { http: [r1.status, r2.status, r3.status], inbox_rows: ids.map((e) => inboxBy(e).length), tickets: ids.map((e) => ticketsFor(e).length),
      audits: audits(h).filter((x) => ["installation_mismatch", "signature_rejected"].includes(x.kind)).map((x) => x.kind) };
    const pass = obs.http.every((s) => s >= 400 && s < 500) && obs.inbox_rows.every((n) => n === 0);
    save({ id: "BH-03", observed: obs, verdict: pass ? "PASS" : "FAIL" });
  }

  // ---------- BH-10 concurrent duplicate deliveries ----------
  {
    const base = await postAs(h, A, "dana", "bh10 anchor (not a mention)");
    const b = eventBody(A, "dana", base, "service-request bh10 concurrent duplicate");
    const raw = JSON.stringify(b);
    const now = Math.floor(Date.now() / 1000);
    const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => deliver(workerUrl(h, "A"), raw, A.signing_secret, { ts: now - (i % 4), ...(i % 3 ? { retry: String(i % 3) } : {}) })));
    const inbox = await waitFor(() => inboxBy(b.event_id)[0], 5000, "inbox");
    const t = await waitFor(() => { const x = ticketsFor(b.event_id)[0]; return x?.receipt_status === "committed" ? x : undefined; }, 30000, "ticket");
    await sleep(4000);
    const keys = await fl.keys();
    const obs = { http: rs.map((r) => r.status), inbox_rows: inboxBy(b.event_id).length, delivery_count: inboxBy(b.event_id)[0]?.delivery_count,
      tickets: ticketsFor(b.event_id).length, receipt_present: t ? keys.includes(t.receipt_key) : false,
      completion_replies: (await botReplies(h, A, base)).filter((m) => /Ticket #\d+ created/.test(m.text)).length,
      sqs_send_outbox: q(h, "outbox", { kind: "sqs.send" }).filter((o) => JSON.parse(o.payload).envelope.input.source_event_id === b.event_id).length };
    const pass = obs.http.every((s) => s === 200) && obs.inbox_rows === 1 && obs.delivery_count === 16 && obs.tickets === 1 && obs.receipt_present && obs.completion_replies === 1;
    save({ id: "BH-10", observed: obs, verdict: pass ? "PASS" : "FAIL", note: inbox ? undefined : "no inbox row" });
  }

  // ---------- BH-04 unicode / RTL / zero-width ----------
  {
    const summary = "printer ‮enilffo‬ on floor ٢ — الطابعة 打印机 ‍​﻿ \u{1F5A8}️ café café";
    const ts = await mention(h, A, "dana", `service-request ${summary}`);
    const t = await ticketDone(h, ts);
    await sleep(1000);
    const body = t ? await fl.get(t.receipt_key) : undefined;
    const reps = await botReplies(h, A, ts);
    const ts2 = await mention(h, A, "dana", "service​-request zero width inside keyword");
    const i2 = await inboxSettled(h, ts2);
    const obs = { ticket_found: !!t, summary_equal: t?.summary === summary, stored_codepoints: t ? [...t.summary].length : null, sent_codepoints: [...summary].length,
      receipt_summary_equal: body ? JSON.parse(body).input.summary === summary : null,
      completion_replies_in_thread: reps.filter((m) => /Ticket #\d+ created/.test(m.text)).length, reply_thread_ts: reps.map((m) => m.thread_ts),
      zw_keyword_inbox_status: i2?.status, zw_keyword_tickets: i2 ? q(h, "tickets", { inbox_id: i2.id }).length : null };
    const pass = obs.summary_equal && obs.receipt_summary_equal && obs.completion_replies_in_thread === 1 && obs.reply_thread_ts.every((x: string) => x === ts) && obs.zw_keyword_tickets === 0;
    save({ id: "BH-04", observed: obs, verdict: pass ? "PASS" : "FAIL" });
  }

  // ---------- BH-05 40k-char message ----------
  {
    const prefix = `<@${A.bot_user_id}> service-request `;
    const text = prefix + "x".repeat(40000 - prefix.length);
    const before = q(h, "tickets").length;
    let posted: any;
    try { posted = await postAs(h, A, "dana", text); } catch (e) { posted = `post failed: ${(e as Error).message}`; }
    await sleep(4000);
    const big = typeof posted === "string" && /^\d/.test(posted) ? q(h, "inbox", { message_ts: posted }) : [];
    const ticketsAfterBig = q(h, "tickets").length - before;
    const repliesBig = typeof posted === "string" && /^\d/.test(posted) ? await botReplies(h, A, posted) : [];
    const ts2 = await mention(h, A, "dana", "service-request bh05 follow-up after big message");
    const t2 = await ticketDone(h, ts2);
    await sleep(1000);
    const obs = { posted_ts: posted, text_len: text.length, inbox_rows_for_big: big.length, inbox_status: big[0]?.status ?? null,
      invalid_event_audits: audits(h, "invalid_event").length, tickets_created_by_big: ticketsAfterBig, bot_replies_to_big: repliesBig.length,
      followup_ticket: !!t2, followup_completion_replies: (await botReplies(h, A, ts2)).filter((m) => /Ticket #\d+ created/.test(m.text)).length,
      worker_alive: h.worker?.exitCode === null };
    const pass = obs.tickets_created_by_big === 0 && obs.bot_replies_to_big === 0 && obs.followup_ticket && obs.followup_completion_replies === 1 && obs.worker_alive;
    save({ id: "BH-05", observed: obs, verdict: pass ? "PASS" : "FAIL" });
  }

  // ---------- BH-12 traversal / S3-special characters ----------
  {
    const summary = "../../T_LAB_B/receipts/../x %2e%2e%2f ?versionId=1#frag *&$@=;:+, \\0 ~/.ssh";
    const ts = await mention(h, A, "dana", `service-request ${summary}`);
    const t = await ticketDone(h, ts);
    await sleep(1000);
    const keys = await fl.keys();
    const body = t ? await fl.get(t.receipt_key) : undefined;
    const i = q(h, "inbox", { message_ts: ts })[0];
    const obs = { inbox_status: i?.status, inbox_reason: i?.reason, ticket_found: !!t, receipt_key: t?.receipt_key ?? null, all_keys: keys,
      keys_outside_tenant_prefix: keys.filter((k: string) => !/^receipts\/T_LAB_A\/[a-z]+-[A-Za-z0-9-]+\.json$/.test(k)),
      summary_verbatim: t ? t.summary === summary : null, receipt_summary_verbatim: body ? JSON.parse(body).input.summary === summary : null };
    const pass = !!t && /^receipts\/T_LAB_A\//.test(t.receipt_key) && obs.keys_outside_tenant_prefix.length === 0 && obs.receipt_summary_verbatim === true;
    // If the receiver/planner refused the input instead, containment still holds but verbatim storage is not shown.
    const refused = !t && keys.every((k: string) => /^receipts\/T_LAB_A\//.test(k));
    save({ id: "BH-12", observed: obs, verdict: pass ? "PASS" : refused ? "INCONCLUSIVE" : "FAIL", note: refused ? "input refused before ticket; containment held" : undefined });
  }
} finally {
  fl.close();
  const m = await h.stop();
  console.log(JSON.stringify({ run: m.config.run_id, cleanup: m.cleanup_status }));
}
