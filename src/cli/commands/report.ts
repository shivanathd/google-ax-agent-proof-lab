// `lab report --run-id ID`: regenerate report.json/report.md/checksums from the stored C4 bundle.
// Exit 0 only when the local core and every selected lane PASS; a report is not a green light otherwise.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { generateReport } from "../../reports/artifacts.ts";

export function register(program: Command) {
  program
    .command("report")
    .description("generate the C5 run report from collected observations (artifacts/runs/<run_id>/)")
    .requiredOption("--run-id <id>", "run to report")
    .action(async (opts: { runId: string }) => {
      const r = await generateReport(opts.runId);
      emit({ run_id: r.run_id, case_id: r.case_id, status: r.status, all_lanes_status: r.all_lanes_status, banner: r.banner, counts: r.counts }, r.banner.green ? 0 : 1);
    });
}
