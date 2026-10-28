// Run lifecycle owned by the coordinator: per-run Floci compose project, ports and DB file; scoped teardown.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { childEnv } from "./env.ts";
import { candidateIdentity, createRunConfig, ROOT, type Endpoint } from "./run-config.ts";
import { createManifest, freePort, loadManifest, recordResource, runDir, saveManifest, type Manifest } from "./manifest.ts";
import { ensureRunResources, flociClients } from "../adapters/floci/clients.ts";
import { loadSlackFixture, startWorkspace, type Workspace } from "../adapters/slack/emulator.ts";
import { startWorkerSlackProxy } from "../adapters/slack/worker-proxy.ts";
import { assertAllowedEndpoint } from "./endpoints.ts";
import type { FaultProxy } from "../adapters/faults/proxy.ts";
import { seedLedger } from "../ledger/seed.ts";
import { workerConfig, workerEnv, type InstallationOverride, type WorkerConfig } from "../worker/config.ts";

const run = promisify(execFile);
export const RUN_LABEL = "dev.agent-proof-lab.run-id";

export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

const composeEnv = (m: Manifest) =>
  childEnv(process.env, { FLOCI_PORT: String(m.ports.floci), APL_RUN_ID: m.config.run_id }, { docker: true });
const compose = (m: Manifest, args: string[]) =>
  run("docker", ["compose", "-f", join(ROOT, "compose.yaml"), "-p", m.compose_project, ...args], { env: composeEnv(m) });

// Emulate reports its URL as localhost, so each owned port is allowlisted under both loopback names.
export const loopback = (port: number): Endpoint[] => [
  { scheme: "http", host: "127.0.0.1", port },
  { scheme: "http", host: "localhost", port },
];

export interface WorkerOptions { overrides?: Record<string, InstallationOverride>; slack_timeout_ms?: number; approval_ttl_ms?: number; floci_endpoint?: string }
export interface RunHandle {
  manifest: Manifest;
  flociEndpoint: string;
  floci?: { queue: string; bucket: string; queueUrl: string };
  workspaces: Workspace[];
  worker?: ChildProcess;
  workerConfig?: WorkerConfig;
  slackProxies: FaultProxy[];
  startWorker: (w?: WorkerOptions) => Promise<void>;
  stopWorker: () => Promise<void>;
  stop: () => Promise<Manifest>;
}

// Allocates every port up front (so the allowlist is fixed in C1), writes the manifest, then starts
// Floci, one Emulate instance per fictional workspace and, optionally, the worker process.
export async function startRun(opts: { floci?: boolean; slack?: boolean; worker?: WorkerOptions | false; extraPorts?: string[] } = {}): Promise<RunHandle> {
  const withFloci = opts.floci ?? true;
  const fx = loadSlackFixture();
  const names = [
    ...(withFloci ? ["floci"] : []),
    ...(opts.slack ? [...fx.workspaces.flatMap((w) => [`slack_${w.installation_id}`, `slack_proxy_${w.installation_id}`]), "worker"] : []),
    ...(opts.extraPorts ?? []),
  ];
  const ports: Record<string, number> = {};
  for (const name of names) ports[name] = await freePort();
  const config = createRunConfig({ endpoint_allowlist: Object.values(ports).flatMap(loopback) });
  const manifest = createManifest(config, candidateIdentity().tree_sha);
  manifest.ports = ports;
  const allowlist = config.endpoint_allowlist;
  const h: RunHandle = {
    manifest, flociEndpoint: withFloci ? `http://127.0.0.1:${ports.floci}` : "", workspaces: [], slackProxies: [],
    startWorker: (w = {}) => startWorker(h, w),
    stopWorker: () => stopWorker(h),
    stop: async () => {
      await stopWorker(h);
      for (const ws of h.workspaces) await ws.close().catch(() => undefined);
      return stopRun(manifest.config.run_id);
    },
  };
  try {
    if (withFloci) {
      recordResource(manifest, { kind: "compose-project", id: manifest.compose_project, role: "floci" });
      await compose(manifest, ["up", "-d", "--wait"]);
      await waitHttp(h.flociEndpoint, 30000);
      h.floci = await ensureRunResources(await flociClients(h.flociEndpoint, allowlist), manifest.compose_project);
    }
    if (opts.slack) {
      for (const ws of fx.workspaces) {
        const base = `http://127.0.0.1:${ports.worker}/slack/${ws.installation_id}`;
        recordResource(manifest, { kind: "emulator", id: `slack-${ws.installation_id}@${ports[`slack_${ws.installation_id}`]}`, role: ws.tenant_id });
        h.workspaces.push(await startWorkspace(fx, ws, { port: ports[`slack_${ws.installation_id}`]!, eventsUrl: `${base}/events`, interactionsUrl: `${base}/interactions`, allowlist }));
      }
      manifest.slack_users = Object.fromEntries(h.workspaces.map((w) => [w.tenant_id, w.users]));
      saveManifest(manifest);
      seedLedger(manifest.db_path, manifest.slack_users);
      if (opts.worker !== false) await h.startWorker(opts.worker || {});
    }
  } catch (e) {
    await h.stop();
    throw e;
  }
  return h;
}

