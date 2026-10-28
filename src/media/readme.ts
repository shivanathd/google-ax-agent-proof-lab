// `lab readme build` writes only the bounded generated media slots of the root README from the manifest;
// `lab readme verify --local` checks links, alt text, captions and static fallbacks, then renders the
// README locally (marked → HTML, opened from disk in Playwright) at 1440 and 400 px. A local render is NOT
// GitHub verification: `--github` is a separate check and stays NOT_RUN without an authorized remote/ref.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { marked } from "marked";
import { ROOT } from "../config/run-config.ts";
import { MANIFEST, REQUIRED, sha256File } from "./spec.ts";

export const SLOTS: Record<string, string[]> = {
  overview: ["lab-overview"],
  workflow: ["slack-service-request", "service-request-success"],
  boundaries: ["duplicate-event-safe", "approval-denied-gif", "approval-denied"],
  evidence: ["evidence-report"],
  profiles: ["profile-boundaries"],
  videos: ["clip-mental-model", "clip-duplicate-delivery", "clip-permission-boundary", "clip-emulator-vs-real-org"],
};
const begin = (slot: string) => `<!-- BEGIN LAB MEDIA: ${slot} -->`;
const end = (slot: string) => `<!-- END LAB MEDIA: ${slot} -->`;

function block(e: any): string {
  if (e.mime_type === "image/gif") {
    return `![${e.alt_text}](${e.path})\n\n${e.caption}\n\n[View the static result (PNG poster)](${e.poster_path})`;
  }
  if (e.mime_type === "video/mp4") {
    return `[![${e.alt_text}](${e.poster_path})](${e.path})\n\n${e.caption} [Download the MP4](${e.path}) · [captions](${e.captions_path}) · [capture record](${e.sidecar_path}).`;
  }
  return `![${e.alt_text}](${e.path})\n\n${e.caption}`;
}

export function buildReadme(root = ROOT) {
  const m = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const byId = new Map<string, any>(m.media.map((e: any) => [e.id, e]));
  let text = readFileSync(join(root, "README.md"), "utf8");
  for (const [slot, ids] of Object.entries(SLOTS)) {
    const a = text.indexOf(begin(slot)), b = text.indexOf(end(slot));
    if (a < 0 || b < a) throw new Error(`README.md lacks the bounded slot ${begin(slot)} … ${end(slot)}`);
    let body = ids.map((id) => {
      const e = byId.get(id);
      if (!e) throw new Error(`manifest has no media item ${id}`);
      return block(e);
    }).join("\n\n");
    if (slot === "videos") body += "\n\nInline playback on GitHub needs a post-publication upload of these clips; until that is approved the links above open the MP4 files from the repository.";
    text = `${text.slice(0, a + begin(slot).length)}\n${body}\n${text.slice(b)}`;
  }
  writeFileSync(join(root, "README.md"), text);
  return { readme: "README.md", slots: Object.keys(SLOTS), sha256: sha256File(join(root, "README.md")) };
}

interface Embed { line: number; alt: string; src: string; href?: string }
const IMG = /(\[)?!\[([^\]]*)\]\(([^)\s]+)\)(?:\]\(([^)\s]+)\))?/g;
const LINK = /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g;
const external = (u: string) => /^[a-z]+:/i.test(u) || u.startsWith("#");

