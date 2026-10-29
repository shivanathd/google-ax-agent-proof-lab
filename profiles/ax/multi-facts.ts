// Pure fact functions for the many-tenant and two-cluster AX runs (docs/MULTI_CLUSTER_BUILD.md §9, §11.2, §12).
// No I/O and no cluster call: the runner and the collector pass in what they captured. A fact that cannot be
// established is absent with its reason, never 0 or false (design rule 3).
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { SECRET_RULES } from "../../src/reports/export.ts";
import type { Status } from "../../src/reports/report.ts";

export type Fact<T> = { value: T } | { absent: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- foreign_marker_count (design 6.3) ----

// An entry of private-runs/ax/tenant-runs.json, as listed under `foreign` in the --foreign-markers-file.
export interface ForeignRun { tenant_run_id: string; run_ids: string[]; tasks: string[]; token_sha256: string[] }
export interface MarkerHit { item: string; tenant_run_id: string; kind: "run_id" | "task" | "token"; marker: string }

// The export rules are not global, so test() and match() stop at the first token; these copies find every one.
const TOKEN_RULES = SECRET_RULES.map(([, re]) => new RegExp(re.source, `${re.flags}g`));

// `items` maps an item name (a Slack message, a Floci object key) to its text. Counts the items that carry a
// marker of another registered tenant run: its run IDs, a task name, or a token whose SHA-256 it lists. A token
// hit names the hash, never the token.
export function foreignMarkerCount(items: Record<string, string>, foreign: ForeignRun[], excluded: string[] = []): ({ value: number; found: MarkerHit[] }) | { absent: string } {
  if (!foreign.length) return { absent: "no foreign tenants" };
  const found: MarkerHit[] = [];
  for (const [item, text] of Object.entries(items)) {
    if (excluded.includes(item)) continue;
    const hashes = new Set(TOKEN_RULES.flatMap((re) => [...text.matchAll(re)].map((m) => sha256(m[0]))));
    for (const f of foreign) {
      const hit = (kind: MarkerHit["kind"], marker: string) => found.push({ item, tenant_run_id: f.tenant_run_id, kind, marker });
      for (const id of [f.tenant_run_id, ...f.run_ids]) if (text.includes(id)) hit("run_id", id);
      for (const task of f.tasks) if (text.includes(task)) hit("task", task);
      for (const h of f.token_sha256) if (hashes.has(h)) hit("token", h);
    }
  }
  return { value: new Set(found.map((h) => h.item)).size, found };
}

// ---- the gateway log (build §9.3, §9.4) ----

// With a selector, `kubectl logs` keeps only the last 10 lines per pod and opens at most 5 pods; without --prefix
// a line cannot be tied to its pod. The builder always sets all three and refuses when it cannot.
export function egressExtractArgs(o: { kubeconfig: string; from: string; pods: { name: string }[] }): string[] {
  if (!o.kubeconfig) throw new Error("refusing to build the extract: no kubeconfig");
  if (Number.isNaN(Date.parse(o.from))) throw new Error("refusing to build the extract: --since-time is not a timestamp");
  if (!o.pods.length) throw new Error("refusing to build the extract: no gateway pods listed, so --max-log-requests cannot cover them");
  return ["--kubeconfig", o.kubeconfig, "-n", "ate-system", "logs", "-l", "app=atenet-egress", "-c", "envoy",
    `--since-time=${o.from}`, "--tail=-1", "--prefix", `--max-log-requests=${o.pods.length}`];
}

export interface EgressEntry { pod: string | null; leg: string; time?: string; actor?: string; upstream: string | null }
export interface Window { from: string; to: string }

const PREFIX = /^\[pod\/([^/\]]+)\/[^\]]+\] /;
// %UPSTREAM_HOST% is ip:port ([ip]:port for IPv6); null or "-" means the gateway answered itself (L-049).
function upstreamAddress(u: unknown): string | null {
  if (typeof u !== "string" || u === "" || u === "-") return null;
  if (u.startsWith("[")) return u.slice(1, u.indexOf("]"));
  const parts = u.split(":");
  return parts.length === 2 ? parts[0]! : u;
}

