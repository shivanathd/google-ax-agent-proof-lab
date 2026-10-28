// `lab run --case ID [--profile NAME] [--run-id ID]`: optional profiles delegate to their adapter.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { isOptionalProfile, profileRun } from "../../config/profiles.ts";
import { loadManifest } from "../../config/manifest.ts";

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
        if (!opts.runId) return emit({ status: "FAIL", reason: "--run-id is required for the local profile (start one with `lab up`)" }, 1);
        const m = loadManifest(opts.runId);
        const res = await fetch(`http://127.0.0.1:${m.ports.console}/api/cases/${encodeURIComponent(opts.case)}/run`, { method: "POST" }).catch(() => undefined);
        if (!res) return emit({ profile: "local", case: opts.case, status: "BLOCKED", reason: "run is not up (console not reachable)" }, 2);
        // Posting the stimulus is not a result: outcomes are judged by the independent collector.
        return emit({ profile: "local", ...(await res.json()) }, res.ok ? 0 : 1);
      }
      if (!isOptionalProfile(opts.profile)) return emit({ status: "FAIL", reason: `unknown profile ${opts.profile}` }, 1);
      const r = await profileRun(opts.profile, opts.case, { authorized: opts.authorized, env: process.env });
      emit(r, r.status === "BLOCKED" ? 2 : r.status === "FAIL" ? 1 : 0);
    });
}
