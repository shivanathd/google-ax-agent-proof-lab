// `lab record --case W01-H` (RECORDING_RUNBOOK): one scenario run in the teaching console, recorded by
// Playwright into gitignored recordings/raw/. Does not touch README media or the manifest.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { captureSuite } from "../../media/capture.ts";
import { scenario } from "../../reports/scenarios.ts";

export function register(program: Command) {
  program
    .command("record")
    .description("record one console scenario run (raw WebM + screenshots + session record) under recordings/raw/")
    .requiredOption("--case <id>", "console scenario id, e.g. W01-H")
    .action(async (o: { case: string }) => {
      if (!scenario(o.case)) return emit({ status: "FAIL", reason: `unknown scenario ${o.case}` }, 1);
      const s = await captureSuite({
        markLatest: false,
        shots: [{ name: `record-${o.case}`, video: true, steps: [{ select: o.case }, { dwell: 1000 }, { run: o.case }, { dwell: 3000 }, { shot: "result" }, { tab: "report" }, { dwell: 3000 }, { shot: "report" }] }],
      });
      emit({ status: "RECORDED", session: `recordings/raw/${s.session}`, runs: s.shots[0]?.runs, video: s.shots[0]?.video, text_scan: s.shots[0]?.text_scan });
    });
}
