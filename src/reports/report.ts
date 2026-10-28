// C5 RunReport generation (F4-R3, F4-R4). Pure functions over a C4 bundle plus fixed expectations; the
// worker's own claims never enter here. Status precedence: FAIL > UNKNOWN > BLOCKED > NOT_RUN > PASS.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertContract } from "../contracts/validate.ts";
import type { DoctorResult, LaneStatus } from "../contracts/profile.ts";

export type Status = LaneStatus;
type Fact = boolean | number | string;

export interface Evidence { path: string; sha256: string; source: string; observations?: string[] }
export interface Bundle {
  schema_version: 1; case_id: string; run_id: string; profile: string; mode: string; execution: "EXECUTED" | "BLOCKED" | "NOT_RUN";
  reason?: string; candidate_revision: string; tree_sha?: string; dirty?: boolean; patch_sha256?: string; fixture_sha256: string;
  dependencies_sha256?: string; seed?: number; floci_image?: string; mutation?: string; collector: string; collector_methods?: string[]; observed_at: string;
  selected_profiles?: string[]; simulated_faults?: string[]; observations: Record<string, Fact>; unobserved?: Record<string, string>;
  evidence?: Evidence[];
}
export interface Assertion { id: string; required: boolean; expected: Fact; observed: Fact | null; status: Status; evidence_refs: string[]; reason: string | null }
export type Lane = { status: Status; selected: boolean; reason: string; parity?: Status; prerequisites?: DoctorResult["prerequisites"] };

const PRECEDENCE: Status[] = ["FAIL", "UNKNOWN", "BLOCKED", "NOT_RUN"];

// CASEBOOK W01-H: a service request is complete only when ledger, S3 receipt and Slack thread all agree.
export const W01_COMPLETION = { ticket_count: 1, receipt_count: 1, receipt_matches_request: true, completion_reply_count: 1 } as const;

// Only required, non-skipped statuses count. No required assertion at all is NOT_RUN, never PASS.
export function aggregate(statuses: Status[]): Status {
  const counted: Status[] = statuses.filter((s) => s !== "SKIPPED");
  if (!counted.length) return "NOT_RUN";
  return PRECEDENCE.find((s) => counted.includes(s)) ?? "PASS";
}

// Same rule as the supplied evaluator: types must match, so false never equals 0.
const same = (a: unknown, b: unknown) => typeof a === typeof b && a === b;

// An assertion passes only with a typed observation AND direct evidence; a missing fact is UNKNOWN.
export function assess(bundle: Bundle, expected: Record<string, Fact>, required = true): Assertion[] {
  return Object.entries(expected).map(([id, want]) => {
    const base = { id, required, expected: want, observed: null as Fact | null, evidence_refs: [] as string[] };
    if (bundle.execution !== "EXECUTED") {
      return { ...base, status: bundle.execution === "BLOCKED" ? "BLOCKED" : "NOT_RUN", reason: bundle.reason ?? "no execution evidence" };
    }
    if (!(id in bundle.observations)) return { ...base, status: "UNKNOWN", reason: bundle.unobserved?.[id] ?? "observation not collected" };
    const observed = bundle.observations[id]!;
    const refs = (bundle.evidence ?? []).filter((e) => e.observations?.includes(id)).map((e) => e.path);
    if (!refs.length) return { ...base, observed, status: "UNKNOWN", reason: "no direct evidence recorded for this observation" };
    return { ...base, observed, evidence_refs: refs, status: same(observed, want) ? "PASS" : "FAIL", reason: same(observed, want) ? null : "observed value differs" };
  });
}

export function counts(assertions: Assertion[]) {
  const req = assertions.filter((a) => a.required);
  const n = (s: Status) => assertions.filter((a) => a.status === s).length;
  return { required: req.length, passed: n("PASS"), failed: n("FAIL"), blocked: n("BLOCKED"), skipped: n("SKIPPED"), not_run: n("NOT_RUN"), unknown: n("UNKNOWN") };
}

// Optional lanes: unselected → SKIPPED and excluded; selected → the doctor's status, never upgraded here.
export function lanesFrom(local: Status, optional: Record<string, DoctorResult & { parity?: Status }>): Record<string, Lane> {
  const lanes: Record<string, Lane> = { local: { status: local, selected: true, reason: "local core: required assertions only" } };
  for (const [name, d] of Object.entries(optional)) {
    const selected = d.status !== "SKIPPED";
    lanes[name] = { status: d.status, selected, reason: d.reason, ...(name === "salesforce" && selected ? { parity: d.parity ?? "UNKNOWN" } : {}), ...(selected ? { prerequisites: d.prerequisites } : {}) };
  }
  return lanes;
}

