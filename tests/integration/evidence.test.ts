// Task 4.1: independent collection and fail-closed reporting. F4-A1/A2 run through the real collect-case
// path (Emulate + Floci + worker + separate collector process); G-UNKNOWN spawns the real collector against an
// unreachable dependency; G-EXPORT, tamper, aggregation and schema checks run on generated artifacts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, createRunConfig, candidateIdentity } from "../../src/config/run-config.ts";
import { createManifest } from "../../src/config/manifest.ts";
import { workerConfig, workerEnv } from "../../src/worker/config.ts";
import { assertContract } from "../../src/contracts/validate.ts";
import { collectCase, collectorConfig, collectorEnv, COLLECTOR_AWS } from "../../src/evaluator/collect-case.ts";
import { CASES } from "../../src/collector/cases/index.ts";
import { aggregate, assess, buildReport, lanesFrom, verifyChecksums, writeChecksums, type Bundle } from "../../src/reports/report.ts";
import { generateReport } from "../../src/reports/artifacts.ts";
import { exportRun } from "../../src/reports/export.ts";
import { verifyRun } from "../../src/cli/commands/verify.ts";
import type { Workspace } from "../../src/adapters/slack/emulator.ts";
import type { RunHandle } from "../../src/config/lifecycle.ts";
import type { CaseDef } from "../../src/collector/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "apl-evidence-"));
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function bundle(over: Partial<Bundle> = {}): Bundle {
  const id = candidateIdentity();
  return {
    schema_version: 1, case_id: "F3-A1", run_id: createRunConfig({}).run_id, profile: "local", mode: "scripted", execution: "EXECUTED",
    candidate_revision: id.revision, tree_sha: id.tree_sha, dirty: id.dirty, fixture_sha256: "0".repeat(64), mutation: "none",
    collector: "test", observed_at: new Date().toISOString(), observations: { ticket_count: 1 },
    evidence: [{ path: "evidence/ledger.json", sha256: "1".repeat(64), source: "read-only SQLite query", observations: ["ticket_count"] }], ...over,
  };
}

describe("aggregation precedence (C5)", () => {
  it("FAIL > UNKNOWN > BLOCKED > NOT_RUN > PASS, SKIPPED excluded, nothing required is NOT_RUN", () => {
    expect(aggregate(["PASS", "NOT_RUN", "BLOCKED", "UNKNOWN", "FAIL"])).toBe("FAIL");
    expect(aggregate(["PASS", "NOT_RUN", "BLOCKED", "UNKNOWN"])).toBe("UNKNOWN");
    expect(aggregate(["PASS", "NOT_RUN", "BLOCKED"])).toBe("BLOCKED");
    expect(aggregate(["PASS", "NOT_RUN"])).toBe("NOT_RUN");
    expect(aggregate(["PASS", "SKIPPED"])).toBe("PASS");
    expect(aggregate(["SKIPPED"])).toBe("NOT_RUN");
    expect(aggregate([])).toBe("NOT_RUN");
  });

  it("an unselected optional lane leaves local-core status alone; the all-lanes status is separate", () => {
    const skipped = { profile: "salesforce" as const, status: "SKIPPED" as const, prerequisites: [], external_calls: 0, reason: "not selected" };
    const blocked = { ...skipped, status: "BLOCKED" as const, reason: "no credentials" };
    const r1 = buildReport({ bundle: bundle(), expected: { ticket_count: 1 }, optional: { salesforce: skipped } });
    expect([r1.status, r1.all_lanes_status, r1.banner.green, r1.lanes.salesforce!.selected]).toEqual(["PASS", "PASS", true, false]);
    const r2 = buildReport({ bundle: bundle(), expected: { ticket_count: 1 }, optional: { salesforce: blocked } });
    expect([r2.status, r2.all_lanes_status, r2.banner.green, r2.lanes.salesforce!.parity]).toEqual(["PASS", "BLOCKED", false, "UNKNOWN"]);
    expect(lanesFrom("FAIL", {}).local!.status).toBe("FAIL");
  });

  it("PASS needs a typed observation and direct evidence; false never equals 0", () => {
    expect(assess(bundle({ evidence: [] }), { ticket_count: 1 })[0]).toMatchObject({ status: "UNKNOWN", reason: expect.stringMatching(/no direct evidence/) });
    expect(assess(bundle({ observations: { ticket_count: 0 } }), { ticket_count: false } as any)[0]!.status).toBe("FAIL");
    expect(assess(bundle({ observations: {}, unobserved: { ticket_count: "ledger unreachable" } }), { ticket_count: 1 })[0])
      .toMatchObject({ status: "UNKNOWN", observed: null, reason: "ledger unreachable" });
    expect(assess(bundle({ execution: "BLOCKED", reason: "docker missing" }), { ticket_count: 1 })[0]!.status).toBe("BLOCKED");
  });
});

