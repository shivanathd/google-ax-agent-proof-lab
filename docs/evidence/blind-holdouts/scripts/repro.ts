// Minimal reproductions for the two FAILs (BH-03b, BH-07 zero amount).
import { approvalPosted, deliver, eventBody, mention, postAs, q, sleep, start, W, workerUrl } from "./lib.ts";
const h = await start();
const A = W(h), B = W(h, "T_LAB_B");
try {
  // BH-03b: T_LAB_B team/user body, signed with A's secret, POSTed to A's receiver.
  const base = await postAs(h, A, "dana", "repro anchor");
  const b = eventBody(B, "ivan", base, "service-request repro cross-team"); b.event.channel = A.channel_id;
  const r = await deliver(workerUrl(h, "A"), JSON.stringify(b), A.signing_secret);
  await sleep(1500);
  console.log("BH-03b", JSON.stringify({ team_ids: [A.team_id, B.team_id], http: r.status, inbox: q(h, "inbox", { event_id: b.event_id }).map((i) => ({ tenant: i.tenant_id, actor: i.actor_id, status: i.status, reason: i.reason })) }));
  // BH-07: zero-amount approval request with no fixture declaring a zero-value demonstration.
  const ts = await mention(h, A, "dana", "purchase-request 0 repro zero");
  const a = await approvalPosted(h, ts);
  console.log("BH-07", JSON.stringify({ status: a?.status, amount_cents: a?.amount_cents, button_ts: a?.message_ts }));
} finally {
  await h.stop();
}
