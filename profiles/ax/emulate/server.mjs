// In-cluster Emulate Slack for the AX lane: one workspace, seeded from APL_EMULATE_SEED (a Secret holding the
// `slack` seed built by workspaceSeed() in src/adapters/slack/emulator.ts).
// Nothing outside the sandbox can reach the worker inside it, so Emulate's event callbacks go to a loopback
// mailbox in this pod. The in-sandbox coordinator pulls them from :8081 and replays them to its worker with the
// raw body and Emulate's signature headers unchanged; the worker still verifies Emulate's signature.
import { createServer } from "node:http";
import { createEmulator } from "emulate";

const seed = JSON.parse(process.env.APL_EMULATE_SEED ?? "null");
const baseUrl = process.env.APL_EMULATE_BASE_URL;
if (!seed || !baseUrl) throw new Error("APL_EMULATE_SEED and APL_EMULATE_BASE_URL are required");

const box = [];
const inbox = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const h = req.headers;
    box.push({
      seq: box.length + 1, at: new Date().toISOString(), path: req.url,
      headers: Object.fromEntries(["content-type", "x-slack-signature", "x-slack-request-timestamp", "x-slack-retry-num", "x-slack-retry-reason"].filter((k) => h[k]).map((k) => [k, h[k]])),
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
});
await new Promise((r) => inbox.listen(8082, "127.0.0.1", r)); // Emulate delivers here; never exposed

// Read-only view of the mailbox for the coordinator; it cannot add deliveries.
const outbox = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://mailbox");
  if (req.method !== "GET") return void res.writeHead(405).end();
  if (u.pathname === "/_apl/health") return void res.writeHead(200).end("ok");
  if (u.pathname !== "/_apl/events") return void res.writeHead(404).end();
  const after = Number(u.searchParams.get("after") ?? 0);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(box.filter((e) => e.seq > after)));
});
await new Promise((r) => outbox.listen(8081, "0.0.0.0", r));

seed.event_subscriptions = [{ url: "http://127.0.0.1:8082/events", events: ["app_mention", "app_uninstalled", "tokens_revoked"] }];
for (const app of seed.oauth_apps ?? []) app.interactivity_url = "http://127.0.0.1:8082/interactions";
const emu = await createEmulator({ service: "slack", port: 8080, hostname: "0.0.0.0", baseUrl, seed: { slack: seed } });
console.log(JSON.stringify({ ready: true, url: emu.url, mailbox: 8081 }));
for (const s of ["SIGTERM", "SIGINT"]) process.once(s, () => process.exit(0));
