// `lab seed --run-id ID`: (re)create this run's Floci queue/bucket and re-seed ledger fixtures. Idempotent.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { loadManifest } from "../../config/manifest.ts";
import { ensureRunResources, flociClients } from "../../adapters/floci/clients.ts";
import { seedLedger } from "../../ledger/seed.ts";

export function register(program: Command) {
  program
    .command("seed")
    .description("seed synthetic fixtures into a running run")
    .requiredOption("--run-id <id>", "run to seed")
    .action(async (opts: { runId: string }) => {
      const m = loadManifest(opts.runId);
      const floci = await flociClients(`http://127.0.0.1:${m.ports.floci}`, m.config.endpoint_allowlist);
      const resources = await ensureRunResources(floci, m.compose_project);
      if (m.slack_users) seedLedger(m.db_path, m.slack_users);
      emit({ run_id: m.config.run_id, floci: resources, ledger: m.slack_users ? "grants and CRM accounts seeded" : "no Slack workspaces in this run" });
    });
}
