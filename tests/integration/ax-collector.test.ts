// Phase 4 gate of docs/MULTI_CLUSTER_BUILD.md: profiles/ax/collector.ts `observe` for F3-A1 and `observe --run`
// for MT-W01 and MT-ISO, on synthetic captures, each call one process started as in the collector Pod
// (`node --env-file=<f> --import tsx collector.ts …`, build §6). Slack is a local Emulate workspace, Floci the
// Docker container the lifecycle tests use, the router a local stub; all on 127.0.0.1, no cluster call.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { flociClients } from "../../src/adapters/floci/clients.ts";
import { stimulus } from "../../src/collector/drive.ts";
import { startRun, type RunHandle } from "../../src/config/lifecycle.ts";
import { ROOT } from "../../src/config/run-config.ts";
import { readBundle } from "../../src/reports/artifacts.ts";
import { buildReport } from "../../src/reports/report.ts";
import { redactAddresses } from "../../profiles/ax/multi-facts.ts";
import { api, mention } from "./helpers.ts";

const COLLECTOR = join(ROOT, "profiles/ax/collector.ts");
const CASES = JSON.parse(readFileSync(join(ROOT, "profiles/ax/cases.ax.json"), "utf8"));
const TENANT = "1a2b3c4d-0000-4000-8000-000000000001";
const ATESPACE = "apl-ax-1a2b3c4d";
const TASK = "apl-1a2b3c4d-01", ISO = "apl-1a2b3c4d-iso";
const IMAGE_REV = "c0ffee".padEnd(40, "0"); // what Dockerfile.lab's ENV would hold
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const T2_TOKEN = "xoxb-t2reader-0000000000";
const T2 = { tenant_run_id: "5e6f7a8b-0000-4000-8000-000000000002", run_ids: ["9a9a9a9a-0000-4000-8000-000000000009"], tasks: ["apl-5e6f7a8b-01", "apl-5e6f7a8b-tgt"], token_sha256: [sha(T2_TOKEN)] };
const TARGETS = [
  { role: "t1-emulate-clusterip", address: "10.8.0.10", port: 8080, host: `emulate.${ATESPACE}.svc.cluster.local`, path: "/_apl/missing", own: true },
  { role: "t1-emulate-pod", address: "10.4.1.7", port: 8080, own: true },
  { role: "t1-floci-clusterip", address: "10.8.0.11", port: 4566, own: true },
  { role: "t1-floci-pod", address: "fd00:10::11", port: 4566, own: true },
  { role: "t2-emulate-clusterip", address: "10.8.0.20", port: 8080, host: "emulate.apl-ax-5e6f7a8b.svc.cluster.local", path: "/_apl/missing", own: false },
  { role: "router", address: "10.8.0.30", port: 443, host: "atenet-router.ate-system.svc", path: "/apl/missing", tls: true, own: false },
  { role: "worker-1-80", address: "fd00:10::40", port: 80, tcp: true, own: false },
];
const T = "2026-10-29T10:00:30.000Z";
const WINDOW = { from: "2026-10-29T10:00:00.000Z", to: "2026-10-29T10:01:00.000Z" };
const PODS = [{ name: "atenet-egress-aaaa", restarts: 0 }];
const gw = (o: object) => `[pod/atenet-egress-aaaa/envoy] ${JSON.stringify({ time: T, actor: `${ATESPACE}/${ISO}`, ...o })}`;
const EGRESS_LINES = [
  `[pod/atenet-egress-aaaa/envoy] [egress] authority=emulate.${ATESPACE}.svc.cluster.local:8080 peer_san=- peer_serial=- code=200 flags=- up_bytes=10 down_bytes=20`,
  gw({ leg: "cleartext", authority: `emulate.${ATESPACE}.svc.cluster.local:8080`, status: 404, upstream: "10.8.0.10:8080" }), // the allowed control
  gw({ leg: "cleartext", authority: `floci.${ATESPACE}.svc.cluster.local:4566`, status: 409, upstream: "[fd00:10::11]:4566" }), // own Floci, IPv6
  gw({ leg: "cleartext", authority: "emulate.apl-ax-5e6f7a8b.svc.cluster.local:8080", status: 403, upstream: "-" }), // refused by the gateway itself
  gw({ leg: "clienthello", sni: "-", destination: "10.99.0.5:443", flags: "NR" }), // an address no target lists
  gw({ leg: "cleartext", time: "2026-10-29T09:58:00.000Z", status: 404, upstream: "10.8.0.20:8080" }), // outside the window
];

