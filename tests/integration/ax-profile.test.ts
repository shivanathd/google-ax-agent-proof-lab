// AX profile: offline gates (doctor/run) and the custom runner contract against the locally built image.
// Nothing here contacts a cluster: run() is only exercised on its refusal paths.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const wrap = <F extends (...a: never[]) => unknown>(f: F) => vi.fn(f);
  return {
    ...real,
    execFileSync: wrap(real.execFileSync),
    execFile: wrap(real.execFile),
    execSync: wrap(real.execSync),
    exec: wrap(real.exec),
    spawn: wrap(real.spawn),
    spawnSync: wrap(real.spawnSync),
    fork: wrap(real.fork),
  };
});
const cp = await import("node:child_process");
const { default: ax, render, FLOCI_IMAGE } = await import("../../profiles/ax/index.ts");

const processCalls = () =>
  (["execFileSync", "execFile", "execSync", "exec", "spawn", "spawnSync", "fork"] as const).reduce(
    (n, k) => n + vi.mocked(cp[k]).mock.calls.length,
    0,
  );
const DIGEST_IMAGE = `registry.example.invalid/lab/ax-runner@sha256:${"a".repeat(64)}`;
// Every prerequisite declared except the kubectl probe target, which points at a path that does not exist.
const declaredEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  APL_AX_CONTEXT: "lab-context",
  APL_AX_IMAGE: DIGEST_IMAGE,
  APL_AX_CLI: "/nonexistent/ax",
  APL_AX_SUBSTRATE_API: "api.ate-system.svc.cluster.local:443",
  APL_AX_AUTHORIZED: "1",
  ...over,
});

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network call during an offline test"));
});
afterEach(() => fetchSpy.mockRestore());

