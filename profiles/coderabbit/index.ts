// CodeRabbit review lane (F5-R3). A review lane, never the execution oracle. Doctor reads local configuration
// only; the adapter never installs an app, opens a PR or requests a review. Offline examples in this directory
// are ILLUSTRATIVE FIXTURES and are never reported as review results.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorResult, LaneStatus, Prerequisite, ProfileAdapter } from "../../src/contracts/profile.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function prerequisites(env: NodeJS.ProcessEnv): Prerequisite[] {
  return [
    {
      id: "cr.hosted-repo",
      description: "APL_CODERABBIT_REPO names the hosted repository (owner/name) the owner has published; the lab is currently local-only",
      satisfied: /^[\w.-]+\/[\w.-]+$/.test(env.APL_CODERABBIT_REPO ?? ""),
    },
    {
      id: "cr.app-approved",
      description: "APL_CODERABBIT_APP_APPROVED=yes after the owner installs and approves the CodeRabbit app on that repository",
      satisfied: env.APL_CODERABBIT_APP_APPROVED === "yes",
    },
    {
      id: "cr.data-disclosure",
      description: "APL_CODERABBIT_DATA_CONSENT=yes after the owner accepts that diffs are sent to a third-party reviewer",
      satisfied: env.APL_CODERABBIT_DATA_CONSENT === "yes",
    },
    {
      id: "cr.config",
      description: "Repository-root .coderabbit.yaml adopted by the owner (proposal: profiles/coderabbit/.coderabbit.yaml)",
      satisfied: existsSync(join(REPO_ROOT, ".coderabbit.yaml")),
    },
  ];
}

function result(status: LaneStatus, prereqs: Prerequisite[], reason: string): DoctorResult {
  return { profile: "coderabbit", status, prerequisites: prereqs, external_calls: 0, reason };
}

export const coderabbitAdapter: ProfileAdapter = {
  name: "coderabbit",

  async doctor(env) {
    const prereqs = prerequisites(env);
    const missing = prereqs.filter((p) => !p.satisfied).map((p) => p.id);
    return missing.length
      ? result("BLOCKED", prereqs, `Missing prerequisites: ${missing.join(", ")}. No review exists; no review score is reported.`)
      : result("NOT_RUN", prereqs, "Prerequisites satisfied; no revision-bound review artifact collected.");
  },

  async run(_caseId, { authorized, env }) {
    const doc = await this.doctor(env);
    if (doc.status === "BLOCKED") return doc;
    if (!authorized) return result("BLOCKED", doc.prerequisites, "Explicit operator authorization required; no CodeRabbit call was made.");
    // A live review is produced by the app on an owner-opened PR. This build does not open PRs or ingest reviews.
    return result("NOT_RUN", doc.prerequisites,
      "Review ingestion is not implemented: the owner opens a PR, and findings must be bound to its head commit and adjudicated before use.");
  },
};

export default coderabbitAdapter;
