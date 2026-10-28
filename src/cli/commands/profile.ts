// `lab profile doctor NAME` / `lab profile run NAME --case ID [--authorized]` for optional lanes.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { isOptionalProfile, profileDoctor, profileRun } from "../../config/profiles.ts";

const exitFor = (status: string) => (status === "PASS" || status === "NOT_RUN" ? 0 : status === "BLOCKED" ? 2 : 1);

export function register(program: Command) {
  const profile = program.command("profile").description("optional profile lanes (salesforce, coderabbit, ax, live-model)");
  profile
    .command("doctor <name>")
    .description("inspect local configuration only; zero external calls")
    .action(async (name: string) => {
      if (!isOptionalProfile(name)) return emit({ status: "FAIL", reason: `unknown profile ${name}` }, 1);
      const r = await profileDoctor(name, process.env);
      emit(r, exitFor(r.status));
    });
  profile
    .command("run <name>")
    .requiredOption("--case <id>", "case to run")
    .option("--authorized", "explicit operator opt-in for live provider actions", false)
    .action(async (name: string, opts: { case: string; authorized: boolean }) => {
      if (!isOptionalProfile(name)) return emit({ status: "FAIL", reason: `unknown profile ${name}` }, 1);
      const r = await profileRun(name, opts.case, { authorized: opts.authorized, env: process.env });
      emit(r, exitFor(r.status));
    });
}