// One entry per line of a --prefix extract: JSON access-log legs by their `leg`, the CONNECT text line as
// "connect" (kept, never counted), anything else as "other". JSON lines whose `time` falls outside the window
// are dropped; a line with no readable time is kept.
export function parseEgressLog(lines: string[], window: Window): EgressEntry[] {
  const from = Date.parse(window.from), to = Date.parse(window.to);
  return lines.flatMap((line): EgressEntry[] => {
    const m = PREFIX.exec(line);
    const pod = m?.[1] ?? null;
    const body = m ? line.slice(m[0].length) : line;
    if (body.startsWith("[egress] ")) return [{ pod, leg: "connect", upstream: null }];
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(body);
    } catch {
      return [{ pod, leg: "other", upstream: null }];
    }
    if (typeof j !== "object" || j === null) return [{ pod, leg: "other", upstream: null }];
    const t = Date.parse(String(j.time));
    if (t < from || t > to) return [];
    return [{ pod, leg: String(j.leg), time: String(j.time), actor: typeof j.actor === "string" ? j.actor : undefined, upstream: upstreamAddress(j.upstream) }];
  });
}

// The --egress-log-file (build Appendix A).
export interface EgressExtract { window: Window; pods_before: { name: string; restarts: number }[]; pods_after: { name: string; restarts: number }[]; exit_code: number; lines: string[] }

const COUNTED_LEGS = new Set(["mitm", "cleartext", "passthrough"]);
const podNames = (ps: EgressExtract["pods_before"]) => JSON.stringify(ps.map((p) => p.name).sort());
const podRestarts = (ps: EgressExtract["pods_before"]) => JSON.stringify(ps.map((p) => [p.name, p.restarts]).sort());

// cross_tenant_upstream_count and allowed_control_reached (design 6.3, 6.4). `own` holds this tenant's Emulate
// and Floci addresses (ClusterIP and pod IP); `selfReportForeignReached` is the probe's own count of foreign
// targets it reached. An incomplete extract makes both absent; a self-report the log does not back makes the
// count absent; a count above 0 stands whatever the self-report says.
export function crossTenantUpstreams(x: EgressExtract, own: { emulate: string[]; floci: string[] }, selfReportForeignReached: number):
  { cross_tenant_upstream_count: Fact<number>; allowed_control_reached: Fact<boolean> } {
  const upstreams = parseEgressLog(x.lines, x.window).filter((e) => COUNTED_LEGS.has(e.leg) && e.upstream).map((e) => e.upstream!);
  const incomplete =
    x.exit_code !== 0 ? `kubectl logs exited ${x.exit_code}`
    : podNames(x.pods_before) !== podNames(x.pods_after) ? "gateway pod set changed during the window"
    : podRestarts(x.pods_before) !== podRestarts(x.pods_after) ? "gateway pod restart count changed during the window"
    : !upstreams.some((u) => own.emulate.includes(u)) ? "allowed control's gateway entry missing from the window"
    : null;
  if (incomplete) {
    const absent = { absent: `incomplete extract: ${incomplete}` };
    return { cross_tenant_upstream_count: absent, allowed_control_reached: absent };
  }
  const count = upstreams.filter((u) => !own.emulate.includes(u) && !own.floci.includes(u)).length;
  return {
    cross_tenant_upstream_count: count === 0 && selfReportForeignReached > 0
      ? { absent: `self-report says ${selfReportForeignReached} foreign target(s) reached; the gateway log shows no cross-tenant upstream` }
      : { value: count },
    allowed_control_reached: { value: true },
  };
}

// ---- redaction (build §10, design 6.5) ----

