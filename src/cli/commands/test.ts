// `lab test [suite]`: thin wrapper that runs the vitest suites (unit, integration or all). Integration needs Docker.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Command } from "commander";
import { ROOT } from "../../config/run-config.ts";

const SUITES: Record<string, string[]> = { all: [], unit: ["tests/unit"], integration: ["tests/integration"] };

export function register(program: Command) {
  program
    .command("test")
    .description("run the vitest suites: unit, integration or all (default)")
    .argument("[suite]", "unit | integration | all", "all")
    .action((suite: string) => {
      if (!(suite in SUITES)) throw new Error(`unknown suite ${suite} (unit | integration | all)`);
      const r = spawnSync(join(ROOT, "node_modules/.bin/vitest"), ["run", ...SUITES[suite]!], { cwd: ROOT, stdio: "inherit" });
      process.exitCode = r.status ?? 1;
    });
}
