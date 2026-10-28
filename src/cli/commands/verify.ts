// `lab verify --run-id ID`: recompute checksums.sha256 and every evidence hash; tampering exits 1.
import { join } from "node:path";
import type { Command } from "commander";
import { emit } from "../registry.ts";
import { artifactDir, readBundle } from "../../reports/artifacts.ts";
import { sha256File, verifyChecksums } from "../../reports/report.ts";

export function verifyRun(runId: string) {
  const dir = artifactDir(runId);
  const r = verifyChecksums(dir);
  if (r.ok) {
    for (const e of readBundle(dir).evidence ?? []) if (sha256File(join(dir, e.path)) !== e.sha256) r.problems.push(`evidence hash mismatch: ${e.path}`);
  }
  return { run_id: runId, ok: r.problems.length === 0, tampered_artifact_rejected: r.problems.length > 0, problems: r.problems };
}

export function register(program: Command) {
  program
    .command("verify")
    .description("recompute the run's artifact checksums and evidence hashes")
    .requiredOption("--run-id <id>", "run to verify")
    .action((opts: { runId: string }) => {
      const r = verifyRun(opts.runId);
      emit(r, r.ok ? 0 : 1);
    });
}
