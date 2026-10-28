// Independent collector process (F4-R1, ADR-7). Spawned by `collect-case` with its own env: reader-only Slack
// tokens, its own S3/SQS credentials, the run's ledger path (opened read-only). It never receives the worker,
// setup/simulator or user tokens. Line protocol: prints {"ready":...}; reads {"op":"snapshot"|"finish"} lines.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { ROOT } from "../config/run-config.ts";
import { assertContract } from "../contracts/validate.ts";
import { Probe, sha256, type CollectorConfig } from "./probe.ts";
import { CASES } from "./cases/index.ts";
import type { CaseDef } from "./types.ts";

const cfg = JSON.parse(process.env.APL_COLLECTOR ?? "null") as CollectorConfig | null;
if (!cfg) {
  console.error("collector: APL_COLLECTOR missing");
  process.exit(1);
}
const def = CASES[cfg.case_id] as CaseDef;
const p = new Probe(cfg, join(dirname(cfg.output), "evidence"));
const send = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

// Loopback sinkhole owned by the collector: anything that reaches it is an outbound request (F1-A2, F5).
if (cfg.needs?.sinkhole) {
  const hits: { method: string; url: string; at: string }[] = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? "?", url: (req.url ?? "").split("?")[0]!, at: new Date().toISOString() });
    res.writeHead(503).end();
  });
  server.on("connect", (req, socket) => {
    hits.push({ method: "CONNECT", url: req.url ?? "", at: new Date().toISOString() });
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  p.sinkhole = { port: (server.address() as { port: number }).port, hits };
  server.unref();
}

// PATH shims for provider CLIs: every invocation is appended to a collector-owned log (F5). Only
// `sf --version` answers, so a configured-looking lane can reach its authorization gate.
const SHIMS = ["sf", "sfdx", "gh", "coderabbit", "cr", "gcloud", "kubectl", "kind", "ax", "curl", "wget"];
if (cfg.needs?.shims) {
  const dir = mkdtempSync(join(tmpdir(), "apl-shims-"));
  const log = join(dir, "invocations.log");
  writeFileSync(log, "");
  for (const name of SHIMS) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\n` +
      (name === "sf" ? `[ "$*" = "--version" ] && { echo "@salesforce/cli/2.99.0 collector-shim (fictional)"; exit 0; }\n` : "") + "exit 1\n");
    chmodSync(file, 0o755);
  }
  p.shims = { dir, log };
}

send({ ready: true, sinkhole_port: p.sinkhole?.port, shim_dir: p.shims?.dir });

// The pinned Floci image (ref@digest) this run's compose project starts; compose.yaml carries the same pin.
const flociImage = () => {
  const i = JSON.parse(readFileSync(join(ROOT, "DEPENDENCIES.lock.json"), "utf8")).images.floci;
  return `${i.ref}@${i.digest}`;
};

function writeBundle() {
  const m = JSON.parse(readFileSync(cfg!.manifest_path, "utf8"));
  const c = m.config;
  const bundle = assertContract("observation-bundle", {
    schema_version: 1, case_id: cfg!.case_id, run_id: c.run_id, profile: c.profile, mode: c.mode, execution: "EXECUTED",
    candidate_revision: c.candidate_revision, tree_sha: m.tree_sha, dirty: c.dirty, ...(c.patch_sha256 ? { patch_sha256: c.patch_sha256 } : {}),
    fixture_sha256: c.fixture_sha256, dependencies_sha256: sha256(readFileSync(join(ROOT, "package-lock.json"), "utf8")), seed: c.seed,
    ...(cfg!.floci ? { floci_image: flociImage() } : {}),
    mutation: cfg!.mutation, collector: `apl-collector pid=${process.pid} (separate process; reader token, own S3/SQS client, read-only SQLite)`,
    collector_methods: [...p.methods].sort(), observed_at: new Date().toISOString(),
    ...(cfg!.selected_profiles ? { selected_profiles: cfg!.selected_profiles } : {}),
    simulated_faults: (p.refs.faults as string[] | undefined) ?? [],
    observations: p.observations, unobserved: p.unobserved, evidence: p.evidence,
  });
  const body = `${JSON.stringify(bundle, null, 2)}\n`;
  writeFileSync(cfg!.output, body);
  mkdirSync(join(cfg!.artifacts_dir, "evidence"), { recursive: true });
  writeFileSync(join(cfg!.artifacts_dir, "observations.json"), body);
  for (const e of p.evidence) copyFileSync(join(dirname(cfg!.output), e.path), join(cfg!.artifacts_dir, e.path));
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line) as { op: "snapshot" | "finish"; name?: string; refs: Record<string, unknown> };
  p.refs = msg.refs ?? {};
  try {
    if (msg.op === "snapshot") {
      const phase = def.phases?.[msg.name ?? ""];
      if (!phase) throw new Error(`unknown phase ${msg.name}`);
      await phase(p);
      send({ ok: true, phase: msg.name });
    } else {
      await def.observe(p);
      writeBundle();
      p.close();
      send({ done: true, observed: Object.keys(p.observations).length, unobserved: Object.keys(p.unobserved) });
      process.exit(0);
    }
  } catch (e) {
    send({ ok: false, error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300) });
    process.exit(1);
  }
}