// IPv6 first, so an IPv4-mapped address goes whole; every candidate must parse as an address (a clock time such
// as 10:00:30 does not). The lookarounds stop a match from starting or ending inside a longer token.
const V6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4})(?![\w:])/gi;
const V4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;

// Replaces every IP address in `text` with `<role>` from the targets file (the first role listed for that
// address), or `<unlisted-address>`; `unlisted` counts those, so their presence is recorded.
export function redactAddresses(text: string, targets: { role: string; address: string }[]): { text: string; unlisted: number } {
  const roles = new Map<string, string>();
  for (const t of targets) if (!roles.has(t.address.toLowerCase())) roles.set(t.address.toLowerCase(), t.role);
  let unlisted = 0;
  const swap = (m: string) => {
    if (!isIP(m)) return m;
    const role = roles.get(m.toLowerCase());
    if (!role) unlisted++;
    return `<${role ?? "unlisted-address"}>`;
  };
  return { text: text.replace(V6, swap).replace(V4, swap), unlisted };
}

// ---- timing (build §12) ----

// slog text handler: key=value pairs, a value quoted (strconv.Quote) when it holds spaces.
function slogFields(line: string): Record<string, string> {
  const unquote = (v: string) => {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  };
  return Object.fromEntries([...line.matchAll(/([\w.]+)=("(?:[^"\\]|\\.)*"|\S*)/g)].map(([, k, v]) => [k!, v!.startsWith('"') ? unquote(v!) : v!]));
}

// server_resume_to_running_ms per task, from an ax-server log extract: the "resuming actor" line to the next
// "task successfully reconciled and running" line with the same actor, both on the ax-server clock.
export function serverIntervals(log: string, tasks: string[]): Record<string, Fact<number>> {
  const lines = log.split("\n").map(slogFields);
  return Object.fromEntries(tasks.map((task): [string, Fact<number>] => {
    const i = lines.findIndex((l) => l.msg === "resuming actor on Substrate worker" && l.actor === task);
    if (i < 0) return [task, { absent: 'no "resuming actor on Substrate worker" line' }];
    const j = lines.findIndex((l, k) => k > i && l.msg === "task successfully reconciled and running" && l.actor === task);
    if (j < 0) return [task, { absent: 'no "task successfully reconciled and running" line after the resume' }];
    // The readiness poll timed out (15 s): the line does not mean ready.
    if (lines[j]!.workspaceReady === "false") return [task, { absent: "workspaceReady=false on the running line" }];
    const ms = Date.parse(lines[j]!.time ?? "") - Date.parse(lines[i]!.time ?? "");
    return [task, Number.isFinite(ms) && ms >= 0 ? { value: ms } : { absent: "invalid time fields" }];
  }));
}

// command_duration_ms from the runner's result.json (RFC 3339 with nanoseconds; millisecond resolution here).
export function commandDuration(result: { started_at?: string; ended_at?: string } | undefined): Fact<number> {
  if (!result) return { absent: "result.json absent" };
  const ms = Date.parse(result.ended_at ?? "") - Date.parse(result.started_at ?? "");
  return Number.isFinite(ms) && ms >= 0 ? { value: ms } : { absent: "result.json has no valid started_at and ended_at" };
}

export { p50 } from "../../src/reports/aggregate.ts";

// ---- the agreement rule (build §11.2) ----

// evaluate_ax.py's verdict against generateReport()'s status for the same bundle.
export function agrees(evaluate: { status: "PASS" | "FAIL" | "BLOCKED"; reasons: string[] }, report: Status): boolean {
  if (evaluate.status === "FAIL" && report === "UNKNOWN") return evaluate.reasons.length > 0 && evaluate.reasons.every((r) => r.startsWith("Missing observation: "));
  if (evaluate.status === "BLOCKED") return report === "BLOCKED" || report === "NOT_RUN";
  return evaluate.status === report;
}
