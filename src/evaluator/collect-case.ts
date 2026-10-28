// `collect-case` coordinator: starts the case's real local stack, spawns the independent collector with its
// own credentials, drives the scripted stimulus, then writes run artifacts and the C5 report. Exit codes:
// 0 collection completed (not a test pass), 2 genuine local prerequisite blocker, 1 anything else.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { childEnv } from "../config/env.ts";
import { dockerAvailable, startRun, type RunHandle } from "../config/lifecycle.ts";
import { runDir } from "../config/manifest.ts";
import { createRunConfig, candidateIdentity, ROOT } from "../config/run-config.ts";
import { assertContract } from "../contracts/validate.ts";
import { openReadOnly, rows } from "../ledger/read.ts";
import { artifactDir, generateReport } from "../reports/artifacts.ts";
import { resourceNames } from "../adapters/floci/clients.ts";
import { CASES } from "../collector/cases/index.ts";
import type { CollectorConfig } from "../collector/probe.ts";
import type { CaseDef, CollectorInfo, Exec } from "../collector/types.ts";

// The collector's own fake Floci credentials: distinct from the worker's, never placed in the worker env.
export const COLLECTOR_AWS = { accessKeyId: "lab-collector-reader-key", secretAccessKey: "lab-collector-reader-secret" };

export function collectorConfig(h: RunHandle, caseId: string, output: string, def: CaseDef): CollectorConfig {
  const m = h.manifest;
  return {
    case_id: caseId, output, artifacts_dir: artifactDir(m.config.run_id), manifest_path: join(runDir(m.config.run_id), "manifest.json"),
    ...(h.workspaces.length ? { db_path: m.db_path } : {}),
    slack: h.workspaces.map((w) => ({ tenant_id: w.tenant_id, installation_id: w.installation_id, url: w.url, reader_token: w.tokens.reader, channel_id: w.channel_id, bot_user_id: w.bot_user_id, users: w.users })),
    ...(h.floci ? { floci: { endpoint: h.flociEndpoint, bucket: h.floci.bucket, queue_url: h.floci.queueUrl, credentials: COLLECTOR_AWS } } : {}),
    allowlist: m.config.endpoint_allowlist, mutation: process.env.APL_MUTATION || "none",
    ...(def.selected_profiles ? { selected_profiles: def.selected_profiles } : {}), needs: def.needs ?? {},
  };
}

export const collectorEnv = (cfg: CollectorConfig, ambient: NodeJS.ProcessEnv = process.env) => childEnv(ambient, { APL_COLLECTOR: JSON.stringify(cfg) });

function spawnCollector(cfg: CollectorConfig) {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/collector/main.ts"], { cwd: ROOT, env: collectorEnv(cfg), stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  const next = async () => {
    const r = await lines.next();
    if (r.done) throw new Error(`collector exited (${child.exitCode ?? "signal"}) without answering`);
    return JSON.parse(r.value) as Record<string, any>;
  };
  const ask = async (msg: object) => {
    child.stdin!.write(`${JSON.stringify(msg)}\n`);
    const r = await next();
    if (r.ok === false) throw new Error(`collector: ${r.error}`);
    return r;
  };
  return { child, next, ask };
}

// A bundle with no execution: the evaluator reports it BLOCKED, never PASS.
function writeUnexecuted(caseId: string, output: string, execution: "BLOCKED" | "NOT_RUN", reason: string) {
  const config = createRunConfig({});
  const id = candidateIdentity();
  const bundle = assertContract("observation-bundle", {
    schema_version: 1, case_id: caseId, run_id: config.run_id, profile: "local", mode: "scripted", execution, reason,
    candidate_revision: id.revision, tree_sha: id.tree_sha, dirty: id.dirty, ...(id.patch_sha256 ? { patch_sha256: id.patch_sha256 } : {}),
    fixture_sha256: config.fixture_sha256, mutation: process.env.APL_MUTATION || "none", collector: "apl-collect-case (no collector started)",
    observed_at: new Date().toISOString(), observations: {},
  });
  writeFileSync(output, `${JSON.stringify(bundle, null, 2)}\n`);
}

