// Media pipeline building blocks: application-tree scope, real decode checks and bounded README slots.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectMedia } from "../../src/media/inspect.ts";
import { buildReadme, SLOTS } from "../../src/media/readme.ts";
import { isAppPath, MANIFEST } from "../../src/media/spec.ts";

const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

describe("application tree scope (ADR-9)", () => {
  it("counts code that decides a captured run, not docs, media or the media tooling", () => {
    for (const p of ["src/workflows/w01.ts", "web/src/main.ts", "fixtures/cases/cases.json", "package-lock.json", "src/collector/cases/f3.ts", "src/console/server.ts"]) expect(isAppPath(p), p).toBe(true);
    for (const p of ["README.md", "docs/assets/media-manifest.json", "docs/evidence/x/report.json", "src/media/verify.ts", "src/cli/commands/media.ts", "src/collector/cases/f6-media.ts", "src/collector/cases/s4.ts", "tests/unit/media.test.ts"]) expect(isAppPath(p), p).toBe(false);
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
