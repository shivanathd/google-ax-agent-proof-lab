// `lab media capture --suite readme`: drives the real teaching console with Playwright (1440×900, dpr 1).
// Every scenario run is a full collect-case run (isolated Emulate + Floci + worker + independent collector);
// the script waits on the console's `data-run-state="reported"`, which appears only after the C5 report
// exists. Raw WebM recordings and PNGs go to gitignored recordings/raw/<session>/ with a session record.
// Pauses after a verified state are viewer dwell for legibility, recorded as edits, never as latency.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { candidateIdentity, fixtureSha256, ROOT } from "../config/run-config.ts";
import { startConsole } from "../console/server.ts";
import { appDirty, applicationTreeSha256, loadPrivateTerms, scanText, sha256File } from "./spec.ts";

export const RAW = join(ROOT, "recordings", "raw");
const VIEWPORT = { width: 1440, height: 900 };

export interface Mark { t_ms: number; label: string; run_id?: string; scenario?: string; detail?: string }
export interface Shot { name: string; video: string | null; video_sha256: string | null; frames: string | null; frames_sha256: string | null; marks: Mark[]; text_scan: { scans: number; secret_findings: number; private_term_findings: number }; screenshots: { id: string; file: string; sha256: string; run_id: string; scenario: string; t_ms: number }[]; runs: { run_id: string; scenario: string }[] }
export interface Session {
  schema_version: 1; session: string; created_at: string; candidate_revision: string; tree_sha: string; dirty: boolean; app_dirty_files: number;
  application_tree_sha256: string; fixture_sha256: string; viewport: typeof VIEWPORT; device_scale_factor: 1; browser: string; console_url: "loopback (ephemeral port)"; shots: Shot[];
}

type Step =
  | { run: string } | { tab: "workflow" | "report" | "profiles" } | { dwell: number } | { shot: string } | { select: string };

// Shot list. Screenshot ids that match README_MEDIA_SPEC names become docs/assets/screenshots/*.png;
// "poster:" ids become the GIF posters; "vposter:" ids become MP4 posters.
export const SHOTS: { name: string; video: boolean; steps: Step[] }[] = [
  { name: "w01h", video: true, steps: [{ select: "W01-H" }, { dwell: 1200 }, { run: "W01-H" }, { dwell: 2500 }, { shot: "service-request-success" }, { shot: "poster:slack-service-request" },
    { tab: "report" }, { dwell: 3500 }, { shot: "evidence-report" }, { tab: "profiles" }, { dwell: 2500 }, { shot: "profile-boundaries" }] },
  { name: "w01d", video: true, steps: [{ select: "W01-D" }, { dwell: 1000 }, { run: "W01-D" }, { dwell: 3000 }, { shot: "poster:duplicate-event-safe" }, { shot: "vposter:duplicate-delivery" },
    { tab: "report" }, { dwell: 4000 }, { tab: "workflow" }, { dwell: 2000 }] },
  { name: "w02u", video: true, steps: [{ select: "W02-U" }, { dwell: 1000 }, { run: "W02-U" }, { dwell: 3000 }, { shot: "approval-denied" }, { shot: "poster:approval-denied" }, { shot: "vposter:permission-boundary" },
    { tab: "report" }, { dwell: 4000 }, { tab: "workflow" }, { dwell: 2000 }] },
  { name: "w02h", video: false, steps: [{ select: "W02-H" }, { run: "W02-H" }, { shot: "lab-overview" }] },
  { name: "mental", video: true, steps: [{ select: "W01-H" }, { dwell: 4000 }, { run: "W01-H" }, { dwell: 4000 }, { shot: "vposter:mental-model" }, { tab: "report" }, { dwell: 5000 },
    { tab: "workflow" }, { select: "W01-F" }, { dwell: 4000 }, { run: "W01-F" }, { dwell: 4000 }, { tab: "report" }, { dwell: 6000 }] },
  { name: "boundary", video: true, steps: [{ select: "W03-V" }, { dwell: 2000 }, { run: "W03-V" }, { dwell: 4000 }, { tab: "report" }, { dwell: 4000 }, { tab: "profiles" }, { dwell: 4000 },
    { shot: "vposter:emulator-vs-real-org" }, { dwell: 4000 }] },
];

// Publication scan of what is on screen: counts only, the matched text is never stored.
async function scanDom(page: Page, shot: Shot, terms: string[]) {
  const found = scanText(await page.evaluate(() => `${document.body.innerText}\n${document.documentElement.outerHTML}`), terms);
  shot.text_scan.scans += 1;
  shot.text_scan.secret_findings += found.secrets.length;
  shot.text_scan.private_term_findings += found.private_terms;
}

