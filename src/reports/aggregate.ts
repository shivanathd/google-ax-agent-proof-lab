// Set roll-up for the many-tenant and two-cluster AX runs (docs/MULTI_CLUSTER_BUILD.md §11.4). It judges nothing:
// one row per planned bundle with its report's status (NOT_RUN, never dropped, when there is no report), then
// tenant, configuration, cluster and overall rows by aggregate() from report.ts. The overall line names every
// cluster, so no single green banner can stand for two clusters (design 8.4).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "../config/run-config.ts";
import { SECRET_RULES, holdsAddress, privateTermsPath } from "./export.ts";
import { aggregate, writeChecksums, type Status } from "./report.ts";

// plan.json and timing-raw.json, as far as the roll-up reads them (build Appendix A).
export interface Plan {
  set_id: string; step: number;
  configurations: { cluster: string; c: number; tenant_runs: { kind: string; tenant: string; tenant_run_id: string; tasks: string[]; bundles: { run_id: string; case: string; task: string | null }[] }[] }[];
}
const TASK_KEYS = ["server_resume_to_running_ms", "command_duration_ms", "egress_attach_ms", "submit_to_result_ms", "empty_exec_ms"] as const;
type TimingTask = { cluster: string; c: number; round: number; task: string } & Partial<Record<(typeof TASK_KEYS)[number], number>>;
export interface TimingRaw {
  tasks: TimingTask[]; rounds: { cluster: string; c: number; round: number; resume_spread_ms: number }[];
  rounds_absent?: { cluster: string; c: number; round: number; resume_spread_ms: string }[];
}

// Task `00` of a tenant run is its warm-up (build §7): listed, never counted.
const isWarmup = (task: string | null) => task?.endsWith("-00") ?? false;

export function rollUp(plan: Plan, reports: Record<string, { status: Status } | undefined>) {
  const rows = plan.configurations.flatMap((cfg, configuration) => cfg.tenant_runs.flatMap((tr) => tr.bundles.map((b) => {
    const r = reports[b.run_id];
    return {
      cluster: cfg.cluster, configuration, c: cfg.c, kind: tr.kind, tenant: tr.tenant, tenant_run_id: tr.tenant_run_id,
      run_id: b.run_id, case: b.case, task: b.task, warmup: isWarmup(b.task),
      status: r?.status ?? ("NOT_RUN" as Status), reason: r ? null : "planned, no report",
    };
  })));
  const counted = rows.filter((r) => !r.warmup);
  const tenants = plan.configurations.flatMap((cfg, configuration) => cfg.tenant_runs.map((tr) => ({
    cluster: cfg.cluster, configuration, c: cfg.c, kind: tr.kind, tenant: tr.tenant, tenant_run_id: tr.tenant_run_id,
    status: aggregate(counted.filter((r) => r.configuration === configuration && r.tenant_run_id === tr.tenant_run_id).map((r) => r.status)),
  })));
  const configurations = plan.configurations.map((cfg, configuration) => ({
    cluster: cfg.cluster, configuration, c: cfg.c, status: aggregate(tenants.filter((t) => t.configuration === configuration).map((t) => t.status)),
  }));
  const clusters = [...new Set(plan.configurations.map((c) => c.cluster))].sort().map((cluster) => ({
    cluster, status: aggregate(configurations.filter((c) => c.cluster === cluster).map((c) => c.status)),
    reports: counted.filter((r) => r.cluster === cluster && r.reason === null).length, planned: counted.filter((r) => r.cluster === cluster).length,
  }));
  const overall = aggregate(clusters.map((c) => c.status));
  const line = `all clusters: ${overall} (${clusters.map((c) => `${c.cluster.toUpperCase()} ${c.status}, ${c.reports} of ${c.planned} planned reports`).join("; ")})`;
  return { set_id: plan.set_id, step: plan.step, overall, line, clusters, configurations, tenants, rows };
}

export function aggregateMarkdown(a: ReturnType<typeof rollUp>) {
  return [
    `# Set ${a.set_id}: step ${a.step}`, "", `> ${a.line}`, "",
    "| Cluster | c | Tenant | Kind | Status |", "|---|---|---|---|---|",
    ...a.tenants.map((t) => `| ${t.cluster} | ${t.c} | ${t.tenant} | ${t.kind} | ${t.status} |`), "",
    "| Run | Case | Task | Cluster | Tenant | Status | Reason |", "|---|---|---|---|---|---|---|",
    ...a.rows.map((r) => `| ${r.run_id} | ${r.case} | ${r.task ?? "—"}${r.warmup ? " (warm-up, not counted)" : ""} | ${r.cluster} | ${r.tenant} | ${r.status} | ${r.reason ?? ""} |`), "",
  ].join("\n");
}

// Nearest rank: the ⌈n/2⌉-th smallest value (the 15th of 30, the 16th of 32), no interpolation; null when empty.
export const p50 = (xs: number[]): number | null => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length / 2) - 1]! : null);

