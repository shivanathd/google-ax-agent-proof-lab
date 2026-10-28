// F5-A1 / F5-A2: optional profile gates. fetch and every child_process entry point are stubbed and counted, so a
// provider call cannot happen during these tests and any attempt is visible.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorResult, ProfileAdapter } from "../../src/contracts/profile.ts";

const state = vi.hoisted(() => ({
  spawns: [] as { cmd: string; args: string[] }[],
  configured: false, // when true, the fake `sf --version` and Keychain metadata lookup succeed
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { basename } = await import("node:path");
  const record = (file: unknown, args: unknown) => {
    const call = { cmd: basename(String(file)), args: Array.isArray(args) ? args.map(String) : [] };
    state.spawns.push(call);
    return call;
  };
  const refuse = (file: unknown, args?: unknown) => {
    record(file, args);
    throw new Error("process spawn refused in profile tests");
  };
  const execFileSync = (file: unknown, args?: unknown) => {
    const call = record(file, args);
    if (state.configured && call.cmd === "sf" && call.args.join(" ") === "--version") return "@salesforce/cli/2.99.0 darwin-arm64 node-v24\n";
    if (state.configured && call.cmd === "security" && !call.args.includes("-w")) return "";
    if (call.cmd === "security" && call.args.includes("-w")) return "fake-test-key\n";
    throw Object.assign(new Error("not available in test"), { status: 1 });
  };
  const mocked = { ...actual, execFileSync, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, fork: refuse };
  return { ...mocked, default: mocked };
});

// The CodeRabbit config prerequisite looks for a repository-root .coderabbit.yaml; F5-A2 simulates its adoption.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: Parameters<typeof actual.existsSync>[0]) =>
    state.configured && String(p).endsWith(`${sep}.coderabbit.yaml`) && !String(p).includes(`${sep}profiles${sep}`)
      ? true
      : actual.existsSync(p);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

const { salesforceAdapter, REQUIRED_PLATFORM_TESTS } = await import("../../profiles/salesforce/index.ts");
const { assertOwnedScratchOrg, activeScratchOrg, MANIFEST } = await import("../../profiles/salesforce/lifecycle.ts");
const { coderabbitAdapter } = await import("../../profiles/coderabbit/index.ts");
const { liveModelAdapter, parseBudgetCents, readApiKey, KEYCHAIN_SERVICE } = await import("../../profiles/live-model/index.ts");
const { LIVE_MODEL_TOOLS, OPERATIONS } = await import("../../profiles/live-model/tools.ts");

const AX_PATH = new URL("../../profiles/ax/index.ts", import.meta.url);
async function axLane(): Promise<ProfileAdapter | undefined> {
  if (!existsSync(AX_PATH)) return undefined;
  const mod = (await import(AX_PATH.href)) as Record<string, unknown>;
  const isAdapter = (v: unknown): v is ProfileAdapter => typeof (v as ProfileAdapter)?.doctor === "function" && (v as ProfileAdapter).name === "ax";
  return [mod.default, mod.axAdapter, ...Object.values(mod)].find(isAdapter);
}
// When another builder has not installed profiles/ax yet, the lane is reported, not silently dropped.
const axNotInstalled: DoctorResult = {
  profile: "ax", status: "BLOCKED", external_calls: 0, reason: "adapter not installed",
  prerequisites: [{ id: "ax.adapter", description: "profiles/ax/index.ts adapter not installed", satisfied: false }],
};

const PROVIDER_CLIS = new Set(["sf", "sfdx", "coderabbit", "cr", "gh", "git", "curl", "docker", "kubectl", "kind", "gcloud", "ax"]);
let fetchCalls = 0;
const emptyPath = mkdtempSync(join(tmpdir(), "apl-empty-path-"));

// No accounts, but ambient credentials and a default org are present and must be ignored.
const noAccountsEnv: NodeJS.ProcessEnv = {
  PATH: emptyPath,
  HOME: emptyPath,
  SF_TARGET_ORG: "fictional-default-org",
  SFDX_DEFAULTUSERNAME: "someone@example.invalid",
  ANTHROPIC_API_KEY: "fake-ambient-key",
  OPENAI_API_KEY: "fake-ambient-key",
  GITHUB_TOKEN: "fake-ambient-token",
};

function configuredEnv(): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), "apl-fake-sf-"));
  writeFileSync(join(bin, "sf"), "#!/bin/sh\nexit 99\n"); // never executed: child_process is stubbed
  chmodSync(join(bin, "sf"), 0o755);
  return {
    PATH: bin,
    HOME: emptyPath,
    APL_SF_DEVHUB_ALIAS: "apl-fictional-devhub",
    APL_SF_OWNER_APPROVED: "yes",
    APL_CODERABBIT_REPO: "fictional-owner/agent-proof-lab",
    APL_CODERABBIT_APP_APPROVED: "yes",
    APL_CODERABBIT_DATA_CONSENT: "yes",
    APL_LIVE_MODEL_APPROVED: "yes",
    APL_LIVE_MODEL_ID: "fictional-model-1",
    APL_LIVE_MODEL_BUDGET_CENTS: "500",
  };
}