describe("C4/C5 schema validation", () => {
  it("accepts a valid bundle and report and rejects unknown versions, enums, fields and unsafe paths", () => {
    expect(() => assertContract("observation-bundle", bundle())).not.toThrow();
    const report = buildReport({ bundle: bundle(), expected: { ticket_count: 1 } });
    expect(() => assertContract("run-report", report)).not.toThrow();
    for (const bad of [
      { ...bundle(), schema_version: 2 }, { ...bundle(), execution: "DONE" }, { ...bundle(), worker_says: "PASS" },
      { ...bundle(), evidence: [{ path: "/etc/passwd", sha256: "1".repeat(64), source: "x" }] },
      { ...bundle(), evidence: [{ path: "../escape.json", sha256: "1".repeat(64), source: "x" }] },
      { ...bundle(), observations: { ticket_count: null } }, { ...bundle(), execution: "BLOCKED", reason: undefined },
    ]) expect(() => assertContract("observation-bundle", JSON.parse(JSON.stringify(bad)))).toThrow();
    expect(() => assertContract("run-report", { ...report, schema_version: 2 })).toThrow();
    expect(() => assertContract("run-report", { ...report, status: "GREEN" })).toThrow();
  });
});

describe("C4 symlink escape (no Docker)", () => {
  // An artifact dir whose files hash cleanly, plus a file outside it that a symlink can point at.
  function artifactRun() {
    const root = mkdtempSync(join(tmpdir(), "apl-symlink-"));
    const b = bundle({ case_id: "F4-A1", evidence: [{ path: "evidence/ledger.json", sha256: "1".repeat(64), source: "read-only SQLite query", observations: ["ticket_count"] }] });
    const dir = join(root, "runs", b.run_id);
    mkdirSync(join(dir, "evidence"), { recursive: true });
    writeFileSync(join(dir, "observations.json"), JSON.stringify(b));
    writeFileSync(join(dir, "report.json"), "{}");
    writeFileSync(join(dir, "evidence", "ledger.json"), "[]");
    const outside = join(root, "outside-secret.txt");
    writeFileSync(outside, "outside the artifact dir\n");
    return { root, dir, runId: b.run_id, outside };
  }

  it("verifyChecksums rejects a symlink inside the artifact dir that points outside it, even after re-binding", () => {
    const { dir, outside } = artifactRun();
    writeChecksums(dir);
    expect(verifyChecksums(dir)).toEqual({ ok: true, problems: [] });
    symlinkSync(outside, join(dir, "evidence", "escape.json"));
    expect(verifyChecksums(dir).problems).toContain("escapes artifact dir: evidence/escape.json");
    // Blessing the escape with fresh checksums is refused, not hashed through the link.
    expect(() => writeChecksums(dir)).toThrow(/escapes artifact dir: evidence\/escape.json/);
  });

  it("a listed evidence file replaced by an outward symlink fails verification, report regeneration and export", async () => {
    const { root, dir, runId, outside } = artifactRun();
    writeChecksums(dir);
    const listed = readFileSync(join(dir, "checksums.sha256"), "utf8");
    rmSync(join(dir, "evidence", "ledger.json"));
    symlinkSync(outside, join(dir, "evidence", "ledger.json"));
    writeFileSync(join(dir, "checksums.sha256"), listed.replace(/^[0-9a-f]{64}(?=  evidence\/ledger\.json$)/m, sha256Hex(readFileSync(outside))));
    expect(verifyChecksums(dir)).toMatchObject({ ok: false, problems: expect.arrayContaining(["escapes artifact dir: evidence/ledger.json"]) });
    process.env.APL_ARTIFACTS_DIR = join(root, "runs");
    try {
      await expect(generateReport(runId)).rejects.toThrow(/escapes artifact dir/);
      const terms = join(root, "terms.txt");
      writeFileSync(terms, "fictional-private-term-zz\n");
      expect(exportRun(runId, { termsPath: terms, outRoot: join(root, "exports"), quarantineRoot: join(root, "q") })).toMatchObject({ status: "REJECTED" });
      expect(existsSync(join(root, "exports"))).toBe(false);
    } finally {
      delete process.env.APL_ARTIFACTS_DIR;
    }
  });

  it("a bundle evidence path that resolves outside the artifact dir is refused when the report is generated", async () => {
    const { root, dir, runId, outside } = artifactRun();
    symlinkSync(join(root), join(dir, "evidence", "up")); // a directory link: evidence/up/... escapes
    const b = read(join(dir, "observations.json"));
    b.evidence = [{ path: "evidence/up/outside-secret.txt", sha256: "1".repeat(64), source: "read-only SQLite query", observations: ["ticket_count"] }];
    writeFileSync(join(dir, "observations.json"), JSON.stringify(b));
    expect(existsSync(outside)).toBe(true);
    process.env.APL_ARTIFACTS_DIR = join(root, "runs");
    try {
      await expect(generateReport(runId)).rejects.toThrow(/escapes artifact dir/);
    } finally {
      delete process.env.APL_ARTIFACTS_DIR;
    }
  });
});

