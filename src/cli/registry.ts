// CLI registry: every file in ./commands exports `register(program)`. Later tasks add one file each.
import { readdirSync } from "node:fs";
import type { Command } from "commander";

export type Register = (program: Command) => void;

export async function registerAll(program: Command) {
  const dir = new URL("./commands/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const mod = (await import(new URL(file, dir).href)) as { register?: Register };
    if (typeof mod.register !== "function") throw new Error(`cli command ${file} has no register()`);
    mod.register(program);
  }
}

// Commands print one JSON document and set the exit code: 0 ok, 2 local prerequisite blocked, 1 failure.
export function emit(result: unknown, exitCode = 0) {
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitCode;
}
