// Slack request verification over the raw body bytes: v0=HMAC-SHA256(secret, "v0:<ts>:<body>").
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SECONDS = 300; // Slack's documented 5-minute replay window

export const sign = (secret: string, ts: number | string, raw: string) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;

export function verifySlackRequest(
  raw: string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" } {
  const ts = headers["x-slack-request-timestamp"];
  const sig = headers["x-slack-signature"];
  if (typeof ts !== "string" || typeof sig !== "string" || !/^\d{1,12}$/.test(ts)) return { ok: false, reason: "missing_headers" };
  if (Math.abs(nowSeconds - Number(ts)) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale_timestamp" };
  const want = Buffer.from(sign(secret, ts, raw));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? { ok: true } : { ok: false, reason: "bad_signature" };
}