const stat = (xs: number[]) => ({ p50: p50(xs), max: xs.length ? Math.max(...xs) : null });
const headline = (xs: number[], planned: number) => ({ n: xs.length, ...stat(xs), ...(xs.length < planned ? { n_below_planned: true } : {}) });
const values = (rows: TimingTask[], k: (typeof TASK_KEYS)[number]) => rows.flatMap((r) => (typeof r[k] === "number" ? [r[k]] : []));

// timing.json (build §12 "Summary"): per configuration of configuration tenant runs, n is the number of counted
// tasks with that headline present, flagged below the configuration's planned counted tasks; per-tenant rows give
// p50 and max only; warm-up tasks are listed apart.
export function timingSummary(plan: Plan, raw: TimingRaw) {
  const configurations = plan.configurations.filter((cfg) => cfg.tenant_runs.some((t) => t.kind === "configuration")).map((cfg) => {
    const tenantOf = new Map(cfg.tenant_runs.flatMap((t) => t.tasks.map((task) => [task, t.tenant] as const)));
    const all = raw.tasks.filter((t) => tenantOf.has(t.task));
    const warm = all.filter((t) => isWarmup(t.task));
    const rows = all.filter((t) => !isWarmup(t.task));
    const warmRounds = new Set(warm.map((t) => t.round));
    const ofCfg = (r: { cluster: string; c: number; round: number }) => r.cluster === cfg.cluster && r.c === cfg.c && !warmRounds.has(r.round);
    const rounds = raw.rounds.filter(ofCfg);
    const planned = cfg.tenant_runs.reduce((n, t) => n + t.tasks.filter((x) => !isWarmup(x)).length, 0);
    const tenants = [...new Set(rows.map((t) => tenantOf.get(t.task)!))].sort();
    return {
      cluster: cfg.cluster, step: plan.step, case: "F3-A1", c: cfg.c,
      server_resume_to_running_ms: headline(values(rows, "server_resume_to_running_ms"), planned),
      command_duration_ms: { ...headline(values(rows, "command_duration_ms"), planned), source: "sandbox-written: the runner's result.json started_at and ended_at" },
      resume_spread_ms: { ...stat(rounds.map((r) => r.resume_spread_ms)), rounds_absent: (raw.rounds_absent ?? []).filter(ofCfg).length },
      operator: { egress_attach_ms: stat(values(rows, "egress_attach_ms")), submit_to_result_ms: stat(values(rows, "submit_to_result_ms")), empty_exec_ms: stat(values(rows, "empty_exec_ms")) },
      tenants: Object.fromEntries(tenants.map((name) => {
        const mine = rows.filter((t) => tenantOf.get(t.task) === name);
        return [name, { server_resume_to_running_ms: stat(values(mine, "server_resume_to_running_ms")), command_duration_ms: stat(values(mine, "command_duration_ms")) }];
      })),
      warmup: warm.map((t) => ({ task: t.task, server_resume_to_running_ms: t.server_resume_to_running_ms ?? null, command_duration_ms: t.command_duration_ms ?? null })),
    };
  });
  return { set_id: plan.set_id, configurations, raw };
}

export interface AggregateResult { status: "EXPORTED" | "QUARANTINED" | "REJECTED"; set_id: string; findings: { file: string; rule: string }[]; output: string | null }

// Writes aggregate.json, aggregate.md, timing.json and checksums.sha256 to docs/evidence/<set_id>/. Each file is
// scanned first with SECRET_RULES, holdsAddress() and the private-terms list, and a finding quarantines the set, as exportRun() does.
export function writeAggregate(plan: Plan, reports: Record<string, { status: Status } | undefined>, raw: TimingRaw,
  o: { termsPath?: string; outRoot?: string; quarantineRoot?: string } = {}): AggregateResult {
  const rolled = rollUp(plan, reports);
  const files: Record<string, string> = {
    "aggregate.json": `${JSON.stringify(rolled, null, 2)}\n`, "aggregate.md": aggregateMarkdown(rolled), "timing.json": `${JSON.stringify(timingSummary(plan, raw), null, 2)}\n`,
  };
  const termsPath = o.termsPath ?? privateTermsPath();
  if (!existsSync(termsPath)) return { status: "REJECTED", set_id: plan.set_id, findings: [{ file: "private-terms.txt", rule: "private-terms-list-missing" }], output: null };
  const terms = readFileSync(termsPath, "utf8").split("\n").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const findings: AggregateResult["findings"] = [];
  for (const [file, text] of Object.entries(files)) {
    for (const [rule, re] of SECRET_RULES) if (re.test(text)) findings.push({ file, rule });
    if (holdsAddress(text)) findings.push({ file, rule: "ip-address" });
    if (terms.some((t) => text.toLowerCase().includes(t))) findings.push({ file, rule: "private-term" });
  }
  const target = findings.length
    ? join(o.quarantineRoot ?? join(ROOT, "private-runs", "quarantine"), `${plan.set_id}-${Date.now()}`)
    : join(o.outRoot ?? join(ROOT, "docs", "evidence"), plan.set_id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(target, name), text);
  if (findings.length) {
    writeFileSync(join(target, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
    return { status: "QUARANTINED", set_id: plan.set_id, findings, output: null };
  }
  writeChecksums(target);
  return { status: "EXPORTED", set_id: plan.set_id, findings: [], output: relative(ROOT, target) };
}
