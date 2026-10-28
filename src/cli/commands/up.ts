// `lab up --profile local`: start this run's isolated stack and the loopback teaching console.
// Stays in the foreground; Ctrl-C (or `lab down --run-id`) removes only this run's resources.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { startRun } from "../../config/lifecycle.ts";
import { isOptionalProfile, profileDoctor } from "../../config/profiles.ts";
import { ROOT } from "../../config/run-config.ts";
import { slackClient } from "../../adapters/slack/client.ts";
import { startConsole } from "../../console/server.ts";

const CASES = JSON.parse(readFileSync(join(ROOT, "fixtures/cases/cases.json"), "utf8"));

export function register(program: Command) {
  program
    .command("up")
    .description("start an isolated run (per-run ports, DB file and compose project) and the teaching console")
    .option("--profile <name>", "profile to start", "local")
    .action(async (opts: { profile: string }) => {
      if (opts.profile !== "local") {
        if (!isOptionalProfile(opts.profile)) return emit({ status: "FAIL", reason: `unknown profile ${opts.profile}` }, 1);
        const doctor = await profileDoctor(opts.profile, process.env);
        return emit({ ...doctor, reason: `optional profile not started by up: ${doctor.reason}` }, 2);
      }
      const handle = await startRun({ slack: true, extraPorts: ["console"] });
      const { manifest } = handle;

      const status = () => ({
        run_id: manifest.config.run_id, profile: "local", mode: manifest.config.mode,
        console: "teaching console; its scenario runs use their own isolated stacks and the independent collector",
        candidate_revision: manifest.config.candidate_revision, dirty: manifest.config.dirty,
        services: {
          floci: { endpoint: handle.flociEndpoint, ...handle.floci },
          slack: handle.workspaces.map((w) => ({ tenant_id: w.tenant_id, emulator: w.url, channel_id: w.channel_id })),
          worker: { endpoint: `http://127.0.0.1:${manifest.ports.worker}`, pid: handle.worker?.pid ?? null },
        },
      });
      const web = await startConsole({
        port: manifest.ports.console!, status,
        // Coordinator-only: post a case's scripted stimulus into THIS run as its fictional user (tokens stay here).
        extend: (app) => app.post("/api/cases/:id/run", async (req: any, reply) => {
          const c = CASES[req.params.id];
          const ws = handle.workspaces.find((w) => w.installation_id === c?.workspace);
          if (!c?.user || !c.text || !ws) return reply.code(404).send({ status: "NOT_RUN", reason: "case has no single scripted stimulus" });
          const post = slackClient({ baseUrl: ws.url, token: ws.tokens.users[c.user]!, allowlist: manifest.config.endpoint_allowlist });
          const r = await post("chat.postMessage", { channel: ws.channel_id, text: `<@${ws.bot_user_id}> ${String(c.text).replace("{n}", "1")}` });
          return { case: req.params.id, mode: "scripted", posted: r.ok, message_ts: r.ts ?? null, tenant_id: ws.tenant_id };
        }),
      });

      const shutdown = async () => {
        await web.close();
        const m = await handle.stop();
        console.error(`lab: run ${m.config.run_id} cleanup ${m.cleanup_status}`);
        process.exit(m.cleanup_status === "CLEAN" ? 0 : 1);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      emit({ run_id: manifest.config.run_id, console_url: web.url, floci: handle.flociEndpoint, manifest: `private-runs/${manifest.config.run_id}/manifest.json` });
    });
}