let run: RunHandle, router: Server, routerPort = 0, ws: RunHandle["workspaces"][number];
const tmp = mkdtempSync(join(tmpdir(), "apl-ax-collector-"));
const outs: string[] = [];
const file = (name: string, body: unknown) => {
  const f = join(tmp, `${randomUUID()}-${name}`);
  writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return f;
};

// The dotenv lines multi.ts puts under key <tr8> of collector-env-tenants (build §6).
function envFile(extra = "") {
  const env = { run_id: TENANT, slack: { url: ws.url, reader_token: ws.tokens.reader, channel: "lab-ops" },
    floci: { endpoint: run.flociEndpoint, credentials: { accessKeyId: "apl-collector-test", secretAccessKey: "test-secret" } }, router_url: `http://127.0.0.1:${routerPort}` };
  return file("collector-env", `APL_AX_COLLECTOR='${JSON.stringify(env)}'\nAPL_AX_ALLOWLIST='${JSON.stringify(run.manifest.config.endpoint_allowlist)}'\n${extra}`);
}

// Async, so the in-process Emulate and the router stub keep answering while the collector runs.
function collector(args: string[], o: { envFile?: string | null; revision?: string } = {}) {
  const envArg = o.envFile === null ? [] : [`--env-file=${o.envFile ?? envFile()}`];
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn(process.execPath, [...envArg, "--import", "tsx", COLLECTOR, ...args], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...(o.revision === undefined ? { APL_CANDIDATE_REVISION: IMAGE_REV } : o.revision ? { APL_CANDIDATE_REVISION: o.revision } : {}) },
    });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const RUN_FACTS = { step: 1, concurrency: 2, tasks_planned: 15, tasks_timed: 15 };
async function observe(args: string[], o: Parameters<typeof collector>[1] = {}) {
  const out = join(tmp, randomUUID());
  const runId = randomUUID();
  const r = await collector(["observe", "--atespace", ATESPACE, "--run-id", runId, "--out", out, ...args], o);
  expect(r.code, r.stderr).toBe(0);
  outs.push(out);
  const bundle = readBundle(out); // the C4 contract validator
  expect(bundle.run_id).toBe(runId);
  return { out, bundle, status: buildReport({ bundle, expected: CASES[bundle.case_id].expected }).status };
}
const runLevel = (c: string, o: { markers?: object; facts?: object | null; extra?: string[] } = {}) => observe([
  "--run", "--case", c, "--foreign-markers-file", file("markers.json", o.markers ?? { tenant_run_id: TENANT, foreign: [T2] }),
  ...(o.facts === null ? [] : ["--run-facts", file("run-facts.json", o.facts ?? RUN_FACTS)]), ...(o.extra ?? []),
]);
const isoArgs = (o: { egress?: boolean; disclosure?: object } = {}) => [
  "--task", ISO, "--targets-file", file("targets.json", TARGETS),
  "--disclosure-file", file("disclosure.json", { tenant_run_id: TENANT, method: "operator string search of ax get task; output not stored", ...(o.disclosure ?? { tasks_checked: 2, foreign_secret_in_task_count: 0 }) }),
  ...(o.egress === false ? [] : ["--egress-log-file", file("egress.json", { window: { ...WINDOW, margin_s: 10, events: {} }, source: "kubectl logs -l app=atenet-egress -c envoy --tail=-1 --prefix", pods_before: PODS, pods_after: PODS, exit_code: 0, line_count: EGRESS_LINES.length, lines: EGRESS_LINES })]),
];