export async function verifyReadmeLocal(root = ROOT, o: { out?: string } = {}) {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const lines = readme.split("\n");
  const m = existsSync(join(root, MANIFEST)) ? JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) : { media: [] };
  const problems: { code: string; detail: string }[] = [];
  const embeds: Embed[] = [];
  lines.forEach((l, i) => {
    for (const x of l.matchAll(IMG)) embeds.push({ line: i, alt: x[2]!.trim(), src: x[3]!, ...(x[4] ? { href: x[4] } : {}) });
  });
  const links = lines.flatMap((l) => [...l.replace(IMG, "").matchAll(LINK)].map((x) => x[2]!));
  // Relative paths must exist inside the repository (anchors stripped); remote URLs are not followed here.
  const target = (u: string) => u.split("#")[0]!;
  const broken = [...new Set([...embeds.flatMap((e) => [e.src, ...(e.href ? [e.href] : [])]), ...links].filter((u) => !external(u)))]
    .filter((u) => normalize(target(u)).startsWith("..") || !existsSync(join(root, target(u))));
  for (const b of broken) problems.push({ code: "broken_path", detail: b });
  const missingAlt = embeds.filter((e) => e.alt.split(/\s+/).filter(Boolean).length < 4 || /\.(png|gif|mp4)$/i.test(e.alt));
  for (const e of missingAlt) problems.push({ code: "alt_text", detail: e.src });

  // Every required asset is embedded once, with its manifest caption next to it; GIFs have a poster link.
  let missingCaption = 0, fallbacks = true;
  for (const req of REQUIRED) {
    const e = m.media.find((x: any) => x.id === req.id);
    const embed = embeds.find((x) => (req.kind === "video" ? x.href === req.path && x.src === req.poster : x.src === req.path));
    if (!embed) {
      problems.push({ code: "not_embedded", detail: req.path });
      missingCaption++;
      if (req.poster) fallbacks = false;
      continue;
    }
    const after = lines.slice(embed.line + 1, embed.line + 6).join("\n");
    const tied = e && after.includes(e.caption) && e.caption.includes(e.mode) && (e.run_ids ?? [e.run_id]).some((id: unknown) => typeof id === "string" && e.caption.includes(id.slice(0, 8)));
    if (!tied) {
      missingCaption++;
      problems.push({ code: "caption", detail: req.path });
    }
    if (req.kind === "gif" && !(after.includes(`](${req.poster})`) && existsSync(join(root, req.poster!)))) {
      fallbacks = false;
      problems.push({ code: "static_fallback", detail: req.path });
    }
    if (req.kind === "video" && !existsSync(join(root, req.poster!))) {
      fallbacks = false;
      problems.push({ code: "static_fallback", detail: req.path });
    }
  }

  // Local render: GitHub-like width limits, images loaded from the repository files on disk.
  const out = o.out ?? join(ROOT, "artifacts", "readme-verify");
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "apl-readme-"));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="${pathToFileURL(`${root}/`).href}"><title>README local render</title>
<style>body{margin:0;background:#fff;color:#1f2328;font:16px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}article{box-sizing:border-box;max-width:1012px;margin:0 auto;padding:32px}
img{max-width:100%;height:auto;border-style:none}table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse}td,th{border:1px solid #d1d9e0;padding:6px 13px}
pre{overflow:auto;background:#f6f8fa;padding:16px}code{font-size:85%}h1,h2{border-bottom:1px solid #d1d9e0;padding-bottom:.3em}</style></head>
<body><article class="markdown-body">${await marked.parse(readme, { gfm: true })}</article></body></html>`;
  writeFileSync(join(dir, "index.html"), html);
  const browser = await chromium.launch();
  const render: Record<string, { images: number; loaded: number; missing_alt: number; horizontal_overflow: boolean; screenshot: string }> = {};
  try {
    for (const [name, width] of [["desktop", 1440], ["narrow", 400]] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(join(dir, "index.html")).href);
      await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 30000 });
      const r = await page.evaluate(() => ({
        images: document.images.length,
        loaded: [...document.images].filter((i) => i.naturalWidth > 0).length,
        missing_alt: [...document.images].filter((i) => !(i.getAttribute("alt") ?? "").trim()).length,
        horizontal_overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }));
      const shot = join(out, `readme-${name}-${width}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      render[name] = { ...r, screenshot: shot.startsWith(ROOT) ? shot.slice(ROOT.length) : `(temp)/${shot.split("/").pop()}` };
      if (r.loaded !== r.images) problems.push({ code: "render_image_failed", detail: `${name}: ${r.images - r.loaded} of ${r.images} images did not load` });
      if (r.missing_alt) problems.push({ code: "alt_text", detail: `${name}: ${r.missing_alt} rendered images without alt` });
      if (r.horizontal_overflow) problems.push({ code: "layout", detail: `${name}: horizontal overflow` });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const failedImages = Math.max(...Object.values(render).map((r) => r.images - r.loaded));
  return {
    local_status: problems.length === 0 ? "PASS" : "FAIL", github_render_status: "NOT_RUN",
    note: "local Markdown render (marked) in Chromium; this is not GitHub-rendered verification",
    readme_sha256: sha256File(join(root, "README.md")), embeds: embeds.length,
    broken_readme_media_path_count: broken.length + failedImages, missing_alt_text_count: missingAlt.length, missing_caption_count: missingCaption,
    static_fallbacks_valid: fallbacks, render, problems,
  };
}

// GitHub-rendered check: only with an existing remote, explicit --repo/--ref and recorded authorization.
export async function verifyReadmeGithub(o: { repo?: string; ref?: string; root?: string } = {}) {
  const remotes = execFileSync("git", ["remote"], { cwd: o.root ?? ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  if (!remotes.length || !o.repo || !o.ref || process.env.APL_GITHUB_RENDER_AUTHORIZED !== "1") {
    return {
      github_render_status: "NOT_RUN", remotes: remotes.length, repo: o.repo ?? null, ref: o.ref ?? null,
      reason: !remotes.length ? "no git remote: the repository has not been published (publication is not authorized)" : "requires --repo OWNER/REPO, --ref REF and APL_GITHUB_RENDER_AUTHORIZED=1 set by the owner",
    };
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`https://github.com/${o.repo}/blob/${o.ref}/README.md`);
    await page.waitForSelector("article.markdown-body", { timeout: 30000 });
    const r = await page.$$eval("article.markdown-body img", (imgs) => imgs.map((i) => ({ loaded: (i as HTMLImageElement).naturalWidth > 0, alt: i.getAttribute("alt") ?? "" })));
    const out = join(ROOT, "artifacts", "readme-verify");
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: join(out, "github-desktop-1440.png"), fullPage: true });
    const ok = r.length > 0 && r.every((x) => x.loaded && x.alt.trim());
    return { github_render_status: ok ? "PASS" : "FAIL", repo: o.repo, ref: o.ref, images: r.length, failed: r.filter((x) => !x.loaded).length, missing_alt: r.filter((x) => !x.alt.trim()).length };
  } finally {
    await browser.close();
  }
}
