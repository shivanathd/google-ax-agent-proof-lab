// Optional-lane status (F1-R6, F5-R6): unselected → SKIPPED; selected without a ready adapter → BLOCKED.
// Adapters live in profiles/<name>/index.ts and export `adapter: ProfileAdapter`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./run-config.ts";
import type { DoctorResult, ProfileAdapter, ProfileName } from "../contracts/profile.ts";

export const OPTIONAL_PROFILES = ["salesforce", "coderabbit", "ax", "live-model"] as const;
export type OptionalProfile = (typeof OPTIONAL_PROFILES)[number];

export function isOptionalProfile(name: string): name is OptionalProfile {
  return (OPTIONAL_PROFILES as readonly string[]).includes(name);
}

export async function loadAdapter(name: OptionalProfile, root = ROOT): Promise<ProfileAdapter | undefined> {
  const file = join(root, "profiles", name, "index.ts");
  if (!existsSync(file)) return undefined;
  return (await import(pathToFileURL(file).href)).adapter as ProfileAdapter | undefined;
}

const notInstalled = (profile: OptionalProfile): DoctorResult => ({
  profile, status: "BLOCKED", external_calls: 0, reason: "adapter not installed",
  prerequisites: [{ id: `${profile}.adapter`, description: `profiles/${profile}/index.ts exporting a ProfileAdapter`, satisfied: false }],
});

// A doctor result never claims more than its prerequisites support, and doctor alone is never PASS.
function normalize(r: DoctorResult): DoctorResult {
  if (r.prerequisites.some((p) => !p.satisfied)) return { ...r, status: "BLOCKED" };
  if (r.status === "PASS") return { ...r, status: "NOT_RUN", reason: "prerequisites satisfied; nothing executed by doctor" };
  return r;
}

export async function profileDoctor(name: OptionalProfile, env: NodeJS.ProcessEnv, load = loadAdapter): Promise<DoctorResult> {
  const adapter = await load(name);
  return adapter ? normalize(await adapter.doctor(env)) : notInstalled(name);
}

export async function profileRun(name: OptionalProfile, caseId: string, opts: { authorized: boolean; env: NodeJS.ProcessEnv }, load = loadAdapter) {
  const adapter = await load(name);
  if (!adapter) return notInstalled(name);
  const doctor = normalize(await adapter.doctor(opts.env));
  if (doctor.status !== "NOT_RUN") return doctor; // never call run() with unmet prerequisites
  return adapter.run(caseId, opts);
}

export async function laneStatuses(selected: ProfileName[], env: NodeJS.ProcessEnv, load = loadAdapter) {
  const out: Record<string, DoctorResult> = {};
  for (const name of OPTIONAL_PROFILES) {
    out[name] = selected.includes(name)
      ? await profileDoctor(name, env, load)
      : { profile: name, status: "SKIPPED", prerequisites: [], external_calls: 0, reason: "not selected" };
  }
  return out;
}