async function startWorker(h: RunHandle, w: WorkerOptions) {
  const m = h.manifest;
  // A crashed worker (S2) leaves its proxies listening; replace them rather than collide on their ports.
  await Promise.all(h.slackProxies.splice(0).map((p) => p.close()));
  // The worker knows only its Slack proxy's URL (worker-proxy.ts); emulator ports are not on its allowlist.
  const overrides: Record<string, InstallationOverride> = {};
  for (const ws of h.workspaces) {
    const own = w.overrides?.[ws.installation_id];
    const upstream = own?.api_url ?? ws.url;
    // The proxy relays without a guard, so it must never front an endpoint the run allowlist forbids
    // (F1-R2). A forbidden override goes to the worker unproxied; the worker's guard rejects it pre-network.
    if (!(await assertAllowedEndpoint(upstream, m.config.endpoint_allowlist).then(() => true, () => false))) {
      overrides[ws.installation_id] = { ...own };
      continue;
    }
    const proxy = await startWorkerSlackProxy(m.ports[`slack_proxy_${ws.installation_id}`]!, upstream);
    h.slackProxies.push(proxy);
    overrides[ws.installation_id] = { ...own, api_url: proxy.url };
  }
  const emulatorPorts = h.workspaces.map((ws) => Number(new URL(ws.url).port));
  const cfg = workerConfig(
    {
      run_id: m.config.run_id, db_path: m.db_path, http_port: m.ports.worker!, allowlist: m.config.endpoint_allowlist.filter((e) => !emulatorPorts.includes(e.port)),
      max_retries: m.config.limits.max_retries, ...(w.slack_timeout_ms ? { slack_timeout_ms: w.slack_timeout_ms } : {}),
      ...(w.approval_ttl_ms ? { approval_ttl_ms: w.approval_ttl_ms } : {}),
      ...(h.floci ? { floci: { endpoint: w.floci_endpoint ?? h.flociEndpoint, queue_url: h.floci.queueUrl, bucket: h.floci.bucket } } : {}),
    },
    h.workspaces, overrides,
  );
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/main.ts", "--run-id", m.config.run_id], {
    cwd: ROOT, env: workerEnv(cfg), stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.pipe(createWriteStream(join(runDir(m.config.run_id), "worker.log"), { flags: "a" }));
  recordResource(m, { kind: "process", id: processResourceId(child.pid!), role: "worker" });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d) => {
      out += d;
      if (out.includes('"ready":true')) resolve();
    });
    child.once("exit", (code) => reject(new Error(`worker exited ${code} before ready (see worker.log)`)));
  });
  h.worker = child;
  h.workerConfig = cfg;
}

async function stopWorker(h: RunHandle) {
  const child = h.worker;
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  h.worker = undefined;
  await Promise.all(h.slackProxies.splice(0).map((p) => p.close()));
}

export async function waitHttp(url: string, ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > end) throw new Error(`service not ready: ${new URL(url).host}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

const labelled = async (runId: string) =>
  (await run("docker", ["ps", "-aq", "--filter", `label=${RUN_LABEL}=${runId}`])).stdout.split("\n").filter(Boolean);

// A process resource id is "<pid>@<start time>", so a recycled pid is never signalled.
const startTime = (pid: number) => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
export const processResourceId = (pid: number) => `${pid}@${startTime(pid)}`;
function ownedPid(id: string): number | undefined {
  const [pid, started] = [Number(id.split("@")[0]), id.slice(id.indexOf("@") + 1)];
  return started && startTime(pid) === started ? pid : undefined;
}

// Removes only what this run's manifest owns (F1-R5); evidence under private-runs/<run_id>/ is kept.
export async function stopRun(runId: string): Promise<Manifest> {
  const m = loadManifest(runId);
  for (const r of m.config.owned_resources) {
    if (r.kind !== "process") continue;
    const pid = ownedPid(r.id);
    if (pid !== undefined && pid !== process.pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  if (m.config.owned_resources.some((r) => r.kind === "compose-project")) {
    await compose(m, ["down", "-v", "--remove-orphans", "--timeout", "5"]).catch(() => undefined);
  }
  const leftovers = await labelled(runId);
  if (leftovers.length) await run("docker", ["rm", "-f", "-v", ...leftovers]).catch(() => undefined);
  m.remaining = await labelled(runId);
  m.cleanup_status = m.remaining.length ? "INCOMPLETE" : "CLEAN";
  saveManifest(m);
  return m;
}
