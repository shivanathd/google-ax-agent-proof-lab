// Owned-resource manifest under private-runs/<run_id>/ (gitignored). Resources are recorded before they
// are created, so an interrupted setup can still be cleaned up from the manifest.
import { createServer, type AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type OwnedResource, type RunConfig } from "./run-config.ts";

export interface Manifest {
  config: RunConfig;
  tree_sha: string;
  compose_project: string;
  ports: Record<string, number>;
  db_path: string;
  slack_users?: Record<string, Record<string, string>>; // tenant -> user name -> generated id (not secret)
  cleanup_status: "NOT_RUN" | "CLEAN" | "INCOMPLETE" | "RETAINED_BY_REQUEST";
  remaining: string[];
  created_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const runsDir = () => process.env.APL_RUNS_DIR ?? join(ROOT, "private-runs");
export function runDir(runId: string) {
  if (!UUID.test(runId)) throw new Error("run id must be a UUID");
  return join(runsDir(), runId);
}
// Validated shortened id used for docker compose project and emulator names.
export const composeProject = (runId: string) => `apl-${runId.replace(/-/g, "").slice(0, 12)}`;

export function createManifest(config: RunConfig, tree_sha: string): Manifest {
  const dir = runDir(config.run_id);
  mkdirSync(dir, { recursive: true });
  const m: Manifest = {
    config, tree_sha, compose_project: composeProject(config.run_id), ports: {},
    db_path: join(dir, "ledger.db"), cleanup_status: "NOT_RUN", remaining: [], created_at: new Date().toISOString(),
  };
  m.config.owned_resources.push({ kind: "directory", id: dir, role: "evidence" });
  saveManifest(m);
  return m;
}

export const saveManifest = (m: Manifest) => writeFileSync(join(runDir(m.config.run_id), "manifest.json"), JSON.stringify(m, null, 2));
export function loadManifest(runId: string): Manifest {
  const file = join(runDir(runId), "manifest.json");
  if (!existsSync(file)) throw new Error(`no manifest for run ${runId}`);
  return JSON.parse(readFileSync(file, "utf8"));
}
export function recordResource(m: Manifest, r: OwnedResource) {
  m.config.owned_resources.push(r);
  saveManifest(m);
}
export const appendAudit = (runId: string, rec: object) =>
  appendFileSync(join(runDir(runId), "audit.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), run_id: runId, ...rec })}\n`);

// Per-run loopback port. A port taken between allocation and bind makes startup fail; we never evict.
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