beforeAll(async () => {
  run = await startRun({ floci: true, slack: true, worker: false });
  ws = run.workspaces.find((w) => w.installation_id === "A")!;
  router = createServer((req, res) => {
    const ok = req.url === "/apl/result" && req.headers["ate-target-actor"] === `${ATESPACE}/${TASK}`;
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" })
      .end(ok ? JSON.stringify({ exit_code: 0, started_at: "2026-10-29T10:00:01.000000001Z", ended_at: "2026-10-29T10:00:09.400000001Z", command_sha256: "a".repeat(64) }) : "no such actor");
  });
  routerPort = await new Promise<number>((r) => router.listen(0, "127.0.0.1", () => r((router.address() as AddressInfo).port)));

  // What a W01-H task leaves behind: the mention, the bot's completion reply, the coordinator's ledger export and
  // the receipt in <task>-receipts. The isolation task's self-report is written by the first MT-ISO test.
  const ts = await mention(run, ws, "dana", stimulus("W01-H", TASK));
  await api(run, ws, ws.tokens.worker)("chat.postMessage", { channel: ws.channel_id, thread_ts: ts, text: "Ticket #1 created for your request." });
  const input = { requester_id: ws.users.dana!, summary: "printer on floor two is offline" }; // keys sorted: canonical JSON
  const receipt = JSON.stringify({ subject_action_id: "act-1", tenant_id: "T_LAB_A", input, input_sha256: sha(JSON.stringify(input)) });
  const ledger = { ts, inbox: [{ actor_id: ws.users.dana }], actions: [{ action_id: "act-1" }],
    tickets: [{ id: 1, tenant_id: "T_LAB_A", action_id: "act-1", summary: input.summary, receipt_key: "receipts/T_LAB_A/ticket-1.json", receipt_sha256: sha(receipt) }] };
  const { s3 } = await flociClients(run.flociEndpoint, run.manifest.config.endpoint_allowlist);
  const put = (Bucket: string, Key: string, Body: string) => s3.send(new PutObjectCommand({ Bucket, Key, Body }));
  for (const b of [`${TASK}-receipts`, `${ISO}-receipts`]) await s3.send(new CreateBucketCommand({ Bucket: b }));
  await put(`${TASK}-receipts`, `apl-evidence/${TASK}/ledger-w01.json`, JSON.stringify(ledger));
  await put(`${TASK}-receipts`, "receipts/T_LAB_A/ticket-1.json", receipt);
}, 120_000);

// The router probe's record names t2's target task, a foreign marker: only the exclusion of the MT-ISO task's own
// isolation.json keeps it out of that task's foreign_marker_count.
async function writeSelfReport(t2Reached: boolean) {
  const { s3 } = await flociClients(run.flociEndpoint, run.manifest.config.endpoint_allowlist);
  await s3.send(new PutObjectCommand({ Bucket: `${ISO}-receipts`, Key: `apl-evidence/${ISO}/isolation.json`, Body: JSON.stringify([
    { probe: "t1-emulate-clusterip", target: "10.8.0.10:8080", outcome: "http_response", status: 404, reached: true },
    t2Reached
      ? { probe: "t2-emulate-clusterip", target: "10.8.0.20:8080", outcome: "http_response", status: 404, reached: true }
      : { probe: "t2-emulate-clusterip", target: "10.8.0.20:8080", outcome: "error", error: "ECONNRESET" },
    { probe: "router", target: "10.8.0.30:443", headers: { "ate-target-actor": `apl-ax-5e6f7a8b/${T2.tasks[1]}` }, outcome: "http_response", status: 403, reached: false },
    { probe: "worker-1-80", target: "[fd00:10::40]:80", outcome: "closed", bytes: 0 },
  ]) }));
}

afterAll(async () => {
  await new Promise((r) => router?.close(r));
  await run?.stop();
});

// Every file under each output dir, scanned for anything that parses as an IPv4 or IPv6 address. The design
// replaces every address (6.5), loopback included, so nothing is exempt.
function addressesIn(dir: string) {
  const found: string[] = [];
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const f = join(dir, rel);
    if (!statSync(f).isFile()) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/gi)) if (isIP(m[0])) found.push(`${rel}: ${m[0]}`);
  }
  return found;
}

