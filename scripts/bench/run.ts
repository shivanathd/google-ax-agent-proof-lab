// Benchmarks (spec NFR Performance, BUILD_PLAN §4). Measures on this machine only and records every raw value with
// min/median/max; no percentiles, no inferential claims. Stages (default: all): setup, workflows, collect, runall.
//   npm run bench -- [setup] [workflows] [collect] [runall]
// Writes artifacts/bench/<timestamp>.json. Nothing here deletes images or touches the user's npm cache: "cold" uses a
// fresh empty npm_config_cache in a temp directory, and installs run in a temp copy of the manifest, not this checkout.
import { deepStrictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, arch, release, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { startRun, type RunHandle } from "../../src/config/lifecycle.ts";
import { candidateIdentity, ROOT } from "../../src/config/run-config.ts";
import { collectorConfig } from "../../src/evaluator/collect-case.ts";
import { Probe, captureTicket } from "../../src/collector/probe.ts";
import { captureApproval } from "../../src/collector/cases/f3.ts";
import { click, mention, q, requestApproval, stimulus, ws } from "../../src/collector/drive.ts";

const sh = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
export const summary = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  return { n: s.length, min: s[0] ?? null, median: s.length ? mid : null, max: s.at(-1) ?? null };
};
// Self-check: median of an even count averages the middle pair.
deepStrictEqual([summary([3, 1, 2]), summary([4, 1, 3, 2]), summary([])], [{ n: 3, min: 1, median: 2, max: 3 }, { n: 4, min: 1, median: 2.5, max: 4 }, { n: 0, min: null, median: null, max: null }]);
const ms = (t0: number) => Math.round(performance.now() - t0);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const POLL_MS = 10;
const id0 = candidateIdentity();

function fingerprint() {
  return {
    os: platform() === "darwin" ? `macOS ${sh("sw_vers", ["-productVersion"])}` : `${platform()} ${release()}`,
    arch: arch(), cpu_count: cpus().length, ram_gib: Math.round(totalmem() / 2 ** 30), node: process.version,
    npm: sh("npm", ["--version"]), docker_server: sh("docker", ["version", "--format", "{{.Server.Version}}"]),
    load_average_at_start: loadavg().map((x) => Math.round(x * 100) / 100),
    candidate: { revision: id0.revision, tree_sha: id0.tree_sha, dirty: id0.dirty, ...(id0.patch_sha256 ? { patch_sha256: id0.patch_sha256 } : {}) },
  };
}

// (i) npm ci in a temp copy of the manifest. Cold: a fresh, empty npm cache. Warm: the default cache.
function setup(reps = 3) {
  const one = (cold: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "apl-bench-ci-"));
    mkdirSync(join(dir, "scripts"));
    for (const f of ["package.json", "package-lock.json", "scripts/patch-emulate.mjs"]) copyFileSync(join(ROOT, f), join(dir, f));
    const cache = cold ? mkdtempSync(join(tmpdir(), "apl-bench-cache-")) : undefined;
    const env = { ...process.env, ...(cache ? { npm_config_cache: cache } : {}), npm_config_audit: "false", npm_config_fund: "false" };
    const t0 = performance.now();
    const r = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, env, stdio: "ignore" });
    const out = { seconds: Math.round((performance.now() - t0) / 100) / 10, exit_code: r.status };
    rmSync(dir, { recursive: true, force: true });
    if (cache) rmSync(cache, { recursive: true, force: true });
    return out;
  };
  const cold = Array.from({ length: reps }, () => one(true));
  const warm = Array.from({ length: reps }, () => one(false));
  const ok = (xs: { seconds: number; exit_code: number | null }[]) => summary(xs.filter((x) => x.exit_code === 0).map((x) => x.seconds));
  return {
    method: "npm ci in a temp copy of package.json + package-lock.json (+ postinstall patch script); cold = empty temp npm_config_cache, warm = default cache",
    cold_npm_ci: { raw: cold, summary_seconds: ok(cold) },
    warm_npm_ci: { raw: warm, summary_seconds: ok(warm) },
    image_pull: { status: "NOT_RUN", reason: "Removing the pinned Floci image could disrupt other lab runs sharing this Docker host; cold pull not measured." },
  };
}