async function act(page: Page, step: Step, t0: number, shot: Shot, dir: string, current: { run_id: string; scenario: string }) {
  const t = () => Date.now() - t0;
  if ("select" in step) {
    await page.click(`[data-scenario="${step.select}"]`);
    shot.marks.push({ t_ms: t(), label: `select ${step.select}`, scenario: step.select });
  } else if ("run" in step) {
    shot.marks.push({ t_ms: t(), label: `run clicked ${step.run}`, scenario: step.run });
    await page.click("#run-button");
    await page.waitForFunction(() => document.body.dataset.runState !== "idle" && document.body.dataset.runState !== "reported", undefined, { timeout: 10000 }).catch(() => undefined);
    await page.waitForSelector('body[data-run-state="reported"], body[data-run-state="error"]', { timeout: 150000 });
    const state = await page.getAttribute("body", "data-run-state");
    if (state !== "reported") throw new Error(`scenario ${step.run} ended in ${state}: ${await page.locator("#banner").innerText()}`);
    current.run_id = (await page.getAttribute("body", "data-run-id"))!;
    current.scenario = step.run;
    shot.runs.push({ ...current });
    shot.marks.push({ t_ms: t(), label: `reported ${step.run}`, ...current, detail: (await page.locator("#banner").innerText()).trim() });
  } else if ("tab" in step) {
    await page.click(`#tab-${step.tab}`);
    const lanes = step.tab === "profiles"
      ? await page.$$eval("#profiles tbody tr", (rows) => rows.map((r) => `${(r as HTMLElement).dataset.lane} ${r.querySelector("[data-status]")?.getAttribute("data-status")}`).join(", "))
      : undefined;
    shot.marks.push({ t_ms: t(), label: `tab ${step.tab}`, ...(lanes ? { detail: lanes } : {}) });
  } else if ("dwell" in step) {
    await page.waitForTimeout(step.dwell); // viewer dwell after a verified state (disclosed edit), not a readiness wait
    shot.marks.push({ t_ms: t(), label: `dwell ${step.dwell}ms` });
  } else {
    const file = join(dir, `${step.shot.replace(":", "-")}.png`);
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
    await page.screenshot({ path: file });
    shot.screenshots.push({ id: step.shot, file: file.slice(RAW.length + 1), sha256: sha256File(file), ...current, t_ms: t() });
  }
}

export async function captureSuite(o: { only?: string[]; shots?: typeof SHOTS; markLatest?: boolean } = {}): Promise<Session> {
  const id = candidateIdentity();
  const session = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(RAW, session);
  // Fail closed: without the private-terms list nothing on screen can be shown free of private identity.
  const terms = loadPrivateTerms();
  mkdirSync(dir, { recursive: true });
  const web = await startConsole();
  const browser = await chromium.launch();
  const out: Session = {
    schema_version: 1, session, created_at: new Date().toISOString(), candidate_revision: id.revision, tree_sha: id.tree_sha, dirty: id.dirty,
    app_dirty_files: appDirty().length, application_tree_sha256: applicationTreeSha256(), fixture_sha256: fixtureSha256(),
    viewport: VIEWPORT, device_scale_factor: 1, browser: `chromium ${browser.version()}`, console_url: "loopback (ephemeral port)", shots: [],
  };
  try {
    for (const s of (o.shots ?? SHOTS).filter((x) => !o.only || o.only.includes(x.name))) {
      const vdir = join(dir, `${s.name}-video`);
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce", ...(s.video ? { recordVideo: { dir: vdir, size: VIEWPORT } } : {}) });
      const page = await context.newPage();
      const t0 = Date.now();
      const shot: Shot = { name: s.name, video: null, video_sha256: null, frames: null, frames_sha256: null, marks: [], text_scan: { scans: 0, secret_findings: 0, private_term_findings: 0 }, screenshots: [], runs: [] };
      const current = { run_id: "", scenario: "" };
      // Lossless source frames: Chromium's screencast pushes a PNG whenever the page repaints. The GIFs and MP4s
      // are encoded from these (the WebM is VP8-lossy and kept only as a cross-check of the same session).
      const frames: { file: string; t_ms: number; sha256: string }[] = [];
      const fdir = join(dir, `${s.name}-frames`);
      const cdp = s.video ? await context.newCDPSession(page) : undefined;
      if (cdp) {
        mkdirSync(fdir, { recursive: true });
        cdp.on("Page.screencastFrame", (f) => {
          const file = join(fdir, `f${String(frames.length).padStart(5, "0")}.png`);
          const data = Buffer.from(f.data, "base64");
          writeFileSync(file, data);
          frames.push({ file: file.slice(RAW.length + 1), t_ms: Math.round((f.metadata.timestamp ?? Date.now() / 1000) * 1000) - t0, sha256: createHash("sha256").update(data).digest("hex") });
          void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
        });
        await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
      }
      await page.goto(web.url);
      await page.waitForSelector("#scenarios [data-scenario]");
      shot.marks.push({ t_ms: Date.now() - t0, label: "console loaded" });
      for (const step of s.steps) {
        await act(page, step, t0, shot, dir, current);
        if (!("dwell" in step)) await scanDom(page, shot, terms);
      }
      if (shot.text_scan.secret_findings || shot.text_scan.private_term_findings) throw new Error(`publication scan found ${shot.text_scan.secret_findings} secret and ${shot.text_scan.private_term_findings} private-term findings in shot ${s.name}; capture stopped`);
      shot.marks.push({ t_ms: Date.now() - t0, label: "end" });
      if (cdp) {
        await cdp.send("Page.stopScreencast");
        const index = join(dir, `${s.name}-frames.json`);
        writeFileSync(index, `${JSON.stringify(frames, null, 2)}\n`);
        shot.frames = index.slice(RAW.length + 1);
        shot.frames_sha256 = sha256File(index); // binds every frame's sha256
      }
      await context.close();
      if (s.video) {
        const webm = readdirSync(vdir).find((f) => f.endsWith(".webm"))!;
        const file = join(dir, `${s.name}.webm`);
        renameSync(join(vdir, webm), file);
        shot.video = file.slice(RAW.length + 1);
        shot.video_sha256 = sha256File(file);
      }
      out.shots.push(shot);
      writeFileSync(join(dir, "session.json"), `${JSON.stringify(out, null, 2)}\n`);
    }
  } finally {
    await browser.close();
    await web.close();
  }
  if (o.markLatest !== false) writeFileSync(join(RAW, "latest.json"), `${JSON.stringify({ session }, null, 2)}\n`);
  return out;
}
