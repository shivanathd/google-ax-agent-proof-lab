// G-SEED (two concurrent runs share nothing), G-CLEAN (scoped cleanup with an unrelated container present) and
// F1-R1 (no accounts; ambient credentials ignored), against real per-run Floci containers. Requires Docker.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { startRun, stopRun, RUN_LABEL, type RunHandle } from "../../src/config/lifecycle.ts";
import { ensureRunResources, flociClients } from "../../src/adapters/floci/clients.ts";
import { getObjectText } from "../../src/adapters/floci/ops.ts";
import { loadManifest, runDir } from "../../src/config/manifest.ts";
import { openReadOnly, rows } from "../../src/ledger/read.ts";
import { ROOT } from "../../src/config/run-config.ts";
import { botReplies, history, mention, waitFor } from "./helpers.ts";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const idsFor = (runId: string) => docker("ps", "-q", "--filter", `label=${RUN_LABEL}=${runId}`).split("\n").filter(Boolean);
const lab = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/cli/main.ts", ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
const readJson = (p: ChildProcess) =>
  new Promise<any>((resolve, reject) => {
    let out = "";
    p.stdout!.on("data", (d) => {
      out += d;
      try {
        resolve(JSON.parse(out));
      } catch {}
    });
    p.once("exit", (code) => reject(new Error(`lab exited ${code} before printing JSON`)));
  });
const exited = (p: ChildProcess) => new Promise<number>((r) => (p.exitCode !== null ? r(p.exitCode) : p.once("exit", (c) => r(c ?? 1))));

const cleanup: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
});

