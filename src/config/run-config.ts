// C1 RunConfig: built from explicit inputs plus the candidate's git identity, then schema-validated.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContract } from "../contracts/validate.ts";
import type { ProfileName } from "../contracts/profile.ts";

export interface Endpoint { scheme: "http" | "https"; host: string; port: number }
export interface OwnedResource { kind: "compose-project" | "container" | "process" | "emulator" | "file" | "directory"; id: string; role?: string }
export interface RunConfig {
  schema_version: 1;
  run_id: string;
  profile: ProfileName;
  mode: "scripted" | "fixture-replay" | "live-model";
  seed: number;
  fixture_sha256: string;
  candidate_revision: string;
  dirty: boolean;
  patch_sha256?: string;
  tenant_id: string;
  endpoint_allowlist: Endpoint[];
  owned_resources: OwnedResource[];
  limits: { wall_clock_seconds: number; max_actions: number; max_retries: number };
  connection_ref?: string | null;
  model_ref?: string | null;
  cost_cap?: number | null;
}

// Design defaults from CONTRACTS.md C1; not performance claims.
export const DEFAULT_LIMITS = { wall_clock_seconds: 120, max_actions: 20, max_retries: 2 } as const;
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const git = (args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

export function candidateIdentity() {
  const revision = git(["rev-parse", "HEAD"]).trim();
  const tree_sha = git(["rev-parse", "HEAD^{tree}"]).trim();
  const dirty = git(["status", "--porcelain"]).trim().length > 0;
  const patch_sha256 = dirty ? sha256(git(["diff", "HEAD", "--binary"])) : undefined;
  return { revision, tree_sha, dirty, patch_sha256 };
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// Hash of every file under fixtures/ (path + content, sorted); empty set hashes the empty string.
export function fixtureSha256(dir = join(ROOT, "fixtures")): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      statSync(p).isDirectory() ? walk(p) : files.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  const h = createHash("sha256");
  for (const f of files.sort()) h.update(`${relative(dir, f)}\0`).update(readFileSync(f)).update("\0");
  return h.digest("hex");
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export function createRunConfig(input: {
  profile?: ProfileName;
  tenant_id?: string;
  seed?: number;
  endpoint_allowlist?: Endpoint[];
  run_id?: string;
}): RunConfig {
  const id = candidateIdentity();
  const config: RunConfig = {
    schema_version: 1,
    run_id: input.run_id ?? randomUUID(),
    profile: input.profile ?? "local",
    mode: "scripted",
    seed: input.seed ?? 0,
    fixture_sha256: fixtureSha256(),
    candidate_revision: id.revision,
    dirty: id.dirty,
    ...(id.patch_sha256 ? { patch_sha256: id.patch_sha256 } : {}),
    tenant_id: input.tenant_id ?? "T_LAB_A",
    endpoint_allowlist: input.endpoint_allowlist ?? [],
    owned_resources: [],
    limits: { ...DEFAULT_LIMITS },
    connection_ref: null,
  };
  return validateRunConfig(config);
}

// Schema check plus the local-profile rule that every allowlisted endpoint is loopback (F1-R2).
export function validateRunConfig(value: unknown): RunConfig {
  const config = assertContract<RunConfig>("run-config", value);
  if (config.profile === "local") {
    const bad = config.endpoint_allowlist.filter((e) => !isLoopbackHost(e.host));
    if (bad.length) throw new Error(`local profile allowlist contains ${bad.length} non-loopback endpoint(s)`);
  }
  return config;
}
