// `lab media optimize --suite readme`: turns the latest raw capture session into the committed README media
// (PNG copies, palette GIFs, posters, H.264 clips with sidecar JSON + WebVTT captions), exports every run's
// sanitized evidence into docs/evidence/ through `lab export` (tamper check + secret and private-term scan),
// and writes docs/assets/media-manifest.json. Raw captures stay in gitignored recordings/raw/.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../config/run-config.ts";
import { artifactDir } from "../reports/artifacts.ts";
import { exportRun } from "../reports/export.ts";
import { scenario } from "../reports/scenarios.ts";
import { RAW, type Mark, type Session, type Shot } from "./capture.ts";
import { inspectMedia, toolVersions } from "./inspect.ts";
import { EVIDENCE_DIR, MANIFEST, REQUIRED, sha256File } from "./spec.ts";

const GIF = { width: 1200, fps: 10, colors: 128 };
const MP4 = { width: 1280, fps: 15, crf: 30 };

function ffmpeg(args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().slice(0, 300)}`);
}

const mark = (s: Shot, prefix: string) => {
  const m = s.marks.find((x) => x.label.startsWith(prefix));
  if (!m) throw new Error(`shot ${s.name} has no mark "${prefix}"`);
  return m;
};
const secs = (ms: number) => (ms / 1000).toFixed(2);

// GIF segments: from just before "Run" is clicked to a mark after the verified result has been shown.
const GIF_SEGMENTS: Record<string, { shot: string; end: string }> = {
  "slack-service-request": { shot: "w01h", end: "end" },
  "duplicate-event-safe": { shot: "w01d", end: "tab workflow" },
  "approval-denied-gif": { shot: "w02u", end: "tab workflow" },
};
const CLIPS: Record<string, { shot: string; title: string; opening: string }> = {
  "clip-mental-model": { shot: "mental", title: "Mental model: the reply is not the acceptance test",
    opening: "Five questions: where the work runs, what it connects to, what it is allowed to do, what happened, and what we can claim." },
  "clip-duplicate-delivery": { shot: "w01d", title: "Duplicate delivery",
    opening: "Deliver the same signed event again. A second delivery must not become a second business action." },
  "clip-permission-boundary": { shot: "w02u", title: "Permission boundary",
    opening: "The requester cannot approve their own request. The action should fail without changing the record." },
  "clip-emulator-vs-real-org": { shot: "boundary", title: "Emulator versus real org",
    opening: "A local CRM contract double cannot prove Salesforce behaviour. That lane needs a real, separately authorized test org." },
};

const ALT: Record<string, string> = {
  "lab-overview": "Teaching console with the scenario list, an emulated Slack thread where Eli approves Dana's purchase request, the layer map and run details",
  "service-request-success": "Emulated Slack thread with Dana's service request and LabBot's ticket reply, beside before and after counts showing one ticket and one S3 receipt",
  "approval-denied": "Emulated Slack thread where Dana's self-approval and Gus's approval click are both refused, with the request still awaiting approval and no receipt",
  "evidence-report": "Evidence report table listing each required assertion with expected value, observed value, PASS status and evidence file, plus limitations",
  "profile-boundaries": "Profile boundaries table: local core PASS, while Salesforce, CodeRabbit, AX and live-model lanes are BLOCKED with their missing prerequisites",
  "slack-service-request": "Animated capture: a service request is posted in emulated Slack, LabBot replies in the thread, and the collector's report turns PASS",
  "duplicate-event-safe": "Animated capture: after the first ticket, the same signed event is re-delivered and the before and after counts stay unchanged",
  "approval-denied-gif": "Animated capture: Dana and Gus click Approve on Dana's request, both clicks are refused, and the request stays awaiting approval",
  "clip-mental-model": "Poster of the mental-model clip: a verified service request run in the teaching console",
  "clip-duplicate-delivery": "Poster of the duplicate-delivery clip: the retried event leaves ticket and reply counts unchanged",
  "clip-permission-boundary": "Poster of the permission-boundary clip: the self-approval is refused and the record is unchanged",
  "clip-emulator-vs-real-org": "Poster of the emulator-versus-real-org clip: optional lanes shown as BLOCKED with parity UNKNOWN",
};

function report(runId: string) {
  return JSON.parse(readFileSync(join(artifactDir(runId), "report.json"), "utf8"));
}
// Caption text built only from the stored C5 report: scenario, run, mode, status and observed values.
function caption(lead: string, runId: string, revision: string) {
  const r = report(runId);
  const observed = r.assertions.map((a: any) => `${a.id} ${JSON.stringify(a.observed)}`).join(", ");
  const faults = r.simulated_faults.length ? ` Injected fault: ${r.simulated_faults.join("; ")}.` : "";
  return `${lead} Run \`${runId.slice(0, 8)}\` (${r.case_id}, ${r.profile} profile, ${r.mode} mode, revision \`${revision.slice(0, 7)}\`): local core ${r.status}, ${r.counts.passed} of ${r.counts.required} required assertions passed; observed ${observed}.${faults} Synthetic data.`;
}
const LEAD: Record<string, string> = {
  "lab-overview": "The teaching console after a real local run of the approval workflow.",
  "service-request-success": "A service request handled end to end: the reply is in the original thread and the collector found the ticket and the matching S3 receipt.",
  "approval-denied": "A self-approval and an ungranted approval click, both refused; the request record and receipts are unchanged.",
  "evidence-report": "The evidence report is the C5 report.json shown as written: expected and observed values, status and evidence file per assertion, plus limitations.",
  "profile-boundaries": "Optional lanes as their doctors report them: blocked lanes are not failures of the local demo and are not evidence of provider parity.",
  "slack-service-request": "The local scripted worker processes a synthetic request; the evaluator checks the ticket, receipt and reply thread.",
  "duplicate-event-safe": "Emulate re-delivers the same signed event; the collector compares before and after counts.",
  "approval-denied-gif": "Dana tries to approve her own request and Gus, who has no grant, tries too; both clicks are refused.",
};