const MODE_LABEL: Record<string, string> = {
  scripted: "local integration run (scripted driver)", "fixture-replay": "fixture replay (not an integration run)", "live-model": "live-model run",
};

export function buildReport(o: {
  bundle: Bundle; expected: Record<string, Fact>; optional?: Record<string, DoctorResult & { parity?: Status }>;
  cleanup_status?: "CLEAN" | "RETAINED_BY_REQUEST" | "INCOMPLETE" | "NOT_RUN"; cleanup_remaining?: string[];
  started_at?: string; ended_at?: string; artifacts?: string[]; limitations?: string[];
}) {
  const b = o.bundle;
  const assertions = assess(b, o.expected);
  const status = aggregate(assertions.filter((a) => a.required).map((a) => a.status));
  const lanes = lanesFrom(status, o.optional ?? {});
  const all_lanes_status = aggregate(Object.values(lanes).filter((l) => l.selected).map((l) => l.status));
  const green = status === "PASS" && all_lanes_status === "PASS" && b.mode !== "fixture-replay" && (b.mutation ?? "none") === "none";
  const optionalText = Object.entries(lanes).filter(([n, l]) => n !== "local" && l.selected).map(([n, l]) => `${n} ${l.status}`).join(", ");
  const text = green
    ? `PASS: all ${assertions.length} required assertions passed with evidence (${MODE_LABEL[b.mode] ?? b.mode})`
    : `NOT A SUCCESS: local core ${status}${optionalText ? `; optional lanes ${optionalText}` : ""}${(b.mutation ?? "none") !== "none" ? `; mutation ${b.mutation} enabled` : ""}`;
  const limitations = [
    `Mode: ${MODE_LABEL[b.mode] ?? b.mode}.`,
    ...(b.simulated_faults?.length ? [`Simulated faults injected by the test coordinator: ${b.simulated_faults.join("; ")}.`] : []),
    ...(b.dirty ? ["Dirty candidate: bound to patch_sha256; no clean-revision claim is allowed."] : []),
    "Public challenge cases are visible to builders; they are not secret holdouts.",
    "Hashes bind artifacts; they do not prove an honest collector.",
    "Emulate's simulator routes accept any valid token; separation from the worker is proxy-enforced, not token-custody alone.",
    "Grants live in the worker-written ledger; the collector reads them read-only but cannot prove the worker did not alter them.",
    "Slack transport limits (Emulate's documented gaps, docs/RESEARCH.md): Socket Mode, slash commands, shortcuts, exact rate limiting and interaction types other than button actions and modal submissions are not emulated; this lab exercises Events API callbacks and button actions only, so it makes no claim about those surfaces.",
    ...(o.limitations ?? []),
  ];
  const report = {
    schema_version: 1 as const, case_id: b.case_id, run_id: b.run_id, profile: b.profile, mode: b.mode,
    candidate_revision: b.candidate_revision, tree_sha: b.tree_sha ?? "UNKNOWN", dirty: b.dirty ?? true, ...(b.patch_sha256 ? { patch_sha256: b.patch_sha256 } : {}),
    fixture_sha256: b.fixture_sha256, // F4-R2 identity: copied only when the bundle carries it (absent stays absent, never a default).
    ...(b.dependencies_sha256 ? { dependencies_sha256: b.dependencies_sha256 } : {}), ...(b.seed !== undefined ? { seed: b.seed } : {}), ...(b.floci_image ? { floci_image: b.floci_image } : {}),
    collector: b.collector, observed_at: b.observed_at, execution: b.execution, ...(b.reason ? { reason: b.reason } : {}),
    mutation: b.mutation ?? "none", simulated_faults: b.simulated_faults ?? [],
    status, lanes, all_lanes_status, banner: { green, text }, assertions, counts: counts(assertions), limitations,
    artifacts: o.artifacts ?? [], cleanup_status: o.cleanup_status ?? "NOT_RUN", cleanup_remaining: o.cleanup_remaining ?? [],
    started_at: o.started_at ?? b.observed_at, ended_at: o.ended_at ?? b.observed_at,
    durations: { wall_clock_seconds: duration(o.started_at, o.ended_at) },
  };
  return assertContract<typeof report>("run-report", report);
}

function duration(start?: string, end?: string) {
  if (!start || !end) return { value: null, reason: "start or end not recorded" };
  const s = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(s) && s >= 0 ? { value: s, reason: null } : { value: null, reason: "invalid timestamps" };
}