describe("collector independence (BUILD_PLAN §8.5)", () => {
  const ws = (id: string): Workspace => ({
    tenant_id: `T_LAB_${id}`, installation_id: id, url: `http://127.0.0.1:1${id === "A" ? 1 : 2}`, team_id: "T000000001", channel_id: "C1",
    api_app_id: "A_LABBOT", bot_user_id: "U_LABBOT", signing_secret: `sign-${id}`, client_id: "cid", client_secret: `client-secret-${id}`, users: { dana: "U1" },
    tokens: { worker: `xoxb-worker-${id}`, narrow: `xoxb-narrow-${id}`, setup: `xoxp-setup-${id}`, reader: `xoxp-reader-${id}`, users: { dana: `xoxp-dana-${id}` } },
    close: async () => {},
  });
  const run_id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const h = {
    manifest: { config: { run_id, endpoint_allowlist: [] }, db_path: "/x/ledger.db" }, workspaces: [ws("A"), ws("B")],
    flociEndpoint: "http://127.0.0.1:13", floci: { bucket: "b", queueUrl: "q", queue: "q" },
  } as unknown as RunHandle;

  it("the worker env never holds collector or simulator credentials, and the collector env never holds worker or setup ones", () => {
    const worker = JSON.stringify(workerEnv(workerConfig({ run_id, db_path: "/x/ledger.db", http_port: 9, allowlist: [] }, h.workspaces), { PATH: "/bin" }));
    const collector = JSON.stringify(collectorEnv(collectorConfig(h, "F3-A1", "/x/out.json", CASES["F3-A1"] as CaseDef), { PATH: "/bin" }));
    for (const id of ["A", "B"]) {
      for (const s of [`xoxp-reader-${id}`, `xoxp-setup-${id}`, `xoxp-dana-${id}`]) expect(worker).not.toContain(s);
      for (const s of [`xoxb-worker-${id}`, `xoxb-narrow-${id}`, `xoxp-setup-${id}`, `xoxp-dana-${id}`, `sign-${id}`, `client-secret-${id}`]) expect(collector).not.toContain(s);
      expect(collector).toContain(`xoxp-reader-${id}`);
    }
    expect(worker).not.toContain(COLLECTOR_AWS.accessKeyId);
    expect(collector).toContain(COLLECTOR_AWS.accessKeyId);
  });

  it("collector sources never read the spec's expected observations", () => {
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
    for (const f of files(join(ROOT, "src/collector"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/evals\/|2026-10-28-agent-proof-lab|SPEC_CASES|expectationsFor|reports\/artifacts/);
    }
  });
});

describe("G-UNKNOWN: a collector that cannot reach a dependency", () => {
  it("leaves every observation absent with a reason, and the report is UNKNOWN — never 0 or PASS", async () => {
    process.env.APL_RUNS_DIR = join(tmp, "runs");
    const config = createRunConfig({});
    const m = createManifest(config, candidateIdentity().tree_sha);
    delete process.env.APL_RUNS_DIR;
    const out = join(tmp, "unknown", "observations.json");
    mkdirSync(join(tmp, "unknown"), { recursive: true });
    const cfg = {
      case_id: "F3-A1", output: out, artifacts_dir: join(tmp, "unknown-artifacts"), manifest_path: join(tmp, "runs", config.run_id, "manifest.json"),
      db_path: join(tmp, "missing", "ledger.db"), allowlist: [{ scheme: "http" as const, host: "127.0.0.1", port: 9 }], mutation: "none",
      slack: [{ tenant_id: "T_LAB_A", installation_id: "A", url: "http://127.0.0.1:9", reader_token: "xoxp-reader-test", channel_id: "C1", bot_user_id: "U_LABBOT", users: {} }],
    };
    const child = spawn(process.execPath, ["--import", "tsx", "src/collector/main.ts"], { cwd: ROOT, env: collectorEnv(cfg), stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    expect(JSON.parse(String((await lines.next()).value))).toMatchObject({ ready: true });
    child.stdin!.write(`${JSON.stringify({ op: "finish", refs: { ts: "1700000000.000100" } })}\n`);
    expect(JSON.parse(String((await lines.next()).value))).toMatchObject({ done: true, observed: 0 });
    const b = assertContract<Bundle>("observation-bundle", read(out));
    expect(b.observations).toEqual({});
    expect(Object.keys(b.unobserved!).sort()).toEqual(["completion_reply_count", "receipt_count", "receipt_matches_request", "ticket_count"]);
    for (const reason of Object.values(b.unobserved!)) expect(reason).toMatch(/not collected/);
    const r = buildReport({ bundle: b, expected: { ticket_count: 1, receipt_count: 1, receipt_matches_request: true, completion_reply_count: 1 } });
    expect([r.status, r.banner.green, r.counts.unknown, r.counts.passed]).toEqual(["UNKNOWN", false, 4, 0]);
    expect(r.assertions.every((a) => a.observed === null)).toBe(true);
    expect(m.config.run_id).toBe(b.run_id);
  });
});

describe("F4 through the real stack", () => {
  const results: Record<string, { bundle: Bundle; dir: string; report: any }> = {};
  beforeAll(async () => {
    for (const id of ["F4-A1", "F4-A2"]) {
      const out = join(tmp, id, "observations.json");
      expect(await collectCase(id, out)).toBe(0);
      const b = read(out) as Bundle;
      results[id] = { bundle: b, dir: join(tmp, id), report: read(join(tmp, id, "evidence", "report.json")) };
    }
  });

  it("F4-A1: worker claims success but the S3 receipt is gone → required assertion FAIL, no green banner", () => {
    const { bundle: b, report } = results["F4-A1"]!;
    expect(b.observations).toMatchObject({ worker_claimed_success: true, receipt_present: false, receipt_count: 0, required_assertion_failed: true, overall_success_banner: false });
    expect(b.simulated_faults).toEqual([expect.stringMatching(/simulated fault/)]);
    expect(report.status).toBe("FAIL");
    expect(report.assertions.find((a: any) => a.id === "receipt_count")).toMatchObject({ status: "FAIL", observed: 0 });
    expect(report.banner).toMatchObject({ green: false, text: expect.stringMatching(/^NOT A SUCCESS/) });
    expect(b.mutation).toBe("none");
  });

  it("F4-A2: selected Salesforce without credentials is BLOCKED with parity UNKNOWN; local results stay separate", () => {
    const { bundle: b, report } = results["F4-A2"]!;
    expect(b.observations).toMatchObject({ salesforce_status: "BLOCKED", salesforce_parity: "UNKNOWN", local_results_separate: true });
    expect([report.status, report.all_lanes_status, report.banner.green]).toEqual(["PASS", "BLOCKED", false]);
    const run = read(join(ROOT, "artifacts", "runs", b.run_id, "report.json"));
    expect(run.lanes.salesforce).toMatchObject({ selected: true, status: "BLOCKED", parity: "UNKNOWN" });
    expect(run.lanes.coderabbit).toMatchObject({ selected: false, status: "SKIPPED" });
  });

  describe("artifacts", () => {
    let runId: string;
    let root: string;
    beforeAll(() => {
      // Work on a copy so the real run directory stays intact.
      runId = results["F4-A1"]!.bundle.run_id;
      root = join(tmp, "artifacts");
      cpSync(join(ROOT, "artifacts", "runs", runId), join(root, runId), { recursive: true });
      process.env.APL_ARTIFACTS_DIR = root;
    });
    afterAll(() => void delete process.env.APL_ARTIFACTS_DIR);

    it("writes the C5 artifact set with checksums that verify", () => {
      for (const f of ["manifest.json", "events.ndjson", "observations.json", "report.json", "report.md", "checksums.sha256"]) expect(existsSync(join(root, runId, f)), f).toBe(true);
      expect(() => assertContract("run-report", read(join(root, runId, "report.json")))).not.toThrow();
      expect(verifyRun(runId)).toMatchObject({ ok: true, tampered_artifact_rejected: false });
      expect(readFileSync(join(root, runId, "manifest.json"), "utf8")).not.toMatch(/xox[bp]-|ledger\.db|\/Users\//);
    });

    it("G-EXPORT: clean export succeeds; a secret-shaped canary blocks it and quarantines; a missing terms list fails closed", () => {
      const terms = join(tmp, "terms.txt");
      writeFileSync(terms, "fictional-private-term-zz\n");
      const ok = exportRun(runId, { termsPath: terms, outRoot: join(tmp, "exports"), quarantineRoot: join(tmp, "quarantine") });
      expect(ok).toMatchObject({ status: "EXPORTED", findings: [] });
      expect(exportRun(runId, { termsPath: join(tmp, "absent.txt"), outRoot: join(tmp, "exports2") })).toMatchObject({ status: "REJECTED", findings: [{ rule: "private-terms-list-missing" }] });

      const canary = `xoxb-${"c4a7".repeat(6)}`;
      writeFileSync(join(root, runId, "evidence", "w01-thread.json"), JSON.stringify([{ text: `leaked ${canary}` }]));
      writeChecksums(join(root, runId)); // re-bind, so only the secret scan (not the tamper check) can stop it
      const q = exportRun(runId, { termsPath: terms, outRoot: join(tmp, "exports3"), quarantineRoot: join(tmp, "quarantine") });
      expect(q).toMatchObject({ status: "QUARANTINED", output: null });
      expect(q.findings).toContainEqual({ file: "evidence/w01-thread.json", rule: "slack-token" });
      expect(existsSync(join(tmp, "exports3"))).toBe(false);
      const quarantined = readdirSync(join(tmp, "quarantine"));
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(join(tmp, "quarantine", quarantined[0]!, "findings.json"), "utf8")).not.toContain(canary);
    });

    it("rejects a tampered artifact and refuses to regenerate a report over it", async () => {
      const p = join(root, runId, "observations.json");
      writeFileSync(p, readFileSync(p, "utf8").replace('"overall_success_banner": false', '"overall_success_banner": true'));
      expect(verifyRun(runId)).toMatchObject({ ok: false, tampered_artifact_rejected: true, problems: ["hash mismatch: observations.json"] });
      await expect(generateReport(runId)).rejects.toThrow(/integrity/);
      expect(exportRun(runId, { termsPath: join(tmp, "terms.txt") })).toMatchObject({ status: "REJECTED" });
    });
  });
});
