// Slack ingress (Events API + interactivity). Order per request: size limit while reading → installation
// from the URL → signature + timestamp over raw bytes → installation binding → durable accept → 200.
// Business processing happens later, off the request path.
import Fastify, { type FastifyInstance } from "fastify";
import { assertContract } from "../contracts/validate.ts";
import { sha256 } from "../config/run-config.ts";
import { verifySlackRequest } from "../adapters/slack/signature.ts";
import { acceptEvent, audit, isRevoked, nowIso, type DB, type InboxEvent } from "../ledger/db.ts";

// Slack event payloads are a few KiB; anything over 64 KiB is rejected (413) before it is parsed.
export const BODY_LIMIT_BYTES = 64 * 1024;

export interface Installation {
  installation_id: string; tenant_id: string; team_id: string; api_app_id: string; bot_user_id: string; signing_secret: string;
}

export interface SlackIngress {
  runId: string;
  db: DB;
  installations: Installation[];
  onAccepted: (inboxId: number) => void;
  onBlockAction: (inst: Installation, payload: Record<string, any>) => Promise<void> | void;
  now?: () => number;
}

export function buildSlackApp(o: SlackIngress): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  const byId = new Map(o.installations.map((i) => [i.installation_id, i]));

  // Shared front half: installation, signature, binding. Returns undefined after replying on failure.
  const gate = (kind: "events" | "interactions") => async (req: any, reply: any) => {
    const inst = byId.get(req.params.installation);
    if (!inst) return reply.code(404).send();
    const raw = typeof req.body === "string" ? req.body : "";
    const check = verifySlackRequest(raw, req.headers, inst.signing_secret, o.now?.());
    if (!check.ok) {
      audit(o.db, o.runId, inst.tenant_id, "signature_rejected", { installation_id: inst.installation_id, kind, reason: check.reason });
      return reply.code(401).send();
    }
    let body: Record<string, any>;
    try {
      body = kind === "events" ? JSON.parse(raw) : JSON.parse(new URLSearchParams(raw).get("payload") ?? "");
    } catch {
      return reply.code(400).send();
    }
    if (body.type === "url_verification") return reply.send({ challenge: body.challenge });
    const teamId = kind === "events" ? body.team_id : body.team?.id;
    if (body.api_app_id !== inst.api_app_id || teamId !== inst.team_id) {
      audit(o.db, o.runId, inst.tenant_id, "installation_mismatch", { installation_id: inst.installation_id, kind });
      return reply.code(403).send();
    }
    req.slack = { inst, raw, body };
  };

  app.post("/slack/:installation/events", { preHandler: gate("events") }, async (req: any, reply) => {
    const { inst, raw, body } = req.slack as { inst: Installation; raw: string; body: Record<string, any> };
    const ev = body.event ?? {};
    if (ev.type === "tokens_revoked" || ev.type === "app_uninstalled") {
      o.db.prepare("UPDATE installations SET revoked_at = COALESCE(revoked_at, ?) WHERE installation_id = ?").run(nowIso(), inst.installation_id);
      audit(o.db, o.runId, inst.tenant_id, "installation_revoked", { installation_id: inst.installation_id, via: ev.type });
      return reply.send({ ok: true });
    }
    if (body.type !== "event_callback" || ev.type !== "app_mention") {
      audit(o.db, o.runId, inst.tenant_id, "unsupported_event", { type: String(ev.type ?? body.type) });
      return reply.send({ ok: true });
    }
    const retry = req.headers["x-slack-retry-num"];
    const event: InboxEvent = {
      run_id: o.runId, tenant_id: inst.tenant_id, installation_id: inst.installation_id, team_id: inst.team_id,
      event_id: body.event_id, event_type: "app_mention", actor_id: ev.user, channel_id: ev.channel, message_ts: ev.ts,
      ...(ev.thread_ts ? { thread_ts: ev.thread_ts } : {}), text: String(ev.text ?? ""), raw_body_sha256: sha256(raw),
      verified_signature: true, received_at: nowIso(), ...(retry ? { retry_num: Number(retry) } : {}),
    };
    try {
      assertContract("workflow-event", event);
    } catch (e) {
      audit(o.db, o.runId, inst.tenant_id, "invalid_event", { issues: (e as { issues?: string[] }).issues ?? [] });
      return reply.code(400).send();
    }
    // Identity comes from the verified installation, never from message text.
    const [status, reason] = isRevoked(o.db, inst.installation_id)
      ? (["denied", "installation_revoked"] as const)
      : ev.bot_id || ev.user === inst.bot_user_id
        ? (["ignored", "own_bot_message"] as const)
        : (["received", undefined] as const);
    const { inbox_id, duplicate } = acceptEvent(o.db, event, status, reason);
    if (duplicate) audit(o.db, o.runId, inst.tenant_id, "duplicate_delivery", { inbox_id, retry_num: event.retry_num ?? null });
    else if (status === "received") setImmediate(() => o.onAccepted(inbox_id));
    return reply.send({ ok: true });
  });

  app.post("/slack/:installation/interactions", { preHandler: gate("interactions") }, async (req: any, reply) => {
    const { inst, body } = req.slack as { inst: Installation; body: Record<string, any> };
    if (isRevoked(o.db, inst.installation_id)) {
      audit(o.db, o.runId, inst.tenant_id, "interaction_denied", { reason: "installation_revoked" });
      return reply.send();
    }
    if (body.type === "block_actions") await o.onBlockAction(inst, body);
    return reply.send();
  });

  return app;
}
