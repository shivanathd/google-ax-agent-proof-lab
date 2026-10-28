import { describe, expect, it } from "vitest";
import { sign, verifySlackRequest } from "../../src/adapters/slack/signature.ts";
import { workerConfig, workerEnv } from "../../src/worker/config.ts";
import type { Workspace } from "../../src/adapters/slack/emulator.ts";

describe("Slack request verification", () => {
  const secret = "unit-secret";
  const now = 1_800_000_000;
  const raw = '{"type":"event_callback","event":{"text":"hello"}}';
  const headers = (ts: number, sig = sign(secret, ts, raw)) => ({ "x-slack-request-timestamp": String(ts), "x-slack-signature": sig });

  it("accepts a correct signature inside the 5-minute window", () => {
    expect(verifySlackRequest(raw, headers(now - 299), secret, now)).toEqual({ ok: true });
  });
  it("rejects tampered bodies, wrong secrets, stale or future timestamps and missing headers", () => {
    expect(verifySlackRequest(raw.replace("hello", "hellp"), headers(now), secret, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySlackRequest(raw, headers(now, sign("other", now, raw)), secret, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySlackRequest(raw, headers(now - 301), secret, now)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verifySlackRequest(raw, headers(now + 301), secret, now)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verifySlackRequest(raw, {}, secret, now)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifySlackRequest(raw, headers(now, "v0=short"), secret, now)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("worker environment (BUILD_PLAN §8.5)", () => {
  const ws = (id: string): Workspace => ({
    tenant_id: `T_LAB_${id}`, installation_id: id, url: `http://localhost:1${id === "A" ? 1 : 2}`, team_id: "T000000001", channel_id: "C1",
    api_app_id: "A_LABBOT", bot_user_id: "U_LABBOT", signing_secret: `sign-${id}`, client_id: "cid", client_secret: `client-secret-${id}`,
    users: { dana: "U1" },
    tokens: { worker: `xoxb-worker-${id}`, narrow: `xoxb-narrow-${id}`, setup: `xoxp-setup-${id}`, reader: `xoxp-reader-${id}`, users: { dana: `xoxp-dana-${id}` } },
    close: async () => {},
  });
  const base = { run_id: "0f8fad5b-d9cb-469f-a165-70867728950e", db_path: "/x/ledger.db", http_port: 9, allowlist: [] };
  const ambient = { PATH: "/bin", SLACK_ADMIN_TOKEN: "xoxa-ambient", AWS_PROFILE: "ambient-profile", OPENAI_API_KEY: "sk-ambient" };

  it("carries only the worker bot token and signing secret per installation", () => {
    const env = workerEnv(workerConfig(base, [ws("A"), ws("B")]), ambient);
    const flat = JSON.stringify(env);
    for (const id of ["A", "B"]) {
      expect(flat).toContain(`xoxb-worker-${id}`);
      expect(flat).toContain(`sign-${id}`);
      for (const forbidden of [`xoxp-setup-${id}`, `xoxp-reader-${id}`, `xoxp-dana-${id}`, `xoxb-narrow-${id}`, `client-secret-${id}`]) expect(flat).not.toContain(forbidden);
    }
    for (const forbidden of ["xoxa-ambient", "ambient-profile", "sk-ambient", "simulate"]) expect(flat).not.toContain(forbidden);
    expect(Object.keys(env).sort()).toEqual(
      ["APL_WORKER", "AWS_ACCESS_KEY_ID", "AWS_CONFIG_FILE", "AWS_EC2_METADATA_DISABLED", "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "AWS_SHARED_CREDENTIALS_FILE", "NODE_ENV", "PATH"],
    );
  });

  it("a narrow-token override replaces, never adds to, the worker token", () => {
    const flat = JSON.stringify(workerEnv(workerConfig(base, [ws("A")], { A: { token: "narrow" } }), ambient));
    expect(flat).toContain("xoxb-narrow-A");
    expect(flat).not.toContain("xoxb-worker-A");
  });
});
