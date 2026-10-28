// `lab media verify --suite readme`: every required asset is decoded and checked against the spec and the
// manifest — signature, decode, dimensions, GIF animation/duration/fps, hashes, posters, budget, provenance
// (committed sanitized evidence of the same run, clean capture, current application tree) and path hygiene.
// `root` may be a copy of the repository (F6-A4 breaks copies on purpose); file lists come from this repo.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { fixtureSha256, ROOT } from "../config/run-config.ts";
import { verifyChecksums } from "../reports/report.ts";
import { SECRET_RULES } from "../reports/export.ts";
import { inspectMedia } from "./inspect.ts";
import { MIN_CUE_MS, parseVtt } from "./captions.ts";
import { appFiles, applicationTreeSha256, BUDGET, EVIDENCE_DIR, GIF_RULES, MANIFEST, REQUIRED, sha256File } from "./spec.ts";

export interface Problem { code: string; id: string; detail: string }
export interface ItemResult { id: string; kind: string; path: string; valid: boolean; provenance_valid: boolean; poster_valid: boolean | null; problems: Problem[] }

const relOk = (p: unknown) => typeof p === "string" && p.length > 0 && !isAbsolute(p) && !normalize(p).startsWith("..") && !p.includes("\\");

export function verifyMedia(root = ROOT, o: { appTree?: string } = {}) {
  const problems: Problem[] = [];
  const add = (code: string, id: string, detail: string) => problems.push({ code, id, detail });
  const mpath = join(root, MANIFEST);
  if (!existsSync(mpath)) {
    add("manifest_missing", "manifest", MANIFEST);
    return summarize([], problems, null);
  }
  const text = readFileSync(mpath, "utf8");
  const m = JSON.parse(text);
  for (const [rule, re] of SECRET_RULES) if (re.test(text)) add("manifest_private_data", "manifest", rule);
  for (const k of ["schema_version", "generated_at", "application_revision", "application_tree_sha256", "fixture_sha256", "capture_tool_versions", "media", "readme_verification"]) {
    if (!(k in m)) add("manifest_field", "manifest", k);
  }
  // Stale: the application code or fixtures changed since capture (ADR-9 application-tree binding).
  const appTree = o.appTree ?? applicationTreeSha256(root, appFiles());
  const stale = m.application_tree_sha256 !== appTree;
  if (stale) add("stale_capture", "manifest", "application tree changed since capture; rerun capture");
  if (m.fixture_sha256 !== fixtureSha256(join(root, "fixtures"))) add("stale_capture", "manifest", "fixtures changed since capture");
  if (m.capture_dirty !== false || m.capture_app_dirty_files !== 0) add("dirty_capture", "manifest", "captured from an uncommitted application tree");

  const items: ItemResult[] = REQUIRED.map((req) => {
    const own: Problem[] = [];
    const bad = (code: string, detail: string) => own.push({ code, id: req.id, detail });
    const e = (m.media ?? []).find((x: any) => x.id === req.id);
    if (!e) bad("manifest_entry_missing", req.path);
    const abs = join(root, req.path);
    const f = inspectMedia(abs);
    if (!f.exists) bad("missing", req.path);
    else {
      const want = { screenshot: "png", gif: "gif", video: "mp4" }[req.kind];
      if (f.signature !== want) bad("signature", `${f.signature} (expected ${want})`);
      if (!f.decoded) bad("decode", f.error ?? "decode failed");
      if (!(f.width > 0 && f.height > 0)) bad("dimensions", `${f.width}x${f.height}`);
      if (req.kind === "screenshot" && f.bytes > BUDGET.png) bad("budget", `${f.bytes} bytes > 2 MiB`);
      if (req.kind === "gif") {
        if (f.frame_count <= 1) bad("single_frame", `${f.frame_count} frame(s)`);
        if (f.bytes > BUDGET.gif) bad("budget", `${f.bytes} bytes > 5 MiB`);
        if (f.width < GIF_RULES.min_width || f.width > GIF_RULES.max_width) bad("width", `${f.width}px`);
        if (f.fps < GIF_RULES.min_fps || f.fps > GIF_RULES.max_fps) bad("fps", `${f.fps}`);
        if (f.duration_ms < req.min_s! * 1000 || f.duration_ms > req.max_s! * 1000) bad("duration", `${f.duration_ms} ms (allowed ${req.min_s}-${req.max_s} s)`);
      }
      if (req.kind === "video" && f.frame_count <= 1) bad("single_frame", `${f.frame_count} frame(s)`);
      // Clip captions: present, hashed, every cue at least MIN_CUE_MS long, no overlaps, inside the clip.
      if (req.kind === "video" && e) {
        const cp = e.captions_path ? join(root, e.captions_path) : "";
        if (!cp || !existsSync(cp)) bad("captions", "WebVTT captions missing");
        else {
          const cues = parseVtt(readFileSync(cp, "utf8"));
          if (e.captions_sha256 !== sha256File(cp)) bad("captions", "captions differ from manifest sha256");
          if (!cues.length) bad("captions", "no cues");
          cues.forEach((c, i) => {
            if (c.to - c.from < MIN_CUE_MS) bad("captions", `cue ${i + 1} lasts ${c.to - c.from} ms (< ${MIN_CUE_MS})`);
            if (i > 0 && c.from < cues[i - 1]!.to) bad("captions", `cue ${i + 1} overlaps cue ${i}`);
            if (c.to > f.duration_ms + 50) bad("captions", `cue ${i + 1} ends after the clip`);
          });
        }
      }
      if (e) {
        if (e.path !== req.path || !relOk(e.path)) bad("path", String(e.path));
        if (e.sha256 !== sha256File(abs)) bad("hash", "file differs from manifest sha256");
        if (e.bytes !== f.bytes || e.width !== f.width || e.height !== f.height) bad("manifest_mismatch", "bytes/dimensions differ from manifest");
        if (req.kind !== "screenshot" && (e.frame_count !== f.frame_count || e.duration_ms !== f.duration_ms)) bad("manifest_mismatch", "frame count/duration differ from manifest");
        for (const k of ["mime_type", "run_id", "scenario_ids", "profile", "mode", "source_capture_sha256", "evidence_refs", "alt_text", "caption", "edits", "redaction_review", "visual_review"]) {
          if (e[k] === undefined || e[k] === null || e[k] === "") bad("manifest_field", k);
        }
        if (req.kind !== "screenshot") for (const k of ["duration_ms", "frame_count", "poster_path", "poster_sha256"]) if (e[k] === undefined) bad("manifest_field", k);
      }
    }
    // Poster: required for every GIF (static fallback) and used as the README link image for every MP4.
    let poster_valid: boolean | null = null;
    if (req.poster) {
      const p = inspectMedia(join(root, req.poster));
      poster_valid = p.exists && p.signature === "png" && p.decoded && p.width > 0 && p.bytes <= BUDGET.png && e?.poster_path === req.poster && e?.poster_sha256 === sha256File(join(root, req.poster));
      if (!poster_valid) bad(p.exists ? "poster_invalid" : "poster_missing", req.poster);
    }
    // Provenance: the run's committed sanitized export exists, is intact, and matches the item's claims.
    const before = own.length;
    if (e) {
      if (!/^[0-9a-f]{64}$/.test(String(e.source_capture_sha256))) bad("provenance", "source_capture_sha256 missing");
      if (e.profile !== "local" || e.mode !== "scripted") bad("provenance", `profile ${e.profile} / mode ${e.mode}`);
      const ids: string[] = e.run_ids ?? [e.run_id];
      if (!Array.isArray(e.evidence_refs) || !e.evidence_refs.length) bad("provenance", "no evidence refs");
      for (const ref of e.evidence_refs ?? []) {
        if (!relOk(ref) || !String(ref).startsWith(`${EVIDENCE_DIR}/`) || !existsSync(join(root, ref))) bad("provenance", `evidence ref not committed: ${ref}`);
      }
      for (const id of ids) {
        const dir = join(root, EVIDENCE_DIR, id);
        const rp = join(dir, "report.json");
        if (!existsSync(rp)) {
          bad("provenance", `no committed evidence for run ${id}`);
          continue;
        }
        if (!verifyChecksums(dir).ok) bad("provenance", `evidence for run ${id} fails its checksums`);
        const r = JSON.parse(readFileSync(rp, "utf8"));
        if (r.run_id !== id) bad("provenance", `report run_id mismatch for ${id}`);
        if (r.candidate_revision !== m.application_revision || r.dirty !== false) bad("provenance", `run ${id} not from the clean application revision`);
        if (r.fixture_sha256 !== m.fixture_sha256) bad("provenance", `run ${id} used other fixtures`);
        if (!(e.scenario_ids ?? []).includes(r.case_id)) bad("provenance", `scenario ${r.case_id} not listed`);
        if (r.mode !== "scripted" || r.profile !== "local" || (r.mutation ?? "none") !== "none") bad("provenance", `run ${id} is not an unmutated local scripted run`);
      }
      if (req.kind === "screenshot" || req.kind === "gif") {
        if (!ids.some((id) => existsSync(join(root, EVIDENCE_DIR, id, "report.json")) && JSON.parse(readFileSync(join(root, EVIDENCE_DIR, id, "report.json"), "utf8")).case_id === req.scenario)) {
          bad("provenance", `expected scenario ${req.scenario}`);
        }
      }
    } else bad("provenance", "no manifest entry");
    if (stale) bad("stale_capture", "application tree changed since capture");
    const provenance_valid = !own.slice(before).some((p) => p.code === "provenance" || p.code === "stale_capture") && !problems.some((p) => p.code === "dirty_capture");
    problems.push(...own);
    return { id: req.id, kind: req.kind, path: req.path, valid: own.length === 0, provenance_valid, poster_valid, problems: own };
  });

  // Budget over everything committed under docs/assets/ (media, posters, clips, captions, manifest).
  const sizes = (m.media ?? []).flatMap((x: any) => [x.path, x.poster_path, x.captions_path, x.sidecar_path].filter(Boolean));
  const size = (p: string) => (existsSync(join(root, p)) ? statSync(join(root, p)).size : 0);
  const total = [...new Set<string>(sizes)].reduce((n, p) => n + size(p), 0) + size(MANIFEST);
  const mp4 = REQUIRED.filter((r) => r.kind === "video").reduce((n, r) => n + size(r.path), 0);
  if (total > BUDGET.total) add("budget", "total", `${total} bytes > 25 MiB`);
  if (mp4 > BUDGET.mp4_total) add("budget", "mp4_total", `${mp4} bytes > 8 MiB`);
  return summarize(items, problems, { total_bytes: total, mp4_bytes: mp4 });
}

function summarize(items: ItemResult[], problems: Problem[], sizes: { total_bytes: number; mp4_bytes: number } | null) {
  const count = (kind: string) => items.filter((i) => i.kind === kind && i.valid).length;
  return {
    status: problems.length === 0 && items.length === REQUIRED.length ? "PASS" : "FAIL",
    counts: { screenshots: count("screenshot"), gifs: count("gif"), posters: items.filter((i) => i.kind === "gif" && i.poster_valid).length, videos: count("video") },
    all_provenance_valid: items.length === REQUIRED.length && items.every((i) => i.provenance_valid),
    budget_passed: sizes !== null && !problems.some((p) => p.code === "budget"),
    sizes, items, problems,
  };
}
