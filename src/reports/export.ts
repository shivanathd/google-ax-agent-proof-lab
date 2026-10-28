// Sanitized export (F4 technical spec, G-EXPORT). Order: tamper check → allowlisted projection → secret scan
// → private-terms scan. Any finding quarantines the candidate export under private-runs/quarantine/ and
// publishes nothing. Findings name the file and rule, never the matched value.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ROOT } from "../config/run-config.ts";
import { artifactDir } from "./artifacts.ts";
import { filesUnder, verifyChecksums, writeChecksums } from "./report.ts";

export const SECRET_RULES: [string, RegExp][] = [
  ["slack-token", /xox[abposr]-[A-Za-z0-9-]{8,}/],
  ["slack-signing-secret", /\bsign-[0-9a-f]{16,}\b/],
  ["oauth-client-secret", /\bcs-[0-9a-f]{16,}\b/],
  ["aws-access-key", /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["api-key", /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._-]{12,}/],
  ["absolute-home-path", /\/(Users|home)\/[^/\s"]+/],
];

// The private-terms list lives only in the main checkout's gitignored private-runs/ (shared by worktrees).
export function privateTermsPath(cwd = ROOT) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  return join(dirname(common), "private-runs", "private-terms.txt");
}

const REPORT_FIELDS = ["schema_version", "case_id", "run_id", "profile", "mode", "candidate_revision", "tree_sha", "dirty", "patch_sha256", "fixture_sha256",
  "collector", "observed_at", "execution", "reason", "mutation", "simulated_faults", "status", "lanes", "all_lanes_status", "banner", "assertions", "counts",
  "limitations", "cleanup_status", "started_at", "ended_at", "durations"] as const;
const BUNDLE_FIELDS = ["schema_version", "case_id", "run_id", "profile", "mode", "execution", "reason", "candidate_revision", "tree_sha", "dirty", "patch_sha256",
  "fixture_sha256", "dependencies_sha256", "mutation", "collector_methods", "observed_at", "simulated_faults", "observations", "unobserved"] as const;
const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

export interface ExportResult { status: "EXPORTED" | "QUARANTINED" | "REJECTED"; run_id: string; findings: { file: string; rule: string }[]; output: string | null }

export function exportRun(runId: string, o: { termsPath?: string; outRoot?: string; quarantineRoot?: string } = {}): ExportResult {
  const src = artifactDir(runId);
  const integrity = verifyChecksums(src);
  if (!integrity.ok) return { status: "REJECTED", run_id: runId, findings: integrity.problems.map((p) => ({ file: p, rule: "tamper-check" })), output: null };

  const termsPath = o.termsPath ?? privateTermsPath();
  // Fail closed: without the private-terms list nothing can be shown to be free of private identity.
  if (!existsSync(termsPath)) return { status: "REJECTED", run_id: runId, findings: [{ file: "private-terms.txt", rule: "private-terms-list-missing" }], output: null };
  const terms = readFileSync(termsPath, "utf8").split("\n").map((t) => t.trim().toLowerCase()).filter(Boolean);

  // Scan every captured file, not only the projection: a secret anywhere in the capture blocks the export.
  const findings: ExportResult["findings"] = [];
  for (const f of filesUnder(src)) {
    const text = readFileSync(f, "utf8");
    const rel = relative(src, f);
    for (const [rule, re] of SECRET_RULES) if (re.test(text)) findings.push({ file: rel, rule });
    if (terms.some((t) => text.toLowerCase().includes(t))) findings.push({ file: rel, rule: "private-term" });
  }
  const report = JSON.parse(readFileSync(join(src, "report.json"), "utf8"));
  const bundle = JSON.parse(readFileSync(join(src, "observations.json"), "utf8"));
  const projection = { "report.json": pick(report, REPORT_FIELDS), "observations.json": pick(bundle, BUNDLE_FIELDS) };

  const target = findings.length
    ? join(o.quarantineRoot ?? join(ROOT, "private-runs", "quarantine"), `${runId}-${Date.now()}`)
    : join(o.outRoot ?? join(ROOT, "artifacts", "exports"), runId);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const [name, value] of Object.entries(projection)) writeFileSync(join(target, name), `${JSON.stringify(value, null, 2)}\n`);
  if (findings.length) {
    writeFileSync(join(target, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
    return { status: "QUARANTINED", run_id: runId, findings, output: null };
  }
  writeChecksums(target);
  return { status: "EXPORTED", run_id: runId, findings: [], output: relative(ROOT, target) };
}
