// `lab up --profile local`: start this run's isolated stack and a loopback console status endpoint.
// Stays in the foreground; Ctrl-C (or `lab down --run-id`) removes only this run's resources.
import Fastify from "fastify";
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { processResourceId, startRun, stopRun } from "../../config/lifecycle.ts";
import { recordResource } from "../../config/manifest.ts";
import { isOptionalProfile, profileDoctor } from "../../config/profiles.ts";
import { ensureRunResources, flociClients } from "../../adapters/floci/clients.ts";

export function register(program: Command) {
  program
    .command("up")
    .description("start an isolated run (per-run ports, DB file and compose project)")
    .option("--profile <name>", "profile to start", "local")
    .action(async (opts: { profile: string }) => {
      if (opts.profile !== "local") {
        if (!isOptionalProfile(opts.profile)) return emit({ status: "FAIL", reason: `unknown profile ${opts.profile}` }, 1);
        const doctor = await profileDoctor(opts.profile, process.env);
        return emit({ ...doctor, reason: `optional profile not started by up: ${doctor.reason}` }, 2);
      }
      const handle = await startRun({ extraPorts: ["console"] });
      const { manifest } = handle;
      recordResource(manifest, { kind: "process", id: processResourceId(process.pid), role: "coordinator" });
      const floci = await flociClients(handle.flociEndpoint, manifest.config.endpoint_allowlist);
      const resources = await ensureRunResources(floci, manifest.compose_project);

      const consoleUrl = `http://127.0.0.1:${manifest.ports.console}/`;
      const app = Fastify();
      const status = () => ({
        run_id: manifest.config.run_id, profile: "local", mode: manifest.config.mode, console: "placeholder",
        candidate_revision: manifest.config.candidate_revision, dirty: manifest.config.dirty,
        services: { floci: { endpoint: handle.flociEndpoint, ...resources } },
      });
      app.get("/", async () => status());
      app.get("/api/status", async () => status());
      await app.listen({ host: "127.0.0.1", port: manifest.ports.console! });

      const shutdown = async () => {
        await app.close();
        const m = await stopRun(manifest.config.run_id);
        console.error(`lab: run ${m.config.run_id} cleanup ${m.cleanup_status}`);
        process.exit(m.cleanup_status === "CLEAN" ? 0 : 1);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      emit({ run_id: manifest.config.run_id, console_url: consoleUrl, floci: handle.flociEndpoint, manifest: `private-runs/${manifest.config.run_id}/manifest.json` });
    });
}