// (ii)+(iii) One run per workflow; 5 reps each. t_callback is the worker's own receipt time of the signed callback
// (inbox.received_at for W01/W03; approval resolved_at, set when the signed block-action is processed, for W02).
// t_verified is when the collector's clients (reader Slack token, own S3 key, read-only SQLite) first see the final state.
type Rep = { rep: number; callback_to_verified_ms: number | null; post_to_verified_ms: number; verified: boolean; observe_ms: number | null };
async function withRun<T>(fn: (h: RunHandle, p: Probe) => Promise<T>) {
  const h = await startRun({ slack: true });
  const scratch = mkdtempSync(join(tmpdir(), "apl-bench-probe-"));
  const p = new Probe(collectorConfig(h, "BENCH", join(scratch, "bundle.json"), { execute: async () => {}, observe: async () => {} }), join(scratch, "evidence"));
  try {
    return { run_id: h.manifest.config.run_id, result: await fn(h, p) };
  } finally {
    p.close();
    const m = await h.stop();
    rmSync(scratch, { recursive: true, force: true });
    if (m.cleanup_status !== "CLEAN") console.error(`bench: run ${m.config.run_id} cleanup ${m.cleanup_status}`);
  }
}
async function until(check: () => Promise<boolean>, limitMs = 20000) {
  const end = Date.now() + limitMs;
  for (;;) {
    if (await check().catch(() => false)) return Date.now();
    if (Date.now() > end) return null;
    await sleep(POLL_MS);
  }
}
const timed = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  return ms(t0);
};

async function w01(h: RunHandle, p: Probe): Promise<Rep[]> {
  const out: Rep[] = [];
  for (let n = 1; n <= 5; n++) {
    const t0 = Date.now();
    const ts = await mention(h, ws(h), "dana", stimulus("W01-H", n));
    const check = async () => {
      const t = await captureTicket(p, "w01", "T_LAB_A", ts);
      return t.ticketCount() === 1 && t.receiptCount() === 1 && t.receiptMatches() && t.completionReplies().length === 1;
    };
    const tv = await until(check);
    const received = q(h, "inbox", { message_ts: ts })[0]?.received_at;
    out.push({ rep: n, callback_to_verified_ms: tv && received ? tv - Date.parse(received) : null, post_to_verified_ms: (tv ?? Date.now()) - t0, verified: tv !== null, observe_ms: tv ? await timed(check) : null });
  }
  return out;
}

async function w02(h: RunHandle, p: Probe): Promise<Rep[]> {
  const out: Rep[] = [];
  for (let n = 1; n <= 5; n++) {
    const { ts, a } = await requestApproval(h, ws(h), "dana", stimulus("W02-H", n));
    const t0 = Date.now();
    await click(ws(h), a.message_ts, "eli");
    const check = async () => {
      await captureApproval(p, a.id);
      const l = p.data("approval-ledger");
      const replies = (await p.replies("T_LAB_A", ts)).filter((m) => m.bot_id && String(m.text).includes("approved by"));
      return l.approval?.status === "approved" && l.approval.receipt_status === "committed" && l.resolve_actions.length === 1 && p.data("approval-s3").present && replies.length === 1;
    };
    const tv = await until(check);
    const resolved = q(h, "approval_requests", { id: a.id })[0]?.resolved_at;
    out.push({ rep: n, callback_to_verified_ms: tv && resolved ? tv - Date.parse(resolved) : null, post_to_verified_ms: (tv ?? Date.now()) - t0, verified: tv !== null, observe_ms: tv ? await timed(check) : null });
  }
  return out;
}

