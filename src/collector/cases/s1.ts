// S1 fresh clone (public challenge, not a secret holdout): clone this repository by local path, `npm ci`
// offline from the warm cache, then run the clone's own W01 collection while a second run (this case's
// stack) processes its own W01 concurrently. Limitation: needs a warm npm cache and the pre-pulled image.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { AMBIENT_CREDENTIAL, childEnv, FAKE_AWS } from "../../config/env.ts";
import { isLoopbackHost, ROOT } from "../../config/run-config.ts";
import { openReadOnly } from "../../ledger/read.ts";
import { sha256, type Probe } from "../probe.ts";
import { lab, mention, stimulus, ticketDone, ws } from "../drive.ts";
import type { CaseDef } from "../types.ts";

const run = promisify(execFile);
const MARKER = "concurrent run B";
const seconds = (t0: number) => Math.round((performance.now() - t0) / 100) / 10;

export const S1: CaseDef = {
  async execute({ h, scratch, ref }) {
    const clone = join(scratch, "clone");
    const env = childEnv(process.env, {}, { docker: true });
    const t0 = performance.now();
    const steps: Record<string, { ok: boolean; seconds: number }> = {};
    const step = async (name: string, fn: () => Promise<unknown>) => {
      const t = performance.now();
      try {
        await fn();
        steps[name] = { ok: true, seconds: seconds(t) };
      } catch {
        steps[name] = { ok: false, seconds: seconds(t) };
        throw new Error(`fresh clone step failed: ${name}`);
      }
    };
    try {
      await step("git_clone", () => run("git", ["clone", "--quiet", "--no-local", ROOT, clone], { env }));
      // Offline: only the existing npm cache may satisfy the install (no registry access).
      await step("npm_ci", () => run("npm", ["ci", "--offline", "--no-audit", "--no-fund"], { cwd: clone, env, maxBuffer: 1 << 24 }));
      const inner = join(clone, ".apl-s1", "observations.json");
      // Run B (this case's stack) works on its own W01 while the clone's run is live.
      const b = (async () => {
        const ts = await mention(h, ws(h), "dana", `${stimulus("W01-H")} ${MARKER}`);
        await ticketDone(h, ts, 90000);
        return ts;
      })();
      let innerCode = -1;
      await step("clone_collect_case", async () => {
        innerCode = (await lab(["collect-case", "--case", "F3-A1", "--output", inner], env, clone)).code;
        if (innerCode !== 0) throw new Error(`clone collect-case exited ${innerCode}`);
      });
      ref("b_ts", await b);
      ref("inner", { clone, bundle: inner, exit_code: innerCode });
    } finally {
      ref("steps", { ...steps, total_seconds: seconds(t0), timeout_seconds: Number(process.env.EVAL_CASE_TIMEOUT_SECONDS ?? 180) });
      ref("env_keys", Object.keys(env).sort());
    }
  },
  async observe(p) {
    const { inner, steps, env_keys, b_ts } = p.refs;
    await p.capture("fresh-clone", "git clone + npm ci --offline + clone collect-case (child processes, durations)", () => steps);
    await p.capture("inner-bundle", "clone's C4 bundle with evidence hashes re-verified by this collector", () => {
      const dir = join(inner.clone, ".apl-s1");
      const bundle = JSON.parse(readFileSync(inner.bundle, "utf8"));
      const verified = bundle.evidence.map((e: any) => ({ path: e.path, ok: !e.path.includes("..") && existsSync(join(dir, e.path)) && sha256(readFileSync(join(dir, e.path), "utf8")) === e.sha256 }));
      return { run_id: bundle.run_id, tree_sha: bundle.tree_sha, execution: bundle.execution, collector: bundle.collector, observations: bundle.observations, unobserved: bundle.unobserved, evidence_verified: verified };
    });
    const innerDb = () => join(inner.clone, "private-runs", p.data("inner-bundle").run_id, "ledger.db");
    const innerManifest = () => JSON.parse(readFileSync(join(inner.clone, "private-runs", p.data("inner-bundle").run_id, "manifest.json"), "utf8")).config;
    await p.capture("clone-config-scan", "env key names given to the clone + clone run manifest (names and hosts only)", () => {
      const c = innerManifest();
      return {
        env_keys, declared_fake: Object.keys(FAKE_AWS),
        credential_like: env_keys.filter((k: string) => (AMBIENT_CREDENTIAL.test(k) || /TOKEN|SECRET|PASSWORD|API_KEY/i.test(k)) && !(k in FAKE_AWS)),
        connection_ref: c.connection_ref ?? null, non_loopback_hosts: c.endpoint_allowlist.map((e: any) => e.host).filter((x: string) => !isLoopbackHost(x)),
      };
    });
    await p.capture("cross-run", "read-only SQLite dumps of both runs' ledgers, searched for the other run's identity", () => {
      const own = JSON.parse(readFileSync(p.cfg.manifest_path, "utf8")).config.run_id;
      const innerId = p.data("inner-bundle").run_id;
      const dump = (path: string) => {
        const db = openReadOnly(path);
        try {
          const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
          return tables.flatMap((t) => (db.prepare(`SELECT * FROM "${t}"`).all() as object[]).map((r) => JSON.stringify(r)));
        } finally {
          db.close();
        }
      };
      const innerRows = dump(innerDb());
      const ownRows = dump(p.cfg.db_path!);
      const innerEvidence = readdirSync(join(inner.clone, ".apl-s1", "evidence")).map((f) => readFileSync(join(inner.clone, ".apl-s1", "evidence", f), "utf8"));
      return {
        b_ts, inner_rows: innerRows.length, own_rows: ownRows.length,
        inner_mentions_b: innerRows.filter((r) => r.includes(own) || r.includes(MARKER)).length + innerEvidence.filter((e) => e.includes(own) || e.includes(MARKER)).length,
        b_mentions_inner: ownRows.filter((r) => r.includes(innerId)).length,
        b_has_own_marker: ownRows.some((r) => r.includes(MARKER)),
      };
    });
    const innerFact = (key: string) => () => {
      const b = p.data("inner-bundle");
      if (!b.evidence_verified.length || !b.evidence_verified.every((e: any) => e.ok)) throw new Error("clone evidence failed hash verification");
      if (!(key in b.observations)) throw new Error(`clone did not observe ${key}`);
      return b.observations[key];
    };
    p.fact("fresh_clone_completed", ["fresh-clone", "inner-bundle"], () =>
      ["git_clone", "npm_ci", "clone_collect_case"].every((s) => p.data("fresh-clone")[s]?.ok) && p.data("inner-bundle").execution === "EXECUTED" &&
      p.data("inner-bundle").evidence_verified.every((e: any) => e.ok));
    p.fact("undeclared_account_count", ["clone-config-scan"], () => {
      const s = p.data("clone-config-scan");
      return s.credential_like.length + s.non_loopback_hosts.length + (s.connection_ref ? 1 : 0);
    });
    p.fact("ticket_count", ["inner-bundle"], innerFact("ticket_count"));
    p.fact("completion_reply_count", ["inner-bundle"], innerFact("completion_reply_count"));
    p.fact("receipt_matches_request", ["inner-bundle"], innerFact("receipt_matches_request"));
    p.fact("cross_run_read_count", ["cross-run"], () => {
      const c = p.data("cross-run");
      if (!c.b_has_own_marker) throw new Error("concurrent run B never processed its own request");
      return c.inner_mentions_b + c.b_mentions_inner;
    });
  },
};
