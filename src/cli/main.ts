// Entry point: `npm run lab -- <command>`. Ambient provider credentials are stripped before anything runs.
import { Command } from "commander";
import { sanitizeProcessEnv } from "../config/env.ts";
import { registerAll } from "./registry.ts";

sanitizeProcessEnv();
const program = new Command("lab").description("Agent Proof Lab coordinator (local-first)").showHelpAfterError();
await registerAll(program);
try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`lab: ${(error as Error).message}`);
  process.exitCode = 1;
}
