// Run lifecycle owned by the coordinator: per-run Floci compose project, ports and DB file; scoped teardown.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { childEnv } from "./env.ts";
import { candidateIdentity, createRunConfig, ROOT, type Endpoint } from "./run-config.ts";
import { createManifest, freePort, loadManifest, recordResource, saveManifest, type Manifest } from "./manifest.ts";

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

export const loopback = (port: number): Endpoint => ({ scheme: "http", host: "127.0.0.1", port });

export interface RunHandle { manifest: Manifest; flociEndpoint: string }

// Allocates ports, writes the manifest, then starts Floci. Callers extend the handle with Slack/worker.
export async function startRun(opts: { extraPorts?: string[] } = {}): Promise<RunHandle> {
  const ports: Record<string, number> = { floci: await freePort() };
  for (const name of opts.extraPorts ?? []) ports[name] = await freePort();
  const config = createRunConfig({ endpoint_allowlist: Object.values(ports).map(loopback) });
  const manifest = createManifest(config, candidateIdentity().tree_sha);
  manifest.ports = ports;
  recordResource(manifest, { kind: "compose-project", id: manifest.compose_project, role: "floci" });
  await compose(manifest, ["up", "-d", "--wait"]);
  const flociEndpoint = `http://127.0.0.1:${ports.floci}`;
  await waitHttp(flociEndpoint, 30000);
  return { manifest, flociEndpoint };
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
