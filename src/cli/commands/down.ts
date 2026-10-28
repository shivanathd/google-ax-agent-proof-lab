// `lab down --run-id ID`: scoped cleanup of one run. There is deliberately no "all runs" option.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { stopRun } from "../../config/lifecycle.ts";

export function register(program: Command) {
  program
    .command("down")
    .description("remove only the resources owned by one run; evidence is kept")
    .requiredOption("--run-id <id>", "run to stop")
    .action(async (opts: { runId: string }) => {
      const m = await stopRun(opts.runId);
      emit({ run_id: m.config.run_id, cleanup_status: m.cleanup_status, remaining: m.remaining }, m.cleanup_status === "CLEAN" ? 0 : 1);
    });
}
