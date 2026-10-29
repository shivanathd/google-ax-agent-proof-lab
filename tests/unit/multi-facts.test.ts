// Phase 2 gate (docs/MULTI_CLUSTER_BUILD.md §3): the pure fact functions of profiles/ax/multi-facts.ts. Gateway
// log lines are built from the vendored access-log formats, so a change to the fixture changes these lines.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agrees, commandDuration, crossTenantUpstreams, egressExtractArgs, foreignMarkerCount, p50, parseEgressLog, serverIntervals,
  type EgressExtract,
} from "../../profiles/ax/multi-facts.ts";

const FIXTURE = readFileSync(join(import.meta.dirname, "../../profiles/ax/tests/fixtures/atenet-egress-access-log.yaml"), "utf8");
const LEGS = ["connect", "clienthello", "mitm", "cleartext", "passthrough"] as const;
const legBlock = (leg: string) => FIXTURE.split(new RegExp(`^  ${leg}:$`, "m"))[1]!.split(/^ {2}\w+:$/m)[0]!;

// The json_format keys of one leg, in fixture order (json_format is the last mapping of each leg's block).
function jsonKeys(leg: string) {
  const lines = legBlock(leg).split("\n");
  const i = lines.findIndex((l) => l.trim() === "json_format:");
  return lines.slice(i + 1).filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => /^\s+(\w+):/.exec(l)![1]!);
}

const T = "2026-10-29T10:00:30.000Z";
const WINDOW = { from: "2026-10-29T10:00:00.000Z", to: "2026-10-29T10:01:00.000Z" };
function line(leg: (typeof LEGS)[number], v: Record<string, string | null> = {}, pod = "atenet-egress-aaaa") {
  if (leg === "connect") {
    const fmt = /inline_string: "(.*)\\n"/.exec(legBlock("connect"))![1]!;
    return `[pod/${pod}/envoy] ${fmt.replace(/%[^%]+%/g, "-")}`;
  }
  const obj = Object.fromEntries(jsonKeys(leg).map((k) => [k, k === "leg" ? leg : k === "time" ? (v.time ?? T) : k in v ? v[k] : "-"]));
  return `[pod/${pod}/envoy] ${JSON.stringify(obj)}`;
}

const OWN = { emulate: ["10.8.0.10", "10.4.1.7"], floci: ["10.8.0.11", "10.4.1.8"] };
const PODS = [{ name: "atenet-egress-aaaa", restarts: 0 }, { name: "atenet-egress-bbbb", restarts: 0 }];
const control = line("mitm", { upstream: "10.8.0.10:8080", status: "404" });
const extract = (lines: string[], o: Partial<EgressExtract> = {}): EgressExtract => ({ window: WINDOW, pods_before: PODS, pods_after: PODS, exit_code: 0, lines, ...o });

describe("foreignMarkerCount() (design 6.3)", () => {
  const token = (s: string) => `xoxb-${s}-0000000000`;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const t2 = { tenant_run_id: "5e6f7a8b-0000-4000-8000-000000000002", run_ids: ["9a9a9a9a-0000-4000-8000-000000000009"], tasks: ["apl-5e6f7a8b-01"], token_sha256: [sha(token("t2reader")), sha(token("t2worker"))] };

  it("finds a foreign run ID, task name and token, and none in clean items", () => {
    const r = foreignMarkerCount({
      "slack/1": `ticket for ${t2.run_ids[0]}`, "slack/2": "reply from apl-5e6f7a8b-01", "floci/a.json": `{"t":"${token("t2reader")}"}`,
      "slack/3": "own text apl-1a2b3c4d-01 and own token " + token("t1reader"),
    }, [t2]);
    expect(r).toMatchObject({ value: 3 });
    expect("found" in r && r.found.map((h) => [h.item, h.kind])).toEqual([["slack/1", "run_id"], ["slack/2", "task"], ["floci/a.json", "token"]]);
    expect(JSON.stringify(r)).not.toContain(token("t2reader"));
    expect(foreignMarkerCount({ "slack/1": "nothing foreign here" }, [t2])).toEqual({ value: 0, found: [] });
  });

  it("ignores a marker that appears only in an excluded file", () => {
    const iso = "apl-evidence/apl-1a2b3c4d-iso/isolation.json";
    expect(foreignMarkerCount({ [iso]: `probe of ${t2.tasks[0]}`, "slack/1": "clean" }, [t2], [iso])).toEqual({ value: 0, found: [] });
  });

  it("is absent, never 0, when no other tenant run is registered", () => {
    expect(foreignMarkerCount({ "slack/1": "anything" }, [])).toEqual({ absent: "no foreign tenants" });
  });

  it("finds two tokens in one text (global copies of SECRET_RULES)", () => {
    const r = foreignMarkerCount({ "slack/1": `${token("t2reader")} then ${token("t2worker")}` }, [t2]);
    expect("found" in r && r.found.map((h) => h.marker)).toEqual(t2.token_sha256);
  });
});

