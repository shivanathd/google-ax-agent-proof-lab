// The README media contract (docs/README_MEDIA_SPEC.md v1.1.0 + ADR-11) as data, plus the application-tree
// digest that binds captures to the code they exercised (ADR-9).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config/run-config.ts";
import { privateTermsPath, SECRET_RULES } from "../reports/export.ts";

export const MiB = 1024 * 1024;
export const BUDGET = { png: 2 * MiB, gif: 5 * MiB, mp4_total: 8 * MiB, total: 25 * MiB };
export const GIF_RULES = { min_width: 960, max_width: 1200, min_fps: 8, max_fps: 12 };

export interface Required { id: string; kind: "screenshot" | "gif" | "video"; path: string; scenario: string; min_s?: number; max_s?: number; poster?: string }
export const REQUIRED: Required[] = [
  { id: "lab-overview", kind: "screenshot", path: "docs/assets/screenshots/lab-overview.png", scenario: "W02-H" },
  { id: "service-request-success", kind: "screenshot", path: "docs/assets/screenshots/service-request-success.png", scenario: "W01-H" },
  { id: "approval-denied", kind: "screenshot", path: "docs/assets/screenshots/approval-denied.png", scenario: "W02-U" },
  { id: "evidence-report", kind: "screenshot", path: "docs/assets/screenshots/evidence-report.png", scenario: "W01-H" },
  { id: "profile-boundaries", kind: "screenshot", path: "docs/assets/screenshots/profile-boundaries.png", scenario: "W01-H" },
  { id: "slack-service-request", kind: "gif", path: "docs/assets/gifs/slack-service-request.gif", scenario: "W01-H", min_s: 12, max_s: 25, poster: "docs/assets/posters/slack-service-request.png" },
  { id: "duplicate-event-safe", kind: "gif", path: "docs/assets/gifs/duplicate-event-safe.gif", scenario: "W01-D", min_s: 8, max_s: 20, poster: "docs/assets/posters/duplicate-event-safe.png" },
  { id: "approval-denied-gif", kind: "gif", path: "docs/assets/gifs/approval-denied.gif", scenario: "W02-U", min_s: 8, max_s: 20, poster: "docs/assets/posters/approval-denied.png" },
  // ADR-11 / RECORDING_RUNBOOK short clips. Durations there are editorial targets, so none is enforced here.
  { id: "clip-mental-model", kind: "video", path: "docs/assets/videos/mental-model.mp4", scenario: "W01-H", poster: "docs/assets/videos/mental-model.png" },
  { id: "clip-duplicate-delivery", kind: "video", path: "docs/assets/videos/duplicate-delivery.mp4", scenario: "W01-D", poster: "docs/assets/videos/duplicate-delivery.png" },
  { id: "clip-permission-boundary", kind: "video", path: "docs/assets/videos/permission-boundary.mp4", scenario: "W02-U", poster: "docs/assets/videos/permission-boundary.png" },
  { id: "clip-emulator-vs-real-org", kind: "video", path: "docs/assets/videos/emulator-vs-real-org.mp4", scenario: "W03-V", poster: "docs/assets/videos/emulator-vs-real-org.png" },
];
export const MANIFEST = "docs/assets/media-manifest.json";
export const REVIEW = "docs/assets/render-review.json";
export const EVIDENCE_DIR = "docs/evidence";

// Application code for ADR-9 binding: the tracked files that decide what a captured run does. Excluded:
// documentation, generated media/evidence, tests, the media/README tooling itself and the F6/S4 verification
// handlers, so a docs- or media-only commit never forces a recapture. Any change to an included file
// (workflows, worker, console, adapters, fixtures, dependency locks) makes existing captures stale.
export const APP_INCLUDE = ["src/", "web/", "fixtures/", "profiles/", "compose.yaml", "package.json", "package-lock.json", "DEPENDENCIES.lock.json", "tsconfig.json", "scripts/patch-emulate.mjs"];
export const APP_EXCLUDE = [/\.md$/, /^src\/media\//, /^src\/cli\/commands\/(media|readme|record)\.ts$/, /^src\/collector\/cases\/(f6-[a-z0-9-]+|s4)\.ts$/];
export const isAppPath = (p: string) => APP_INCLUDE.some((i) => (i.endsWith("/") ? p.startsWith(i) : p === i)) && !APP_EXCLUDE.some((r) => r.test(p));

export function appFiles(repo = ROOT): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean).filter(isAppPath).sort();
}

// sha256 over "path\0sha256(content)\n" for every application file, read from `root` (a copy may be checked).
export function applicationTreeSha256(root = ROOT, files = appFiles()): string {
  const h = createHash("sha256");
  for (const f of files) {
    const p = join(root, f);
    h.update(`${f}\0${existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "MISSING"}\n`);
  }
  return h.digest("hex");
}

// Uncommitted changes to application files: captures made now would not match any commit.
export function appDirty(repo = ROOT): string[] {
  return execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: repo, encoding: "utf8" })
    .split("\0").filter(Boolean).map((l) => l.slice(3)).filter(isAppPath);
}

export const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

// The gitignored private-terms list (main checkout's private-runs/). Missing list = refuse, never "0 findings".
export function loadPrivateTerms(path = privateTermsPath()): string[] {
  if (!existsSync(path)) throw new Error("private-terms list missing (private-runs/private-terms.txt in the main checkout); refusing to scan as clean");
  return readFileSync(path, "utf8").split("\n").map((t) => t.trim().toLowerCase()).filter(Boolean);
}

// Counts only; the matched value is never returned or written.
export function scanText(text: string, terms: string[]) {
  return { secrets: SECRET_RULES.filter(([, re]) => re.test(text)).map(([rule]) => rule), private_terms: terms.filter((t) => text.toLowerCase().includes(t)).length };
}
