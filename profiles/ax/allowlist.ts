// AX lane endpoint allowlist (F1-R2 for profile "ax"). The local profile allows loopback only and never loads
// this module. The AX case loads it in every process it starts (`node --import`), reading APL_AX_ALLOWLIST:
// scheme/host/port tuples, where a loopback host must still resolve to loopback and a cluster service host must
// be a Service in this run's lab namespace and resolve to exactly the ClusterIPs pinned when the run was set up.
import { installAddressRule } from "../../src/config/endpoints.ts";
import { isLoopbackHost, type Endpoint } from "../../src/config/run-config.ts";

export interface AxEndpoint extends Endpoint { addresses?: string[] }
const LAB_SERVICE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?\.apl-ax-[a-f0-9]{8}\.svc\.cluster\.local$/;

export function parseAxAllowlist(raw: string): AxEndpoint[] {
  const list = JSON.parse(raw) as AxEndpoint[];
  for (const e of list) {
    if (e.scheme !== "http") throw new Error(`AX allowlist entry ${e.host}:${e.port}: only http is used in-cluster`);
    if (isLoopbackHost(e.host)) continue;
    if (!LAB_SERVICE.test(e.host) || !e.addresses?.length) {
      throw new Error(`AX allowlist entry ${e.host}:${e.port} must be a lab-namespace Service host with pinned addresses`);
    }
  }
  return list;
}

export const toEndpoints = (list: AxEndpoint[]): Endpoint[] => list.map(({ scheme, host, port }) => ({ scheme, host, port }));

export function axAddressRule(list: AxEndpoint[]) {
  return (e: Endpoint, addrs: string[]) => {
    if (isLoopbackHost(e.host)) return addrs.every(isLoopbackHost);
    const pinned = list.find((x) => x.scheme === e.scheme && x.host === e.host && x.port === e.port)?.addresses ?? [];
    return addrs.every((a) => pinned.includes(a));
  };
}

if (process.env.APL_AX_ALLOWLIST) installAddressRule(axAddressRule(parseAxAllowlist(process.env.APL_AX_ALLOWLIST)));
