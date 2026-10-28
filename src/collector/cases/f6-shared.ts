// Shared halves for the console/media cases (F6-A1..A5, S4). Coordinator: start the real teaching console and
// run scenarios through its API (each one is a full collect-case run). Collector: open the console in its own
// Chromium and read the DOM; read report.json straight from the run's artifact directory.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { ROOT } from "../../config/run-config.ts";
import { childEnv } from "../../config/env.ts";
import { lab, waitFor } from "../drive.ts";
import type { Probe } from "../probe.ts";
import type { Exec } from "../types.ts";

// ---- coordinator half ----
export async function consoleRuns(x: Exec, scenarios: string[]) {
  const { startConsole } = await import("../../console/server.ts"); // never loaded by the collector process
  const web = await startConsole();
  x.defer(() => web.close());
  const runs: Record<string, string> = {};
  for (const id of scenarios) {
    const res = await fetch(`${web.url}api/scenarios/${id}/run`, { method: "POST" });
    if (!res.ok) throw new Error(`console refused scenario ${id}: ${res.status}`);
    const { job_id } = (await res.json()) as { job_id: number };
    const job = await waitFor(async () => {
      const j = (await (await fetch(`${web.url}api/jobs/${job_id}`)).json()) as { phase: string; run_id: string | null; error: string | null; report: unknown };
      return j.phase === "error" || j.report ? j : undefined;
    }, 150000, `console scenario ${id} reported`);
    if (job.phase === "error" || !job.run_id) throw new Error(`console scenario ${id} failed: ${job.error}`);
    runs[id] = job.run_id;
  }
  x.ref("console_url", web.url);
  x.ref("runs", runs);
  return { web, runs };
}

// ---- collector half ----
const artifactsRoot = () => join(ROOT, "artifacts", "runs");
export const readReport = (runId: string) => JSON.parse(readFileSync(join(artifactsRoot(), runId, "report.json"), "utf8"));
export const runArtifacts = (runId: string) => join(artifactsRoot(), runId);

export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// What the console actually shows for a stored run: banner, badge, details and every assertion row.
export async function readConsole(page: Page, url: string, runId: string, tab = "report") {
  await page.goto(`${url}?run=${encodeURIComponent(runId)}&tab=${tab}`);
  await page.waitForSelector('body[data-run-state="reported"]', { timeout: 30000 });
  const inView = async (sel: string) => {
    const box = await page.locator(sel).first().boundingBox();
    return Boolean(box && (await page.locator(sel).first().isVisible()) && box.y >= 0 && box.y + box.height <= 900 && box.x + box.width <= 1440);
  };
  const banner = page.locator("#banner");
  return {
    run_id: await page.getAttribute("body", "data-run-id"),
    banner: { text: (await banner.innerText()).trim(), visible: await inView("#banner"), green: await banner.getAttribute("data-green"), report_status: await banner.getAttribute("data-report-status"), classes: await banner.getAttribute("class") },
    success_badges_visible: await page.locator("[data-success-badge]").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length),
    details: Object.fromEntries(await page.$$eval("#run-details dd", (dds) => dds.map((d) => [(d as HTMLElement).dataset.field, d.textContent ?? ""]))),
    details_in_view: { run_id: await inView('[data-field="run-id"]'), tree: await inView('[data-field="tree"]'), commit: await inView('[data-field="commit"]') },
    notice: { text: (await page.locator("#synthetic-notice").innerText()).trim(), visible: await inView("#synthetic-notice") },
    // No named helper inside the browser callback: tsx's keepNames would inject an undefined __name there.
    rows: await page.$$eval("#assertions tbody tr", (trs) => trs.map((tr) => ({
      id: (tr as HTMLElement).dataset.assertion, status: (tr as HTMLElement).dataset.status,
      status_text: (tr.querySelector('[data-col="status"]')?.textContent ?? "").trim(), expected: (tr.querySelector('[data-col="expected"]')?.textContent ?? "").trim(),
      observed: (tr.querySelector('[data-col="observed"]')?.textContent ?? "").trim(), evidence: (tr.querySelector('[data-col="evidence"]')?.textContent ?? "").trim(),
      visible: (tr as HTMLElement).offsetParent !== null,
    }))),
    profiles: await page.$$eval("#profiles tbody tr", (trs) => trs.map((tr) => ({ lane: (tr as HTMLElement).dataset.lane, status: tr.querySelector("[data-status]")?.getAttribute("data-status") ?? null }))),
    html: await page.content(),
    text: await page.locator("body").innerText(),
  };
}

// Mirrors the console's documented formatting so the comparison is exact, not fuzzy.
const fmt = (v: unknown) => (v === null ? "— (not observed)" : JSON.stringify(v));
export function matchesReport(dom: Awaited<ReturnType<typeof readConsole>>, r: any) {
  const rowsOk = dom.rows.length === r.assertions.length && r.assertions.every((a: any, i: number) => {
    const row = dom.rows[i]!;
    return row.id === a.id && row.status === a.status && row.status_text === a.status && row.expected === fmt(a.expected) && row.observed === fmt(a.observed) &&
      row.evidence === (a.evidence_refs.join(", ") || (a.reason ?? "—"));
  });
  return rowsOk && dom.run_id === r.run_id && dom.details.tree === r.tree_sha && dom.banner.text.includes(r.banner.text) &&
    dom.banner.green === String(r.banner.green) && dom.banner.report_status === r.status;
}

// A screenshot kept as evidence of what the collector's browser saw.
export async function screenshotEvidence(p: Probe, page: Page, name: string) {
  const rel = `evidence/${name}.png`;
  const file = join(p.evidenceDir, `${name}.png`);
  await page.screenshot({ path: file });
  p.evidence.push({ path: rel, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), source: "browser screenshot (collector's own Chromium)", observations: [] });
}

export async function labJson(args: string[], extra: Record<string, string> = {}) {
  const r = await lab(args, { ...childEnv(process.env, extra), ...extra });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.code, json };
}
