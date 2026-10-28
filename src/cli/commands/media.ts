// `lab media doctor|capture|optimize|verify --suite readme` (docs/README_MEDIA_SPEC.md).
import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import type { Command } from "commander";
import { chromium } from "@playwright/test";
import { emit } from "../registry.ts";
import { localPrerequisites } from "./doctor.ts";
import { ROOT } from "../../config/run-config.ts";
import { captureSuite } from "../../media/capture.ts";
import { optimizeSuite } from "../../media/optimize.ts";
import { verifyMedia } from "../../media/verify.ts";
import { appDirty, loadPrivateTerms } from "../../media/spec.ts";
import { toolVersions } from "../../media/inspect.ts";

const suite = (s: string) => {
  if (s !== "readme") throw new Error(`unknown suite ${s} (only "readme")`);
};
const ok = (fn: () => boolean) => {
  try {
    return fn();
  } catch {
    return false;
  }
};

export function mediaDoctor() {
  const v = toolVersions();
  const filters = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout ?? "";
  const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
  const fs = statfsSync(ROOT);
  const free = Number(fs.bavail) * Number(fs.bsize);
  const prerequisites = [
    { id: "media.chromium", description: "Playwright Chromium installed (npx playwright install chromium)", satisfied: ok(() => existsSync(chromium.executablePath())) },
    { id: "media.ffmpeg", description: `FFmpeg 6.x on PATH (found: ${v.ffmpeg ?? "none"})`, satisfied: /ffmpeg version 6\./.test(v.ffmpeg ?? "") && v.ffprobe !== null },
    { id: "media.palette", description: "ffmpeg palettegen/paletteuse filters (GIF encoding)", satisfied: /palettegen/.test(filters) && /paletteuse/.test(filters) },
    { id: "media.x264", description: "ffmpeg libx264 encoder (MP4 clips, ADR-11)", satisfied: /libx264/.test(encoders) },
    { id: "media.disk", description: "at least 2 GiB free for raw recordings", satisfied: free > 2 * 1024 ** 3 },
    { id: "media.private-terms", description: "private-terms list present for the publication scan (fail closed)", satisfied: ok(() => loadPrivateTerms().length > 0) },
    ...localPrerequisites(),
  ];
  const dirty = appDirty();
  return {
    status: prerequisites.every((p) => p.satisfied) ? "NOT_RUN" : "BLOCKED", prerequisites, tools: v,
    application_tree_clean: dirty.length === 0, note: dirty.length ? `${dirty.length} uncommitted application file(s): captures would be marked dirty and fail media verify` : "application tree clean",
  };
}

export function register(program: Command) {
  const media = program.command("media").description("README screenshots, GIFs, posters and MP4 clips from real local runs");
  media.command("doctor").description("check browser, encoder, disk space and app/emulator prerequisites").action(() => {
    const d = mediaDoctor();
    emit(d, d.status === "BLOCKED" ? 2 : 0);
  });
  media.command("capture").description("run the scenarios in the console and record raw captures (recordings/raw/)").requiredOption("--suite <name>")
    .option("--only <shots...>", "subset of shot names (development only)")
    .action(async (o: { suite: string; only?: string[] }) => {
      suite(o.suite);
      const d = mediaDoctor();
      if (d.status === "BLOCKED") return emit({ status: "BLOCKED", prerequisites: d.prerequisites.filter((p) => !p.satisfied) }, 2);
      const s = await captureSuite({ only: o.only });
      emit({ status: "CAPTURED", session: `recordings/raw/${s.session}`, dirty: s.dirty, app_dirty_files: s.app_dirty_files, shots: s.shots.map((x) => ({ name: x.name, runs: x.runs, screenshots: x.screenshots.length, video: Boolean(x.video) })) });
    });
  media.command("optimize").description("encode README media, export sanitized evidence, write the media manifest").requiredOption("--suite <name>").action(async (o: { suite: string }) => {
    suite(o.suite);
    emit({ status: "OPTIMIZED", ...(await optimizeSuite()) });
  });
  media.command("verify").description("decode and check every required asset, its provenance and the budget").requiredOption("--suite <name>")
    .option("--root <dir>", "verify a copy of the repository instead of this checkout")
    .action((o: { suite: string; root?: string }) => {
      suite(o.suite);
      const r = verifyMedia(o.root ?? ROOT);
      emit(r, r.status === "PASS" ? 0 : 1);
    });
}
