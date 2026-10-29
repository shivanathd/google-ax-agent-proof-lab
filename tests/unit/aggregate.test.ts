// Phase 2 gate (docs/MULTI_CLUSTER_BUILD.md §3, §11.4): the set roll-up in src/reports/aggregate.ts.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollUp, timingSummary, writeAggregate, type Plan } from "../../src/reports/aggregate.ts";
import { verifyChecksums, type Status } from "../../src/reports/report.ts";

// Two clusters, one tenant run each: a warm-up F3-A1, two counted F3-A1 and one MT-W01.
function plan(): Plan {
  const tenantRun = (cluster: string) => ({
    kind: "configuration", tenant: "t1", tenant_run_id: `tr-${cluster}`, tasks: ["00", "01", "02"].map((n) => `apl-${cluster}0000000-${n}`),
    bundles: [
      ...["00", "01", "02"].map((n) => ({ run_id: `${cluster}-${n}`, case: "F3-A1", task: `apl-${cluster}0000000-${n}` })),
      { run_id: `${cluster}-mt`, case: "MT-W01", task: null },
    ],
  });
  return { set_id: "set-1", step: 2, configurations: [{ cluster: "a", c: 1, tenant_runs: [tenantRun("a")] }, { cluster: "b", c: 1, tenant_runs: [tenantRun("b")] }] };
}
const allPass = () => Object.fromEntries(plan().configurations.flatMap((c) => c.tenant_runs.flatMap((t) => t.bundles.map((b) => [b.run_id, { status: "PASS" as Status }]))));

describe("set roll-up (build §11.4)", () => {
  it("one FAIL among PASS rows gives FAIL", () => {
    const r = rollUp(plan(), { ...allPass(), "b-01": { status: "FAIL" } });
    expect(r.overall).toBe("FAIL");
    expect(r.line).toBe("all clusters: FAIL (A PASS, 3 reports; B FAIL, 3 reports)");
  });

  it("a missing planned row gives NOT_RUN, never dropped", () => {
    const { "a-mt": _, ...reports } = allPass();
    const r = rollUp(plan(), reports);
    expect(r.rows.find((x) => x.run_id === "a-mt")).toMatchObject({ status: "NOT_RUN", reason: "planned, no report" });
    expect(r.rows).toHaveLength(8);
    expect(r.overall).toBe("NOT_RUN");
    expect(r.line).toBe("all clusters: NOT_RUN (A NOT_RUN, 3 reports; B PASS, 3 reports)");
  });

  it("UNKNOWN outranks BLOCKED", () => {
    const r = rollUp(plan(), { ...allPass(), "a-01": { status: "BLOCKED" }, "b-02": { status: "UNKNOWN" } });
    expect(r.clusters.map((c) => c.status)).toEqual(["BLOCKED", "UNKNOWN"]);
    expect(r.overall).toBe("UNKNOWN");
    expect(rollUp(plan(), { ...allPass(), "a-01": { status: "BLOCKED" }, "a-02": { status: "UNKNOWN" } }).tenants[0]!.status).toBe("UNKNOWN");
  });

  it("all PASS gives PASS with every cluster named, and the warm-up is listed but not counted", () => {
    const r = rollUp(plan(), { ...allPass(), "a-00": { status: "FAIL" } });
    expect(r.overall).toBe("PASS");
    expect(r.line).toBe("all clusters: PASS (A PASS, 3 reports; B PASS, 3 reports)");
    expect(r.rows.find((x) => x.run_id === "a-00")).toMatchObject({ warmup: true, status: "FAIL" });
  });

  it("timing.json: nearest-rank p50 and max per headline, actual n below 30 flagged, warm-up apart", () => {
    const task = (n: string, round: number, ms: number) => ({ cluster: "a", c: 1, round, task: `apl-a0000000-${n}`, server_resume_to_running_ms: ms, command_duration_ms: ms * 4 });
    const t = timingSummary(plan(), { tasks: [task("00", 0, 9000), task("01", 1, 2100), task("02", 2, 2600)], rounds: [{ cluster: "a", c: 1, round: 0, resume_spread_ms: 0 }, { cluster: "a", c: 1, round: 1, resume_spread_ms: 0 }] });
    expect(t.configurations[0]).toMatchObject({
      cluster: "a", step: 2, c: 1, server_resume_to_running_ms: { n: 2, p50: 2100, max: 2600, n_below_planned: true },
      command_duration_ms: { n: 2, p50: 8400, max: 10400 }, resume_spread_ms: { p50: 0, max: 0 },
      tenants: { t1: { server_resume_to_running_ms: { p50: 2100, max: 2600 } } }, warmup: [{ task: "apl-a0000000-00", server_resume_to_running_ms: 9000 }],
    });
  });

  it("writes the four files with checksums, and quarantines on a private term", () => {
    const dir = mkdtempSync(join(tmpdir(), "apl-aggregate-"));
    const terms = join(dir, "terms.txt");
    writeFileSync(terms, "\n");
    const ok = writeAggregate(plan(), allPass(), { tasks: [], rounds: [] }, { termsPath: terms, outRoot: join(dir, "out"), quarantineRoot: join(dir, "q") });
    expect(ok.status).toBe("EXPORTED");
    expect(verifyChecksums(join(dir, "out", "set-1"))).toEqual({ ok: true, problems: [] });
    expect(readFileSync(join(dir, "out", "set-1", "aggregate.md"), "utf8")).toContain("all clusters: PASS (A PASS, 3 reports; B PASS, 3 reports)");
    writeFileSync(terms, "apl-b0000000\n");
    expect(writeAggregate(plan(), allPass(), { tasks: [], rounds: [] }, { termsPath: terms, outRoot: join(dir, "out2"), quarantineRoot: join(dir, "q") }))
      .toMatchObject({ status: "QUARANTINED", output: null, findings: [{ file: "aggregate.json", rule: "private-term" }, { file: "aggregate.md", rule: "private-term" }] });
  });
});