export function reportMarkdown(r: ReturnType<typeof buildReport>) {
  const rows = r.assertions.map((a) => `| ${a.id} | ${a.required ? "yes" : "no"} | \`${JSON.stringify(a.expected)}\` | \`${a.observed === null ? "—" : JSON.stringify(a.observed)}\` | ${a.status} | ${a.evidence_refs.join(", ") || "—"} | ${a.reason ?? ""} |`);
  const lanes = Object.entries(r.lanes).map(([n, l]) => `| ${n} | ${l.selected ? "yes" : "no"} | ${l.status} | ${l.parity ?? ""} | ${l.reason} |`);
  const c = r.counts;
  return [
    `# Run report: ${r.case_id}`, "",
    `> ${r.banner.green ? "✅" : "⚠️"} ${r.banner.text}`, "",
    `- Run: \`${r.run_id}\` · profile \`${r.profile}\` · mode \`${r.mode}\` · execution ${r.execution}`,
    `- Tree \`${r.tree_sha}\` · commit \`${r.candidate_revision}\` · dirty ${r.dirty}${r.patch_sha256 ? ` · patch \`${r.patch_sha256}\`` : ""} · mutation \`${r.mutation}\``,
    ...("floci_image" in r || "seed" in r ? [`- Seed \`${r.seed ?? "—"}\` · Floci image \`${r.floci_image ?? "not used"}\``] : []),
    `- Local core: **${r.status}** · all selected lanes: **${r.all_lanes_status}** · cleanup ${r.cleanup_status}`,
    `- Counts: required ${c.required}, passed ${c.passed}, failed ${c.failed}, blocked ${c.blocked}, skipped ${c.skipped}, not run ${c.not_run}, unknown ${c.unknown}`, "",
    "| Assertion | Required | Expected | Observed | Status | Evidence | Reason |", "|---|---|---|---|---|---|---|", ...rows, "",
    "| Lane | Selected | Status | Parity | Reason |", "|---|---|---|---|---|", ...lanes, "",
    "## Limitations", "", ...r.limitations.map((l) => `- ${l}`), "",
  ].join("\n");
}

export const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

// C4: `rel` must name something whose real path stays inside `dir` — no absolute path, no `..`, no symlink
// (file or directory) leading out. Returns the joined path, or null when it escapes or does not resolve.
export function containedPath(dir: string, rel: string): string | null {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return null;
  const p = join(dir, rel);
  try {
    const root = realpathSync(dir);
    const real = realpathSync(p);
    return real === root || real.startsWith(root + sep) ? p : null;
  } catch {
    return null;
  }
}

// lstat walk: symlinks are listed as entries (never followed), so a link cannot pull outside files in.
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      lstatSync(p).isDirectory() ? walk(p) : out.push(p);
    }
  };
  walk(dir);
  return out;
}
const escapes = (dir: string) => filesUnder(dir).map((p) => relative(dir, p)).filter((rel) => !containedPath(dir, rel)).map((rel) => `escapes artifact dir: ${rel}`);

// checksums.sha256 in `sha256sum` format over every other file in the run directory.
export function writeChecksums(dir: string) {
  const bad = escapes(dir);
  if (bad.length) throw new Error(`refusing to checksum: ${bad.join("; ")}`);
  const lines = filesUnder(dir).filter((p) => relative(dir, p) !== "checksums.sha256").map((p) => `${sha256File(p)}  ${relative(dir, p)}`);
  writeFileSync(join(dir, "checksums.sha256"), `${lines.join("\n")}\n`);
}

// Tamper check: every listed file must exist with its hash, and no unlisted file may appear.
export function verifyChecksums(dir: string) {
  const file = join(dir, "checksums.sha256");
  if (!existsSync(file)) return { ok: false, problems: ["checksums.sha256 missing"] };
  const listed = new Map(readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(66), l.slice(0, 64)] as const));
  const problems: string[] = escapes(dir);
  for (const [path, hash] of listed) {
    const p = containedPath(dir, path);
    if (p) {
      if (sha256File(p) !== hash) problems.push(`hash mismatch: ${path}`);
    } else if (!problems.includes(`escapes artifact dir: ${path}`)) problems.push(existsSync(join(dir, path)) ? `escapes artifact dir: ${path}` : `missing: ${path}`);
  }
  for (const p of filesUnder(dir)) {
    const rel = relative(dir, p);
    if (rel !== "checksums.sha256" && !listed.has(rel)) problems.push(`unlisted: ${rel}`);
  }
  return { ok: problems.length === 0, problems };
}
