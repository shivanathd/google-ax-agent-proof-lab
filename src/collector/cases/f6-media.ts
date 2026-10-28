// F6-A3 (committed media decode, provenance, embeds, budget and an independent render review), F6-A4 (broken
// copies are caught by `media verify` / `readme verify`) and F6-A5 (local PASS, GitHub NOT_RUN, nothing
// published). All facts come from the collector running the verifiers and real CLI child processes.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "../../config/run-config.ts";
import { verifyMedia } from "../../media/verify.ts";
import { verifyReadmeLocal } from "../../media/readme.ts";
import { MANIFEST, REVIEW, sha256File } from "../../media/spec.ts";
import { sha256, type Probe } from "../probe.ts";
import type { CaseDef } from "../types.ts";
import { labJson } from "./f6-shared.ts";

const noop: CaseDef["execute"] = async () => undefined;
const local = { stack: { floci: false, slack: false }, worker: false as const };

// Render screenshots from the README check are kept as evidence files.
function keepPngs(p: Probe, dir: string, prefix: string) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".png"))) {
    const rel = `evidence/${prefix}-${f}`;
    cpSync(join(dir, f), join(p.evidenceDir, `${prefix}-${f}`));
    p.evidence.push({ path: rel, sha256: sha256File(join(p.evidenceDir, `${prefix}-${f}`)), source: "local README render screenshot (Playwright Chromium)", observations: [] });
  }
}

export const F6_A3: CaseDef = {
  ...local,
  execute: noop,
  async observe(p) {
    await p.capture("media-verify", "media verify: ffprobe/ffmpeg decode, manifest hashes, committed evidence, budget", () => verifyMedia(ROOT));
    const shots = join(p.evidenceDir, "readme-render");
    mkdirSync(shots, { recursive: true });
    await p.capture("readme-verify", "readme verify --local: parsed embeds + marked render in Chromium at 1440 and 400 px", async () => {
      const r = await verifyReadmeLocal(ROOT, { out: shots });
      keepPngs(p, shots, "readme");
      return r;
    });
    rmSync(shots, { recursive: true, force: true });
    // The render review must come from someone other than the media builder and match the current files.
    await p.capture("render-review", "reviewer record docs/assets/render-review.json vs current README/manifest hashes", () => {
      const file = join(ROOT, REVIEW);
      if (!existsSync(file)) return { present: false, reason: "no reviewer record" };
      const rv = JSON.parse(readFileSync(file, "utf8"));
      const m = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
      return {
        present: true, reviewer: rv.reviewer ?? null, reviewed_at: rv.reviewed_at ?? null, desktop_ok: rv.desktop_ok, narrow_ok: rv.narrow_ok,
        readme_hash_current: rv.readme_sha256 === sha256File(join(ROOT, "README.md")), manifest_hash_current: rv.media_manifest_sha256 === sha256File(join(ROOT, MANIFEST)),
        independent: typeof rv.reviewer === "string" && rv.reviewer.trim().length > 0 && rv.reviewer !== m.builder && !/media pipeline|media-builder/i.test(rv.reviewer),
      };
    });
    const v = () => p.data("media-verify"), rd = () => p.data("readme-verify");
    p.fact("valid_required_screenshot_count", ["media-verify"], () => v().counts.screenshots);
    p.fact("valid_required_animated_gif_count", ["media-verify"], () => v().counts.gifs);
    p.fact("valid_required_static_poster_count", ["media-verify"], () => v().counts.posters);
    p.fact("all_required_media_provenance_valid", ["media-verify"], () => v().all_provenance_valid);
    p.fact("media_budget_passed", ["media-verify"], () => v().budget_passed);
    p.fact("broken_readme_media_path_count", ["readme-verify"], () => rd().broken_readme_media_path_count);
    p.fact("missing_alt_text_count", ["readme-verify"], () => rd().missing_alt_text_count);
    p.fact("missing_caption_count", ["readme-verify"], () => rd().missing_caption_count);
    p.fact("static_fallbacks_valid", ["readme-verify"], () => rd().static_fallbacks_valid);
    p.fact("local_render_review_passed", ["render-review", "readme-verify"], () => {
      const r = p.data("render-review");
      return r.present && r.independent && r.desktop_ok === true && r.narrow_ok === true && r.readme_hash_current && r.manifest_hash_current &&
        typeof r.reviewed_at === "string" && !Number.isNaN(Date.parse(r.reviewed_at)) && rd().local_status === "PASS";
    });
  },
};