describe("parseEgressLog() and cross_tenant_upstream_count (build §9.3)", () => {
  it("parses a line built from each of the fixture's five formats", () => {
    expect(jsonKeys("mitm")).toEqual(["leg", "time", "actor", "sni", "authority", "method", "path", "protocol", "status", "grpc_status", "flags", "duration_ms", "bytes_sent", "bytes_rcvd", "upstream", "upstream_failure", "termination"]);
    const entries = parseEgressLog(LEGS.map((l) => line(l, { upstream: "10.9.0.1:4566" })), WINDOW);
    expect(entries.map((e) => [e.leg, e.pod, e.upstream])).toEqual([
      ["connect", "atenet-egress-aaaa", null], ["clienthello", "atenet-egress-aaaa", null], ["mitm", "atenet-egress-aaaa", "10.9.0.1"],
      ["cleartext", "atenet-egress-aaaa", "10.9.0.1"], ["passthrough", "atenet-egress-aaaa", "10.9.0.1"],
    ]);
  });

  it("strips ip:port to the address, counts no null or - upstream and no own address, and drops lines outside the window", () => {
    const lines = [
      line("connect"), control, line("cleartext", { upstream: "10.4.1.8:4566", status: "404" }),
      line("mitm", { upstream: null, status: "403" }), line("cleartext", { upstream: "-", status: "403" }),
      line("clienthello", { destination: "10.8.9.9:8080" }),
      line("passthrough", { upstream: "10.8.9.9:8080" }), line("mitm", { upstream: "[fd00::5]:8080", status: "404" }),
      line("mitm", { upstream: "10.8.7.7:8080", time: "2026-10-29T09:00:00.000Z" }),
    ];
    expect(crossTenantUpstreams(extract(lines), OWN, 0)).toEqual({ cross_tenant_upstream_count: { value: 2 }, allowed_control_reached: { value: true } });
    expect(crossTenantUpstreams(extract([control, line("cleartext", { upstream: "10.8.0.11:4566" })]), OWN, 0).cross_tenant_upstream_count).toEqual({ value: 0 });
  });

  it("gives absent with the reason for an incomplete extract or a self-report the log does not back", () => {
    const absent = (x: EgressExtract, self = 0) => crossTenantUpstreams(x, OWN, self);
    expect(absent(extract([control], { pods_after: [PODS[0]!] }))).toEqual({
      cross_tenant_upstream_count: { absent: "incomplete extract: gateway pod set changed during the window" },
      allowed_control_reached: { absent: "incomplete extract: gateway pod set changed during the window" },
    });
    expect(absent(extract([control], { pods_after: [PODS[0]!, { ...PODS[1]!, restarts: 1 }] })).allowed_control_reached)
      .toEqual({ absent: "incomplete extract: gateway pod restart count changed during the window" });
    expect(absent(extract([line("cleartext", { upstream: "10.8.0.11:4566" })])).cross_tenant_upstream_count)
      .toEqual({ absent: "incomplete extract: allowed control's gateway entry missing from the window" });
    expect(absent(extract([control], { exit_code: 1 })).cross_tenant_upstream_count).toEqual({ absent: "incomplete extract: kubectl logs exited 1" });
    expect(absent(extract([control]), 1)).toEqual({
      cross_tenant_upstream_count: { absent: "self-report says 1 foreign target(s) reached; the gateway log shows no cross-tenant upstream" },
      allowed_control_reached: { value: true },
    });
    // A count above 0 stands whatever the self-report says.
    expect(absent(extract([control, line("mitm", { upstream: "10.8.9.9:8080" })]), 0).cross_tenant_upstream_count).toEqual({ value: 1 });
  });

  it("truncation fixture: a 25-line extract from two pods is parsed whole; the extract command always carries --tail=-1, --prefix and --max-log-requests", () => {
    // 13 and 12 lines: more than the 10 per pod that `kubectl logs -l` keeps without --tail.
    const lines = Array.from({ length: 25 }, (_, i) => line(i % 3 ? "mitm" : "cleartext", { upstream: `10.8.0.${i % 2 ? 10 : 11}:8080`, status: "404" }, PODS[i % 2]!.name));
    const entries = parseEgressLog(lines, WINDOW);
    expect(entries).toHaveLength(25);
    expect(entries.filter((e) => e.pod === "atenet-egress-aaaa")).toHaveLength(13);
    expect(entries.filter((e) => e.pod === "atenet-egress-bbbb")).toHaveLength(12);
    expect(crossTenantUpstreams(extract(lines), OWN, 0).cross_tenant_upstream_count).toEqual({ value: 0 });

    const args = egressExtractArgs({ kubeconfig: "/run/kubeconfig", from: WINDOW.from, pods: PODS });
    expect(args).toEqual(["--kubeconfig", "/run/kubeconfig", "-n", "ate-system", "logs", "-l", "app=atenet-egress", "-c", "envoy",
      `--since-time=${WINDOW.from}`, "--tail=-1", "--prefix", "--max-log-requests=2"]);
    expect(() => egressExtractArgs({ kubeconfig: "/run/kubeconfig", from: WINDOW.from, pods: [] })).toThrow(/--max-log-requests/);
    expect(() => egressExtractArgs({ kubeconfig: "", from: WINDOW.from, pods: PODS })).toThrow(/refusing/);
    expect(() => egressExtractArgs({ kubeconfig: "/run/kubeconfig", from: "yesterday", pods: PODS })).toThrow(/--since-time/);
  });
});

