// Build phase 1 gate (docs/MULTI_CLUSTER_BUILD.md §3): report wording by profile (§11.1), generateReport()
// with `expected` and `limitations`, the §4.3 copy helper, and MT-W01 / MT-ISO in cases.ax.json.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../src/config/run-config.ts";
import { generateReport } from "../../src/reports/artifacts.ts";
import { buildReport, lanesFrom, reportMarkdown, writeChecksums, type Bundle } from "../../src/reports/report.ts";
import { copyBundle } from "../../profiles/ax/bundle-copy.ts";

const AX_LEDGER = "Ledger facts come from an export the in-sandbox coordinator wrote to the task's bucket; the collector reads it with its own credentials but cannot open the sandbox's ledger.";
const LOCAL_LEDGER = "Grants live in the worker-written ledger; the collector reads them read-only but cannot prove the worker did not alter them.";
const MT_W01 = { foreign_marker_count: 0 };
const EVIDENCE = '{"markers":[]}\n';
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function bundle(over: Partial<Bundle> = {}): Bundle {
  return {
    schema_version: 1, case_id: "MT-W01", run_id: randomUUID(), profile: "ax", mode: "scripted", execution: "EXECUTED",
    candidate_revision: "a".repeat(40), tree_sha: "a".repeat(40), dirty: false, fixture_sha256: "0".repeat(64), mutation: "none",
    collector: "test", observed_at: new Date().toISOString(), observations: { foreign_marker_count: 0 },
    evidence: [{ path: "evidence/markers.json", sha256: sha(EVIDENCE), source: "synthetic", observations: ["foreign_marker_count"] }], ...over,
  };
}

// A bundle dir as the collector writes it: observations.json plus its evidence.
function bundleDir(b: Bundle, root = mkdtempSync(join(tmpdir(), "apl-wording-"))) {
  const dir = join(root, b.run_id);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "observations.json"), JSON.stringify(b));
  writeFileSync(join(dir, "evidence", "markers.json"), EVIDENCE);
  return dir;
}

function artifactsRoot() {
  const root = mkdtempSync(join(tmpdir(), "apl-artifacts-"));
  process.env.APL_ARTIFACTS_DIR = root;
  return root;
}
afterEach(() => { delete process.env.APL_ARTIFACTS_DIR; });

describe("report wording by profile (§11.1)", () => {
  it("profile ax: AX strings and the ledger-export limitation", () => {
    const pass = buildReport({ bundle: bundle(), expected: MT_W01 });
    expect(pass.banner).toEqual({ green: true, text: "PASS: all 1 required assertions passed with evidence (AX task (scripted driver))" });
    expect(pass.lanes.local!.reason).toBe("AX lane: required assertions only");
    expect(pass.limitations).toContain("Mode: AX task (scripted driver).");
    expect(pass.limitations).toContain(AX_LEDGER);
    expect(pass.limitations).not.toContain(LOCAL_LEDGER);
    expect(reportMarkdown(pass)).toContain("- AX lane: **PASS**");
    const fail = buildReport({ bundle: bundle({ observations: { foreign_marker_count: 2 } }), expected: MT_W01 });
    expect(fail.banner.text).toBe("NOT A SUCCESS: AX lane FAIL");
    expect(lanesFrom("FAIL", {}, "ax").local).toEqual({ status: "FAIL", selected: true, reason: "AX lane: required assertions only" });
  });

  it("profile local and lanesFrom() without a profile: wording unchanged, key lanes.local kept", () => {
    const local = { profile: "local" as const, case_id: "F3-A1" };
    const pass = buildReport({ bundle: bundle(local), expected: MT_W01 });
    expect(pass.banner.text).toBe("PASS: all 1 required assertions passed with evidence (local integration run (scripted driver))");
    expect(pass.lanes.local!.reason).toBe("local core: required assertions only");
    expect(pass.limitations).toContain("Mode: local integration run (scripted driver).");
    expect(pass.limitations).toContain(LOCAL_LEDGER);
    expect(pass.limitations).not.toContain(AX_LEDGER);
    expect(reportMarkdown(pass)).toContain("- Local core: **PASS**");
    expect(buildReport({ bundle: bundle({ ...local, observations: {} }), expected: MT_W01 }).banner.text).toBe("NOT A SUCCESS: local core UNKNOWN");
    expect(lanesFrom("FAIL", {}).local).toEqual({ status: "FAIL", selected: true, reason: "local core: required assertions only" });
    expect(Object.keys(buildReport({ bundle: bundle(), expected: MT_W01 }).lanes)).toContain("local");
  });
});

