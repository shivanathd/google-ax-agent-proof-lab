// Endpoint guard (F1-R2): scheme, resolved host, port and every redirect hop are checked against the
// run allowlist before any socket is opened. Local runs only ever allow loopback.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isLoopbackHost, type Endpoint } from "./run-config.ts";

export class EndpointRejected extends Error {
  constructor(public reason: string, public target: string) {
    super(`endpoint rejected (${reason}): ${target}`);
  }
}

export interface Rejection { kind: "endpoint_rejected"; reason: string; target: string; outbound_request_count: 0 }
export type OnReject = (r: Rejection) => void;

// Address rule for a listed endpoint's resolved addresses. Default (local profile, F1-R2): all loopback.
// An optional lane may replace it once per process before any request (profiles/ax/allowlist.ts); the local
// profile never loads such a module, and validateRunConfig still rejects non-loopback local allowlists.
export type AddressRule = (endpoint: Endpoint, addrs: string[]) => boolean;
let addressRule: AddressRule = (_e, addrs) => addrs.every(isLoopbackHost);
let ruleInstalled = false;
export function installAddressRule(rule: AddressRule) {
  if (ruleInstalled) throw new Error("endpoint address rule already installed");
  addressRule = rule;
  ruleInstalled = true;
}

// Only scheme://host:port is reported; paths and query strings may carry tokens.
const describe = (u: URL) => `${u.protocol}//${u.host}`;

export async function assertAllowedEndpoint(raw: string | URL, allowlist: Endpoint[], onReject?: OnReject): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("unparseable_url", "<unparseable>", onReject);
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https") return reject("scheme_not_allowed", describe(url), onReject);
  if (url.username || url.password) return reject("userinfo_not_allowed", describe(url), onReject);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = Number(url.port || (scheme === "https" ? 443 : 80));
  const listed = allowlist.find((e) => e.scheme === scheme && e.host.toLowerCase() === host && e.port === port);
  if (!listed) return reject("not_allowlisted", describe(url), onReject);
  // Resolve and require every address to satisfy the address rule, so a listed name cannot point elsewhere.
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length || !addressRule(listed, addrs)) return reject(ruleInstalled ? "address_not_allowed" : "non_loopback_resolution", describe(url), onReject);
  return url;
}

function reject(reason: string, target: string, onReject?: OnReject): never {
  onReject?.({ kind: "endpoint_rejected", reason, target, outbound_request_count: 0 });
  throw new EndpointRejected(reason, target);
}

// fetch with manual redirects: each Location is validated before it is followed.
export async function guardedFetch(
  url: string | URL,
  init: RequestInit & { allowlist: Endpoint[]; onReject?: OnReject; maxRedirects?: number },
): Promise<Response> {
  const { allowlist, onReject, maxRedirects = 3, ...rest } = init;
  let target = await assertAllowedEndpoint(url, allowlist, onReject);
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...rest, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    if (hop >= maxRedirects) reject("too_many_redirects", describe(target), onReject);
    target = await assertAllowedEndpoint(new URL(location, target), allowlist, onReject);
  }
}

// AWS SDK v3 middleware: re-checks the actual request host/port at send time, after endpoint resolution.
type AwsClient = { middlewareStack: { add: (mw: any, opts: any) => void } };
export function guardAwsClient<T extends AwsClient>(client: T, allowlist: Endpoint[], onReject?: OnReject): T {
  client.middlewareStack.add(
    (next: (a: any) => Promise<any>) => async (args: any) => {
      const r = args.request as { protocol: string; hostname: string; port?: number };
      await assertAllowedEndpoint(`${r.protocol}//${r.hostname}${r.port ? `:${r.port}` : ""}/`, allowlist, onReject);
      return next(args);
    },
    { step: "finalizeRequest", name: "aplEndpointGuard", priority: "low" },
  );
  return client;
}