function vtt(cues: { from: number; to: number; text: string }[]) {
  const ts = (ms: number) => new Date(Math.max(0, ms)).toISOString().slice(11, 23);
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to)}\n${c.text}\n`).join("\n")}`;
}
function cuesFor(s: Shot, opening: string, start: number) {
  const describe = (m: Mark) => {
    if (m.label === "console loaded") return opening;
    if (m.label.startsWith("select ")) {
      const sc = scenario(m.scenario!);
      return sc ? `Scenario ${sc.id}: ${sc.title}. ${sc.summary}` : null;
    }
    if (m.label.startsWith("run clicked")) return "Run: an isolated stack starts (two Emulate Slack workspaces, a Floci container, the scripted worker) and the independent collector attaches.";
    if (m.label.startsWith("reported")) return `Collector report for run ${m.run_id!.slice(0, 8)}: ${m.detail}`;
    if (m.label === "tab report") return "Evidence report: expected and observed values copied from report.json, with the evidence file behind each assertion.";
    if (m.label === "tab profiles") return `Optional lanes as reported by their doctors: ${m.detail}.`;
    if (m.label === "tab workflow") return "Back to the emulated Slack thread and the before/after state.";
    return null;
  };
  const marks = s.marks.filter((m) => describe(m));
  const end = mark(s, "end").t_ms;
  return marks.map((m, i) => ({ from: m.t_ms - start, to: (marks[i + 1]?.t_ms ?? end) - start, text: describe(m)! }));
}

