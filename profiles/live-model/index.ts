// Live-model lane (F5-R5, F5-R6, C1 cost_cap/model_ref). BLOCKED until the owner approves a provider, a model
// identity and a positive budget cap. The API key comes only from the macOS Keychain at run time; this module
// never reads it from env vars, env files or chat, and doctor never reads the secret.
import { execFileSync } from "node:child_process";
import type { DoctorResult, LaneStatus, Prerequisite, ProfileAdapter } from "../../src/contracts/profile.ts";

export const KEYCHAIN_SERVICE = "agent-proof-lab/live-model";
const SECURITY = "/usr/bin/security"; // absolute path: no PATH lookup for the secret reader

export function parseBudgetCents(raw: string | undefined): number | undefined {
  return raw && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : undefined;
}

// Metadata-only lookup (no -w): confirms the item exists without reading or prompting for the secret.
function keychainItemExists(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// Called only on an authorized run, immediately before a provider request.
export function readApiKey(): string {
  return execFileSync(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", timeout: 30_000 }).trim();
}

function prerequisites(env: NodeJS.ProcessEnv): Prerequisite[] {
  return [
    {
      id: "lm.provider-approved",
      description: "APL_LIVE_MODEL_APPROVED=yes after the owner approves a model provider and its data handling",
      satisfied: env.APL_LIVE_MODEL_APPROVED === "yes",
    },
    {
      id: "lm.model-id",
      description: "APL_LIVE_MODEL_ID names the exact model identity recorded in the run report",
      satisfied: Boolean(env.APL_LIVE_MODEL_ID?.trim()),
    },
    {
      id: "lm.budget-cap",
      description: "APL_LIVE_MODEL_BUDGET_CENTS is a positive integer spend cap in cents; requests stop when it is reached",
      satisfied: parseBudgetCents(env.APL_LIVE_MODEL_BUDGET_CENTS) !== undefined,
    },
    {
      id: "lm.keychain-item",
      description: `macOS Keychain generic password with service "${KEYCHAIN_SERVICE}" (add with: security add-generic-password -s ${KEYCHAIN_SERVICE} -a lab -w)`,
      satisfied: keychainItemExists(),
    },
  ];
}

function result(status: LaneStatus, prereqs: Prerequisite[], reason: string): DoctorResult {
  return { profile: "live-model", status, prerequisites: prereqs, external_calls: 0, reason };
}

export const liveModelAdapter: ProfileAdapter = {
  name: "live-model",

  async doctor(env) {
    const prereqs = prerequisites(env);
    const missing = prereqs.filter((p) => !p.satisfied).map((p) => p.id);
    return missing.length
      ? result("BLOCKED", prereqs, `Missing prerequisites: ${missing.join(", ")}. No model request made; the scripted lane is unaffected.`)
      : result("NOT_RUN", prereqs, "Prerequisites satisfied; no live-model run recorded.");
  },

  async run(_caseId, { authorized, env }) {
    const doc = await this.doctor(env);
    if (doc.status === "BLOCKED") return doc;
    if (!authorized) return result("BLOCKED", doc.prerequisites, "Explicit operator authorization required; no model request was made and no key was read.");
    // No provider client is wired in this build, so the key is not read and nothing is sent.
    return result("NOT_RUN", doc.prerequisites,
      "Provider driver not implemented: an authorized run must read the key via readApiKey(), offer only LIVE_MODEL_TOOLS, stop at the budget cap and use the deterministic evaluator.");
  },
};

export default liveModelAdapter;
