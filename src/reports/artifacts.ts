// Run artifacts under artifacts/runs/{run_id}/ (F4 technical spec): manifest.json, events.ndjson,
// observations.json (+ evidence/), report.json, report.md, checksums.sha256. Expectations come from the
// spec's fixed cases.json — this is the evaluator side, never the worker or the collector.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneStatuses } from "../config/profiles.ts";
import { ROOT } from "../config/run-config.ts";
import { assertContract } from "../contracts/validate.ts";
import type { ProfileName } from "../contracts/profile.ts";
import { buildReport, reportMarkdown, verifyChecksums, writeChecksums, type Bundle } from "./report.ts";
import { scenario } from "./scenarios.ts";

export const SPEC_CASES = join(ROOT, "docs/spec/active/2026-10-28-agent-proof-lab/evals/cases.json");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const artifactsRoot = () => process.env.APL_ARTIFACTS_DIR ?? join(ROOT, "artifacts", "runs");
export function artifactDir(runId: string) {
  if (!UUID.test(runId)) throw new Error("run id must be a UUID");
  return join(artifactsRoot(), runId);
}

export function expectationsFor(caseId: string): Record<string, boolean | number | string> {
  const cases = JSON.parse(readFileSync(SPEC_CASES, "utf8"));
  // Console scenarios (src/reports/scenarios.ts) reuse a supplied case's expectations or a CASEBOOK row.
  const s = scenario(caseId);
  const expected = cases[caseId]?.expected ?? (s?.expected_from ? cases[s.expected_from]?.expected : s?.expected);
  if (!expected) throw new Error(`unknown case ${caseId}`);
  return expected;
}

export const readBundle = (dir: string) => assertContract<Bundle>("observation-bundle", JSON.parse(readFileSync(join(dir, "observations.json"), "utf8")));

// Regenerates report.json/report.md and the checksum list from the stored bundle. Safe to re-run.
export async function generateReport(runId: string, o: { cleanup_status?: "CLEAN" | "INCOMPLETE" | "NOT_RUN" | "RETAINED_BY_REQUEST"; cleanup_remaining?: string[]; started_at?: string; ended_at?: string } = {}) {
  const dir = artifactDir(runId);
  if (!existsSync(join(dir, "observations.json"))) throw new Error(`no observations for run ${runId}`);
  // Regenerating must not launder tampering: captured files must still match the recorded checksums.
  if (existsSync(join(dir, "checksums.sha256"))) {
    const bad = verifyChecksums(dir).problems.filter((p) => !/report\.(json|md)$/.test(p));
    if (bad.length) throw new Error(`run ${runId} artifacts fail integrity check: ${bad.join("; ")}`);
  }
  const bundle = readBundle(dir);
  const meta = existsSync(join(dir, "manifest.json")) ? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) : {};
  const optional = await laneStatuses((bundle.selected_profiles ?? []) as ProfileName[], process.env);
  const report = buildReport({
    bundle, expected: expectationsFor(bundle.case_id), optional,
    cleanup_status: o.cleanup_status ?? meta.cleanup_status, cleanup_remaining: o.cleanup_remaining ?? [],
    started_at: o.started_at ?? meta.started_at, ended_at: o.ended_at ?? meta.ended_at,
    artifacts: ["manifest.json", "events.ndjson", "observations.json", ...(bundle.evidence ?? []).map((e) => e.path), "report.json", "report.md", "checksums.sha256"],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), reportMarkdown(report));
  writeChecksums(dir);
  return report;
}