export async function optimizeSuite() {
  const { session } = JSON.parse(readFileSync(join(RAW, "latest.json"), "utf8"));
  const sess = JSON.parse(readFileSync(join(RAW, session, "session.json"), "utf8")) as Session;
  const raw = (rel: string) => join(RAW, rel);
  const shot = (name: string) => sess.shots.find((s) => s.name === name) ?? (() => { throw new Error(`session has no shot ${name}`); })();
  const screenshot = (id: string) => {
    for (const s of sess.shots) for (const x of s.screenshots) if (x.id === id) return x;
    throw new Error(`session has no screenshot ${id}`);
  };
  const runs = [...new Map(sess.shots.flatMap((s) => s.runs).map((r) => [r.run_id, r])).values()];

  // 1. Sanitized evidence for every run used by the media, through the export path (fails closed).
  rmSync(join(ROOT, EVIDENCE_DIR), { recursive: true, force: true });
  for (const r of runs) {
    const ex = exportRun(r.run_id);
    if (ex.status !== "EXPORTED") throw new Error(`export of run ${r.run_id} ${ex.status}: ${ex.findings.map((f) => `${f.file} ${f.rule}`).join("; ")}`);
    cpSync(join(ROOT, ex.output!), join(ROOT, EVIDENCE_DIR, r.run_id), { recursive: true });
  }
  writeFileSync(join(ROOT, EVIDENCE_DIR, "README.md"), [
    "# Sanitized run evidence", "",
    "Each directory is the allowlisted `lab export` projection of one executed local run used by the README media: `report.json` (C5 run report),",
    "`observations.json` (C4 facts) and `checksums.sha256`. Exports pass the tamper check, the secret scan and the private-terms scan first.",
    "Raw evidence files (ledger rows, Slack payloads) stay in the gitignored `artifacts/runs/<run_id>/`.", "",
    ...runs.map((r) => `- [\`${r.run_id}\`](${r.run_id}/report.json): ${r.scenario}, local core ${report(r.run_id).status}`), "",
  ].join("\n"));
  const evidenceRefs = (ids: string[]) => ids.flatMap((id) => [`${EVIDENCE_DIR}/${id}/report.json`, `${EVIDENCE_DIR}/${id}/observations.json`]);

  const media: Record<string, unknown>[] = [];
  const base = (req: (typeof REQUIRED)[number], runIds: string[], source: string) => {
    const f = inspectMedia(join(ROOT, req.path));
    const primary = report(runIds[0]!);
    return {
      id: req.id, path: req.path, sha256: sha256File(join(ROOT, req.path)),
      mime_type: { screenshot: "image/png", gif: "image/gif", video: "video/mp4" }[req.kind], width: f.width, height: f.height, bytes: f.bytes,
      run_id: runIds[0], ...(runIds.length > 1 ? { run_ids: runIds } : {}), scenario_ids: runIds.map((id) => report(id).case_id),
      profile: primary.profile, mode: primary.mode, source_capture: source.split("/").pop(), source_capture_sha256: sha256File(raw(source)),
      evidence_refs: evidenceRefs(runIds), alt_text: ALT[req.id],
      redaction_review: { automated: "PASS: on-screen text and DOM scanned at every capture step; 0 secret-rule and 0 private-term findings", manual: "PENDING: independent reviewer (docs/assets/render-review.json)" },
      visual_review: { automated: `decoded=${f.decoded}, ${f.width}x${f.height}`, manual: "PENDING: independent reviewer (docs/assets/render-review.json)" },
    };
  };

  // 2. Screenshots: byte-for-byte copies of the Playwright PNGs.
  for (const req of REQUIRED.filter((r) => r.kind === "screenshot")) {
    const s = screenshot(req.id);
    mkdirSync(dirname(join(ROOT, req.path)), { recursive: true });
    copyFileSync(raw(s.file), join(ROOT, req.path));
    media.push({ ...base(req, [s.run_id], s.file), caption: caption(LEAD[req.id]!, s.run_id, sess.candidate_revision), edits: ["none: PNG exactly as captured by Playwright at 1440x900, device scale factor 1"] });
  }

  // Lossless screencast frames for [start, end] as an ffconcat list: each PNG lasts until the next repaint.
  const concat = (s: Shot, start: number, end: number, tag: string) => {
    if (!s.frames) throw new Error(`shot ${s.name} has no screencast frames`);
    const all = JSON.parse(readFileSync(raw(s.frames), "utf8")) as { file: string; t_ms: number }[];
    const first = Math.max(0, all.findLastIndex((f) => f.t_ms <= start));
    const used = all.slice(first).filter((f, i) => i === 0 || f.t_ms < end);
    const q = (f: string) => `'${raw(f).replaceAll("'", "'\\''")}'`;
    const body = used.map((f, i) => `file ${q(f.file)}\nduration ${((Math.min(end, used[i + 1]?.t_ms ?? end) - Math.max(start, f.t_ms)) / 1000).toFixed(3)}`);
    const list = join(RAW, session, `${tag}.ffconcat`);
    writeFileSync(list, `ffconcat version 1.0\n${body.join("\n")}\nfile ${q(used.at(-1)!.file)}\n`);
    return ["-f", "concat", "-safe", "0", "-i", list];
  };

  // 3. GIFs (palette, real-time, trimmed) and their posters (full-resolution PNG of the verified state).
  for (const req of REQUIRED.filter((r) => r.kind === "gif")) {
    const seg = GIF_SEGMENTS[req.id]!;
    const s = shot(seg.shot);
    const start = Math.max(0, mark(s, "run clicked").t_ms - 300), end = mark(s, seg.end).t_ms;
    mkdirSync(dirname(join(ROOT, req.path)), { recursive: true });
    ffmpeg([...concat(s, start, end, req.id), "-vf",
      `fps=${GIF.fps},scale=${GIF.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${GIF.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      "-loop", "0", join(ROOT, req.path)]);
    const posterShot = screenshot(`poster:${req.path.split("/").pop()!.replace(".gif", "")}`);
    mkdirSync(dirname(join(ROOT, req.poster!)), { recursive: true });
    copyFileSync(raw(posterShot.file), join(ROOT, req.poster!));
    const f = inspectMedia(join(ROOT, req.path));
    media.push({
      ...base(req, [s.runs[0]!.run_id], s.frames!), caption: caption(LEAD[req.id]!, s.runs[0]!.run_id, sess.candidate_revision),
      duration_ms: f.duration_ms, frame_count: f.frame_count, fps: f.fps, poster_path: req.poster, poster_sha256: sha256File(join(ROOT, req.poster!)),
      edits: [`trimmed to ${secs(start)}-${secs(end)} s of the source capture (from the Run click to after the verified result)`,
        `source: lossless Chromium screencast PNG frames, resampled to ${GIF.fps} fps; scaled 1440 to ${GIF.width} px wide (lanczos)`,
        `${GIF.colors}-colour palette (ffmpeg palettegen/paletteuse, no dither)`, "real-time playback: no speed change; includes viewer dwell pauses after verified states, which are not latency",
        "poster is a full-resolution Playwright PNG of the verified state from the same run"],
      video_url: null, video_url_reason: "not published: inline/hosted video needs separately approved upload",
    });
  }

  // 4. MP4 clips (ADR-11) with poster, WebVTT captions and a sidecar record per clip.
  for (const req of REQUIRED.filter((r) => r.kind === "video")) {
    const c = CLIPS[req.id]!;
    const s = shot(c.shot);
    const start = mark(s, "console loaded").t_ms, end = mark(s, "end").t_ms;
    mkdirSync(dirname(join(ROOT, req.path)), { recursive: true });
    ffmpeg([...concat(s, start, end, req.id), "-vf", `fps=${MP4.fps},scale=${MP4.width}:-2:flags=lanczos`,
      "-c:v", "libx264", "-preset", "slow", "-crf", String(MP4.crf), "-tune", "stillimage", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", join(ROOT, req.path)]);
    const posterShot = screenshot(`vposter:${req.path.split("/").pop()!.replace(".mp4", "")}`);
    copyFileSync(raw(posterShot.file), join(ROOT, req.poster!));
    const captions = req.path.replace(".mp4", ".vtt");
    writeFileSync(join(ROOT, captions), vtt(cuesFor(s, c.opening, start)));
    const f = inspectMedia(join(ROOT, req.path));
    const runIds = s.runs.map((r) => r.run_id);
    const edits = [`trimmed to ${secs(start)}-${secs(end)} s of the source capture`, `source: lossless Chromium screencast PNG frames; scaled to ${MP4.width} px wide, ${MP4.fps} fps, H.264 CRF ${MP4.crf}, no audio`,
      "real-time playback: no speed change; viewer dwell pauses after verified states are not latency", `captions: ${captions.split("/").pop()} (WebVTT, generated from capture marks and the run report)`];
    const sidecar = {
      schema_version: 1, clip: req.id, title: c.title, run_ids: runIds, scenario_ids: runIds.map((id) => report(id).case_id), candidate_revision: sess.candidate_revision,
      tree_sha: sess.tree_sha, application_tree_sha256: sess.application_tree_sha256, profile: "local", mode: "scripted",
      recorded_at: sess.created_at, marks: s.marks.map((m) => ({ t_ms: m.t_ms - start, label: m.label })),
      original_capture: s.frames!.split("/").pop(), original_capture_sha256: s.frames_sha256, webm_cross_check: s.video?.split("/").pop() ?? null, webm_sha256: s.video_sha256,
      mp4_sha256: sha256File(join(ROOT, req.path)), edits, evidence_refs: evidenceRefs(runIds),
      synthetic_data_notice: "Synthetic data only: fictional workspaces, people and records on local emulators.",
    };
    writeFileSync(join(ROOT, req.path.replace(".mp4", ".json")), `${JSON.stringify(sidecar, null, 2)}\n`);
    media.push({
      ...base(req, runIds, s.frames!), caption: caption(`${c.title} (MP4 clip, ${Math.round(f.duration_ms / 1000)} s, silent with captions).`, runIds.at(-1)!, sess.candidate_revision),
      duration_ms: f.duration_ms, frame_count: f.frame_count, fps: f.fps, poster_path: req.poster, poster_sha256: sha256File(join(ROOT, req.poster!)),
      captions_path: captions, captions_sha256: sha256File(join(ROOT, captions)), sidecar_path: req.path.replace(".mp4", ".json"),
      sidecar_sha256: sha256File(join(ROOT, req.path.replace(".mp4", ".json"))), edits,
      video_url: null, video_url_reason: "inline GitHub playback needs a post-publication user-attachment upload (NOT_RUN, not authorized)",
    });
  }

  const manifest = {
    schema_version: 1, generated_at: new Date().toISOString(), application_revision: sess.candidate_revision, application_tree_sha256: sess.application_tree_sha256,
    application_tree_definition: "sha256 over 'path\\0sha256(content)\\n' for tracked files matching APP_INCLUDE minus APP_EXCLUDE in src/media/spec.ts (see docs/REPRODUCING.md)",
    git_tree_sha: sess.tree_sha, capture_dirty: sess.dirty, capture_app_dirty_files: sess.app_dirty_files, fixture_sha256: sess.fixture_sha256,
    capture_tool_versions: { ...toolVersions(), browser: sess.browser, playwright: "@playwright/test 1.64.1", viewport: sess.viewport, device_scale_factor: sess.device_scale_factor },
    capture_session: sess.session, builder: "media pipeline (lab media capture/optimize)",
    media,
    readme_verification: { local_status: "NOT_RUN", github_render_status: "NOT_RUN", reason: "run `lab readme verify --local --record` after `lab readme build`" },
  };
  writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest: MANIFEST, items: media.length, runs: runs.length, evidence: EVIDENCE_DIR, raw_session: `recordings/raw/${session}` };
}
