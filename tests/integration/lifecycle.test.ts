// G-SEED (two concurrent runs share nothing) and G-CLEAN (scoped cleanup with an unrelated container present),
// against real per-run Floci containers. Requires Docker.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { startRun, stopRun, RUN_LABEL, type RunHandle } from "../../src/config/lifecycle.ts";
import { ensureRunResources, flociClients } from "../../src/adapters/floci/clients.ts";
import { runDir } from "../../src/config/manifest.ts";
import { ROOT } from "../../src/config/run-config.ts";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const idsFor = (runId: string) => docker("ps", "-q", "--filter", `label=${RUN_LABEL}=${runId}`).split("\n").filter(Boolean);
const lab = (...args: string[]) => spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/cli/main.ts", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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
  it("G-SEED: two concurrent runs get disjoint ports, DB files, compose projects and Floci state", async () => {
    const [a, b] = await Promise.all([startRun(), startRun()]);
    cleanup.push(() => stopRun(a.manifest.config.run_id), () => stopRun(b.manifest.config.run_id));
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
  });

  it("G-CLEAN: `down --run-id` removes only that run; an unrelated labelled container and another run survive", async () => {
    const image = JSON.parse(readFileSync(join(ROOT, "DEPENDENCIES.lock.json"), "utf8")).images.floci;
    const otherRun = randomUUID();
    const unrelated = docker("run", "-d", "--rm", "--label", `${RUN_LABEL}=${otherRun}`, "--name", `apl-unrelated-${otherRun.slice(0, 8)}`,
      "-p", "127.0.0.1::4566", `${image.ref}@${image.digest}`);
    cleanup.push(async () => docker("rm", "-f", unrelated));

    const survivor: RunHandle = await startRun();
    cleanup.push(() => stopRun(survivor.manifest.config.run_id));

    const up = lab("up", "--profile", "local");
    cleanup.push(async () => up.kill("SIGKILL"));
    const started = await readJson(up);
    expect(started.console_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const status = await (await fetch(`${started.console_url}api/status`)).json();
    expect(status).toMatchObject({ run_id: started.run_id, profile: "local", mode: "scripted" });
    expect(new URL(status.services.floci.endpoint).hostname).toBe("127.0.0.1");
    expect(idsFor(started.run_id).length).toBe(1);

    const down = lab("down", "--run-id", started.run_id);
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
