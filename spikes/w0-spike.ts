// W0 spike: prove the pinned upstream interfaces the lab depends on, against real processes.
// Run: npm run spike. Prints one line per check; exits nonzero on the first failure.
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import Fastify from "fastify";
import { createEmulator } from "emulate";
import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, CreateQueueCommand, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";

const SECRET = "spike-signing-secret";
const ok = (name: string, cond: unknown, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`spike check failed: ${name}`);
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

type Captured = { path: string; raw: string; headers: Record<string, string> };
const captured: Captured[] = [];
const verify = (c: Captured) => {
  const base = `v0:${c.headers["x-slack-request-timestamp"]}:${c.raw}`;
  const want = Buffer.from(`v0=${createHmac("sha256", SECRET).update(base).digest("hex")}`);
  const got = Buffer.from(c.headers["x-slack-signature"] ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
};
const waitFor = async <T>(fn: () => T | undefined, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function slackSpike() {
  const app = Fastify();
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.post("/*", async (req) => {
    captured.push({ path: req.url, raw: req.body as string, headers: req.headers as Record<string, string> });
    const body = String(req.body);
    return body.includes('"url_verification"') ? JSON.parse(body).challenge : "";
  });
  const appPort = await freePort();
  await app.listen({ host: "127.0.0.1", port: appPort });
  const appUrl = `http://127.0.0.1:${appPort}`;

  const seed = (team: string) => ({
    slack: {
      team: { name: `Lab ${team}`, domain: `lab-${team.toLowerCase()}` },
      signing_secret: SECRET,
      strict_scopes: true,
      users: [
        { name: "alice", user_id: "U_ALICE", real_name: "Alice Requester" },
        { name: "bob", user_id: "U_BOB", real_name: "Bob Approver" },
      ],
      channels: [{ name: "service-desk" }],
      oauth_apps: [
        {
          app_id: "A_LABBOT", client_id: "lab-client", client_secret: "lab-client-secret", name: "LabBot",
          redirect_uris: [], bot_id: "B_LABBOT", bot_user_id: "U_LABBOT", bot_name: "labbot",
          scopes: ["chat:write", "channels:history", "app_mentions:read"],
          interactivity_url: `${appUrl}/slack/interactions`,
        },
      ],
      tokens: [
        { token: "xoxb-spike", type: "bot", user: "U_LABBOT", app_id: "A_LABBOT", bot_id: "B_LABBOT", bot_user_id: "U_LABBOT", scopes: ["chat:write"] },
        { token: "xoxp-alice", type: "user", user: "alice", scopes: ["chat:write", "channels:write", "channels:manage", "channels:history", "channels:read", "users:read"] },
        { token: "xoxp-reader", type: "user", user: "bob", scopes: ["channels:history", "channels:read"] },
      ],
      event_subscriptions: [{ url: `${appUrl}/slack/events`, events: ["app_mention"] }],
    },
  });
  const emuA = await createEmulator({ service: "slack", port: await freePort(), seed: seed("A") as never });
  const emuB = await createEmulator({ service: "slack", port: await freePort(), seed: seed("B") as never });
  ok("emulate binds loopback", new URL(emuA.url).hostname === "127.0.0.1" || new URL(emuA.url).hostname === "localhost", emuA.url);
  ok("two isolated emulator instances", emuA.url !== emuB.url, `${emuA.url} / ${emuB.url}`);

  const api = async (base: string, method: string, token: string, body: object) => {
    const r = await fetch(`${base}/api/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return (await r.json()) as Record<string, any>;
  };
  const list = await api(emuA.url, "conversations.list", "xoxp-alice", {});
  const channel = list.channels.find((c: any) => c.name === "service-desk").id as string;
  ok("invite bot", (await api(emuA.url, "conversations.invite", "xoxp-alice", { channel, users: "U_LABBOT" })).ok);

  const posted = await api(emuA.url, "chat.postMessage", "xoxp-alice", { channel, text: "<@U_LABBOT> service-request printer offline" });
  ok("user posts mention", posted.ok, posted.ts);
  const ev = await waitFor(() => captured.find((c) => c.path === "/slack/events"));
  const env = JSON.parse(ev.raw);
  ok("signed app_mention callback arrives", env.event?.type === "app_mention", env.event_id);
  ok("signature verifies over raw bytes", verify(ev));
  ok("tampered body fails verification", !verify({ ...ev, raw: ev.raw.replace("printer", "printr") }));

  const denied = await api(emuA.url, "conversations.history", "xoxb-spike", { channel });
  ok("strict scopes deny bot without channels:history", denied.ok === false && denied.error === "missing_scope", JSON.stringify(denied.needed));

  const reply = await api(emuA.url, "chat.postMessage", "xoxb-spike", { channel, thread_ts: posted.ts, text: "Ticket created" });
  ok("bot replies in thread", reply.ok);
  const replies = await api(emuA.url, "conversations.replies", "xoxp-reader", { channel, ts: posted.ts });
  ok("independent reader sees threaded reply", replies.messages?.length === 2 && replies.messages[1].bot_id === "B_LABBOT");

  const before = captured.length;
  const retry = await fetch(`${emuA.url}/_slack/simulate/event-retry`, {
    method: "POST", headers: { authorization: "Bearer xoxp-alice", "content-type": "application/json" },
    body: JSON.stringify({ event_id: env.event_id, reason: "http_timeout" }),
  }).then((r) => r.json() as Promise<Record<string, any>>);
  const re = await waitFor(() => (captured.length > before ? captured[captured.length - 1] : undefined));
  ok("event-retry resends same event_id", JSON.parse(re.raw).event_id === env.event_id, `retry_num=${retry.retry_num}`);
  ok("retry carries fresh valid signature + retry header", verify(re) && re.headers["x-slack-retry-num"] === "1");

  const btn = await api(emuA.url, "chat.postMessage", "xoxb-spike", {
    channel, text: "Approve purchase?",
    blocks: [{ type: "actions", elements: [{ type: "button", action_id: "approve", text: { type: "plain_text", text: "Approve" }, value: "req-1" }] }],
  });
  const users = await api(emuA.url, "users.list", "xoxp-alice", {});
  const bobId = users.members.find((m: any) => m.name === "bob").id as string;
  ok("seeded user_id is not honoured; ids are generated", bobId !== "U_BOB", bobId);
  await api(emuA.url, "conversations.invite", "xoxp-alice", { channel, users: bobId });
  const sim = await fetch(`${emuA.url}/_slack/simulate/block-actions`, {
    method: "POST", headers: { authorization: "Bearer xoxp-alice", "content-type": "application/json" },
    body: JSON.stringify({ channel, message_ts: btn.ts, action_id: "approve", user: "bob" }),
  }).then((r) => r.json() as Promise<Record<string, any>>);
  const ia = await waitFor(() => captured.find((c) => c.path === "/slack/interactions"));
  const payload = JSON.parse(new URLSearchParams(ia.raw).get("payload") ?? "{}");
  ok("block-actions delivers signed interaction", verify(ia) && payload.user?.id === bobId, JSON.stringify(Object.keys(sim)));

  const un = await api(emuA.url, "apps.uninstall", "xoxp-alice", { client_id: "lab-client", client_secret: "lab-client-secret" });
  const afterRevoke = await api(emuA.url, "chat.postMessage", "xoxb-spike", { channel, text: "should fail" });
  ok("uninstall revokes bot token", afterRevoke.ok === false, `uninstall=${JSON.stringify(un)} post=${afterRevoke.error}`);

  await emuA.close();
  await emuB.close();
  await app.close();
}

async function flociSpike() {
  const port = await freePort();
  const project = `apl-spike-${process.pid}`;
  const env = { ...process.env, FLOCI_PORT: String(port), APL_RUN_ID: project };
  execFileSync("docker", ["compose", "-p", project, "up", "-d", "--wait"], { env, stdio: "ignore" });
  try {
    const ports = execFileSync("docker", ["compose", "-p", project, "port", "floci", "4566"], { env }).toString().trim();
    ok("floci bound to loopback", ports.startsWith("127.0.0.1:"), ports);
    const cfg = { endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "lab", secretAccessKey: "lab" } };
    const start = Date.now();
    for (;;) {
      try { await fetch(cfg.endpoint); break; } catch { if (Date.now() - start > 30000) throw new Error("floci not ready"); await new Promise((r) => setTimeout(r, 250)); }
    }
    const s3 = new S3Client(cfg);
    await s3.send(new CreateBucketCommand({ Bucket: "receipts" }));
    await s3.send(new PutObjectCommand({ Bucket: "receipts", Key: "r1.json", Body: '{"ticket":1}' }));
    const got = await (await s3.send(new GetObjectCommand({ Bucket: "receipts", Key: "r1.json" }))).Body?.transformToString();
    ok("floci S3 put/get round-trip", got === '{"ticket":1}');
    const sqs = new SQSClient(cfg);
    const q = await sqs.send(new CreateQueueCommand({ QueueName: "jobs" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: q.QueueUrl, MessageBody: "job-1" }));
    const rec = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q.QueueUrl, WaitTimeSeconds: 2 }));
    ok("floci SQS send/receive", rec.Messages?.[0]?.Body === "job-1", q.QueueUrl);
  } finally {
    execFileSync("docker", ["compose", "-p", project, "down", "-v"], { env, stdio: "ignore" });
  }
}

await slackSpike();
await flociSpike();
console.log("W0 spike: all checks passed");
