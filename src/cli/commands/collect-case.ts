// `lab collect-case --case ID --output ABS_PATH`: the evaluator's external protocol (CONTRACTS.md).
// Exit 0 = collection completed (not a pass), 2 = local prerequisite blocked, 1 = anything else.
import type { Command } from "commander";
import { collectCase } from "../../evaluator/collect-case.ts";

export function register(program: Command) {
  program
    .command("collect-case")
    .description("set up one case on the real local stack and collect C4 facts through the independent collector")
    .requiredOption("--case <id>", "case id from the supplied evaluator, e.g. F2-A2")
    .requiredOption("--output <path>", "absolute path of the C4 bundle to write")
    .action(async (opts: { case: string; output: string }) => {
      const code = await collectCase(opts.case, opts.output);
      console.log(JSON.stringify({ case: opts.case, output: opts.output, exit_code: code }));
      process.exit(code);
    });
}