export async function collectCase(caseId: string, output: string): Promise<number> {
  const entry = CASES[caseId];
  if (!entry) throw new Error(`unknown case ${caseId}`);
  if (!isAbsolute(output)) throw new Error("--output must be an absolute path");
  mkdirSync(dirname(output), { recursive: true });
  if ("pending" in entry) {
    writeUnexecuted(caseId, output, "NOT_RUN", entry.pending);
    return 2;
  }
  if (!dockerAvailable()) {
    writeUnexecuted(caseId, output, "BLOCKED", "Docker daemon not reachable (local prerequisite)");
    return 2;
  }
  const def = entry;
  const started_at = new Date().toISOString();
  const h = await startRun({ floci: def.stack?.floci ?? true, slack: def.stack?.slack ?? true, extraPorts: def.stack?.extraPorts, worker: false });
  const runId = h.manifest.config.run_id;
  const scratch = mkdtempSync(join(tmpdir(), "apl-case-"));
  const faults: string[] = [];
  const refs: Record<string, unknown> = { faults };
  const collector = spawnCollector(collectorConfig(h, caseId, output, def));
  let stopped: Awaited<ReturnType<RunHandle["stop"]>> | undefined;
  try {
    const info = (await collector.next()) as CollectorInfo & { ready?: boolean };
    if (!info.ready) throw new Error("collector did not start");
    if (h.workspaces.length && def.worker !== false) await h.startWorker(def.worker?.(h, info) ?? {});
    const x: Exec = {
      h, info, scratch,
      ref: (k, v) => void (refs[k] = v),
      fault: (d) => void faults.push(d),
      snapshot: async (phase) => void (await collector.ask({ op: "snapshot", name: phase, refs })),
    };
    await def.execute(x);
    const done = await collector.ask({ op: "finish", refs });
    if (!done.done) throw new Error("collector did not finish");
  } finally {
    if (collector.child.exitCode === null) collector.child.kill("SIGKILL");
    stopped = await h.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
  writeRunArtifacts(h, caseId, started_at, stopped);
  await generateReport(runId, { cleanup_status: stopped.cleanup_status, cleanup_remaining: stopped.remaining, started_at, ended_at: new Date().toISOString() });
  return 0;
}

// Sanitized copies only: no tokens, no absolute paths, no process ids.
function writeRunArtifacts(h: RunHandle, caseId: string, started_at: string, m: Awaited<ReturnType<RunHandle["stop"]>>) {
  const dir = artifactDir(m.config.run_id);
  mkdirSync(dir, { recursive: true });
  const c = m.config;
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({
    case_id: caseId, run_id: c.run_id, profile: c.profile, mode: c.mode, seed: c.seed, fixture_sha256: c.fixture_sha256,
    candidate_revision: c.candidate_revision, tree_sha: m.tree_sha, dirty: c.dirty, ...(c.patch_sha256 ? { patch_sha256: c.patch_sha256 } : {}),
    limits: c.limits, endpoint_allowlist: c.endpoint_allowlist, owned_resources: c.owned_resources.map((r) => ({ kind: r.kind, role: r.role ?? null })),
    floci_resources: h.floci ? resourceNames(m.compose_project) : null, cleanup_status: m.cleanup_status, cleanup_remaining: m.remaining.length,
    started_at, ended_at: new Date().toISOString(),
  }, null, 2)}\n`);
  const events = existsSync(m.db_path)
    ? (() => {
        const db = openReadOnly(m.db_path);
        try {
          return rows(db, "run_audit").map((r) => JSON.stringify({ at: r.at, tenant_id: r.tenant_id, kind: r.kind, detail: JSON.parse(r.detail) }));
        } finally {
          db.close();
        }
      })()
    : [];
  writeFileSync(join(dir, "events.ndjson"), events.length ? `${events.join("\n")}\n` : "");
}
