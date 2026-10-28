// Media pipeline building blocks: application-tree scope, real decode checks and bounded README slots.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectMedia } from "../../src/media/inspect.ts";
import { cuesFor, MIN_CUE_MS, parseVtt, vtt } from "../../src/media/captions.ts";
import { buildReadme, SLOTS } from "../../src/media/readme.ts";
import { isAppPath, MANIFEST } from "../../src/media/spec.ts";
import { CASES } from "../../src/collector/cases/index.ts";
import { collectCase } from "../../src/evaluator/collect-case.ts";
import type { CaseDef } from "../../src/collector/types.ts";

const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

describe("application tree scope (ADR-9)", () => {
  it("counts code that decides a captured run, not docs, media or the media tooling", () => {
    for (const p of ["src/workflows/w01.ts", "web/src/main.ts", "fixtures/cases/cases.json", "package-lock.json", "src/collector/cases/f3.ts", "src/console/server.ts", "profiles/ax/index.ts"]) expect(isAppPath(p), p).toBe(true);
    for (const p of ["README.md", "docs/assets/media-manifest.json", "docs/evidence/x/report.json", "src/media/verify.ts", "src/cli/commands/media.ts", "src/collector/cases/f6-media.ts", "src/collector/cases/s4.ts", "tests/unit/media.test.ts", "profiles/ax/RESULTS.md", "profiles/ax/README.md"]) expect(isAppPath(p), p).toBe(false);
  });
});

describe("inspectMedia decodes files instead of trusting extensions", () => {
  const dir = mkdtempSync(join(tmpdir(), "apl-media-unit-"));
  it("reports an animated GIF's frames and a single-frame GIF as one frame", () => {
    ff("-f", "lavfi", "-i", "testsrc=size=1000x600:rate=10:duration=2", "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", join(dir, "anim.gif"));
    ff("-f", "lavfi", "-i", "testsrc=size=1000x600:rate=1:duration=1", "-frames:v", "1", join(dir, "one.gif"));
    const anim = inspectMedia(join(dir, "anim.gif")), one = inspectMedia(join(dir, "one.gif"));
    expect(anim).toMatchObject({ signature: "gif", decoded: true, width: 1000, height: 600, frame_count: 20 });
    expect(anim.fps).toBeGreaterThan(9);
    expect(one.frame_count).toBe(1);
  });
  it("rejects a renamed file by signature and reports a missing file", () => {
    writeFileSync(join(dir, "fake.png"), "not an image");
    expect(inspectMedia(join(dir, "fake.png"))).toMatchObject({ signature: "unknown", decoded: false });
    expect(inspectMedia(join(dir, "absent.png"))).toMatchObject({ exists: false });
  });
});

describe("clip captions", () => {
  it("merge marks closer than the minimum cue length, never overlap and end with the clip", () => {
    const marks = [{ t_ms: 0, label: "console loaded" }, { t_ms: 34, label: "select W01-H" }, { t_ms: 4000, label: "run clicked W01-H" },
      { t_ms: 9000, label: "tab report" }, { t_ms: 9031, label: "tab workflow" }, { t_ms: 15900, label: "tab profiles" }];
    const cues = cuesFor(marks, [], "Opening.", 16500);
    expect(cues.map((c) => c.to - c.from).every((d) => d >= MIN_CUE_MS)).toBe(true);
    cues.forEach((c, i) => i && expect(c.from).toBeGreaterThanOrEqual(cues[i - 1]!.to));
    expect(cues.at(-1)!.to).toBe(16500);
    expect(cues[0]!.text).toContain("Opening.\nScenario W01-H");
    expect(parseVtt(vtt(cues))).toEqual(cues);
  });
});

describe("readme build owns only its bounded slots", () => {
  it("rewrites slot bodies idempotently and keeps manual text", () => {
    const root = mkdtempSync(join(tmpdir(), "apl-readme-unit-"));
    mkdirSync(join(root, "docs/assets"), { recursive: true });
    const media = Object.values(SLOTS).flat().map((id) => ({ id, path: `docs/assets/${id}.png`, mime_type: "image/png", alt_text: `alt text for ${id} here`, caption: `Caption ${id}.` }));
    writeFileSync(join(root, MANIFEST), JSON.stringify({ media }));
    const slots = Object.keys(SLOTS).map((s) => `<!-- BEGIN LAB MEDIA: ${s} -->\nstale\n<!-- END LAB MEDIA: ${s} -->`).join("\n\nManual paragraph.\n\n");
    writeFileSync(join(root, "README.md"), `# Title\n\nKeep me.\n\n${slots}\n\nTail.\n`);
    buildReadme(root);
    const once = readFileSync(join(root, "README.md"), "utf8");
    buildReadme(root);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(once);
    expect(once).toContain("Keep me.");
    expect(once).toContain("Tail.");
    expect(once).not.toContain("stale");
    expect(once).toContain("![alt text for lab-overview here](docs/assets/lab-overview.png)");
  });
  it("refuses a README without the bounded slots", () => {
    const root = mkdtempSync(join(tmpdir(), "apl-readme-unit-"));
    mkdirSync(join(root, "docs/assets"), { recursive: true });
    writeFileSync(join(root, MANIFEST), JSON.stringify({ media: [] }));
    writeFileSync(join(root, "README.md"), "# No slots\n");
    expect(() => buildReadme(root)).toThrow(/bounded slot/);
  });
});

describe("F6-A2 without the private-terms list", () => {
  it("is NOT_RUN with a clear reason (exit 2, nothing started), never a thrown scan or a PASS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apl-terms-"));
    vi.stubEnv("APL_PRIVATE_TERMS", join(dir, "absent-private-terms.txt"));
    try {
      expect((CASES["F6-A2"] as CaseDef).prerequisite?.()).toMatch(/private-terms list missing/);
      const out = join(dir, "observations.json");
      expect(await collectCase("F6-A2", out)).toBe(2);
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ case_id: "F6-A2", execution: "NOT_RUN", reason: expect.stringMatching(/private-terms list missing/), observations: {} });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("media evidence cleanup", () => {
  it("removes only the previous capture's media runs, never other evidence", async () => {
    const { clearMediaEvidence } = await import("../../src/media/optimize.ts");
    const root = mkdtempSync(join(tmpdir(), "apl-ev-"));
    const ev = join(root, "docs/evidence");
    const oldMedia = "11111111-1111-4111-8111-111111111111", harness = "22222222-2222-4222-8222-222222222222";
    for (const d of [oldMedia, harness, "blind-holdouts"]) { mkdirSync(join(ev, d), { recursive: true }); writeFileSync(join(ev, d, "report.json"), "{}"); }
    clearMediaEvidence(root, JSON.stringify({ media: [{ id: "x", run_id: oldMedia }] }));
    expect(existsSync(join(ev, oldMedia))).toBe(false);
    expect(existsSync(join(ev, harness, "report.json"))).toBe(true);
    expect(existsSync(join(ev, "blind-holdouts", "report.json"))).toBe(true);
  });
});
