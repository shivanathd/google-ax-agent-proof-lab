// `npm run verify:task -- <id>`: typecheck + the task's tests (+ supplied acceptance cases once
// `collect-case` exists). Exit 0 pass, 1 fail, 2 only for a missing LOCAL prerequisite.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "../../src/config/lifecycle.ts";
import { ROOT } from "../../src/config/run-config.ts";

interface TaskSpec { tests: string[]; docker: boolean; cases: string[] }
const TASKS: Record<string, TaskSpec> = {
  "1.1": { tests: ["tests/unit/config.test.ts", "tests/integration/lifecycle.test.ts"], docker: true, cases: ["F1-A1", "F1-A2"] },
  "2.1": { tests: ["tests/unit/slack.test.ts", "tests/integration/slack.test.ts"], docker: true, cases: ["F2-A1", "F2-A2"] },
  "3.1": { tests: ["tests/unit/policy.test.ts", "tests/integration/workflows.test.ts"], docker: true, cases: ["F3-A1", "F3-A2", "F3-A3"] },
  "4.1": { tests: ["tests/integration/evidence.test.ts"], docker: true, cases: ["F4-A1", "F4-A2", "S1", "S2", "S3"] },
  "5.1": { tests: ["tests/integration/profiles.test.ts", "tests/integration/ax-profile.test.ts"], docker: false, cases: ["F5-A1", "F5-A2"] },
};

const id = process.argv[2] ?? "";
const task = TASKS[id];
if (!task) {
  console.error(`verify:task: unknown task "${id}" (known: ${Object.keys(TASKS).join(", ")})`);
  process.exit(1);
}
if (task.docker && !dockerAvailable()) {
  console.error("verify:task: BLOCKED — Docker daemon not reachable (local prerequisite)");
  process.exit(2);
}
const step = (name: string, cmd: string, args: string[]) => {
  console.log(`verify:task ${id}: ${name}`);
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" }).status ?? 1;
};
if (step("typecheck", "npx", ["tsc", "--noEmit"]) !== 0) process.exit(1);
if (step("tests", "npx", ["vitest", "run", ...task.tests]) !== 0) process.exit(1);

// The supplied evaluator needs the independent collector (Task 4.1). Until it exists the acceptance
// cases are reported NOT_RUN — never PASS — and do not fail the author tests above.
if (existsSync(join(ROOT, "src/cli/commands/collect-case.ts"))) {
  const evaluator = "docs/spec/active/2026-10-28-agent-proof-lab/evals/evaluate.py";
  const rc = step(`acceptance ${task.cases.join(" ")}`, "python3", [evaluator, ...task.cases]);
  process.exit(rc === 0 ? 0 : rc === 2 ? 2 : 1);
}
console.log(`verify:task ${id}: acceptance ${task.cases.join(", ")} NOT_RUN (collect-case not installed; Task 4.1)`);
process.exit(0);
