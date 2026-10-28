// Salesforce scratch-org lane (F5-R1, F5-R2, F4-A2). Doctor reads local configuration only:
// it never reads the developer's default org (SF_TARGET_ORG, sf config) and never contacts Salesforce.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { DoctorResult, LaneStatus, Prerequisite, ProfileAdapter } from "../../src/contracts/profile.ts";
import { activeScratchOrg, runPlatformTests } from "./lifecycle.ts";

export interface SalesforceResult extends DoctorResult {
  parity: LaneStatus; // local double vs platform parity; UNKNOWN until the platform tests actually run
}

// F5-R2: permitted, denied and stale-version cases (Apex test methods in AccountDescriptionResourceTest).
export const REQUIRED_PLATFORM_TESTS = [
  "writerUpdatesWhenVersionMatches",
  "readOnlyPersonaIsDenied",
  "staleVersionConflictsWithoutOverwrite",
] as const;

export function findOnPath(cmd: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return join(dir, cmd);
    } catch {}
  }
  return undefined;
}

// Local-only version read; telemetry and update checks are disabled so the CLI makes no network request.
function sfMajorVersion(sfPath: string, env: NodeJS.ProcessEnv): number | undefined {
  try {
    const out = execFileSync(sfPath, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...env, SF_DISABLE_TELEMETRY: "true", SF_AUTOUPDATE_DISABLE: "true", SF_SKIP_NEW_VERSION_CHECK: "true" },
    });
    const m = /@salesforce\/cli\/(\d+)\./.exec(String(out));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

function prerequisites(env: NodeJS.ProcessEnv): Prerequisite[] {
  const sfPath = findOnPath("sf", env);
  const major = sfPath ? sfMajorVersion(sfPath, env) : undefined;
  return [
    {
      id: "sf.cli",
      description: "Salesforce CLI `sf` v2 or later on PATH (install @salesforce/cli; doctor only runs `sf --version`)",
      satisfied: major !== undefined && major >= 2,
    },
    {
      id: "sf.devhub-alias",
      description: "APL_SF_DEVHUB_ALIAS names an owner-authorized Dev Hub alias (`sf org login web --set-default-dev-hub` is NOT used; the alias is passed explicitly)",
      satisfied: Boolean(env.APL_SF_DEVHUB_ALIAS?.trim()),
    },
    {
      id: "sf.owner-approval",
      description: "APL_SF_OWNER_APPROVED=yes records that the owner approved scratch-org creation with synthetic data for this lab",
      satisfied: env.APL_SF_OWNER_APPROVED === "yes",
    },
  ];
}

function result(status: LaneStatus, prereqs: Prerequisite[], reason: string, parity: LaneStatus = "UNKNOWN"): SalesforceResult {
  return { profile: "salesforce", status, prerequisites: prereqs, external_calls: 0, reason, parity };
}

function missing(prereqs: Prerequisite[]): string {
  return prereqs.filter((p) => !p.satisfied).map((p) => p.id).join(", ");
}

export const salesforceAdapter = {
  name: "salesforce" as const,

  async doctor(env: NodeJS.ProcessEnv): Promise<SalesforceResult> {
    const prereqs = prerequisites(env);
    if (prereqs.some((p) => !p.satisfied)) {
      return result("BLOCKED", prereqs, `Missing prerequisites: ${missing(prereqs)}. Platform tests not run; parity UNKNOWN.`);
    }
    return result("NOT_RUN", prereqs, "Prerequisites satisfied; platform tests not run; parity UNKNOWN.");
  },

  async run(caseId: string, { authorized, env }: { authorized: boolean; env: NodeJS.ProcessEnv }): Promise<SalesforceResult> {
    const doc = await salesforceAdapter.doctor(env);
    if (doc.status === "BLOCKED") return doc;
    if (!authorized) {
      return result("BLOCKED", doc.prerequisites, "Explicit operator authorization required; no Salesforce call was made. Parity UNKNOWN.");
    }
    if (caseId !== "W03-SF") return result("BLOCKED", doc.prerequisites, `Unknown Salesforce case: ${caseId}`);
    // Creation is a separate owner step (`lifecycle.ts create --authorize`); run never provisions an org.
    const org = activeScratchOrg();
    if (!org) {
      return result("BLOCKED", doc.prerequisites, "No unexpired manifest-owned scratch org; run `npx tsx profiles/salesforce/lifecycle.ts create --authorize` first.");
    }
    let outcomes: { method: string; outcome: string }[];
    try {
      outcomes = runPlatformTests(org, env);
    } catch (err) {
      return { ...result("UNKNOWN", doc.prerequisites,
        `Platform state unreadable (${(err as Error).message}); lane stopped. Cleanup: scratch org ${org.alias} stays recorded in the manifest until lifecycle.ts delete.`), external_calls: 1 };
    }
    const passed = new Set(outcomes.filter((o) => o.outcome === "Pass").map((o) => o.method));
    const ok = REQUIRED_PLATFORM_TESTS.every((m) => passed.has(m)) && outcomes.every((o) => o.outcome === "Pass");
    // Parity with the local double is decided by the report generator, which sees both lanes.
    return {
      ...result(ok ? "PASS" : "FAIL", doc.prerequisites,
        `Platform Apex tests on ${org.alias}: ${outcomes.map((o) => `${o.method}=${o.outcome}`).join(", ")}`),
      external_calls: 2, // Organization guard query + Apex test run
    };
  },
} satisfies ProfileAdapter;

export default salesforceAdapter;
