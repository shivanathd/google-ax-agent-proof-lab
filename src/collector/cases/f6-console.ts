// F6-A1 (a failed required assertion stays visible, no success badge) and F6-A2 (a recording export carries
// revision, run id, synthetic notice and valid evidence refs, with no secrets or private identity).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { ROOT } from "../../config/run-config.ts";
import { SECRET_RULES } from "../../reports/export.ts";
import { verifyChecksums } from "../../reports/report.ts";
import { loadPrivateTerms, privateTermsMissing } from "../../media/spec.ts";
import type { CaseDef } from "../types.ts";
import { consoleRuns, readConsole, readReport, screenshotEvidence, withPage } from "./f6-shared.ts";

const lean = (d: Awaited<ReturnType<typeof readConsole>>) => ({ ...d, html: undefined, text: undefined });

export const F6_A1: CaseDef = {
  stack: { floci: false, slack: false },
  worker: false,
  // W01-F: the worker reports success, then the coordinator deletes the receipt (injected fault).
  execute: async (x) => void (await consoleRuns(x, ["W01-F"])),
  async observe(p) {
    const run = p.refs.runs["W01-F"] as string;
    await p.capture("report", "report.json read from the run's artifact directory", () => readReport(run));
    await p.capture("console", "browser assertion: console DOM for the stored run (collector's own Chromium)", () => withPage(async (page) => {
      const d = await readConsole(page, p.refs.console_url, run, "report");
      await screenshotEvidence(p, page, "f6-a1-console");
      return lean(d);
    }));
    p.fact("failure_visible", ["report", "console"], () => {
      const r = p.data("report"), d = p.data("console");
      const failed = r.assertions.filter((a: any) => a.required && a.status === "FAIL");
      return failed.length > 0 && d.banner.visible && d.banner.text.includes(r.banner.text) && d.banner.report_status === r.status &&
        failed.every((a: any) => d.rows.some((row: any) => row.id === a.id && row.status === "FAIL" && row.status_text === "FAIL" && row.visible));
    });
    p.fact("overall_success_banner", ["console"], () => p.data("console").success_badges_visible > 0 || p.data("console").banner.green === "true");
  },
};

