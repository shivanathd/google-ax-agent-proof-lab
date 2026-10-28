// Minimal Slack Web API client for the emulator: one token, guarded endpoint, explicit timeout.
// A timeout or server error after the request was sent is AMBIGUOUS: the write may have happened.
import { EndpointRejected, guardedFetch, type OnReject } from "../../config/endpoints.ts";
import type { Endpoint } from "../../config/run-config.ts";

export class SlackTransportError extends Error {
  constructor(public method: string, public ambiguous: boolean, cause: string) {
    super(`${method}: ${ambiguous ? "outcome unknown" : "not delivered"} (${cause})`);
  }
}

export type SlackCall = (method: string, body?: object) => Promise<Record<string, any>>;

export function slackClient(o: { baseUrl: string; token: string; allowlist: Endpoint[]; timeoutMs?: number; onReject?: OnReject }): SlackCall {
  return async (method, body = {}) => {
    let res: Response;
    try {
      res = await guardedFetch(`${o.baseUrl}/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
        allowlist: o.allowlist,
        onReject: o.onReject,
      });
    } catch (e) {
      if (e instanceof EndpointRejected) throw e;
      const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
      throw new SlackTransportError(method, code !== "ECONNREFUSED", code);
    }
    if (res.status >= 500) throw new SlackTransportError(method, true, `http_${res.status}`);
    return (await res.json()) as Record<string, any>;
  };
}
