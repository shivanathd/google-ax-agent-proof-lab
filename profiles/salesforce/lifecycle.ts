// Owner-run scratch-org lifecycle for the Salesforce lane. Every command needs `--authorize` and a satisfied
// doctor. Every sf call passes --target-org/--target-dev-hub explicitly; the developer's default org is never used.
// Usage: npx tsx profiles/salesforce/lifecycle.ts create|deploy|seed|test|delete --authorize
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// private-runs/ is gitignored: org usernames and ids are real identities and stay out of commits.
export const MANIFEST = join(HERE, "../../private-runs/salesforce/scratch-manifest.json");

export interface ManifestEntry {
  alias: string;
  username: string;
  org_id: string;
  dev_hub_alias: string;
  created_at: string;
  expires_at: string; // ISO date reported by the platform
  owner: "agent-proof-lab";
  status: "active" | "deleted";
}

export interface OrgRow {
  Id: string;
  IsSandbox: boolean;
  TrialExpirationDate: string | null;
}

function readManifest(): ManifestEntry[] {
  return existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as ManifestEntry[]) : [];
}

function writeManifest(entries: ManifestEntry[]): void {
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(entries, null, 2) + "\n");
}

export function activeScratchOrg(now = new Date(), entries = readManifest()): ManifestEntry | undefined {
  return entries.find((e) => e.status === "active" && new Date(e.expires_at) > now);
}

// Deploy/seed/test guard: the target must be the org this lab created (manifest org id) AND report itself as a
// scratch org (sandbox flag with a trial expiration). A production org or a long-lived sandbox fails both checks.
export function assertOwnedScratchOrg(row: OrgRow, entry: ManifestEntry, now = new Date()): void {
  if (row.Id.slice(0, 15) !== entry.org_id.slice(0, 15)) throw new Error("Target org id does not match the manifest");
  if (row.IsSandbox !== true || !row.TrialExpirationDate) throw new Error("Target org is not a scratch org");
  if (new Date(row.TrialExpirationDate) <= now) throw new Error("Scratch org has expired");
}

function sf(args: string[]): any {
  const out = execFileSync("sf", [...args, "--json"], {
    cwd: HERE,
    encoding: "utf8",
    env: { ...process.env, SF_DISABLE_TELEMETRY: "true", SF_AUTOUPDATE_DISABLE: "true" },
  });
  return JSON.parse(out).result;
}

function orgRow(entry: ManifestEntry): OrgRow {
  const rows = sf(["data", "query", "--query", "SELECT Id, IsSandbox, TrialExpirationDate FROM Organization", "--target-org", entry.alias]).records as OrgRow[];
  if (rows.length !== 1) throw new Error("Could not read Organization row");
  return rows[0]!;
}

function guarded(entry: ManifestEntry): void {
  assertOwnedScratchOrg(orgRow(entry), entry);
}

export function runPlatformTests(entry: ManifestEntry, _env: NodeJS.ProcessEnv): { method: string; outcome: string }[] {
  guarded(entry);
  const res = sf(["apex", "run", "test", "--class-names", "AccountDescriptionResourceTest", "--target-org", entry.alias,
    "--result-format", "json", "--synchronous", "--wait", "10"]);
  return (res.tests as { MethodName: string; Outcome: string }[]).map((t) => ({ method: t.MethodName, outcome: t.Outcome }));
}

async function main(): Promise<number> {
  const [command] = process.argv.slice(2);
  const { salesforceAdapter } = await import("./index.ts");
  const doc = await salesforceAdapter.doctor(process.env);
  if (doc.status === "BLOCKED") { console.error(doc.reason); return 2; }
  if (!process.argv.includes("--authorize")) { console.error("Refusing: pass --authorize after owner approval"); return 2; }
  const entries = readManifest();
  const org = activeScratchOrg(new Date(), entries);

  if (command === "create") {
    const alias = `apl-sf-${Date.now()}`;
    const devHub = process.env.APL_SF_DEVHUB_ALIAS!;
    const created = sf(["org", "create", "scratch", "--definition-file", "config/scratch-def.json", "--alias", alias,
      "--target-dev-hub", devHub, "--duration-days", "1", "--no-track-source", "--wait", "15"]);
    // Record ownership before anything else so a failure below still leaves a cleanup handle.
    const entry: ManifestEntry = { alias, username: created.username, org_id: created.orgId, dev_hub_alias: devHub,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), owner: "agent-proof-lab", status: "active" };
    entries.push(entry);
    writeManifest(entries);
    entry.expires_at = orgRow(entry).TrialExpirationDate ?? entry.expires_at;
    writeManifest(entries);
    console.log(`Created ${alias}; expires ${entry.expires_at}; recorded in ${MANIFEST}`);
    return 0;
  }
  if (!org) { console.error("No active manifest-owned scratch org; run create first"); return 2; }
  if (command === "deploy") {
    guarded(org);
    sf(["project", "deploy", "start", "--source-dir", "force-app", "--target-org", org.alias, "--wait", "15"]);
  } else if (command === "seed") {
    guarded(org);
    sf(["data", "import", "tree", "--files", "data/Account.json", "--target-org", org.alias]);
  } else if (command === "test") {
    console.log(JSON.stringify(runPlatformTests(org, process.env), null, 2));
  } else if (command === "delete") {
    // Only orgs recorded in the manifest are ever deleted.
    sf(["org", "delete", "scratch", "--target-org", org.alias, "--no-prompt"]);
    org.status = "deleted";
    writeManifest(entries);
  } else {
    console.error("Usage: lifecycle.ts create|deploy|seed|test|delete --authorize");
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code), (err) => { console.error(String(err?.message ?? err)); process.exit(1); });
}