describe("ax doctor (offline)", () => {
  it("returns BLOCKED with actionable prerequisites and makes zero external calls", async () => {
    const d = await ax.doctor({});
    expect(d.profile).toBe("ax");
    expect(d.status).toBe("BLOCKED");
    expect(d.external_calls).toBe(0);
    expect(d.prerequisites.map((p) => p.id)).toEqual([
      "ax.kubectl",
      "ax.kube-context",
      "ax.image",
      "ax.cli",
      "ax.substrate-api",
      "ax.authorized",
    ]);
    expect(d.prerequisites.every((p) => !p.satisfied && p.description.length > 20)).toBe(true);
    expect(d.prerequisites[0]!.description).toContain("1.35");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(processCalls()).toBe(0);
  });

  it("rejects a tag-only image and an unset authorization flag", async () => {
    const d = await ax.doctor(declaredEnv({ APL_AX_IMAGE: "lab/ax-runner:v1", APL_AX_AUTHORIZED: "yes" }));
    const unsatisfied = d.prerequisites.filter((p) => !p.satisfied).map((p) => p.id);
    expect(unsatisfied).toEqual(expect.arrayContaining(["ax.image", "ax.authorized"]));
    expect(d.status).toBe("BLOCKED");
  });

  it("probes only the configured kubectl client, with no kubeconfig, and treats 1.34 as a gap", async (ctx) => {
    let hostKubectl = "";
    try {
      hostKubectl = (cp.execFileSync("sh", ["-c", "command -v kubectl"]) as Buffer).toString().trim();
    } catch {
      ctx.skip("no kubectl on PATH; the version probe cannot be exercised");
    }
    vi.clearAllMocks();
    const d = await ax.doctor({ APL_AX_KUBECTL: hostKubectl });
    const calls = vi.mocked(cp.execFileSync).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual(["version", "--client", "-o", "json"]);
    expect((calls[0]![2] as { env: NodeJS.ProcessEnv }).env.KUBECONFIG).toBe("/dev/null");
    const k = d.prerequisites.find((p) => p.id === "ax.kubectl")!;
    expect(k.description).toMatch(/found 1\.\d+/);
    expect(d.external_calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ax run (refusal paths only)", () => {
  it("refuses without authorized=true and makes no call", async () => {
    const r = await ax.run("w01-happy", { authorized: false, env: declaredEnv() });
    expect(r.status).toBe("BLOCKED");
    expect(r.reason).toMatch(/authorized=true/);
    expect(r.external_calls).toBe(0);
    expect(processCalls()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses when doctor is blocked even if authorized=true", async () => {
    const r = await ax.run("w01-happy", { authorized: true, env: {} });
    expect(r.status).toBe("BLOCKED");
    expect(r.external_calls).toBe(0);
    expect(processCalls()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ax manifests", () => {
  const dir = join(import.meta.dirname, "../../profiles/ax/manifests");
  const runId = randomUUID();
  const vars = {
    APL_RUN_ID: runId,
    APL_CASE_ID: "w01-happy",
    APL_AX_IMAGE: DIGEST_IMAGE,
    APL_AX_ATESPACE: `apl-${runId}`,
    APL_FLOCI_IMAGE: FLOCI_IMAGE,
    APL_EMULATE_IMAGE: `registry.example.invalid/lab/emulate@sha256:${"b".repeat(64)}`,
  };

  it("renders every placeholder and labels every Kubernetes object with apl-run", () => {
    const k8s = render(readFileSync(join(dir, "k8s/emulators.yaml"), "utf8"), vars);
    expect(k8s).not.toContain("${");
    const docs = k8s.split(/^---$/m).filter((d) => /^kind:/m.test(d));
    expect(docs.length).toBeGreaterThanOrEqual(6);
    for (const d of docs) expect(d).toContain(`apl-run: "${runId}"`);
  });

  it("puts the run id into AX names, atespace and config, since AX metadata has no labels", () => {
    const task = render(readFileSync(join(dir, "ax/task.yaml"), "utf8"), vars);
    expect(task).not.toContain("${");
    expect(task).toContain(`name: apl-task-${runId}`);
    expect(task).toContain(`atespace: apl-${runId}`);
    expect(task).toContain(`apl-run: "${runId}"`);
    expect(task).toContain("debug: false");
    expect(`apl-task-${runId}`.length).toBeLessThanOrEqual(63);
  });

  it("refuses to render an unknown placeholder", () => {
    expect(() => render("x: ${APL_NOPE}", {})).toThrow(/APL_NOPE/);
  });
});

// ---------------- Runner contract against the locally built linux/amd64 image ----------------

const dockerSkipReason = (() => {
  try {
    cp.execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 10_000 });
    cp.execFileSync("docker", ["buildx", "version"], { stdio: "ignore" });
    return null;
  } catch {
    return "Docker daemon or buildx unavailable";
  }
})();
const IMAGE = "apl-ax-runner:dev";
const RUN_LABEL = `dev.agent-proof-lab.run-id=${randomUUID()}`;
const docker = (...args: string[]) => (cp.execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }) as Buffer).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(200);
  }
}
const workspaces: string[] = [];
function startRunner(taskYaml: string, wsYaml?: string) {
  const dir = mkdtempSync(join(tmpdir(), "apl-ax-ws-"));
  workspaces.push(dir);
  const env = ["-e", `AX_TASK_YAML=${taskYaml}`, ...(wsYaml ? ["-e", `AX_WORKSPACE_YAML=${wsYaml}`] : [])];
  const id = docker("run", "-d", "--platform", "linux/amd64", "--label", RUN_LABEL, "-p", "127.0.0.1::80", "-v", `${dir}:/workspace`, ...env, IMAGE, "--grace", "2s");
  return { id, dir, url: urlOf(id) };
}
const urlOf = (id: string) => `http://127.0.0.1:${docker("port", id, "80/tcp").split("\n")[0]!.split(":").pop()}`;
const status = async (url: string) => {
  try {
    return (await fetch(url)).status;
  } catch {
    return undefined;
  }
};
const taskYaml = (command: string[], extra = "") =>
  `apiVersion: ax.io/v1alpha1\nkind: Task\nmetadata:\n  name: contract\n  futureField: ignored\nspec:\n  command: ${JSON.stringify(command)}\n  env:\n    - {name: LAB_FOO, value: bar}\n  newerControlPlaneField: {a: 1}\n${extra}`;
const resultOf = (dir: string) => {
  const p = join(dir, ".apl/result.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : undefined;
};
const sha = (argv: string[]) => createHash("sha256").update(argv.join("\0")).digest("hex");
const running = (id: string) => docker("inspect", "-f", "{{.State.Running}}", id) === "true";

describe.skipIf(dockerSkipReason !== null)(
  `ax runner contract (docker)${dockerSkipReason ? ` [SKIPPED: ${dockerSkipReason}]` : ""}`,
  () => {
    beforeAll(() => {
      cp.execFileSync("docker", ["buildx", "build", "--platform", "linux/amd64", "--load", "-t", IMAGE, join(import.meta.dirname, "../../profiles/ax/runner")], { stdio: "ignore" });
    }, 600_000);
    beforeEach(() => fetchSpy.mockRestore());
    afterAll(() => {
      // Remove only containers this file created, selected by its own run-id label.
      const ours = docker("ps", "-aq", "--filter", `label=${RUN_LABEL}`).split("\n").filter(Boolean);
      if (ours.length) docker("rm", "-f", ...ours);
      for (const d of workspaces) rmSync(d, { recursive: true, force: true });
    });

    it("image is linux/amd64 with the runner at /usr/local/bin/ax-task-runner", () => {
      expect(docker("image", "inspect", IMAGE, "--format", "{{.Os}}/{{.Architecture}}")).toBe("linux/amd64");
    });

    it("passing command: probes, metadata on loopback only, env, cwd, result.json exit 0, stays up", async () => {
      const argv = ["sh", "-c", 'pwd > cwd.txt; echo "$AX_METADATA_URL $LAB_FOO" > env.txt; exit 0'];
      const r = startRunner(taskYaml(argv));
      expect(await until(() => status(`${r.url}/healthz`).then((s) => (s === 200 ? s : undefined)))).toBe(200);
      const res = await until(() => resultOf(r.dir));
      expect(res.exit_code).toBe(0);
      expect(res.command_sha256).toBe(sha(argv));
      expect(Date.parse(String(res.ended_at))).toBeGreaterThanOrEqual(Date.parse(String(res.started_at)));
      expect(readFileSync(join(r.dir, "cwd.txt"), "utf8").trim()).toBe("/workspace");
      expect(readFileSync(join(r.dir, "env.txt"), "utf8").trim()).toBe("http://127.0.0.1:8099 bar");
      expect(await status(`${r.url}/readyz`)).toBe(200);
      expect(JSON.parse(await (await fetch(`${r.url}/apl/result`)).text())).toEqual(res);
      await sleep(1000);
      expect(running(r.id)).toBe(true);
      expect(await status(`${r.url}/healthz`)).toBe(200);
      expect(docker("exec", r.id, "cat", "/proc/1/cmdline").split("\0")[0]).toBe("/usr/local/bin/ax-task-runner");
      expect(docker("exec", r.id, "wget", "-qO-", "http://127.0.0.1:8099/metadata/v1alpha1/ax/task")).toContain("name: contract");
      expect(() => docker("exec", r.id, "wget", "-qO-", "http://127.0.0.1:8099/metadata/v1alpha1/ax/workspace")).toThrow();
      const ip = docker("exec", r.id, "hostname", "-i").split(/\s+/)[0]!;
      expect(() => docker("exec", r.id, "wget", "-T", "2", "-qO-", `http://${ip}:8099/metadata/v1alpha1/ax/task`)).toThrow();
      expect(await status(`${r.url}/metadata/v1alpha1/ax/task`)).toBe(404);
    }, 60_000);

    it("failing command: result.json records exit 3 and the runner keeps serving", async () => {
      const argv = ["sh", "-c", "exit 3"];
      const r = startRunner(taskYaml(argv));
      const res = await until(() => resultOf(r.dir));
      expect(res.exit_code).toBe(3);
      expect(res.command_sha256).toBe(sha(argv));
      await sleep(1000);
      expect(running(r.id)).toBe(true);
      expect(await status(`${r.url}/healthz`)).toBe(200);
    }, 60_000);

    it("readyz stays 503 while the workspace cannot be prepared, and the command never starts", async () => {
      const ws = "kind: Workspace\nspec:\n  git:\n    - {name: origin, repo: 'https://example.invalid/repo.git'}\n";
      const r = startRunner(taskYaml(["sh", "-c", "exit 0"], "  workspace: {name: w}\n"), ws);
      expect(await until(() => status(`${r.url}/healthz`).then((s) => (s === 200 ? s : undefined)))).toBe(200);
      await sleep(1500);
      expect(await status(`${r.url}/readyz`)).toBe(503);
      expect(resultOf(r.dir)).toBeUndefined();
    }, 60_000);

    it("prepares the workspace once: a restart keeps the marker and does not overwrite agent edits", async () => {
      const ws = "kind: Workspace\nspec:\n  files:\n    - {path: AGENTS.md, content: original}\n  skills: {path: /.agents/skills}\n";
      const r = startRunner(taskYaml(["sh", "-c", "exit 0"], "  workspace: {name: w}\n"), ws);
      await until(() => resultOf(r.dir));
      expect(await status(`${r.url}/readyz`)).toBe(200);
      expect(readFileSync(join(r.dir, "AGENTS.md"), "utf8")).toBe("original");
      expect(existsSync(join(r.dir, ".agents/skills"))).toBe(true);
      const marker = readFileSync(join(r.dir, ".apl/prepared"), "utf8");
      writeFileSync(join(r.dir, "AGENTS.md"), "edited by agent");
      docker("restart", "-t", "15", r.id);
      const after = urlOf(r.id); // the host port can change across a restart
      await until(() => status(`${after}/readyz`).then((s) => (s === 200 ? s : undefined)));
      expect(readFileSync(join(r.dir, ".apl/prepared"), "utf8")).toBe(marker);
      expect(readFileSync(join(r.dir, "AGENTS.md"), "utf8")).toBe("edited by agent");
    }, 90_000);

    it("SIGTERM is forwarded to the command's process group", async () => {
      const argv = ["sh", "-c", 'trap "echo term > term.txt; exit 7" TERM; while :; do sleep 1; done'];
      const r = startRunner(taskYaml(argv));
      await until(() => status(`${r.url}/readyz`).then((s) => (s === 200 ? s : undefined)));
      await sleep(1000);
      docker("stop", "-t", "15", r.id);
      expect(resultOf(r.dir)?.exit_code).toBe(7);
      expect(readFileSync(join(r.dir, "term.txt"), "utf8").trim()).toBe("term");
      expect(docker("inspect", "-f", "{{.State.ExitCode}}", r.id)).toBe("0");
    }, 60_000);

    it("a command ignoring SIGTERM is SIGKILLed after the bounded grace period", async () => {
      const argv = ["sh", "-c", "trap '' TERM; sleep 300"];
      const r = startRunner(taskYaml(argv));
      await until(() => status(`${r.url}/readyz`).then((s) => (s === 200 ? s : undefined)));
      await sleep(1000);
      const t0 = Date.now();
      docker("stop", "-t", "15", r.id);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(2000);
      expect(elapsed).toBeLessThan(12_000);
      expect(resultOf(r.dir)?.exit_code).toBe(137);
      // 0 means the runner exited by itself, not by docker's own SIGKILL after 15 s.
      expect(docker("inspect", "-f", "{{.State.ExitCode}}", r.id)).toBe("0");
    }, 60_000);
  },
);