const providerSpawns = () => state.spawns.filter((s) => PROVIDER_CLIS.has(s.cmd) && s.args.join(" ") !== "--version");
const secretReads = () => state.spawns.filter((s) => s.cmd === "security" && s.args.includes("-w"));

beforeEach(() => {
  state.spawns.length = 0;
  state.configured = false;
  fetchCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    fetchCalls++;
    throw new Error("network refused in profile tests");
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("F5-A1: no external accounts", () => {
  it("every optional doctor is BLOCKED with actionable prerequisites and creates nothing", async () => {
    const ax = await axLane();
    const results = [
      await salesforceAdapter.doctor(noAccountsEnv),
      await coderabbitAdapter.doctor(noAccountsEnv),
      await liveModelAdapter.doctor(noAccountsEnv),
      ax ? await ax.doctor(noAccountsEnv) : axNotInstalled,
    ];
    expect(results.map((r) => r.profile)).toEqual(["salesforce", "coderabbit", "live-model", "ax"]);
    expect(results.filter((r) => r.status === "BLOCKED")).toHaveLength(4); // blocked_optional_profile_count
    for (const r of results) {
      expect(r.external_calls).toBe(0);
      expect(r.prerequisites.some((p) => !p.satisfied)).toBe(true); // prerequisites_reported
      for (const p of r.prerequisites) expect(p.description.length).toBeGreaterThan(10);
      expect(r.reason).not.toMatch(/fake-ambient/);
    }
    expect(fetchCalls).toBe(0);
    expect(providerSpawns()).toEqual([]); // external_resource_create_count 0
    expect(secretReads()).toEqual([]);
    // Instrumentation is live: the Keychain metadata probe (no secret) was intercepted on macOS.
    expect(state.spawns.some((s) => s.cmd === "security")).toBe(process.platform === "darwin");
  });

  it("Salesforce reports parity UNKNOWN and ignores the developer's default org", async () => {
    const r = await salesforceAdapter.doctor(noAccountsEnv);
    expect(r.parity).toBe("UNKNOWN");
    expect(r.prerequisites.find((p) => p.id === "sf.devhub-alias")?.satisfied).toBe(false);
    expect(JSON.stringify(r)).not.toContain("fictional-default-org");
  });

  it("live-model ignores ambient API keys", async () => {
    const r = await liveModelAdapter.doctor(noAccountsEnv);
    expect(r.status).toBe("BLOCKED");
    expect(r.prerequisites.find((p) => p.id === "lm.budget-cap")?.satisfied).toBe(false);
  });
});

describe("F5-A2: configured but not authorized", () => {
  const local = { profile: "local", status: "PASS", assertions: [{ id: "W03-H", status: "PASS" }] };

  it("makes zero remote calls and preserves the local result", async () => {
    const env = configuredEnv();
    state.configured = true;
    const before = structuredClone(local);
    const lanes: ProfileAdapter[] = [salesforceAdapter, coderabbitAdapter, liveModelAdapter];

    for (const lane of lanes) expect((await lane.doctor(env)).status).toBe("NOT_RUN"); // configured
    const ax = await axLane();
    const results = await Promise.all([...lanes, ...(ax ? [ax] : [])].map((l) => l.run("W03-SF", { authorized: false, env })));

    for (const r of results) {
      expect(r.status).toBe("BLOCKED"); // authorization_rejected
      expect(r.external_calls).toBe(0);
    }
    for (const r of results.slice(0, 3)) expect(r.reason).toMatch(/authorization required/i);
    expect(fetchCalls).toBe(0); // external_call_count 0
    expect(providerSpawns()).toEqual([]);
    expect(secretReads()).toEqual([]);
    expect(local).toEqual(before); // local_result_preserved
    expect(results.every((r) => r.profile !== "local")).toBe(true);
  });

  it.skipIf(existsSync(MANIFEST))("authorized Salesforce run without a manifest-owned scratch org stays BLOCKED and provisions nothing", async () => {
    state.configured = true;
    const r = await salesforceAdapter.run("W03-SF", { authorized: true, env: configuredEnv() });
    expect(r.status).toBe("BLOCKED");
    expect(r.parity).toBe("UNKNOWN");
    expect(providerSpawns()).toEqual([]);
  });
});

describe("Salesforce scratch-org guard", () => {
  const entry = {
    alias: "apl-sf-1", username: "apl@example.invalid", org_id: "00D000000000001AAA", dev_hub_alias: "hub",
    created_at: "2026-10-28T00:00:00Z", expires_at: "2026-10-29T00:00:00Z", owner: "agent-proof-lab" as const, status: "active" as const,
  };
  const now = new Date("2026-10-28T12:00:00Z");

  it("accepts only the manifest-owned, unexpired scratch org", () => {
    expect(() => assertOwnedScratchOrg({ Id: "00D000000000001", IsSandbox: true, TrialExpirationDate: "2026-10-29" }, entry, now)).not.toThrow();
    expect(() => assertOwnedScratchOrg({ Id: "00D000000000001", IsSandbox: false, TrialExpirationDate: null }, entry, now)).toThrow(/not a scratch org/);
    expect(() => assertOwnedScratchOrg({ Id: "00D000000000001", IsSandbox: true, TrialExpirationDate: null }, entry, now)).toThrow(/not a scratch org/);
    expect(() => assertOwnedScratchOrg({ Id: "00D000000000002", IsSandbox: true, TrialExpirationDate: "2026-10-29" }, entry, now)).toThrow(/manifest/);
    expect(() => assertOwnedScratchOrg({ Id: "00D000000000001", IsSandbox: true, TrialExpirationDate: "2026-10-28" }, entry, now)).toThrow(/expired/);
  });

  it("ignores deleted or expired manifest entries", () => {
    expect(activeScratchOrg(now, [entry])).toBe(entry);
    expect(activeScratchOrg(now, [{ ...entry, status: "deleted" }])).toBeUndefined();
    expect(activeScratchOrg(new Date("2026-10-30"), [entry])).toBeUndefined();
  });

  it("platform tests cover permitted, denied and stale-version cases", () => {
    const apex = readFileSync(new URL("../../profiles/salesforce/force-app/main/default/classes/AccountDescriptionResourceTest.cls", import.meta.url), "utf8");
    for (const m of REQUIRED_PLATFORM_TESTS) expect(apex).toContain(`static void ${m}()`);
  });
});

describe("CodeRabbit fixtures", () => {
  it("are labelled ILLUSTRATIVE FIXTURE and carry no review result", () => {
    const f = JSON.parse(readFileSync(new URL("../../profiles/coderabbit/illustrative-defects.json", import.meta.url), "utf8"));
    expect(f.label).toBe("ILLUSTRATIVE FIXTURE");
    expect(f.is_review_result).toBe(false);
    expect(f.examples.length).toBeGreaterThanOrEqual(2);
    for (const e of f.examples) {
      expect(e.label).toBe("ILLUSTRATIVE FIXTURE");
      for (const k of ["score", "severity", "reviewer", "review_id", "commit"]) expect(e).not.toHaveProperty(k);
    }
  });
});

describe("live-model gates", () => {
  it("tool schema is limited to the six C3 operations and rejects unknown fields", () => {
    expect(LIVE_MODEL_TOOLS.map((t) => t.operation).sort()).toEqual([...OPERATIONS].sort());
    const ajv = new Ajv({ strict: true });
    for (const t of LIVE_MODEL_TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      const validate = ajv.compile(t.input_schema);
      expect(validate({ tenant_id: "other-tenant" })).toBe(false);
      const props = Object.keys((t.input_schema as { properties: object }).properties);
      for (const forbidden of ["tenant_id", "actor_id", "connection_ref", "authorization_decision", "policy_version"]) {
        expect(props).not.toContain(forbidden);
      }
    }
  });

  it("budget cap must be a positive integer number of cents", () => {
    for (const bad of [undefined, "", "0", "-5", "1.5", "10abc", "1e3"]) expect(parseBudgetCents(bad)).toBeUndefined();
    expect(parseBudgetCents("500")).toBe(500);
  });

  it("reads the key only from the named Keychain item via the security CLI", () => {
    expect(readApiKey()).toBe("fake-test-key");
    expect(secretReads()).toEqual([{ cmd: "security", args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"] }]);
  });
});
