// Teaching console (F6-R1, Task 6.1): a loopback Fastify app serving the Vite build in web/ plus read-only
// APIs. "Run scenario" executes one case through the same collect-case path the evaluator uses — an
// isolated stack, the independent collector and a C5 report — so the console only displays what the
// report and the emulator state say. The console never grades a run itself.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, relative } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { build } from "vite";
import { collectCase } from "../evaluator/collect-case.ts";
import { OPTIONAL_PROFILES, laneStatuses } from "../config/profiles.ts";
import { runDir } from "../config/manifest.ts";
import { candidateIdentity, ROOT } from "../config/run-config.ts";
import { artifactDir } from "../reports/artifacts.ts";
import { SCENARIOS, scenario } from "../reports/scenarios.ts";
import { readState, readTranscript, type StateSnapshot, type Transcript } from "./live.ts";
import type { RunHandle } from "../config/lifecycle.ts";

const WEB = join(ROOT, "web");
const DIST = join(WEB, "dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export async function buildWeb() {
  await build({ root: WEB, logLevel: "warn", build: { outDir: DIST, emptyOutDir: true } });
}

type Phase = "starting" | "running" | "collecting" | "stopping" | "reported" | "error";
export interface Job {
  job_id: number; scenario: string; phase: Phase; phases: { phase: string; at: string }[]; run_id: string | null;
  transcript: Transcript | null; before: StateSnapshot | null; after: StateSnapshot | null; error: string | null;
}

const jobs: Job[] = [];

// Persisted per run under private-runs/<run_id>/ (gitignored) so a finished run can be reopened.
const consoleFile = (runId: string) => join(runDir(runId), "console-view.json");

async function runScenario(job: Job) {
  const set = (phase: Phase) => {
    job.phase = phase;
    job.phases.push({ phase, at: new Date().toISOString() });
  };
  let live: RunHandle | undefined;
  let polling = true;
  const poll = async () => {
    while (polling) {
      if (live) job.transcript = await readTranscript(live).catch(() => job.transcript);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const poller = poll();
  try {
    const out = join(mkdtempSync(join(tmpdir(), "apl-console-")), "observations.json");
    const code = await collectCase(job.scenario, out, {
      onStarted: async (h) => {
        job.run_id = h.manifest.config.run_id;
        job.before = await readState(h, "before stimulus");
        live = h;
      },
      onPhase: (p) => void (p !== "reported" && set(p)), // "reported" is set below, once the view is stored
      // A case's own "before" snapshot (e.g. W01-D: after the first result, before the retry) is the better baseline.
      onSnapshot: async (phase, h) => {
        if (phase !== "before") return;
        job.before = await readState(h, "before the challenged step");
        job.phases.push({ phase: "before snapshot", at: new Date().toISOString() });
      },
      beforeStop: async (h) => {
        polling = false;
        job.transcript = await readTranscript(h);
        job.after = await readState(h, "after collection");
        live = undefined;
      },
    });
    if (code !== 0) throw new Error(`collect-case exited ${code} (prerequisite blocked)`);
    if (!job.run_id) throw new Error("run id missing");
    writeFileSync(consoleFile(job.run_id), `${JSON.stringify({ ...job, phase: "reported" }, null, 2)}\n`);
    set("reported");
  } catch (e) {
    job.error = String((e as Error).message).slice(0, 300);
    set("error");
  } finally {
    polling = false;
    await poller;
  }
}

// The C5 report exactly as written by the report generator; the console adds nothing to it.
function reportFor(runId: string) {
  const file = join(artifactDir(runId), "report.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export interface ConsoleOptions { port?: number; status?: () => unknown; extend?: (app: FastifyInstance) => void }

export async function startConsole(o: ConsoleOptions = {}) {
  await buildWeb();
  const app = Fastify();
  const identity = candidateIdentity();

  app.get("/api/console", async () => ({
    app: { name: "Agent Proof Lab", candidate_revision: identity.revision, tree_sha: identity.tree_sha, dirty: identity.dirty, profile: "local", mode: "scripted" },
    synthetic_notice: "Synthetic data only: fictional workspaces, people, companies and records. Local emulators; no real Slack, cloud or CRM account.",
    scenarios: SCENARIOS,
    // Doctor results (local configuration only, zero external calls); never upgraded by the console.
    profiles: Object.values(await laneStatuses([...OPTIONAL_PROFILES], process.env)).map((d) => ({
      profile: d.profile, status: d.status, reason: d.reason, external_calls: d.external_calls,
      prerequisites: d.prerequisites.map((p) => ({ id: p.id, description: p.description, satisfied: p.satisfied })),
      ...(d.profile === "salesforce" ? { parity: "UNKNOWN" } : {}),
    })),
  }));
  app.post("/api/scenarios/:id/run", async (req: any, reply) => {
    const s = scenario(req.params.id);
    if (!s) return reply.code(404).send({ error: "unknown scenario" });
    if (jobs.some((j) => !["reported", "error"].includes(j.phase))) return reply.code(409).send({ error: "a scenario is already running" });
    const job: Job = { job_id: jobs.length + 1, scenario: s.id, phase: "starting", phases: [{ phase: "starting", at: new Date().toISOString() }], run_id: null, transcript: null, before: null, after: null, error: null };
    jobs.push(job);
    void runScenario(job);
    return { job_id: job.job_id };
  });
  app.get("/api/jobs/:id", async (req: any, reply) => {
    const j = jobs[Number(req.params.id) - 1];
    return j ? { ...j, report: j.phase === "reported" && j.run_id ? reportFor(j.run_id) : null } : reply.code(404).send({ error: "unknown job" });
  });
  // Reopen a finished run (deep link ?run=<id>): stored console view + its C5 report.
  app.get("/api/runs/:id", async (req: any, reply) => {
    let view: Job | null = null;
    try {
      view = existsSync(consoleFile(req.params.id)) ? JSON.parse(readFileSync(consoleFile(req.params.id), "utf8")) : null;
    } catch {
      return reply.code(400).send({ error: "invalid run id" });
    }
    const report = reportFor(req.params.id);
    return view && report ? { ...view, report } : reply.code(404).send({ error: "unknown run" });
  });
  if (o.status) app.get("/api/status", async () => o.status!());
  o.extend?.(app);

  app.get("/*", async (req, reply) => {
    const path = decodeURIComponent((req.params as any)["*"] || "index.html");
    const file = normalize(join(DIST, path));
    if (relative(DIST, file).startsWith("..") || !existsSync(file)) return reply.code(404).send({ error: "not found" });
    return reply.type(TYPES[extname(file)] ?? "application/octet-stream").send(readFileSync(file));
  });
  await app.listen({ host: "127.0.0.1", port: o.port ?? 0 });
  const port = (app.server.address() as { port: number }).port;
  return { app, url: `http://127.0.0.1:${port}/`, close: () => app.close() };
}