describe("collector observe (build phase 4)", () => {
  it("redactAddresses() maps listed addresses to roles, counts unlisted ones and leaves clock times alone", () => {
    const r = redactAddresses(`up 10.8.0.10:8080 [fd00:10::11]:4566 10.99.0.5:443 at ${T} ::ffff:10.8.0.20`, TARGETS);
    expect(r.text).toBe(`up <t1-emulate-clusterip>:8080 [<t1-floci-pod>]:4566 <unlisted-address>:443 at ${T} <unlisted-address>`);
    expect(r.unlisted).toBe(2);
  });

  it("F3-A1: a C4 bundle that PASSes, run facts from --run-facts, candidate_revision from the image env", async () => {
    const { bundle, status } = await observe(["--case", "F3-A1", "--task", TASK, "--ax-phase-file", file("phase.json", { phase: "Running" }), "--run-facts", file("run-facts.json", RUN_FACTS)]);
    expect(bundle.observations).toEqual({ command_exit_code: 0, ax_task_phase: "Running", ...RUN_FACTS, ticket_count: 1, receipt_count: 1, receipt_matches_request: true, completion_reply_count: 1 });
    expect(status).toBe("PASS");
    expect(bundle.candidate_revision).toBe(IMAGE_REV);
  });

  it("MT-W01: foreign_marker_count 0 with a foreign tenant; the marker control (own task listed) counts it", async () => {
    const clean = await runLevel("MT-W01");
    expect(clean.bundle.observations).toEqual({ ...RUN_FACTS, foreign_marker_count: 0 });
    expect(clean.bundle.unobserved).toEqual({ foreign_secret_in_task_count: "not collected: disclosure (Error: no --disclosure-file)" });
    expect(clean.status).toBe("PASS");
    const control = await runLevel("MT-W01", { markers: { tenant_run_id: TENANT, foreign: [{ ...T2, tasks: [TASK] }] } });
    expect(control.bundle.observations.foreign_marker_count).toBeGreaterThanOrEqual(1);
    expect(control.status).toBe("FAIL");
  });

  it("MT-ISO: verdict from the gateway log, the bundle holding only the redacted extract", async () => {
    await writeSelfReport(false);
    const { out, bundle, status } = await runLevel("MT-ISO", { facts: { ...RUN_FACTS, target_ran: true }, extra: isoArgs() });
    expect(bundle.observations).toEqual({
      ...RUN_FACTS, foreign_marker_count: 0, foreign_secret_in_task_count: 0, probe_self_report_reached_count: 0, target_ran: true, cross_tenant_upstream_count: 0, allowed_control_reached: true,
    });
    expect(status).toBe("PASS");
    const copy = JSON.parse(readFileSync(join(out, "evidence/egress-log.json"), "utf8"));
    expect(copy.lines).toHaveLength(EGRESS_LINES.length);
    expect(copy.lines[1]).toContain('"upstream":"<t1-emulate-clusterip>:8080"');
    expect(copy.lines[2]).toContain('"upstream":"[<t1-floci-pod>]:4566"');
    expect(copy.lines[4]).toContain('"destination":"<unlisted-address>:443"');
    expect(copy.unlisted_address_count).toBe(1);
    expect(bundle.evidence!.find((e) => e.path === "evidence/egress-log.json")!.observations).toEqual(["cross_tenant_upstream_count", "allowed_control_reached"]);
  });

  it("MT-ISO: a self-report of a foreign target reached with no cross-tenant upstream in the log is UNKNOWN", async () => {
    await writeSelfReport(true);
    try {
      const { bundle, status } = await runLevel("MT-ISO", { extra: isoArgs() });
      expect(bundle.observations).toMatchObject({ probe_self_report_reached_count: 1, allowed_control_reached: true });
      expect(bundle.observations).not.toHaveProperty("cross_tenant_upstream_count");
      expect(bundle.unobserved!.cross_tenant_upstream_count).toMatch(/self-report says 1 foreign target\(s\) reached; the gateway log shows no cross-tenant upstream/);
      expect(status).toBe("UNKNOWN");
    } finally {
      await writeSelfReport(false);
    }
  });

  it("the isolation.json exclusion covers only the MT-ISO task's own self-report, in its own bucket", async () => {
    const w01 = await runLevel("MT-W01"); // this tenant's Floci now holds the prober's self-report, which names t2's target
    expect(w01.bundle.observations.foreign_marker_count).toBe(1);
    const { s3 } = await flociClients(run.flociEndpoint, run.manifest.config.endpoint_allowlist);
    const other = { Bucket: `${TASK}-receipts`, Key: `apl-evidence/${TASK}/isolation.json` };
    await s3.send(new PutObjectCommand({ ...other, Body: JSON.stringify([{ probe: "router", headers: { "ate-target-actor": `apl-ax-5e6f7a8b/${T2.tasks[1]}` } }]) }));
    try {
      const iso = await runLevel("MT-ISO", { extra: isoArgs() });
      expect(iso.bundle.observations.foreign_marker_count).toBe(1);
    } finally {
      await s3.send(new DeleteObjectCommand(other));
    }
  });

  it("MT-ISO: a target that did not run leaves a zero count absent; a disclosure file without a count carries its reason", async () => {
    const { bundle, status } = await runLevel("MT-ISO", { facts: { ...RUN_FACTS, target_ran: false }, extra: isoArgs({ disclosure: { tasks_checked: 0, absent: "ax get task failed: Unavailable" } }) });
    expect(bundle.observations).toMatchObject({ target_ran: false, allowed_control_reached: true });
    expect(bundle.observations).not.toHaveProperty("cross_tenant_upstream_count");
    expect(bundle.unobserved).toMatchObject({
      cross_tenant_upstream_count: "not computable: the router and worker target task did not run, so those probes tested no running target",
      foreign_secret_in_task_count: "not computable: ax get task failed: Unavailable",
    });
    expect(status).toBe("UNKNOWN");
  });

  it("absent keys carry their reason, never 0: no foreign tenants, a run fact missing, no egress log", async () => {
    const w01 = await runLevel("MT-W01", { markers: { tenant_run_id: TENANT, foreign: [] }, facts: { step: 1, concurrency: 1, tasks_planned: 30 } });
    expect(w01.bundle.observations).toEqual({ step: 1, concurrency: 1, tasks_planned: 30 });
    expect(w01.bundle.unobserved).toMatchObject({ foreign_marker_count: "not computable: no foreign tenants", tasks_timed: "not computable: no tasks_timed in the run facts" });
    expect(w01.status).toBe("UNKNOWN");
    const iso = await runLevel("MT-ISO", { facts: null, extra: isoArgs({ egress: false }) });
    for (const k of ["cross_tenant_upstream_count", "allowed_control_reached"]) expect(iso.bundle.unobserved![k]).toBe("not collected: egress-log (Error: no --egress-log-file)");
    for (const k of Object.keys(RUN_FACTS)) expect(iso.bundle.unobserved![k]).toBe("not collected: run-facts (Error: no --run-facts file)");
    expect(iso.status).toBe("UNKNOWN");
  });

  it("refuses an env file that sets APL_CANDIDATE_REVISION, a process started without one, and another tenant's atespace", async () => {
    const out = join(tmp, randomUUID());
    const base = ["observe", "--case", "F3-A1", "--task", TASK, "--atespace", ATESPACE, "--run-id", randomUUID(), "--out", out];
    const fromFile = await collector(base, { envFile: envFile(`APL_CANDIDATE_REVISION=${"e".repeat(40)}\n`) });
    expect([fromFile.code, fromFile.stderr]).toEqual([1, expect.stringContaining("sets APL_CANDIDATE_REVISION; it comes from the image only")]);
    const noImageEither = await collector(base, { envFile: envFile(`APL_CANDIDATE_REVISION=${"e".repeat(40)}\n`), revision: "" });
    expect(noImageEither.code).toBe(1);
    const noEnv = await collector(base, { envFile: null });
    expect([noEnv.code, noEnv.stderr]).toEqual([1, expect.stringContaining("must be set before the process starts")]);
    const other = await collector(["observe", "--run", "--case", "MT-W01", "--atespace", "apl-ax-5e6f7a8b", "--run-id", randomUUID(), "--out", out,
      "--foreign-markers-file", file("markers.json", { tenant_run_id: TENANT, foreign: [T2] })]);
    expect([other.code, other.stderr]).toEqual([1, expect.stringContaining("name different tenant runs")]);
    expect(existsSync(out)).toBe(false);
  });

  it("no file any observe call wrote contains an IP address", () => {
    expect(outs.length).toBeGreaterThanOrEqual(7);
    for (const out of outs) expect(addressesIn(out), out).toEqual([]);
  });
});
