// `lab run --case ID [--profile NAME] [--run-id ID]`: optional profiles delegate to their adapter.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { isOptionalProfile, profileRun } from "../../config/profiles.ts";

export function register(program: Command) {
  program
    .command("run")
    .description("run one case against a started stack")
    .requiredOption("--case <id>", "case id, e.g. W01-H")
    .option("--profile <name>", "profile", "local")
    .option("--run-id <id>", "run started by `lab up` (local profile)")
    .option("--authorized", "explicit operator opt-in for live provider actions", false)
    .action(async (opts: { case: string; profile: string; runId?: string; authorized: boolean }) => {
      if (opts.profile === "local") {
        return emit({ profile: "local", case: opts.case, status: "NOT_RUN", reason: "local workflows not installed yet" }, 2);
      }
      if (!isOptionalProfile(opts.profile)) return emit({ status: "FAIL", reason: `unknown profile ${opts.profile}` }, 1);
      const r = await profileRun(opts.profile, opts.case, { authorized: opts.authorized, env: process.env });
      emit(r, r.status === "BLOCKED" ? 2 : r.status === "FAIL" ? 1 : 0);
    });
}