describe("timing (build §12)", () => {
  const resume = (t: string, task: string) => `time=${t} level=INFO msg="resuming actor on Substrate worker" actor=${task} worker=w-1`;
  const running = (t: string, task: string, ready = "true") => `time=${t} level=INFO msg="task successfully reconciled and running" actor=${task} workspaceReady=${ready}`;

  it("serverIntervals() measures resume to running per actor, and is absent on workspaceReady=false or a missing line", () => {
    const log = [
      resume("2026-10-29T10:00:00.000Z", "apl-1a2b3c4d-01"), resume("2026-10-29T10:00:00.100Z", "apl-1a2b3c4d-02"),
      running("2026-10-29T10:00:02.100Z", "apl-1a2b3c4d-01"), running("2026-10-29T10:00:15.200Z", "apl-1a2b3c4d-02", "false"),
      resume("2026-10-29T10:00:01.000Z", "apl-1a2b3c4d-03"),
    ].join("\n");
    expect(serverIntervals(log, ["apl-1a2b3c4d-01", "apl-1a2b3c4d-02", "apl-1a2b3c4d-03", "apl-1a2b3c4d-04"])).toEqual({
      "apl-1a2b3c4d-01": { value: 2100 },
      "apl-1a2b3c4d-02": { absent: "workspaceReady=false on the running line" },
      "apl-1a2b3c4d-03": { absent: 'no "task successfully reconciled and running" line after the resume' },
      "apl-1a2b3c4d-04": { absent: 'no "resuming actor on Substrate worker" line' },
    });
  });

  it("commandDuration() reads ended_at - started_at from a result.json", () => {
    const result = { exit_code: 0, started_at: "2026-10-29T10:00:00.123456789Z", ended_at: "2026-10-29T10:00:08.523987654Z", command_sha256: "0".repeat(64) };
    expect(commandDuration(result)).toEqual({ value: 8400 });
    expect(commandDuration(undefined)).toEqual({ absent: "result.json absent" });
    expect(commandDuration({ started_at: "x" })).toEqual({ absent: "result.json has no valid started_at and ended_at" });
  });

  it("p50() is the nearest rank at n = 29, 30 and 32", () => {
    const shuffled = (n: number) => Array.from({ length: n }, (_, i) => ((i * 7) % n) + 1);
    expect(p50(shuffled(29))).toBe(15);
    expect(p50(shuffled(30))).toBe(15);
    expect(p50(shuffled(32))).toBe(16);
    expect(p50([])).toBeNull();
  });
});

describe("agrees() (build §11.2)", () => {
  it("decides every evaluate/report pair by the agreement rule", () => {
    const evals = {
      PASS: { status: "PASS", reasons: [] }, "FAIL missing": { status: "FAIL", reasons: ["Missing observation: ticket_count", "Missing observation: command_exit_code"] },
      "FAIL other": { status: "FAIL", reasons: ["Missing observation: ticket_count", "Unexpected observation: receipt_count"] }, BLOCKED: { status: "BLOCKED", reasons: ["stopped"] },
    } as const;
    const reports = ["PASS", "FAIL", "UNKNOWN", "BLOCKED", "NOT_RUN"] as const;
    const table = Object.fromEntries(Object.entries(evals).map(([name, e]) => [name, reports.filter((r) => agrees({ status: e.status, reasons: [...e.reasons] }, r))]));
    expect(table).toEqual({ PASS: ["PASS"], "FAIL missing": ["FAIL", "UNKNOWN"], "FAIL other": ["FAIL"], BLOCKED: ["BLOCKED", "NOT_RUN"] });
    expect(agrees({ status: "FAIL", reasons: [] }, "UNKNOWN")).toBe(false);
  });
});
