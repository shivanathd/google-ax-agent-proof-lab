// `lab seed --run-id ID`: (re)create this run's namespaced Floci queue and bucket. Idempotent.
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { loadManifest } from "../../config/manifest.ts";
import { ensureRunResources, flociClients } from "../../adapters/floci/clients.ts";

export function register(program: Command) {
  program
    .command("seed")
    .description("seed synthetic fixtures into a running run")
    .requiredOption("--run-id <id>", "run to seed")
    .action(async (opts: { runId: string }) => {
      const m = loadManifest(opts.runId);
      const floci = await flociClients(`http://127.0.0.1:${m.ports.floci}`, m.config.endpoint_allowlist);
      emit({ run_id: m.config.run_id, floci: await ensureRunResources(floci, m.compose_project) });
    });
}
