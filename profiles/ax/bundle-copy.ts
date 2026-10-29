// MULTI_CLUSTER_BUILD §4.3 step 4: a bundle copied off the collector is checksummed at once, because
// generateReport() runs its tamper check (L-022) only when checksums.sha256 exists.
import { cpSync, existsSync, rmSync } from "node:fs";
import { artifactDir } from "../../src/reports/artifacts.ts";
import { writeChecksums } from "../../src/reports/report.ts";

export function copyBundle(src: string, runId: string): string {
  const dest = artifactDir(runId);
  if (existsSync(dest)) throw new Error(`artifact dir for run ${runId} already exists`);
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  try {
    writeChecksums(dest);
  } catch (e) {
    rmSync(dest, { recursive: true, force: true }); // never leave an unchecksummed copy behind
    throw e;
  }
  return dest;
}
