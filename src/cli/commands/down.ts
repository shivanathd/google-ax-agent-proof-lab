// `lab down --run-id ID`: scoped cleanup of one run. `lab down --orphans` removes only lab-labelled containers
// whose run is not active (see labContainers). There is deliberately no "all runs" option.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { removeOrphans, stopRun } from "../../config/lifecycle.ts";

export function register(program: Command) {
  program
    .command("down")
    .description("remove only the resources owned by one run (evidence is kept), or only orphaned lab containers")
    .option("--run-id <id>", "run to stop; with --orphans, only that run's containers and only if it is not active")
    .option("--orphans", "remove lab-labelled containers whose run is not active")
    .action(async (opts: { runId?: string; orphans?: boolean }) => {
      if (opts.orphans) return emit(await removeOrphans(opts.runId ? [opts.runId] : undefined));
      if (!opts.runId) return emit({ status: "FAIL", reason: "give --run-id <id> or --orphans" }, 1);
      const m = await stopRun(opts.runId);
      emit({ run_id: m.config.run_id, cleanup_status: m.cleanup_status, remaining: m.remaining }, m.cleanup_status === "CLEAN" ? 0 : 1);
    });
}
