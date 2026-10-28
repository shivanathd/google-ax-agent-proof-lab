// S4 evidence (public challenge): the console never shows green for a non-green report, shows optional lanes
// as their doctors report them, matches report.json cell for cell, and `lab verify` rejects a tampered copy.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneStatuses, OPTIONAL_PROFILES } from "../../config/profiles.ts";
import type { CaseDef } from "../types.ts";
import { consoleRuns, labJson, matchesReport, readConsole, readReport, runArtifacts, screenshotEvidence, withPage } from "./f6-shared.ts";

const SCENARIOS = ["W01-H", "W01-F"]; // one PASS run, one run with an injected fault (FAIL)

export const S4: CaseDef = {
  stack: { floci: false, slack: false },
  worker: false,
  execute: async (x) => void (await consoleRuns(x, SCENARIOS)),
  async observe(p) {
    const runs = p.refs.runs as Record<string, string>;
    await p.capture("reports", "report.json for each console run, read from its artifact directory", () => Object.fromEntries(SCENARIOS.map((s) => [s, readReport(runs[s]!)])));
    await p.capture("console", "browser assertion: console DOM per run + profile view (collector's own Chromium)", () => withPage(async (page) => {
      const out: Record<string, unknown> = {};
      for (const s of SCENARIOS) {
        const d = await readConsole(page, p.refs.console_url, runs[s]!, "report");
        out[s] = { ...d, html: undefined, text: undefined };
        await screenshotEvidence(p, page, `s4-${s.toLowerCase()}-report`);
      }
      const prof = await readConsole(page, p.refs.console_url, runs["W01-H"]!, "profiles");
      await screenshotEvidence(p, page, "s4-profiles");
      out.profiles = prof.profiles;
      return out;
    }));
    await p.capture("doctor", "profile doctor run by the collector (local configuration only, zero external calls)", async () =>
      Object.values(await laneStatuses([...OPTIONAL_PROFILES], process.env)).map((d) => ({ profile: d.profile, status: d.status })));
    await p.capture("tamper", "`lab verify --run-id` on an intact and a tampered copy of one run's artifacts (child processes)", async () => {
      const root = mkdtempSync(join(tmpdir(), "apl-s4-artifacts-"));
      try {
        const run = runs["W01-H"]!;
        cpSync(runArtifacts(run), join(root, run), { recursive: true });
        const intact = await labJson(["verify", "--run-id", run], { APL_ARTIFACTS_DIR: root });
        const file = join(root, run, "evidence", "w01-s3.json");
        writeFileSync(file, readFileSync(file, "utf8").replace('"present": true', '"present": false'));
        const tampered = await labJson(["verify", "--run-id", run], { APL_ARTIFACTS_DIR: root });
        return { intact: { code: intact.code, ok: intact.json?.ok ?? null }, tampered: { code: tampered.code, rejected: tampered.json?.tampered_artifact_rejected ?? null, problems: tampered.json?.problems ?? [] } };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    const reports = () => p.data("reports"), dom = () => p.data("console");
    p.fact("false_green_count", ["reports", "console"], () => SCENARIOS.filter((s) => {
      const r = reports()[s], d = dom()[s];
      const green = r.banner.green && r.assertions.every((a: any) => !a.required || a.status === "PASS");
      return (d.success_badges_visible > 0 || d.banner.green === "true") && !green;
    }).length);
    p.fact("optional_profile_status", ["console", "doctor"], () => {
      const shown = dom().profiles.filter((x: any) => x.lane !== "local");
      const truth = p.data<{ profile: string; status: string }[]>("doctor");
      const agree = shown.length === truth.length && truth.every((t) => shown.some((x: any) => x.lane === t.profile && x.status === t.status));
      const statuses = [...new Set(shown.map((x: any) => x.status))];
      return agree && statuses.length === 1 ? String(statuses[0]) : `MISMATCH:${shown.map((x: any) => `${x.lane}=${x.status}`).join(",")}`;
    });
    p.fact("tampered_artifact_rejected", ["tamper"], () => {
      const t = p.data("tamper");
      return t.intact.code === 0 && t.intact.ok === true && t.tampered.code === 1 && t.tampered.rejected === true;
    });
    p.fact("console_matches_report", ["reports", "console"], () => SCENARIOS.every((s) => matchesReport(dom()[s], reports()[s])));
  },
};