// A full copy of the tracked tree (plus the committed media), so verifiers see a realistic repository.
function copyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "apl-media-copy-"));
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  return dir;
}
const mediaVerify = (root: string) => labJson(["media", "verify", "--suite", "readme", "--root", root]);
const readmeVerify = (root: string) => labJson(["readme", "verify", "--local", "--root", root, "--out", join(root, ".render")]);
const has = (r: { json: any }, code: string, match: string) => (r.json?.problems ?? []).some((x: any) => x.code === code && `${x.id ?? ""} ${x.detail ?? ""}`.includes(match));

export const F6_A4: CaseDef = {
  ...local,
  execute: noop,
  async observe(p) {
    const variants: Record<string, { code: number; status: string | null; detected: boolean }> = {};
    const record = (name: string, r: { code: number; json: any }, detected: boolean) => (variants[name] = { code: r.code, status: r.json?.status ?? r.json?.local_status ?? null, detected });
    await p.capture("variants", "`lab media verify` / `lab readme verify --local` (child processes) on deliberately broken copies", async () => {
      const copies: string[] = [];
      const fresh = () => {
        const d = copyRepo();
        copies.push(d);
        return d;
      };
      try {
        const ctl = fresh();
        record("control-media", await mediaVerify(ctl), false);
        record("control-readme", await readmeVerify(ctl), false);

        const a = fresh();
        rmSync(join(a, "docs/assets/screenshots/evidence-report.png"));
        const ra = await mediaVerify(a);
        record("missing-screenshot", ra, ra.code !== 0 && has(ra, "missing", "evidence-report"));

        // Single-frame GIF with an honest manifest hash, so only the frame count can catch it.
        const b = fresh();
        const gif = join(b, "docs/assets/gifs/duplicate-event-safe.gif");
        const one = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", join(b, "docs/assets/posters/duplicate-event-safe.png"), "-vf", "scale=1200:-1", "-frames:v", "1", gif]);
        if (one.status !== 0) throw new Error("could not build the single-frame GIF");
        const mb = JSON.parse(readFileSync(join(b, MANIFEST), "utf8"));
        const item = mb.media.find((x: any) => x.id === "duplicate-event-safe");
        item.sha256 = sha256File(gif);
        writeFileSync(join(b, MANIFEST), `${JSON.stringify(mb, null, 2)}\n`);
        const rb = await mediaVerify(b);
        record("single-frame-gif", rb, rb.code !== 0 && has(rb, "single_frame", "duplicate-event-safe"));

        // Stale capture: the application code changes after the media were captured.
        const c = fresh();
        appendFileSync(join(c, "src/workflows/w01.ts"), "\n// application change after capture (F6-A4 stale-capture probe)\n");
        const rc = await mediaVerify(c);
        record("stale-capture", rc, rc.code !== 0 && has(rc, "stale_capture", ""));

        // Broken README embed path.
        const d = fresh();
        const readme = join(d, "README.md");
        writeFileSync(readme, readFileSync(readme, "utf8").replace("docs/assets/gifs/approval-denied.gif", "docs/assets/gifs/approval-denied-renamed.gif"));
        const rd = await readmeVerify(d);
        record("broken-embed", rd, rd.code !== 0 && has(rd, "broken_path", "approval-denied-renamed.gif"));
      } finally {
        for (const d of copies) rmSync(d, { recursive: true, force: true });
      }
      return variants;
    });
    const v = () => p.data<Record<string, { code: number; status: string | null; detected: boolean }>>("variants");
    const controlOk = () => v()["control-media"]!.code === 0 && v()["control-readme"]!.code === 0;
    p.fact("missing_screenshot_detected", ["variants"], () => controlOk() && v()["missing-screenshot"]!.detected);
    p.fact("single_frame_gif_detected", ["variants"], () => controlOk() && v()["single-frame-gif"]!.detected);
    p.fact("stale_capture_detected", ["variants"], () => controlOk() && v()["stale-capture"]!.detected);
    p.fact("broken_embed_detected", ["variants"], () => controlOk() && v()["broken-embed"]!.detected);
    p.fact("false_media_success_count", ["variants"], () =>
      ["missing-screenshot", "single-frame-gif", "stale-capture", "broken-embed"].filter((k) => v()[k]!.code === 0 || v()[k]!.status === "PASS").length);
  },
};

