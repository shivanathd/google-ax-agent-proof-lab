// Starts one Emulate Slack instance per fictional workspace (separate ports, separate state) and seeds it.
// Token values and signing secrets are generated per run. Only the test coordinator receives the setup,
// reader and per-user tokens; the worker gets just its bot token (see src/worker/config.ts).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEmulator } from "emulate";
import { ROOT, type Endpoint } from "../../config/run-config.ts";
import { slackClient, type SlackCall } from "./client.ts";

export const SCOPES = {
  worker: ["chat:write", "app_mentions:read"],
  narrow: ["app_mentions:read"], // G-SCOPE: a bot token that cannot post
  setup: ["chat:write", "channels:write", "channels:manage", "channels:history", "channels:read", "users:read"],
  reader: ["channels:history", "channels:read"],
  user: ["chat:write"],
};

export interface Fixture {
  app: { app_id: string; name: string; bot_id: string; bot_user_id: string; bot_name: string; client_id: string };
  workspaces: { tenant_id: string; installation_id: string; team: { name: string; domain: string }; channel: string;
    setup_user: string; reader_user: string; users: { name: string; real_name: string; email: string }[] }[];
}
export const loadSlackFixture = (): Fixture => JSON.parse(readFileSync(join(ROOT, "fixtures/slack/workspaces.json"), "utf8"));

export interface Workspace {
  tenant_id: string; installation_id: string; url: string; team_id: string; channel_id: string;
  api_app_id: string; bot_user_id: string; signing_secret: string; client_id: string; client_secret: string;
  users: Record<string, string>; // name -> generated user id (seeded ids are not honoured, LEARNINGS L-002)
  tokens: { worker: string; narrow: string; setup: string; reader: string; users: Record<string, string> };
  close: () => Promise<void>;
}

const secret = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;

export async function startWorkspace(
  fx: Fixture, ws: Fixture["workspaces"][number],
  o: { port: number; eventsUrl: string; interactionsUrl: string; allowlist: Endpoint[] },
): Promise<Workspace> {
  const tokens = {
    worker: secret("xoxb"), narrow: secret("xoxb"), setup: secret("xoxp"), reader: secret("xoxp"),
    users: Object.fromEntries(ws.users.map((u) => [u.name, secret("xoxp")])),
  };
  const signing_secret = secret("sign");
  const client_secret = secret("cs");
  const bot = { app_id: fx.app.app_id, bot_id: fx.app.bot_id, bot_user_id: fx.app.bot_user_id };
  const emu = await createEmulator({
    service: "slack",
    port: o.port,
    seed: {
      slack: {
        team: ws.team, signing_secret, strict_scopes: true,
        users: ws.users.map((u) => ({ name: u.name, real_name: u.real_name, email: u.email })),
        channels: [{ name: ws.channel }],
        oauth_apps: [{ ...fx.app, client_secret, redirect_uris: [], scopes: SCOPES.worker, interactivity_url: o.interactionsUrl }],
        tokens: [
          { token: tokens.worker, type: "bot", user: bot.bot_user_id, ...bot, scopes: SCOPES.worker },
          { token: tokens.narrow, type: "bot", user: bot.bot_user_id, ...bot, scopes: SCOPES.narrow },
          { token: tokens.setup, type: "user", user: ws.setup_user, scopes: SCOPES.setup },
          { token: tokens.reader, type: "user", user: ws.reader_user, scopes: SCOPES.reader },
          ...ws.users.map((u) => ({ token: tokens.users[u.name], type: "user", user: u.name, scopes: SCOPES.user })),
        ],
        event_subscriptions: [{ url: o.eventsUrl, events: ["app_mention", "app_uninstalled", "tokens_revoked"] }],
      },
    } as never,
  });
  const setup = slackClient({ baseUrl: emu.url, token: tokens.setup, allowlist: o.allowlist });
  const must = async (call: SlackCall, method: string, body?: object) => {
    const r = await call(method, body);
    if (!r.ok) throw new Error(`slack setup ${method} failed: ${r.error}`);
    return r;
  };
  const team_id = (await must(setup, "auth.test")).team_id as string;
  const channel_id = (await must(setup, "conversations.list")).channels.find((c: any) => c.name === ws.channel).id as string;
  const members = (await must(setup, "users.list")).members as { id: string; name: string }[];
  const users = Object.fromEntries(ws.users.map((u) => [u.name, members.find((m) => m.name === u.name)!.id]));
  for (const id of [bot.bot_user_id, ...ws.users.filter((u) => u.name !== ws.setup_user).map((u) => users[u.name]!)]) {
    const r = await setup("conversations.invite", { channel: channel_id, users: id });
    if (!r.ok && r.error !== "already_in_channel") throw new Error(`slack setup conversations.invite failed: ${r.error}`);
  }
  return {
    tenant_id: ws.tenant_id, installation_id: ws.installation_id, url: emu.url, team_id, channel_id,
    api_app_id: fx.app.app_id, bot_user_id: bot.bot_user_id, signing_secret, client_id: fx.app.client_id, client_secret,
    users, tokens, close: () => emu.close(),
  };
}

// Test-coordinator simulator calls. Emulate accepts ANY valid token here, the worker's bot token included
// (LEARNINGS L-019); the worker is kept out by its Slack proxy (worker-proxy.ts), not by token scope.
export async function simulate(ws: Workspace, route: "event-retry" | "block-actions", body: object) {
  const r = await fetch(`${ws.url}/_slack/simulate/${route}`, {
    method: "POST", headers: { authorization: `Bearer ${ws.tokens.setup}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return (await r.json()) as Record<string, any>;
}