// The recording export: the coordinator records the console while a real W01-H run executes, encodes an MP4,
// writes the sidecar + captions and exports the run's sanitized evidence. The collector then audits it.
export const F6_A2: CaseDef = {
  stack: { floci: false, slack: false },
  worker: false,
  prerequisite: () => privateTermsMissing(),
  async execute(x) {
    const { startConsole } = await import("../../console/server.ts");
    const { exportRun } = await import("../../reports/export.ts");
    const web = await startConsole();
    x.defer(() => web.close());
    const dir = join(x.scratch, "recording-export");
    mkdirSync(join(dir, "raw"), { recursive: true });
    const browser = await chromium.launch();
    let run = "";
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, recordVideo: { dir: join(dir, "raw"), size: { width: 1440, height: 900 } } });
      const page = await ctx.newPage();
      await page.goto(`${web.url}?scenario=W01-H`);
      await page.click("#run-button");
      await page.waitForSelector('body[data-run-state="reported"], body[data-run-state="error"]', { timeout: 150000 });
      run = (await page.getAttribute("body", "data-run-id")) ?? "";
      await ctx.close();
    } finally {
      await browser.close();
    }
    if (!run) throw new Error("console run did not report");
    const webm = join(dir, "raw", readdirSync(join(dir, "raw")).find((f) => f.endsWith(".webm"))!);
    const enc = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", webm, "-vf", "fps=15,scale=1280:-2", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-an", join(dir, "clip.mp4")], { encoding: "utf8" });
    if (enc.status !== 0) throw new Error(`ffmpeg: ${enc.stderr.slice(0, 200)}`);
    const ex = exportRun(run);
    const r = readReport(run);
    writeFileSync(join(dir, "clip.vtt"), `WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nSynthetic data only. Local profile, scripted mode, run ${run.slice(0, 8)}, tree ${r.tree_sha.slice(0, 12)}.\n\n2\n00:00:05.000 --> 00:00:10.000\nCollector report: ${r.banner.text}\n`);
    writeFileSync(join(dir, "clip.json"), `${JSON.stringify({
      schema_version: 1, run_id: run, case_id: r.case_id, candidate_revision: r.candidate_revision, tree_sha: r.tree_sha, profile: r.profile, mode: r.mode,
      synthetic_data_notice: "Synthetic data only: fictional workspaces, people and records on local emulators.", original_capture: "raw/*.webm",
      export_status: ex.status, evidence_refs: ex.status === "EXPORTED" ? ["report.json", "observations.json", "checksums.sha256"].map((f) => `export/${f}`) : [],
    }, null, 2)}\n`);
    if (ex.output) cpSync(join(ROOT, ex.output), join(dir, "export"), { recursive: true });
    x.ref("console_url", web.url);
    x.ref("run", run);
    x.ref("export_dir", dir);
  },
  async observe(p) {
    const { run, export_dir: dir, console_url } = p.refs as { run: string; export_dir: string; console_url: string };
    const files = [join(dir, "clip.json"), join(dir, "clip.vtt"), ...(existsSync(join(dir, "export")) ? readdirSync(join(dir, "export")).map((f) => join(dir, "export", f)) : [])];
    await p.capture("export", "recording export files (sidecar, captions, sanitized run export) + ffprobe decode", () => {
      const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", join(dir, "clip.mp4")], { encoding: "utf8" });
      return { sidecar: JSON.parse(readFileSync(join(dir, "clip.json"), "utf8")), captions: readFileSync(join(dir, "clip.vtt"), "utf8"), files: files.map((f) => f.slice(dir.length + 1)),
        mp4: probe.status === 0 ? JSON.parse(probe.stdout).streams?.[0] ?? null : null, export_integrity: existsSync(join(dir, "export")) ? verifyChecksums(join(dir, "export")) : { ok: false, problems: ["no export"] } };
    });
    await p.capture("report", "report.json read from the run's artifact directory", () => readReport(run));
    // Scan text the recording shows or ships: console DOM + API response for the run + every export file.
    await p.capture("scan", "publication scan: secret rules + private-terms list (counts only; matches never stored)", () => withPage(async (page) => {
      const terms = loadPrivateTerms(); // fails closed: a missing list leaves secret/identity counts unobserved
      const d = await readConsole(page, console_url, run, "workflow");
      await screenshotEvidence(p, page, "f6-a2-console");
      const api = await (await fetch(`${console_url}api/runs/${run}`)).text();
      const texts: [string, string][] = [["console-dom", `${d.text}\n${d.html}`], ["console-api", api], ...files.map((f) => [f.slice(dir.length + 1), readFileSync(f, "utf8")] as [string, string])];
      const secret = texts.flatMap(([name, t]) => SECRET_RULES.filter(([, re]) => re.test(t)).map(([rule]) => ({ name, rule })));
      const priv = texts.flatMap(([name, t]) => terms.filter((term) => t.toLowerCase().includes(term)).map(() => ({ name })));
      return { scanned: texts.map(([n]) => n), secret_findings: secret, private_term_findings: priv.length, view: lean(d) };
    }));
    const s = () => p.data("export").sidecar, r = () => p.data("report"), v = () => p.data("scan").view;
    p.fact("revision_visible", ["export", "report", "scan"], () =>
      s().tree_sha === r().tree_sha && s().candidate_revision === r().candidate_revision && v().details.tree === r().tree_sha &&
      v().details.commit === r().candidate_revision.slice(0, 12) && v().details_in_view.tree && v().details_in_view.commit);
    p.fact("run_id_visible", ["export", "report", "scan"], () => s().run_id === run && v().details["run-id"] === run && v().details_in_view.run_id && p.data("export").captions.includes(run.slice(0, 8)));
    p.fact("synthetic_notice_visible", ["export", "scan"], () => v().notice.visible && /Synthetic data only/.test(v().notice.text) && /Synthetic data only/.test(s().synthetic_data_notice) && /Synthetic data only/.test(p.data("export").captions));
    p.fact("secret_count", ["scan"], () => p.data("scan").secret_findings.length);
    p.fact("forbidden_identity_count", ["scan"], () => p.data("scan").private_term_findings);
    p.fact("evidence_refs_valid", ["export", "report"], () => {
      const e = p.data("export");
      return s().evidence_refs.length > 0 && e.export_integrity.ok && Boolean(e.mp4 && Number(e.mp4.nb_read_frames) > 1) &&
        s().evidence_refs.every((ref: string) => existsSync(join(dir, ref))) && JSON.parse(readFileSync(join(dir, "export", "report.json"), "utf8")).run_id === run;
    });
  },
};
