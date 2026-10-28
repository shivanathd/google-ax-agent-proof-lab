import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createRunConfig, validateRunConfig } from "../../src/config/run-config.ts";
import { assertAllowedEndpoint, EndpointRejected, guardAwsClient, guardedFetch, type Rejection } from "../../src/config/endpoints.ts";
import { browsersPath, childEnv, sanitizeProcessEnv } from "../../src/config/env.ts";
import { workerConfig, workerEnv } from "../../src/worker/config.ts";
import { composeProject, runDir } from "../../src/config/manifest.ts";
import { laneStatuses, profileDoctor, profileRun } from "../../src/config/profiles.ts";
import { flociClients } from "../../src/adapters/floci/clients.ts";
import type { ProfileAdapter } from "../../src/contracts/profile.ts";

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<{ server: Server; port: number; hits: () => number }>((resolve) => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      handler!(req, res);
    }).listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, hits: () => hits }));
  });

describe("C1 RunConfig", () => {
  it("builds a valid scripted local config with a UUID run id and candidate identity", () => {
    const c = createRunConfig({ endpoint_allowlist: [{ scheme: "http", host: "127.0.0.1", port: 4566 }] });
    expect(c.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.mode).toBe("scripted");
    expect(c.candidate_revision).toMatch(/^[0-9a-f]{40}$/);
    expect(c.dirty ? typeof c.patch_sha256 : "clean").toBe(c.dirty ? "string" : "clean");
    expect(c.limits).toEqual({ wall_clock_seconds: 120, max_actions: 20, max_retries: 2 });
  });

  it("rejects unknown fields, unknown enums, dirty without patch digest and uncapped live inference", () => {
    const good = createRunConfig({});
    expect(() => validateRunConfig({ ...good, admin_token: "x" })).toThrow(/additional properties/);
    expect(() => validateRunConfig({ ...good, profile: "prod" })).toThrow(/profile/);
    expect(() => validateRunConfig({ ...good, run_id: "../../etc" })).toThrow(/run_id/);
    const { patch_sha256: _p, ...noPatch } = good;
    expect(() => validateRunConfig({ ...noPatch, dirty: true })).toThrow(/patch_sha256/);
    expect(() => validateRunConfig({ ...good, mode: "live-model" })).toThrow(/cost_cap/);
    expect(() => validateRunConfig({ ...good, mode: "live-model", cost_cap: 0 })).toThrow(/cost_cap/);
  });

  it("refuses a non-loopback endpoint in a local allowlist (F1-R2)", () => {
    expect(() => createRunConfig({ endpoint_allowlist: [{ scheme: "https", host: "slack.com", port: 443 }] })).toThrow(/non-loopback/);
  });

  it("rejects path traversal in run ids and derives a validated compose project", () => {
    expect(() => runDir("../outside")).toThrow(/UUID/);
    expect(composeProject("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("apl-0f8fad5bd9cb");
  });
});

describe("endpoint guard (F1-R2, F1-A2)", () => {
  let target: Awaited<ReturnType<typeof listen>>;
  let sink: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => {
    sink = await listen((_q, r) => r.end("sink"));
    target = await listen((req, res) => {
      const to = req.url === "/to-sink" ? `http://127.0.0.1:${sink.port}/` : req.url === "/to-prod" ? "https://slack.com/api/chat.postMessage" : "";
      if (to) res.writeHead(302, { location: to }).end();
      else res.end("ok");
    });
  });
  afterAll(() => {
    target.server.close();
    sink.server.close();
  });
  const allow = () => [{ scheme: "http" as const, host: "127.0.0.1", port: target.port }, { scheme: "http" as const, host: "localhost", port: target.port }];

  it("accepts allowlisted loopback by IP and by name", async () => {
    await expect(assertAllowedEndpoint(`http://127.0.0.1:${target.port}/x`, allow())).resolves.toBeInstanceOf(URL);
    await expect(assertAllowedEndpoint(`http://localhost:${target.port}/x`, allow())).resolves.toBeInstanceOf(URL);
  });

  it("rejects production hosts, other ports, other schemes and userinfo with a zero-write audit record", async () => {
    const audit: Rejection[] = [];
    const spy = vi.spyOn(globalThis, "fetch");
    for (const url of ["https://slack.com/api/chat.postMessage", "https://sqs.us-east-1.amazonaws.com/", `http://127.0.0.1:${sink.port}/`,
      `file:///etc/passwd`, `http://user:pw@127.0.0.1:${target.port}/`]) {
      await expect(guardedFetch(url, { method: "POST", body: "x", allowlist: allow(), onReject: (r) => audit.push(r) })).rejects.toBeInstanceOf(EndpointRejected);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(sink.hits()).toBe(0);
    expect(audit.map((a) => a.reason)).toEqual(["not_allowlisted", "not_allowlisted", "not_allowlisted", "scheme_not_allowed", "userinfo_not_allowed"]);
    expect(audit.every((a) => a.outbound_request_count === 0 && !a.target.includes("/api"))).toBe(true);
  });

  it("rejects an allowlisted name that does not resolve to loopback", async () => {
    await expect(assertAllowedEndpoint("http://lab.invalid:80/", [{ scheme: "http", host: "lab.invalid", port: 80 }])).rejects.toThrow(/non_loopback_resolution/);
  });

  it("validates redirect targets before following them", async () => {
    const before = sink.hits();
    await expect(guardedFetch(`http://127.0.0.1:${target.port}/to-sink`, { allowlist: allow() })).rejects.toThrow(/not_allowlisted/);
    await expect(guardedFetch(`http://127.0.0.1:${target.port}/to-prod`, { allowlist: allow() })).rejects.toThrow(/not_allowlisted/);
    expect(sink.hits()).toBe(before);
    expect(await (await guardedFetch(`http://127.0.0.1:${target.port}/`, { allowlist: allow() })).text()).toBe("ok");
  });

  it("guards AWS SDK requests at send time and refuses a non-allowlisted Floci endpoint", async () => {
    const audit: Rejection[] = [];
    const s3 = guardAwsClient(new S3Client({ region: "us-east-1", endpoint: "https://s3.amazonaws.com", credentials: { accessKeyId: "a", secretAccessKey: "b" } }), allow(), (r) => audit.push(r));
    await expect(s3.send(new PutObjectCommand({ Bucket: "b", Key: "k", Body: "x" }))).rejects.toBeInstanceOf(EndpointRejected);
    await expect(flociClients("https://s3.amazonaws.com", allow())).rejects.toBeInstanceOf(EndpointRejected);
    expect(audit[0]).toMatchObject({ kind: "endpoint_rejected", outbound_request_count: 0 });
  });
});

describe("credential hygiene (F1-R3)", () => {
  const ambient = {
    PATH: "/usr/bin", HOME: "/home/lab", AWS_PROFILE: "prod", AWS_ACCESS_KEY_ID: "AKIAREAL", AWS_SESSION_TOKEN: "s",
    GOOGLE_APPLICATION_CREDENTIALS: "/k.json", SLACK_BOT_TOKEN: "xoxb-real", OPENAI_API_KEY: "sk-real", SF_ACCESS_TOKEN: "t",
    GITHUB_TOKEN: "ghp", KUBECONFIG: "/k", DOCKER_HOST: "unix:///d.sock",
  };

  it("builds child envs from an allowlist with fake AWS creds and metadata lookup disabled", () => {
    const env = childEnv(ambient, { APL_RUN_ID: "r" });
    expect(env).toMatchObject({ PATH: "/usr/bin", AWS_EC2_METADATA_DISABLED: "true", AWS_ACCESS_KEY_ID: "lab-fake-access-key", AWS_SHARED_CREDENTIALS_FILE: "/dev/null", APL_RUN_ID: "r" });
    for (const k of ["AWS_PROFILE", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "SLACK_BOT_TOKEN", "OPENAI_API_KEY", "SF_ACCESS_TOKEN", "GITHUB_TOKEN", "KUBECONFIG", "DOCKER_HOST"]) {
      expect(env).not.toHaveProperty(k);
    }
    expect(Object.values(env)).not.toContain("AKIAREAL");
    expect(childEnv(ambient, {}, { docker: true })).toHaveProperty("DOCKER_HOST");
  });

  it("child envs never carry the developer's HOME, so gcloud/kube/other CLI configs there are not discoverable", () => {
    const env = childEnv(ambient, { APL_RUN_ID: "r" });
    expect(env.HOME).toBeDefined();
    expect(env.HOME).not.toBe("/home/lab");
    expect(childEnv(ambient, { HOME: "/run-owned/home" }).HOME).toBe("/run-owned/home");
    // The collector drives a browser under a scoped HOME, so it is given the real browser cache path (S4 regression);
    // generic child envs (the worker's included) do not carry it.
    expect(browsersPath({})).toMatch(/ms-playwright$/);
    expect(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" })).toBe("/opt/pw");
    expect(childEnv(ambient, { HOME: "/run-owned/home" })).not.toHaveProperty("PLAYWRIGHT_BROWSERS_PATH");
    const w = workerConfig({ run_id: "0f8fad5b-d9cb-469f-a165-70867728950e", db_path: "/runs/r1/ledger.db", http_port: 9, allowlist: [] }, []);
    expect(workerEnv(w, ambient).HOME).toBe("/runs/r1/worker-home");
    // Docker's CLI context and credential store live under HOME; only the docker CLI child keeps it.
    expect(childEnv(ambient, {}, { docker: true }).HOME).toBe("/home/lab");
  });

  it("strips ambient provider credentials from the coordinator process env", () => {
    const env: NodeJS.ProcessEnv = { ...ambient };
    sanitizeProcessEnv(env);
    expect(env.AWS_ACCESS_KEY_ID).toBe("lab-fake-access-key");
    for (const k of ["AWS_PROFILE", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "SLACK_BOT_TOKEN", "OPENAI_API_KEY", "GITHUB_TOKEN"]) expect(env).not.toHaveProperty(k);
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("optional profile status (F1-R6)", () => {
  const none = async () => undefined;

  it("reports every unselected optional profile as SKIPPED, never PASS", async () => {
    const lanes = await laneStatuses([], {}, none);
    expect(Object.values(lanes).map((l) => l.status)).toEqual(["SKIPPED", "SKIPPED", "SKIPPED", "SKIPPED"]);
  });

  it("reports a selected profile without an adapter as BLOCKED with a prerequisite and zero external calls", async () => {
    const lanes = await laneStatuses(["salesforce"], {}, none);
    expect(lanes.salesforce).toMatchObject({ status: "BLOCKED", reason: "adapter not installed", external_calls: 0 });
    expect(lanes.salesforce!.prerequisites).toEqual([expect.objectContaining({ id: "salesforce.adapter", satisfied: false })]);
    expect(lanes.ax!.status).toBe("SKIPPED");
  });

  it("never lets an adapter turn unmet prerequisites or a bare doctor into PASS, and never runs a blocked lane", async () => {
    const run = vi.fn();
    const adapter: ProfileAdapter = {
      name: "ax",
      doctor: async () => ({ profile: "ax", status: "PASS", external_calls: 0, reason: "", prerequisites: [{ id: "ax.cluster", description: "cluster", satisfied: false }] }),
      run,
    };
    expect((await profileDoctor("ax", {}, async () => adapter)).status).toBe("BLOCKED");
    expect((await profileRun("ax", "W01-H", { authorized: true, env: {} }, async () => adapter)).status).toBe("BLOCKED");
    expect(run).not.toHaveBeenCalled();
    const ready: ProfileAdapter = { ...adapter, doctor: async () => ({ profile: "ax", status: "PASS", external_calls: 0, reason: "", prerequisites: [] }) };
    expect((await profileDoctor("ax", {}, async () => ready)).status).toBe("NOT_RUN");
  });
});
