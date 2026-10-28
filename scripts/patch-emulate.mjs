// Adds a `slack.event_subscriptions` seed key to emulate@0.12.3.
// Upstream gap: the Slack seeder ignores the webhook dispatcher it is passed, so the public
// createEmulator() API cannot register Events API subscriptions (see docs/LEARNINGS.md L-001).
// Fails closed on any version or content mismatch; never patches an unknown file.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const file = "node_modules/emulate/dist/dist-B5YXZCS3.js";
const pkg = JSON.parse(readFileSync("node_modules/emulate/package.json", "utf8"));
const ORIGINAL = "c4c5244040bc9fd66afaf3dd41440e0f60cea4d1cea1e520819d5d181037d0a8";
const MARKER = "/* agent-proof-lab:event_subscriptions */";
if (pkg.version !== "0.12.3" || !existsSync(file)) {
  console.error(`patch-emulate: expected emulate 0.12.3 with ${file}; refusing to patch`);
  process.exit(1);
}
let src = readFileSync(file, "utf8");
if (src.includes(MARKER)) process.exit(0);
const sha = createHash("sha256").update(src).digest("hex");
if (sha !== ORIGINAL) {
  console.error(`patch-emulate: unexpected ${file} sha256 ${sha}; refusing to patch`);
  process.exit(1);
}
const sig = "function seedFromConfig(store, _baseUrl, config) {";
const anchor = "  if (config.strict_scopes !== void 0) {";
if (src.split(sig).length !== 2 || src.split(anchor).length !== 2) {
  console.error("patch-emulate: anchors not unique; refusing to patch");
  process.exit(1);
}
src = src.replace(sig, "function seedFromConfig(store, _baseUrl, config, webhooks) {").replace(
  anchor,
  `  ${MARKER}
  if (Array.isArray(config.event_subscriptions) && webhooks) {
    for (const sub of config.event_subscriptions) {
      webhooks.register({ url: sub.url, events: sub.events, active: true, owner: "slack" });
    }
  }
${anchor}`,
);
writeFileSync(file, src);
console.log("patch-emulate: added slack.event_subscriptions seed support");