async function w03(h: RunHandle, p: Probe): Promise<Rep[]> {
  const out: Rep[] = [];
  for (let n = 1; n <= 5; n++) {
    const t0 = Date.now();
    const ts = await mention(h, ws(h), "fran", stimulus("W03-H", n));
    const check = async () => {
      const acct = p.rows("crm_accounts", { tenant_id: "T_LAB_A", account_id: "acct-northstar" })[0];
      const replies = (await p.replies("T_LAB_A", ts)).filter((m) => m.bot_id && String(m.text).includes(`version ${n} → ${n + 1}`));
      return acct?.version === n + 1 && acct.description === "Workshop follow-up requested" && replies.length === 1;
    };
    const tv = await until(check);
    const received = q(h, "inbox", { message_ts: ts })[0]?.received_at;
    out.push({ rep: n, callback_to_verified_ms: tv && received ? tv - Date.parse(received) : null, post_to_verified_ms: (tv ?? Date.now()) - t0, verified: tv !== null, observe_ms: tv ? await timed(check) : null });
  }
  return out;
}

async function workflows() {
  const res: Record<string, unknown> = {};
  for (const [name, fn] of [["W01", w01], ["W02", w02], ["W03", w03]] as const) {
    const { run_id, result } = await withRun(fn);
    const vals = (k: "callback_to_verified_ms" | "observe_ms") => result.map((r) => r[k]).filter((v): v is number => v !== null);
    res[name] = {
      run_id, raw: result, callback_to_verified_ms: summary(vals("callback_to_verified_ms")), observe_ms: summary(vals("observe_ms")),
      unverified_reps: result.filter((r) => !r.verified).map((r) => r.rep),
    };
  }
  return { method: `poll every ${POLL_MS} ms with the collector's clients; resolution is one poll plus one observation`, ...res };
}

// (iii) Full `lab collect-case F3-A1` wall clock (stack start + stimulus + collection + teardown), n=3.
function collect(reps = 3) {
  const dir = mkdtempSync(join(tmpdir(), "apl-bench-collect-"));
  const raw = Array.from({ length: reps }, (_, i) => {
    const out = join(dir, `f3a1-${i}.json`);
    const t0 = performance.now();
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli/main.ts", "collect-case", "--case", "F3-A1", "--output", out], { cwd: ROOT, stdio: "ignore" });
    const seconds = Math.round((performance.now() - t0) / 100) / 10;
    const run_id = r.status === 0 ? JSON.parse(readFileSync(out, "utf8")).run_id : null;
    return { seconds, exit_code: r.status, run_id };
  });
  rmSync(dir, { recursive: true, force: true });
  return { method: "lab collect-case --case F3-A1, whole command", raw, summary_seconds: summary(raw.filter((x) => x.exit_code === 0).map((x) => x.seconds)) };
}

// (iv) Supplied harness: evals/run-all.sh, n=1. Its verdict is recorded, not interpreted here.
function runall() {
  const t0 = performance.now();
  const r = spawnSync("bash", ["docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh"], { cwd: ROOT, encoding: "utf8" });
  return { seconds: Math.round((performance.now() - t0) / 100) / 10, exit_code: r.status, verdict: r.stdout.trim().split("\n").at(-1) ?? null };
}

const stages = process.argv.slice(2).length ? process.argv.slice(2) : ["setup", "workflows", "collect", "runall"];
const record: Record<string, unknown> = { schema_version: 1, recorded_at: new Date().toISOString(), environment: fingerprint(), stages };
if (stages.includes("setup")) record.setup = setup();
if (stages.includes("workflows")) record.workflows = await workflows();
if (stages.includes("collect")) record.collect_case = collect();
if (stages.includes("runall")) record.run_all = runall();
record.load_average_at_end = loadavg().map((x) => Math.round(x * 100) / 100);
record.note = "Single laptop, other workloads running, small n. Raw values are the result; min/median/max are descriptive only.";
mkdirSync(join(ROOT, "artifacts", "bench"), { recursive: true });
const file = join(ROOT, "artifacts", "bench", `${String(record.recorded_at).replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ output: relative(ROOT, file), stages }));
process.exit(0);
