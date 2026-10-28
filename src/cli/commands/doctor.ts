// `lab doctor [--profile name...]`: local prerequisites (no network) plus optional-lane status.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { dockerAvailable } from "../../config/lifecycle.ts";
import { laneStatuses } from "../../config/profiles.ts";
import { ROOT } from "../../config/run-config.ts";
import type { Prerequisite, ProfileName } from "../../contracts/profile.ts";

const check = (fn: () => boolean) => {
  try {
    return fn();
  } catch {
    return false;
  }
};

export function localPrerequisites(): Prerequisite[] {
  const lock = JSON.parse(readFileSync(join(ROOT, "DEPENDENCIES.lock.json"), "utf8"));
  const image = `${lock.images.floci.ref}@${lock.images.floci.digest}`;
  const docker = dockerAvailable();
  return [
    { id: "local.node", description: "Node.js 24.x", satisfied: process.versions.node.startsWith("24.") },
    { id: "local.docker", description: "Docker daemon reachable (docker info)", satisfied: docker },
    { id: "local.floci-image", description: `pinned image ${lock.images.floci.ref} present locally (docker pull it once)`,
      satisfied: docker && check(() => (execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }), true)) },
    { id: "local.emulate-patch", description: "npm install applied scripts/patch-emulate.mjs",
      satisfied: check(() => readFileSync(join(ROOT, "node_modules/emulate/dist/dist-B5YXZCS3.js"), "utf8").includes("agent-proof-lab:event_subscriptions")) },
    { id: "local.sqlite", description: "better-sqlite3 native module loads",
      satisfied: check(() => (execFileSync(process.execPath, ["-e", "new (require('better-sqlite3'))(':memory:')"], { cwd: ROOT, stdio: "ignore" }), true)) },
  ];
}

export function register(program: Command) {
  program
    .command("doctor")
    .description("check local prerequisites and optional profile lanes; makes no external calls")
    .option("--profile <names...>", "optional profiles to select", [])
    .action(async (opts: { profile: ProfileName[] }) => {
      const prerequisites = localPrerequisites();
      const ok = prerequisites.every((p) => p.satisfied);
      const lanes = await laneStatuses(opts.profile, process.env);
      emit({ profile: "local", status: ok ? "NOT_RUN" : "BLOCKED", prerequisites, lanes, external_calls: 0 }, ok ? 0 : 2);
    });
}
