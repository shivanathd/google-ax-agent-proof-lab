// BH-14 (collector with stopped Floci) and BH-15 (scoped `lab down`).
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BLIND, lc, save, start } from "./lib.ts";
const C = `${BLIND}/candidate`;
const cc = await import(`${C}/src/evaluator/collect-case.ts`);
const f3 = await import(`${C}/src/collector/cases/f3.ts`);
const art = await import(`${C}/src/reports/artifacts.ts`);
const LABEL = lc.RUN_LABEL;
const byLabel = (v: string) => execFileSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${v}`], { encoding: "utf8" }).split("\n").filter(Boolean);

// ---------- BH-14 ----------
{
  const h = await start({ worker: false });
  const runId = h.manifest.config.run_id;
  const out = `${BLIND}/results/bh14-bundle.json`;
  let obs: any = {};
  try {
    const cfg = cc.collectorConfig(h, "F3-A1", out, f3.F3_A1);
    const child = spawn(process.execPath, ["--import", "tsx", "src/collector/main.ts"], { cwd: C, env: cc.collectorEnv(cfg), stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await lines.next()).value);
    await next(); // ready
    await h.startWorker({});
    const refs: Record<string, unknown> = { faults: [] };
    await f3.F3_A1.execute({ h, ref: (k: string, v: unknown) => void (refs[k] = v) } as any);
    const ids = byLabel(runId);
    execFileSync("docker", ["stop", "-t", "2", ...ids]); // owned, labelled container of this run only
    child.stdin!.write(`${JSON.stringify({ op: "finish", refs })}\n`);
    const done = await next();
    const bundle = JSON.parse(readFileSync(out, "utf8"));
    let report: any;
    try { report = await art.generateReport(runId, { cleanup_status: "NOT_RUN" }); } catch (e) { report = { error: (e as Error).message }; }
    obs = { collector_done: done, observations: bundle.observations, unobserved: bundle.unobserved, report_status: report.status ?? report.error,
      report_assertions: (report.assertions ?? []).map((a: any) => ({ id: a.id, observed: a.observed ?? null, status: a.status })) };
    const absent = (k: string) => !(k in bundle.observations) && k in bundle.unobserved;
    const pass = absent("receipt_count") && absent("receipt_matches_request") && report.status && report.status !== "PASS" && report.status === "UNKNOWN";
    const partial = absent("receipt_count") && report.status && report.status !== "PASS";
    save({ id: "BH-14", observed: obs, verdict: pass ? "PASS" : partial ? "INCONCLUSIVE" : "FAIL" });
  } finally {
    const m = await h.stop();
    console.log(JSON.stringify({ run: runId, cleanup: m.cleanup_status }));
  }
}

// ---------- BH-15 ----------
{
  const X = await start({ slack: false });
  const Y = await start({ slack: false });
  const x = X.manifest.config.run_id, y = Y.manifest.config.run_id;
  const fake = randomUUID();
  const sentinel = execFileSync("docker", ["create", "--label", `${LABEL}=${fake}`, "--name", `blind-sentinel-${fake.slice(0, 8)}`, "floci/floci:2.3.0"], { encoding: "utf8" }).trim();
  const lab = (args: string[]) => {
    try {
      const stdout = execFileSync(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...args], { cwd: C, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out: stdout.slice(0, 300) };
    } catch (e: any) { return { code: e.status ?? 1, out: String(e.stdout ?? "").slice(0, 200), err: String(e.stderr ?? "").split("\n").find((l: string) => /Error/.test(l)) ?? "" }; }
  };
  const snap = () => ({ X: byLabel(x).length, Y: byLabel(y).length, sentinel: byLabel(fake).length });
  try {
    const before = snap();
    const malformed = lab(["down", "--run-id", "not-a-uuid"]);
    const traversal = lab(["down", "--run-id", "../../../etc"]);
    const unknown = lab(["down", "--run-id", randomUUID()]);
    const mid = snap();
    const downY = lab(["down", "--run-id", y]);
    const after = snap();
    const obs = { before, malformed, traversal, unknown, mid, downY, after };
    const pass = [malformed, traversal, unknown].every((r) => r.code !== 0) && JSON.stringify(mid) === JSON.stringify(before) &&
      downY.code === 0 && after.Y === 0 && after.X === before.X && after.X > 0 && after.sentinel === 1;
    save({ id: "BH-15", observed: obs, verdict: pass ? "PASS" : "FAIL" });
  } finally {
    await X.stop();
    await Y.stop();
    execFileSync("docker", ["rm", "-f", sentinel]);
    console.log(JSON.stringify({ leftover: { X: byLabel(x).length, Y: byLabel(y).length, sentinel: byLabel(fake).length } }));
  }
}
