// Mutation probes (F4-R6, BUILD_PLAN §8.7): each tests/mutations/*.patch is applied in a throwaway git worktree
// of HEAD — never via flags in shipped code — and the relevant integration tests plus supplied evaluator cases
// run there. A mutant is caught when any check FAILs, uncaught when all pass, invalid when it cannot be applied
// or does not typecheck. The candidate checkout is never modified. Writes artifacts/mutations/<timestamp>.json.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateIdentity, ROOT } from "../../src/config/run-config.ts";
import { stopRun } from "../../src/config/lifecycle.ts";
import { loadManifest } from "../../src/config/manifest.ts";

const EVALUATOR = "docs/spec/active/2026-10-28-agent-proof-lab/evals/evaluate.py";
// The checks each mutant must be caught by: integration tests (optionally filtered) and evaluator cases.
const CHECKS: Record<string, { tests: string[]; filter?: string; cases: string[] }> = {
  "01-disable-dedupe": { tests: ["tests/integration/slack.test.ts"], filter: "F2-A2", cases: ["F2-A2"] },
  "02-bypass-approval": { tests: ["tests/unit/policy.test.ts"], cases: ["F3-A2", "S3"] },
  "03-reply-before-receipt": { tests: ["tests/integration/workflows.test.ts"], filter: "W01-S", cases: ["S2"] },
  "04-missing-evidence-success": { tests: ["tests/integration/evidence.test.ts"], filter: "G-UNKNOWN|PASS needs", cases: ["F4-A1"] },
};

const git = (args: string[], cwd = ROOT) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const status = (code: number | null) => (code === 0 ? "PASS" : code === 2 ? "BLOCKED" : "FAIL");
const before = candidateIdentity();
const only = process.argv.slice(2);
const results = [];

for (const file of readdirSync(join(ROOT, "tests/mutations")).filter((f) => f.endsWith(".patch")).sort()) {
  const name = file.replace(/\.patch$/, "");
  if (only.length && !only.includes(name)) continue;
  const check = CHECKS[name];
  const dir = join(mkdtempSync(join(tmpdir(), "apl-mutant-")), "tree");
  const t0 = Date.now();
  const checks: { check: string; status: string }[] = [];
  let verdict: "caught" | "uncaught" | "invalid";
  let reason = "";
  try {
    git(["worktree", "add", "--detach", "--quiet", dir, "HEAD"]);
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const env = { ...process.env, APL_MUTATION: name };
    const run = (label: string, cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { cwd: dir, env, stdio: "ignore", timeout: 900_000 });
      checks.push({ check: label, status: status(r.status) });
      return r.status;
    };
    if (!check) throw new Error("no checks registered for this mutant");
    if (spawnSync("git", ["apply", join(ROOT, "tests/mutations", file)], { cwd: dir }).status !== 0) throw new Error("patch does not apply to HEAD");
    if (run("typecheck", "npx", ["tsc", "--noEmit"]) !== 0) throw new Error("mutant does not typecheck");
    run(`vitest ${check.tests.join(" ")}${check.filter ? ` -t "${check.filter}"` : ""}`, "npx", ["vitest", "run", ...check.tests, ...(check.filter ? ["-t", check.filter] : [])]);
    run(`evaluate.py ${check.cases.join(" ")}`, "python3", [join(dir, EVALUATOR), ...check.cases]);
    verdict = checks.slice(1).some((c) => c.status === "FAIL") ? "caught" : "uncaught";
  } catch (e) {
    verdict = "invalid";
    reason = (e as Error).message;
  } finally {
    // A check killed by its timeout skips its own teardown. Stop every run the mutant started before its
    // worktree (and with it the only manifests naming those containers) is deleted.
    const runs = join(dir, "private-runs");
    if (existsSync(runs)) {
      process.env.APL_RUNS_DIR = runs;
      for (const id of readdirSync(runs).filter((n) => existsSync(join(runs, n, "manifest.json")))) {
        if (loadManifest(id).cleanup_status !== "CLEAN") await stopRun(id).catch(() => undefined);
      }
      delete process.env.APL_RUNS_DIR;
    }
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: ROOT, stdio: "ignore" });
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
  results.push({ mutant: name, patch: `tests/mutations/${file}`, verdict, checks, ...(reason ? { reason } : {}), seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`${name}: ${verdict}`);
}
git(["worktree", "prune"]);

// The known-good candidate must be untouched after the probes (F4-R6).
const after = candidateIdentity();
const summary = {
  caught: results.filter((r) => r.verdict === "caught").length,
  uncaught: results.filter((r) => r.verdict === "uncaught").length,
  invalid: results.filter((r) => r.verdict === "invalid").length,
};
const record = {
  schema_version: 1, recorded_at: new Date().toISOString(), candidate: { revision: before.revision, tree_sha: before.tree_sha, dirty: before.dirty },
  candidate_restored: after.tree_sha === before.tree_sha && after.patch_sha256 === before.patch_sha256, summary, results,
  note: "Counts are of these probes only; they do not show the application is free of other defects.",
};
mkdirSync(join(ROOT, "artifacts", "mutations"), { recursive: true });
const out = join(ROOT, "artifacts", "mutations", `${record.recorded_at.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, candidate_restored: record.candidate_restored, output: out.slice(ROOT.length) }));
process.exit(summary.uncaught || summary.invalid || !record.candidate_restored ? 1 : 0);