describe("run isolation and scoped cleanup", () => {
  it("G-SEED: two concurrent runs get disjoint ports, DB files, compose projects and Floci state, and each runs W01 alone", async () => {
    const [a, b] = await Promise.all([startRun({ slack: true }), startRun({ slack: true })]);
    cleanup.push(() => a.stop(), () => b.stop());
    const ma = a.manifest, mb = b.manifest;
    expect(ma.config.run_id).not.toBe(mb.config.run_id);
    expect(ma.ports.floci).not.toBe(mb.ports.floci);
    expect(ma.db_path).not.toBe(mb.db_path);
    expect(ma.compose_project).not.toBe(mb.compose_project);
    for (const h of [a, b]) {
      const port = docker("compose", "-p", h.manifest.compose_project, "port", "floci", "4566");
      expect(port.startsWith("127.0.0.1:")).toBe(true); // F1-R4 loopback-only binding
    }

    const ca = await flociClients(a.flociEndpoint, ma.config.endpoint_allowlist);
    const cb = await flociClients(b.flociEndpoint, mb.config.endpoint_allowlist);
    const ra = await ensureRunResources(ca, ma.compose_project);
    const rb = await ensureRunResources(cb, mb.compose_project);
    await ca.s3.send(new PutObjectCommand({ Bucket: ra.bucket, Key: "probe.json", Body: '{"run":"a"}' }));
    const got = await (await ca.s3.send(new GetObjectCommand({ Bucket: ra.bucket, Key: "probe.json" }))).Body!.transformToString();
    expect(got).toBe('{"run":"a"}');
    // Run B cannot see run A's bucket at all, and its own bucket is empty.
    await expect(cb.s3.send(new ListObjectsV2Command({ Bucket: ra.bucket }))).rejects.toMatchObject({ name: "NoSuchBucket" });
    expect((await cb.s3.send(new ListObjectsV2Command({ Bucket: rb.bucket }))).KeyCount ?? 0).toBe(0);
    // B's allowlist does not include A's endpoint, so a client aimed at A is refused before any request.
    await expect(flociClients(a.flociEndpoint, mb.config.endpoint_allowlist)).rejects.toThrow(/not_allowlisted/);

    // Both runs execute W01 end to end at the same time (Slack → worker → SQS → ledger → S3 → reply). Each run's
    // independent readers (its reader token, its read-only ledger, its own S3 client) see only that run's effects.
    const runs = [{ h: a, s3: ca }, { h: b, s3: cb }];
    const summaries = ["isolation probe for run a", "isolation probe for run b"];
    const tss = await Promise.all(runs.map(({ h }, i) => mention(h, h.workspaces[0]!, "dana", `service-request ${summaries[i]}`)));
    for (const [i, { h, s3 }] of runs.entries()) {
      const ws = h.workspaces[0]!;
      const other = runs[1 - i]!.h;
      const L = openReadOnly(h.manifest.db_path);
      await waitFor(() => rows(L, "tickets").some((t) => t.receipt_status === "committed"), 20000, `run ${i} receipt committed`);
      const replies = await waitFor(async () => {
        const r = await botReplies(h, ws, tss[i]!);
        return r.length ? r : undefined;
      }, 10000, `run ${i} completion reply`);
      const tickets = rows(L, "tickets");
      L.close();
      expect(tickets.map((t) => t.summary)).toEqual([summaries[i]]);
      expect(replies.map((m) => String(m.text).includes(summaries[i]!) && !String(m.text).includes(summaries[1 - i]!))).toEqual([true]);
      const keys = (await s3.s3.send(new ListObjectsV2Command({ Bucket: h.floci!.bucket, Prefix: "receipts/" }))).Contents?.map((o) => o.Key);
      expect(keys).toEqual([tickets[0]!.receipt_key]);
      const receipt = JSON.parse((await getObjectText(s3, h.floci!.bucket, tickets[0]!.receipt_key))!);
      expect(receipt).toMatchObject({ run_id: h.manifest.config.run_id, input: { summary: summaries[i] } });
      expect((await history(other, other.workspaces[0]!)).some((m) => String(m.text).includes(summaries[i]!))).toBe(false);
    }
  });

  it("F1-R1: the local profile runs with fake ambient provider credentials present, passes none to the worker or Floci, and needs no account", async () => {
    const ambient: Record<string, string> = {
      AWS_ACCESS_KEY_ID: "AKIAAMBIENTFAKE00001", AWS_SECRET_ACCESS_KEY: "ambient-fake-aws-secret", AWS_SESSION_TOKEN: "ambient-fake-aws-session",
      AWS_PROFILE: "ambient-fake-profile", SLACK_BOT_TOKEN: "xoxb-ambient-fake-token", GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/ambient-fake-gcp.json",
      ANTHROPIC_API_KEY: "sk-ant-ambient-fake-key", OPENAI_API_KEY: "sk-ambient-fake-openai", GITHUB_TOKEN: "ghp_ambient_fake_token", SF_ACCESS_TOKEN: "ambient-fake-sf-token",
    };
    const env = { ...process.env, ...ambient };
    const leaked = (text: string) => Object.values(ambient).filter((v) => text.includes(v));
    const up = lab(["up", "--profile", "local"], env);
    cleanup.push(async () => up.kill("SIGKILL"));
    const started = await readJson(up);
    cleanup.push(() => stopRun(started.run_id));

    // The worker's actual process environment, read from the OS rather than from the config that built it.
    const worker = loadManifest(started.run_id).config.owned_resources.find((r) => r.kind === "process" && r.role === "worker")!;
    const pid = Number(worker.id.split("@")[0]);
    const workerEnvText = process.platform === "linux"
      ? readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", "\n")
      : execFileSync("ps", ["-wwE", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
    expect(workerEnvText).toContain("AWS_EC2_METADATA_DISABLED=true"); // the probe really reads the env
    expect(leaked(workerEnvText)).toEqual([]);
    for (const id of idsFor(started.run_id)) expect(leaked(docker("inspect", "--format", "{{json .Config.Env}}", id))).toEqual([]);

    // No account needed: W01 completes against the local emulators with nothing but the fakes in scope.
    const ran = await readJson(lab(["run", "--run-id", started.run_id, "--case", "W01-H"], env));
    expect(ran).toMatchObject({ profile: "local", posted: true });
    const L = openReadOnly(loadManifest(started.run_id).db_path);
    await waitFor(() => rows(L, "tickets").some((t) => t.receipt_status === "committed"), 20000, "receipt committed");
    L.close();
    const down = lab(["down", "--run-id", started.run_id], env);
    expect(await readJson(down)).toMatchObject({ cleanup_status: "CLEAN" });
    await exited(up);
  });

  it("G-CLEAN: `down --run-id` removes only that run; an unrelated labelled container and another run survive", async () => {
    const image = JSON.parse(readFileSync(join(ROOT, "DEPENDENCIES.lock.json"), "utf8")).images.floci;
    const otherRun = randomUUID();
    const unrelated = docker("run", "-d", "--rm", "--label", `${RUN_LABEL}=${otherRun}`, "--name", `apl-unrelated-${otherRun.slice(0, 8)}`,
      "-p", "127.0.0.1::4566", `${image.ref}@${image.digest}`);
    cleanup.push(async () => docker("rm", "-f", unrelated));

    const survivor: RunHandle = await startRun();
    cleanup.push(() => stopRun(survivor.manifest.config.run_id));

    const up = lab(["up", "--profile", "local"]);
    cleanup.push(async () => up.kill("SIGKILL"));
    const started = await readJson(up);
    expect(started.console_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const status = await (await fetch(`${started.console_url}api/status`)).json();
    expect(status).toMatchObject({ run_id: started.run_id, profile: "local", mode: "scripted" });
    expect(new URL(status.services.floci.endpoint).hostname).toBe("127.0.0.1");
    expect(idsFor(started.run_id).length).toBe(1);
    // F1-A1 shape: both Slack emulators and Floci are up, every endpoint is loopback, a workflow runs end to end.
    expect(status.services.slack).toHaveLength(2);
    const endpoints = [status.services.floci.endpoint, status.services.worker.endpoint, ...status.services.slack.map((s: any) => s.emulator)];
    expect(endpoints.filter((u: string) => !["127.0.0.1", "localhost"].includes(new URL(u).hostname))).toEqual([]);
    const ran = await readJson(lab(["run", "--run-id", started.run_id, "--case", "W01-H"]));
    expect(ran).toMatchObject({ profile: "local", case: "W01-H", mode: "scripted", posted: true, tenant_id: "T_LAB_A" });
    const L = openReadOnly(loadManifest(started.run_id).db_path);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !rows(L, "tickets").some((t) => t.receipt_status === "committed")) await new Promise((r) => setTimeout(r, 100));
    expect(rows(L, "tickets").map((t) => t.receipt_status)).toEqual(["committed"]);
    L.close();

    const down = lab(["down", "--run-id", started.run_id]);
    const report = await readJson(down);
    expect(await exited(down)).toBe(0);
    expect(report).toMatchObject({ cleanup_status: "CLEAN", remaining: [] });
    await exited(up);

    expect(idsFor(started.run_id)).toEqual([]);
    expect(idsFor(otherRun)).toEqual([unrelated.slice(0, 12)]);
    expect(idsFor(survivor.manifest.config.run_id).length).toBe(1);
    // Evidence is preserved until an explicit purge.
    expect(existsSync(join(runDir(started.run_id), "manifest.json"))).toBe(true);
  });
});
