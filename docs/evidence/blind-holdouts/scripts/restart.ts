// BH-13: worker SIGKILL while holding an SQS job mid-processing (S3 receipt PUT stalled), then restart.
import { botReplies, faults, floci, mention, q, save, sleep, start, ticketDone, W, waitFor, audits } from "./lib.ts";

const h = await start({ worker: false, extraPorts: ["floci_fault"] });
const A = W(h);
const fl = floci(h);
let proxy: any;
try {
  proxy = await faults.startFaultProxy(h.manifest.ports.floci_fault, h.flociEndpoint);
  proxy.rules.push({ name: "stall-receipt-put", action: "stall", match: (r: any) => r.method === "PUT" && r.url.includes("/receipts/") });
  await h.startWorker({ floci_endpoint: proxy.url });
  const ts = await mention(h, A, "dana", "service-request bh13 coffee machine leaking");
  const stalled = await waitFor(() => (proxy.hits["stall-receipt-put"] ?? 0) >= 1, 20000, "receipt PUT stalled");
  await sleep(2500); // past the 1 s visibility timeout: the job is redelivered while the first attempt is stalled
  const inbox = q(h, "inbox", { message_ts: ts })[0];
  const pre = { stalled: !!stalled, tickets: q(h, "tickets", { inbox_id: inbox.id }).length, receipt_status: q(h, "tickets", { inbox_id: inbox.id })[0]?.receipt_status,
    completion_replies_before_kill: (await botReplies(h, A, ts)).filter((m) => /Ticket #\d+ created/.test(m.text)).length,
    s3_keys_before_kill: (await fl.keys()).length, depth: await fl.depth() };
  const w = h.worker;
  const exited = new Promise((r) => w.once("exit", r));
  w.kill("SIGKILL");
  await exited;
  await proxy.close();
  await h.startWorker({}); // direct Floci
  const t = await ticketDone(h, ts, 30000);
  await sleep(6000);
  const tickets = q(h, "tickets", { inbox_id: inbox.id });
  const keys = await fl.keys();
  const body = t ? await fl.get(t.receipt_key) : undefined;
  const { createHash } = await import("node:crypto");
  const post = { tickets: tickets.length, receipt_committed: t?.receipt_status, s3_keys: keys,
    receipt_hash_matches: body ? createHash("sha256").update(body).digest("hex") === t.receipt_sha256 : false,
    completion_replies: (await botReplies(h, A, ts)).filter((m) => /Ticket #\d+ created/.test(m.text)).length,
    depth: await fl.depth(), duplicate_job_audits: audits(h, "duplicate_job").length, recovery_audits: audits(h, "receipt_recovery").length };
  const pass = pre.stalled && pre.completion_replies_before_kill === 0 && post.tickets === 1 && post.receipt_committed === "committed" && post.receipt_hash_matches &&
    post.completion_replies === 1 && keys.length === 1 && Number(post.depth.ApproximateNumberOfMessages) === 0 && Number(post.depth.ApproximateNumberOfMessagesNotVisible) === 0;
  save({ id: "BH-13", observed: { pre, post }, verdict: pass ? "PASS" : "FAIL" });
} finally {
  fl.close();
  const m = await h.stop();
  console.log(JSON.stringify({ run: m.config.run_id, cleanup: m.cleanup_status }));
}
