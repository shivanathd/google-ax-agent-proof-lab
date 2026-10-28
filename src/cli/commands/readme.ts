// `lab readme build` and `lab readme verify --local | --github --repo OWNER/REPO --ref REF`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { ROOT } from "../../config/run-config.ts";
import { buildReadme, verifyReadmeGithub, verifyReadmeLocal } from "../../media/readme.ts";
import { MANIFEST } from "../../media/spec.ts";

export function register(program: Command) {
  const readme = program.command("readme").description("root README media slots and their verification");
  readme.command("build").description("rewrite only the bounded LAB MEDIA slots from the media manifest").action(() => emit(buildReadme()));
  readme.command("verify").description("local: links, alt text, captions, fallbacks and a local render; github: actual GitHub render (authorized only)")
    .option("--local", "verify locally (never labelled as GitHub verification)")
    .option("--github", "verify the GitHub-rendered README (needs a remote, --repo, --ref and owner authorization)")
    .option("--repo <owner/repo>").option("--ref <ref>")
    .option("--root <dir>", "verify a copy of the repository")
    .option("--out <dir>", "directory for render screenshots (default artifacts/readme-verify)")
    .option("--record", "store the deterministic result summary in the media manifest's readme_verification")
    .action(async (o: { local?: boolean; github?: boolean; repo?: string; ref?: string; root?: string; out?: string; record?: boolean }) => {
      if (o.github) {
        const g = await verifyReadmeGithub({ repo: o.repo, ref: o.ref, root: o.root });
        return emit(g, g.github_render_status === "PASS" ? 0 : g.github_render_status === "NOT_RUN" ? 2 : 1);
      }
      if (!o.local) return emit({ status: "FAIL", reason: "choose --local or --github" }, 1);
      const r = await verifyReadmeLocal(o.root ?? ROOT, { out: o.out });
      if (o.record) {
        const file = join(o.root ?? ROOT, MANIFEST);
        const m = JSON.parse(readFileSync(file, "utf8"));
        // No timestamps: re-running on unchanged inputs leaves the manifest byte-identical.
        m.readme_verification = {
          local_status: r.local_status, github_render_status: "NOT_RUN", github_reason: "no authorized repository/ref; nothing published", readme_sha256: r.readme_sha256,
          embeds: r.embeds, broken_readme_media_path_count: r.broken_readme_media_path_count, missing_alt_text_count: r.missing_alt_text_count,
          missing_caption_count: r.missing_caption_count, static_fallbacks_valid: r.static_fallbacks_valid,
          render: Object.fromEntries(Object.entries(r.render).map(([k, v]) => [k, { images: v.images, loaded: v.loaded, horizontal_overflow: v.horizontal_overflow, screenshot: v.screenshot }])),
          method: "marked 18.1.1 Markdown render opened from disk in Playwright Chromium at 1440 and 400 px; not GitHub's renderer",
        };
        writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
      }
      emit(r, r.local_status === "PASS" ? 0 : 1);
    });
}
