// Egress policy and gateway config check for the multi-tenant AX runs (docs/MULTI_CLUSTER_BUILD.md section 9).
// Pure functions only: attaching the policy (`kubectl ate create egress-policy`) is a cluster call and is made by
// profiles/ax/multi.ts, the one cluster driver (design rule 9).

const TENANT_NS = /^apl-ax-[a-f0-9]{8}$/;

// The singleton EgressPolicy for a tenant's task: its own Emulate (8080, 8081) and Floci (4566), by DNS name only
// (HttpRule.hostnames takes no IP). `foreignNs` adds the planted control's rule (design 6.4): t2's Emulate on 8080.
export function egressPolicy(ns: string, foreignNs?: string) {
  for (const n of [ns, ...(foreignNs ? [foreignNs] : [])]) if (!TENANT_NS.test(n)) throw new Error(`egress policy: ${n} is not a tenant namespace`);
  return {
    rules: [
      { http: { hostnames: [`emulate.${ns}.svc.cluster.local`], ports: { numbers: [8080, 8081] } } },
      { http: { hostnames: [`floci.${ns}.svc.cluster.local`], ports: { numbers: [4566] } } },
      ...(foreignNs ? [{ http: { hostnames: [`emulate.${foreignNs}.svc.cluster.local`], ports: { numbers: [8080] } } }] : []),
    ],
  };
}

// The vendored fixture (tests/fixtures/atenet-egress-access-log.yaml): each leg's block, dedented, as lines.
export function accessLogBlocks(fixture: string): Record<string, string[]> {
  const blocks: Record<string, string[]> = {};
  let leg: string | undefined;
  for (const line of fixture.split("\n")) {
    const head = /^ {2}([a-z]+):$/.exec(line);
    if (head) {
      leg = head[1]!;
      blocks[leg] = [];
    } else if (/^\S/.test(line) || /^ {2}#/.test(line)) leg = undefined;
    else if (leg && line.startsWith("    ")) blocks[leg]!.push(line.slice(4));
  }
  return blocks;
}

// Preflight of section 4.1: the deployed ConfigMap atenet-egress (`kubectl get cm -o json`) must hold every
// vendored access-log block verbatim, at one indent, in key envoy.yaml. Returns the legs that differ.
export function gatewayConfigDiff(configMap: { data?: Record<string, string> }, fixture: string): string[] {
  const envoy = (configMap.data?.["envoy.yaml"] ?? "").split("\n");
  return Object.entries(accessLogBlocks(fixture))
    .filter(([, block]) => !envoy.some((line, i) => {
      const indent = line.slice(0, line.length - block[0]!.length);
      return /^ *$/.test(indent) && block.every((b, k) => envoy[i + k] === indent + b);
    }))
    .map(([leg]) => leg);
}
