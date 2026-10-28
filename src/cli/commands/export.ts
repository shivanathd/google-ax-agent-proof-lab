// `lab export --run-id ID`: allowlisted, secret-scanned export; any finding quarantines it (exit 1).
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { exportRun } from "../../reports/export.ts";

export function register(program: Command) {
  program
    .command("export")
    .description("write a sanitized, allowlisted export of one run (tamper check + secret and private-term scan)")
    .requiredOption("--run-id <id>", "run to export")
    .action((opts: { runId: string }) => {
      const r = exportRun(opts.runId);
      emit(r, r.status === "EXPORTED" ? 0 : 1);
    });
}