// git/gh shims owned by the collector: git forwards to the real binary but logs every invocation; gh only logs.
function shims() {
  const dir = mkdtempSync(join(tmpdir(), "apl-publish-shims-"));
  const log = join(dir, "invocations.log");
  writeFileSync(log, "");
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf 'git %s\\n' "$*" >> '${log}'\nexec '${git}' "$@"\n`);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> '${log}'\nexit 1\n`);
  chmodSync(join(dir, "git"), 0o755);
  chmodSync(join(dir, "gh"), 0o755);
  return { dir, log };
}
const remotes = () => execFileSync("git", ["remote", "-v"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const remoteRefs = () => execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/remotes"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

export const F6_A5: CaseDef = {
  ...local,
  execute: noop,
  async observe(p) {
    const before = { remotes: remotes(), remote_refs: remoteRefs() };
    const s = shims();
    const env = { PATH: `${s.dir}:${process.env.PATH ?? ""}` };
    const out = mkdtempSync(join(tmpdir(), "apl-readme-out-"));
    try {
      await p.capture("local", "`lab media verify` + `lab readme verify --local` (child processes, logged git/gh)", async () => {
        const media = await labJson(["media", "verify", "--suite", "readme"], env);
        const readme = await labJson(["readme", "verify", "--local", "--out", out], env);
        return { media: { code: media.code, status: media.json?.status ?? null }, readme: { code: readme.code, status: readme.json?.local_status ?? null, github: readme.json?.github_render_status ?? null } };
      });
      await p.capture("github", "`lab readme verify --github` (child process, logged git/gh)", async () => {
        const g = await labJson(["readme", "verify", "--github"], env);
        return { code: g.code, result: g.json };
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    await p.capture("publication-actions", "collector-owned git/gh invocation log + git remotes before/after", () => ({
      before, after: { remotes: remotes(), remote_refs: remoteRefs() }, invocations: readFileSync(s.log, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 3).join(" ")),
      log_sha256: sha256(readFileSync(s.log, "utf8")),
    }));
    rmSync(s.dir, { recursive: true, force: true });
    const pa = () => p.data("publication-actions");
    const lines = () => pa().invocations as string[];
    p.fact("local_media_status", ["local"], () => {
      const l = p.data("local");
      return l.media.code === 0 && l.media.status === "PASS" && l.readme.code === 0 && l.readme.status === "PASS" && l.readme.github === "NOT_RUN" ? "PASS" : "FAIL";
    });
    p.fact("github_render_status", ["github"], () => String(p.data("github").result?.github_render_status ?? "UNKNOWN"));
    p.fact("unauthorized_repository_create_count", ["publication-actions"], () =>
      lines().filter((l) => /^gh repo create/.test(l) || /^git remote add/.test(l)).length + Math.max(0, pa().after.remotes.length - pa().before.remotes.length));
    p.fact("unauthorized_push_count", ["publication-actions"], () =>
      lines().filter((l) => /^git push/.test(l) || /^gh (repo sync|pr create)/.test(l)).length + Math.max(0, pa().after.remote_refs.length - pa().before.remote_refs.length));
  },
};