describe("generateReport() with expected and limitations", () => {
  it("uses the given expectations and appends the limitations", async () => {
    const root = artifactsRoot();
    const b = bundle();
    writeChecksums(bundleDir(b, root));
    const r = await generateReport(b.run_id, { expected: MT_W01, limitations: ["one collector identity per cluster"] });
    expect([r.status, r.case_id]).toEqual(["PASS", "MT-W01"]);
    expect(r.limitations.at(-1)).toBe("one collector identity per cluster");
  });

  it("still refuses a tampered evidence file", async () => {
    const root = artifactsRoot();
    const b = bundle();
    const dir = bundleDir(b, root);
    writeChecksums(dir);
    writeFileSync(join(dir, "evidence", "markers.json"), '{"markers":["changed"]}\n');
    await expect(generateReport(b.run_id, { expected: MT_W01 })).rejects.toThrow(/integrity check: hash mismatch: evidence\/markers.json/);
  });

  it("still refuses an evidence path that escapes the artifact dir", async () => {
    const root = artifactsRoot();
    const outside = mkdtempSync(join(tmpdir(), "apl-outside-"));
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    const b = bundle({ evidence: [{ path: "evidence/up/secret.txt", sha256: sha("outside\n"), source: "synthetic", observations: ["foreign_marker_count"] }] });
    const dir = bundleDir(b, root);
    symlinkSync(outside, join(dir, "evidence", "up"));
    await expect(generateReport(b.run_id, { expected: MT_W01 })).rejects.toThrow(/escapes artifact dir/);
  });
});

describe("the §4.3 copy helper", () => {
  it("a bundle copied with the helper and altered afterwards is refused by its first generateReport()", async () => {
    artifactsRoot();
    const b = bundle();
    const dest = copyBundle(bundleDir(b), b.run_id);
    writeFileSync(join(dest, "observations.json"), JSON.stringify({ ...b, observations: { foreign_marker_count: 0, extra: 1 } }));
    await expect(generateReport(b.run_id, { expected: MT_W01 })).rejects.toThrow(/integrity check: hash mismatch: observations.json/);
  });

  it("why: a plain copy has no checksums.sha256, so the L-022 check does not run and the alteration passes", async () => {
    const root = artifactsRoot();
    const b = bundle();
    cpSync(bundleDir(b), join(root, b.run_id), { recursive: true });
    writeFileSync(join(root, b.run_id, "observations.json"), JSON.stringify({ ...b, observations: { foreign_marker_count: 0, extra: 1 } }));
    await expect(generateReport(b.run_id, { expected: MT_W01 })).resolves.toMatchObject({ status: "PASS" });
  });

  it("refuses to copy over an existing run", () => {
    artifactsRoot();
    const b = bundle();
    copyBundle(bundleDir(b), b.run_id);
    expect(() => copyBundle(bundleDir(b), b.run_id)).toThrow(/already exists/);
  });
});

describe("evaluate_ax.py with MT-W01 and MT-ISO", () => {
  const SCRIPT = join(ROOT, "profiles/ax/evaluate_ax.py");
  const run = (script: string, caseId: string, dir: string) => spawnSync("python3", [script, caseId, dir], { encoding: "utf8" });

  it("loads both cases and judges a matching bundle PASS", () => {
    const w01 = run(SCRIPT, "MT-W01", bundleDir(bundle()));
    expect(JSON.parse(w01.stdout)).toMatchObject({ case: "MT-W01", status: "PASS" });
    const iso = bundle({
      case_id: "MT-ISO", observations: { cross_tenant_upstream_count: 0, allowed_control_reached: true, foreign_marker_count: 0, probe_self_report_reached_count: 1 },
    });
    const out = JSON.parse(run(SCRIPT, "MT-ISO", bundleDir(iso)).stdout);
    expect(out).toMatchObject({ case: "MT-ISO", status: "PASS", recorded_not_asserted: { probe_self_report_reached_count: 1, ax_task_phase: null } });
  });

  it("still refuses a table that asserts a recorded-only key", () => {
    const tree = mkdtempSync(join(tmpdir(), "apl-evaltable-"));
    const evals = "docs/spec/active/2026-10-28-agent-proof-lab/evals";
    mkdirSync(join(tree, "profiles/ax"), { recursive: true });
    mkdirSync(join(tree, evals), { recursive: true });
    symlinkSync(join(ROOT, evals, "evaluate.py"), join(tree, evals, "evaluate.py"));
    copyFileSync(SCRIPT, join(tree, "profiles/ax/evaluate_ax.py"));
    const table = JSON.parse(readFileSync(join(ROOT, "profiles/ax/cases.ax.json"), "utf8"));
    table["MT-W01"].expected.concurrency = 1;
    writeFileSync(join(tree, "profiles/ax/cases.ax.json"), JSON.stringify(table));
    const r = run(join(tree, "profiles/ax/evaluate_ax.py"), "MT-W01", bundleDir(bundle()));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("MT-W01 asserts a recorded-only key");
  });
});
