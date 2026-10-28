// The worker's entire configuration, passed as one env var. It holds only the worker's own bot token and
// signing secret per installation: never the setup/simulator, reader or per-user tokens.
import { dirname, join } from "node:path";
import { childEnv } from "../config/env.ts";
import type { Endpoint } from "../config/run-config.ts";
import type { Installation } from "../http/slack.ts";
import type { Workspace } from "../adapters/slack/emulator.ts";

export interface WorkerInstallation extends Installation { api_url: string; bot_token: string }
export interface WorkerConfig {
  run_id: string;
  db_path: string;
  http_port: number;
  allowlist: Endpoint[];
  installations: WorkerInstallation[];
  slack_timeout_ms: number;
  max_retries: number;
  floci?: { endpoint: string; queue_url: string; bucket: string };
  approval_ttl_ms?: number;
}

export interface InstallationOverride { token?: "worker" | "narrow"; api_url?: string }

export function workerConfig(
  base: Omit<WorkerConfig, "installations" | "slack_timeout_ms" | "max_retries"> & Partial<Pick<WorkerConfig, "slack_timeout_ms" | "max_retries">>,
  workspaces: Workspace[],
  overrides: Record<string, InstallationOverride> = {},
): WorkerConfig {
  return {
    slack_timeout_ms: 5000, max_retries: 2, ...base,
    installations: workspaces.map((w) => ({
      installation_id: w.installation_id, tenant_id: w.tenant_id, team_id: w.team_id, api_app_id: w.api_app_id,
      bot_user_id: w.bot_user_id, signing_secret: w.signing_secret,
      api_url: overrides[w.installation_id]?.api_url ?? w.url,
      bot_token: overrides[w.installation_id]?.token === "narrow" ? w.tokens.narrow : w.tokens.worker,
    })),
  };
}

// HOME is a run-owned dir next to the ledger (created by startWorker), never the developer's.
export const workerHome = (cfg: Pick<WorkerConfig, "db_path">) => join(dirname(cfg.db_path), "worker-home");
export const workerEnv = (cfg: WorkerConfig, ambient: NodeJS.ProcessEnv = process.env) =>
  childEnv(ambient, { APL_WORKER: JSON.stringify(cfg), NODE_ENV: "production", HOME: workerHome(cfg) });
