// The one cluster driver for the many-tenant and two-cluster AX runs (design rule 9; docs/MULTI_CLUSTER_BUILD.md §1).
//   multi.ts plan      --step 1|2 --set-id <uuid> --infra-a <dir> [--infra-b <dir> --step1-set-id <uuid>]
//   multi.ts infra     a|b --infra <dir> [--resize 0|2] [--dry-run]
//   multi.ts run-step  --plan <plan.json> --cluster a|b [--only probe|configuration|mt-iso[,...]] [--dry-run]
//   multi.ts report    --plan <plan.json>
// plan and report refuse --dry-run.
// Every kubectl, kubectl ate, ax, gcloud and teardown.sh call goes through one injectable Exec, after the context
// guard of §8.4, with KUBECONFIG=<run-dir>/kubeconfig in its environment. --dry-run prints every call and makes
// none, except `kubectl config current-context`, which reads only the run dir's kubeconfig (§1.2). Local tooling
// (orchestrate.ts, evaluate_ax.py, doctor()'s client-version probe) touches no cluster and runs directly.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ROOT, fixtureSha256 } from "../../src/config/run-config.ts";
import { assertContract } from "../../src/contracts/validate.ts";
import { type Plan, type TimingRaw, writeAggregate } from "../../src/reports/aggregate.ts";
import { artifactDir, generateReport } from "../../src/reports/artifacts.ts";
import { exportRun } from "../../src/reports/export.ts";
import { type Status, writeChecksums } from "../../src/reports/report.ts";
import { copyBundle } from "./bundle-copy.ts";
import { accessLogBlocks, egressPolicy, gatewayConfigDiff } from "./egress.ts";
import { doctor, render } from "./index.ts";
import { agrees, commandDuration, crossTenantUpstreams, egressExtractArgs, isolationWaitMs, resumeSpread, serverIntervals, type EgressExtract } from "./multi-facts.ts";
import { manifestObjects, markRemoved, ownedResourcesErrors, recordOwned } from "./run-dir.ts";

const AX = join(ROOT, "profiles/ax");
const TEARDOWN = join(AX, "teardown.sh");
const FIXTURE = readFileSync(join(AX, "tests/fixtures/atenet-egress-access-log.yaml"), "utf8");
const COLLECTOR_TR8 = "6882d106";
const COLLECTOR_NS = `apl-ax-${COLLECTOR_TR8}`;
const SUBSTRATE_API = "api.ate-system.svc.cluster.local:443"; // the upstream default named in index.ts
const PORTS: Record<ClusterId, number> = { a: 18480, b: 18481 }; // one ax-server port-forward per cluster (§1.2)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// design 11.1: every report from these runs carries these.
export const LIMITATIONS = [
  "One collector identity per cluster: whether a second, separately allowlisted identity could read another tenant's results through the router is not tested.",
  "One operator identity drives the AX API; a tenant is a namespace, an atespace and an Emulate workspace, not a separately authenticated AX tenant (L-034).",
  "gVisor sandboxes only.",
  "Both clusters are in one project and one VPC.",
  "Isolation is judged only on traffic that leaves the sandbox through the egress gateway.",
  "Isolation verdicts rest on a gateway-log extract the operator copies verbatim into the private set dir; the public MT-ISO export carries a copy with addresses replaced by roles, so the verdict cannot be re-derived from public files.",
  "Cluster B's Substrate uses cluster A's snapshot transfer identity.",
  "The ate-api-server Workload Identity principal is the same identity on both clusters, so its bindings on B's bucket also apply to A's ate-api-server.",
  "One collector Secret holds every current tenant's fake credentials on its cluster.",
];

type ClusterId = "a" | "b";
type Execution = "BLOCKED" | "NOT_RUN";
export interface Call { cmd: string; args: string[]; env: Record<string, string>; input?: string; inputLabel?: string; background?: boolean; local?: boolean }
export interface Result { code: number; stdout: string; stderr: string; alive?: () => boolean; stop?: () => void }
export type Exec = (call: Call) => Promise<Result>;
export interface Deps { exec: Exec; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; runsRoot?: string; evidenceRoot?: string; uuid?: () => string; portFree?: (port: number) => Promise<boolean> }
type D = Required<Deps>;

interface BundleRef { run_id: string; case: string; task: string | null }
interface TenantRun { kind: string; tenant: string; tenant_run_id: string; tr8: string; tasks: string[]; bundles: BundleRef[] }
type Kind = "probe" | "configuration" | "mt-iso";
const KINDS: Kind[] = ["probe", "configuration", "mt-iso"];
interface Configuration { kind: Kind; cluster: ClusterId; c: number; rounds: number; warmup: boolean; tenant_runs: TenantRun[] }
interface Control { kind: "marker" | "egress"; cluster: ClusterId; tenant_run_id: string; task: string | null; run_id: string }
// A `run-step --only` (§4.7): its fresh copies of the configurations it re-ran and of their controls.
interface StepRun { step_run_id: string; only?: Kind[]; created_at?: string; configurations?: Configuration[]; controls?: Control[] }
export interface MultiPlan {
  set_id: string; step: 1 | 2; created_at: string;
  clusters: Partial<Record<ClusterId, { infra_run_dir: string; context: string; step_run_id: string; step_runs?: StepRun[] }>>;
  configurations: Configuration[]; controls: Control[];
  a?: { reused: { set_id: string; c: 1 } } | { rerun: { differences: string[] } };
}
export interface Stopped { run_id: string; case: string; execution: Execution; reason: string; at: string }

// A stop rule (design section 10). scope "set": no further step runs anywhere until the context is resolved (stop
// rule 2); this step's teardown.sh, which keeps its own context guard, still runs (§8.4).
export class Stop extends Error {
  constructor(readonly execution: Execution, reason: string, readonly scope: "step" | "set" = "step") { super(reason); }
}

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const readJsonIf = (f: string) => (existsSync(f) ? readJson(f) : undefined);
const parseJson = (s: string): any => { try { return JSON.parse(s); } catch { return undefined; } };
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const grpcCode = (r: Result) => /code = (\w+)/.exec(`${r.stderr}\n${r.stdout}`)?.[1] ?? `exit ${r.code}`;
// A kubectl-ate or ax listing: a JSON list, or an object whose list is its first array; protojson omits an empty
// repeated field, so an object with no array is an empty list. Unparsable output is no listing at all.
function listItems(s: string): any[] | undefined {
  const j = parseJson(s);
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== "object") return undefined;
  return (Object.values(j).find(Array.isArray) as any[] | undefined) ?? [];
}
const nameOf = (x: any) => String(x?.metadata?.name ?? x?.name);

// ---- infrastructure run dirs ----

interface Infra { dir: string; owned: any; versions: any; project?: string; location?: string; clusterName?: string }
export function readInfra(dir: string): Infra {
  const owned = readJson(join(dir, "owned-resources.json"));
  return { dir, owned, versions: readJsonIf(join(dir, "versions.json")) ?? {}, project: owned.project, location: owned.gke_cluster?.location ?? owned.zone, clusterName: owned.gke_cluster?.name ?? owned.cluster };
}
// B's infrastructure run dir created its cluster (gke_cluster); A's did not. A dir named for the other cluster is refused.
function assertIdentity(id: ClusterId, infra: Infra) {
  if ((id === "b") !== Boolean(infra.owned.gke_cluster)) throw new Error(`${infra.dir} is not cluster ${id}'s infrastructure run dir (${id === "b" ? "no" : "it has a"} gke_cluster)`);
}
function imageRef(infra: Infra, re: RegExp) {
  const i = (infra.owned.images ?? []).find((x: { name: string }) => re.test(x.name));
  if (!i) throw new Error(`no image matching ${re} in the infrastructure run dir's images list`);
  return `${i.name}@${i.digest}`;
}

// §1.2: doctor() on the values of that cluster's infrastructure run dir; only APL_AX_AUTHORIZED is ambient.
async function preflight(infra: Infra, context: string): Promise<string | null> {
  const l = infra.owned.local ?? {};
  if (context !== infra.owned.kube_context) return "the plan's context is not the infrastructure run dir's kube_context";
  if (!l.bin || l.kubectl !== join(l.bin, "kubectl")) return "local.kubectl must be <local.bin>/kubectl in owned-resources.json (build §1.2)";
  const d = await doctor({
    APL_AX_KUBECTL: l.kubectl, APL_AX_CONTEXT: infra.owned.kube_context, APL_AX_IMAGE: infra.versions.lab_image ?? "", APL_AX_CLI: l.ax_cli ?? "",
    APL_AX_SUBSTRATE_API: SUBSTRATE_API, APL_AX_AUTHORIZED: process.env.APL_AX_AUTHORIZED ?? "",
  });
  return d.status === "BLOCKED" ? d.reason : null;
}

// ---- one cluster: the context guard (§8.4) and the guarded calls ----

export class Cluster {
  where = "";
  calls = 0;
  pf?: Result;
  private pfReopened = false;
  private kubeconfigSha?: string;
  onOutput?: (c: Call, out: string) => void;
  constructor(readonly id: ClusterId, readonly context: string, readonly runDir: string, readonly infra: Infra, private d: D, readonly dry: boolean) {}
  get kubeconfig() { return join(this.runDir, "kubeconfig"); }
  get kubectlBin(): string { return this.infra.owned.local?.kubectl ?? ""; }
  get axCli(): string { return this.infra.owned.local?.ax_cli ?? ""; }
  env(): Record<string, string> {
    return { PATH: [this.infra.owned.local?.bin, process.env.PATH].filter(Boolean).join(":"), HOME: process.env.HOME ?? "", KUBECONFIG: this.kubeconfig, AX_HOME: join(this.runDir, "axhome") };
  }

  guard(c: Call) {
    const refuse = (what: string): never => { throw new Stop("BLOCKED", `stop rule 2: context guard refused a call on cluster ${this.id}: ${what}`, "set"); };
    const flag = (n: string) => { const i = c.args.indexOf(n); return i < 0 ? undefined : c.args[i + 1]; };
    if (c.env.KUBECONFIG !== this.kubeconfig) refuse("KUBECONFIG is not this cluster's run-dir kubeconfig");
    if (c.cmd === this.kubectlBin) {
      if (flag("--kubeconfig") !== this.kubeconfig) refuse("--kubeconfig is not this cluster's");
      if (!c.local && this.kubeconfigSha !== sha256(readFileSync(this.kubeconfig))) refuse("the kubeconfig's context was not checked, or the file changed since");
    } else if (c.cmd === this.axCli) {
      if (flag("--server") !== `http://127.0.0.1:${PORTS[this.id]}`) refuse("ax --server is not this cluster's port-forward");
      if (c.env.AX_HOME !== join(this.runDir, "axhome")) refuse("AX_HOME is not this run dir's");
    } else if (c.cmd === "gcloud") {
      if (!this.infra.project || flag("--project") !== this.infra.project || flag("--location") !== this.infra.location) refuse("gcloud --project or --location is not this cluster's");
      const verb = c.args.findIndex((x) => x === "describe" || x === "resize");
      if (verb < 0 || c.args[verb + 1] !== this.infra.clusterName) refuse("gcloud names another cluster");
    } else if (!(c.cmd === "bash" && c.args[0] === TEARDOWN) && c.cmd !== join(this.infra.owned.local?.bin ?? "", "kubectl-ate")) {
      refuse(`${basename(c.cmd)} is not a guarded tool`);
    }
  }

  async call(c: Call): Promise<Result> {
    this.guard(c);
    const shown = c.args.map((x) => (x === this.kubeconfig ? "<kubeconfig>" : x)).join(" ");
    this.d.log(`${this.dry && !c.local ? "DRY" : "+"} [${this.id}] ${c.background ? "(background) " : ""}${basename(c.cmd)} ${shown}${c.inputLabel ? ` < ${c.inputLabel}` : ""}`);
    if (!c.local) this.calls++;
    const r = this.dry && !c.local ? dryResult(c) : await this.d.exec(c);
    const out = `${r.stdout}\n${r.stderr}`;
    const verb = c.args.filter((x, i) => !["--kubeconfig", "--server"].includes(x) && !["--kubeconfig", "--server"].includes(c.args[i - 1] ?? "")).slice(0, 3).join(" ");
    if (/ResourceExhausted/.test(out)) throw new Stop("NOT_RUN", `stop rule 4: ResourceExhausted from ${basename(c.cmd)} ${verb} (${this.where})`);
    this.onOutput?.(c, out);
    return r;
  }

  kubectl(args: string[], o: Partial<Call> = {}) { return this.call({ cmd: this.kubectlBin, args: ["--kubeconfig", this.kubeconfig, ...args], env: this.env(), ...o }); }
  // kubectl refuses flags before a plugin name, so --kubeconfig follows `ate`; KUBECONFIG pins it either way (§1.2).
  ate(args: string[]) { return this.call({ cmd: this.kubectlBin, args: ["ate", "--kubeconfig", this.kubeconfig, ...args], env: this.env() }); }
  gcloud(args: string[]) { return this.call({ cmd: "gcloud", args, env: this.env() }); }
  async ax(args: string[]) {
    if (this.pf && this.pf.alive?.() === false) {
      if (this.pfReopened) throw new Stop("BLOCKED", "AX API unreachable");
      this.pfReopened = true;
      this.d.log(`[${this.id}] port-forward died; reopening it once`);
      await this.openPf();
      if (this.pf?.alive?.() === false) throw new Stop("BLOCKED", "AX API unreachable");
    }
    return this.call({ cmd: this.axCli, args: ["--server", `http://127.0.0.1:${PORTS[this.id]}`, ...args], env: this.env() });
  }
  async openPf() {
    // A port someone else holds would send ax calls to whatever listens there.
    if (!this.dry && !(await this.d.portFree(PORTS[this.id]))) throw new Stop("BLOCKED", `AX API unreachable: local port ${PORTS[this.id]} is already in use`);
    this.pf = await this.kubectl(["-n", "ax-system", "port-forward", "svc/ax-server", `${PORTS[this.id]}:8080`], { background: true });
    if (!this.dry) await this.d.sleep(3000);
  }

  async checkContext() {
    const r = await this.call({ cmd: this.kubectlBin, args: ["--kubeconfig", this.kubeconfig, "config", "current-context"], env: this.env(), local: true });
    const got = r.stdout.trim();
    this.d.log(`[${this.id}] resolved context: ${got || "(none)"}; plan: ${this.context}; ${got === this.context ? "match" : "MISMATCH"}`);
    if (r.code !== 0 || got !== this.context) throw new Stop("BLOCKED", `stop rule 2: cluster ${this.id}'s kubeconfig resolves to another context`, "set");
    this.kubeconfigSha = sha256(readFileSync(this.kubeconfig));
  }
}

// --dry-run: the shape of each reply, with documentation addresses (RFC 5737), so the flow can be walked.
const DRY = { emulate: "192.0.2.10", floci: "192.0.2.20", pod: "192.0.2.30", router: "192.0.2.40", worker: "192.0.2.50" };
function dryResult(c: Call): Result {
  const a = ` ${c.args.join(" ")} `;
  const ok = (v: unknown): Result => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "" });
  if (c.background) return { ...ok(""), alive: () => true, stop: () => {} };
  if (a.includes(" get svc,endpoints ")) {
    return ok({ items: (["emulate", "floci"] as const).flatMap((n) => [
      { kind: "Service", metadata: { name: n }, spec: { clusterIP: DRY[n] } }, { kind: "Endpoints", metadata: { name: n }, subsets: [{ addresses: [{ ip: DRY.pod }] }] }]) });
  }
  if (a.includes(" get svc atenet-router ")) return ok({ spec: { clusterIP: DRY.router } });
  if (a.includes(" app=atenet-egress ") && a.includes(" get pods ")) return ok({ items: [{ metadata: { name: "atenet-egress-dry" }, status: { containerStatuses: [{ restartCount: 0 }] } }] });
  if (a.includes(" get cm atenet-egress ")) return ok({ data: { "envoy.yaml": Object.values(accessLogBlocks(FIXTURE)).map((b) => b.join("\n")).join("\n") } });
  if (a.includes(" get pods,replicasets,deployments,statefulsets ")) {
    return ok({ items: [{ kind: "Pod", metadata: { name: "worker-dry", uid: "p", ownerReferences: [{ kind: "WorkerPool", name: "apl-ax-pool", uid: "w" }] }, spec: { containers: [] }, status: { podIP: DRY.worker } }] });
  }
  if (/ ate .* get actor \S+ /.test(a)) return ok({ metadata: { name: "dry" }, status: { state: "DRY_RUN" } });
  if (/ get (actors|actor-templates|workerpools) /.test(a)) return ok({ items: [] });
  if (a.includes(" collector.ts result ")) return ok({ http_status: 200 });
  return ok("");
}

export const realExec: Exec = (c) => new Promise((resolve) => {
  const p = spawn(c.cmd, c.args, { env: c.env, stdio: [c.input === undefined ? "ignore" : "pipe", c.background ? "ignore" : "pipe", c.background ? "ignore" : "pipe"] });
  if (c.background) {
    let alive = true;
    p.on("exit", () => (alive = false)).on("error", () => (alive = false));
    resolve({ code: 0, stdout: "", stderr: "", alive: () => alive, stop: () => p.kill() });
    return;
  }
  let stdout = "", stderr = "";
  p.stdout!.on("data", (b) => (stdout += b));
  p.stderr!.on("data", (b) => (stderr += b));
  p.on("error", (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
  p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  if (c.input !== undefined) p.stdin!.end(c.input);
});
const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const s = createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
  s.listen(port, "127.0.0.1");
});

// ---- plan (§1.1, design 6.1, §4.6) ----

const taskName = (tr8: string, s: string) => `apl-${tr8}-${s}`;
const nn = (i: number) => String(i).padStart(2, "0");
const range = (n: number) => [...Array(n).keys()];

export function buildPlan(o: { step: 1 | 2; setId: string; clusters: MultiPlan["clusters"]; registry: { tr8: string }[]; uuid: () => string; aReused?: string | null; differences?: string[] }): MultiPlan {
  const used = new Set([COLLECTOR_TR8, ...o.registry.map((r) => r.tr8)]);
  const bundle = (kase: string, task: string | null): BundleRef => ({ run_id: o.uuid(), case: kase, task });
  const tenantRun = (kind: string, tenant: string, tasks: (tr8: string) => string[], bundles: (tasks: string[]) => BundleRef[]): TenantRun => {
    const id = o.uuid(), tr8 = id.slice(0, 8);
    if (!UUID.test(id)) throw new Error("tenant run IDs must be UUIDs");
    if (used.has(tr8)) throw new Error(`refusing tenant run <tr8> ${tr8}: it is the collector's or already registered`);
    used.add(tr8);
    const ts = tasks(tr8);
    return { kind, tenant, tenant_run_id: id, tr8, tasks: ts, bundles: bundles(ts) };
  };
  // A configuration tenant run: warm-up 00, then the counted tasks; one F3-A1 per task and one MT-W01 (design 6.1).
  const w01 = (cluster: ClusterId, c: number, counted: number): Configuration => ({
    kind: "configuration", cluster, c, rounds: counted, warmup: true,
    tenant_runs: range(c).map((i) => tenantRun("configuration", `t${i + 1}`, (tr8) => range(counted + 1).map((n) => taskName(tr8, nn(n))),
      (ts) => [...ts.map((t) => bundle("F3-A1", t)), bundle("MT-W01", null)])),
  });
  const configurations: Configuration[] = [];
  const controls: Control[] = [];
  const marker = (cfg: Configuration) => controls.push({ kind: "marker", cluster: cfg.cluster, tenant_run_id: cfg.tenant_runs[0]!.tenant_run_id, task: null, run_id: o.uuid() });
  if (o.step === 1) {
    configurations.push({ kind: "probe", cluster: "a", c: 1, rounds: 2, warmup: false,
      tenant_runs: [tenantRun("probe", "t1", (tr8) => [taskName(tr8, "p1"), taskName(tr8, "p2")], (ts) => ts.map((t) => bundle("F3-A1", t)))] });
    configurations.push(w01("a", 1, 30), w01("a", 2, 15), w01("a", 4, 8));
    const iso: Configuration = { kind: "mt-iso", cluster: "a", c: 2, rounds: 4, warmup: false,
      tenant_runs: range(4).map((i) => tenantRun("mt-iso", `t${i + 1}`, (tr8) => [taskName(tr8, "iso"), taskName(tr8, "tgt"), ...(i === 0 ? [taskName(tr8, "ctl")] : [])],
        (ts) => [bundle("MT-ISO", ts[0]!)])) };
    configurations.push(iso);
    marker(configurations[1]!);
    controls.push({ kind: "egress", cluster: "a", tenant_run_id: iso.tenant_runs[0]!.tenant_run_id, task: iso.tenant_runs[0]!.tasks[2]!, run_id: o.uuid() });
  } else {
    if (!o.aReused) configurations.push(w01("a", 1, 30));
    configurations.push(w01("b", 1, 30));
    marker(configurations[configurations.length - 1]!); // B's first counted MT-W01; A's ran in step 1
  }
  return {
    set_id: o.setId, step: o.step, created_at: iso(), clusters: o.clusters, configurations, controls,
    ...(o.step === 2 ? { a: o.aReused ? { reused: { set_id: o.aReused, c: 1 as const } } : { rerun: { differences: o.differences ?? [] } } } : {}),
  };
}

// Every step run of a cluster: the plan's first (`step_run_id`), then each `run-step --only` (§4.7).
const stepRunsOf = (c: { step_run_id: string; step_runs?: StepRun[] }): StepRun[] => c.step_runs ?? [{ step_run_id: c.step_run_id }];
const taskSuffix = (task: string) => task.slice("apl-12345678-".length);

// §4.7: fresh copies of configurations for `run-step --only`, with new tenant run IDs, task names and bundle run IDs,
// so no tenant dir, namespace, registry entry or artifacts/runs/<run_id>/ of an earlier step run is reused.
function freshCopies(plan: MultiPlan, cfgs: Configuration[], registry: { tr8: string }[], uuid: () => string) {
  const planned = [...plan.configurations, ...Object.values(plan.clusters).flatMap((c) => stepRunsOf(c!).flatMap((s) => s.configurations ?? []))];
  const used = new Set([COLLECTOR_TR8, ...registry.map((r) => r.tr8), ...planned.flatMap((cfg) => cfg.tenant_runs.map((t) => t.tr8))]);
  const copies = new Map<string, TenantRun>();
  const configurations = cfgs.map((cfg) => ({ ...cfg, tenant_runs: cfg.tenant_runs.map((tr) => {
    const id = uuid(), tr8 = id.slice(0, 8);
    if (!UUID.test(id)) throw new Error("tenant run IDs must be UUIDs");
    if (used.has(tr8)) throw new Error(`refusing tenant run <tr8> ${tr8}: it is the collector's, registered or already in the plan`);
    used.add(tr8);
    const copy: TenantRun = { ...tr, tenant_run_id: id, tr8, tasks: tr.tasks.map((t) => taskName(tr8, taskSuffix(t))),
      bundles: tr.bundles.map((b) => ({ ...b, run_id: uuid(), task: b.task && taskName(tr8, taskSuffix(b.task)) })) };
    copies.set(tr.tenant_run_id, copy);
    return copy;
  }) }));
  const controls = plan.controls.filter((x) => copies.has(x.tenant_run_id)).map((x) => {
    const tr = copies.get(x.tenant_run_id)!;
    return { ...x, tenant_run_id: tr.tenant_run_id, task: x.task && taskName(tr.tr8, taskSuffix(x.task)), run_id: uuid() };
  });
  return { configurations, controls };
}

// §1.3: the read-only queries. A digest missing from `images` is an error, never a guess.
const VERSION_FIELDS = ["gke.master", "gke.nodes", "kubectl_client", "substrate.version", "substrate.commit", "substrate.kubectl_ate", "ax.commit", "ax.ax_server"];
const at = (o: any, path: string) => path.split(".").reduce((v, k) => v?.[k], o);
export async function queryVersions(cl: Cluster) {
  const infra = cl.infra;
  const json = async (p: Promise<Result>, what: string) => {
    const r = await p;
    const v = cl.dry ? {} : parseJson(r.stdout); // a dry run prints the queries and reads nothing
    if (r.code !== 0 || v === undefined) throw new Error(`versions: ${what} failed (${grpcCode(r)})`);
    return v;
  };
  const lookup = (image: string) => {
    const digest = /@(sha256:[a-f0-9]{64})$/.exec(image)?.[1];
    const i = cl.dry ? { name: "<dry>", digest: "<dry>", source: "<dry>" } : (infra.owned.images ?? []).find((x: { digest: string }) => x.digest === digest);
    if (!i) throw new Error(`versions: the digest of ${basename(image.split("@")[0]!)} is not in the run dir's images list`);
    return i as { name: string; digest: string; source?: string };
  };
  const gke = await json(cl.gcloud(["container", "clusters", "describe", infra.clusterName ?? "", "--project", infra.project ?? "", "--location", infra.location ?? "", "--format=json"]), "gcloud describe");
  const client = await json(cl.kubectl(["version", "--client", "-o", "json"]), "kubectl version");
  const deps = await json(cl.kubectl(["-n", "ate-system", "get", "deployments", "-o", "json"]), "ate-system deployments");
  const sources = new Set<string>((deps.items ?? []).flatMap((d: any) => (d.spec?.template?.spec?.containers ?? []).map((c: any) => lookup(c.image).source ?? "")));
  if (sources.size !== 1 && !cl.dry) throw new Error(`versions: the ate-system images name ${sources.size} sources, not one`);
  const src = [...sources][0]!;
  const ate = await cl.call({ cmd: join(infra.owned.local?.bin ?? "", "kubectl-ate"), args: ["--version"], env: cl.env() });
  const axDep = await json(cl.kubectl(["-n", "ax-system", "get", "deployment", "ax-server", "-o", "json"]), "ax-server deployment");
  const axImg = lookup(axDep.spec?.template?.spec?.containers?.[0]?.image ?? "");
  return {
    cluster: infra.clusterName, gke: { master: gke.currentMasterVersion, nodes: gke.currentNodeVersion }, kubectl_client: client.clientVersion?.gitVersion,
    substrate: { version: /v\d+\.\d+\.\d+/.exec(src)?.[0], commit: /\b[0-9a-f]{7,40}\b/.exec(src)?.[0], kubectl_ate: ate.code === 0 ? ate.stdout.trim() : undefined },
    ax: { commit: /@([0-9a-f]{7,40})/.exec(axImg.source ?? "")?.[1], ax_server: `${axImg.name}@${axImg.digest}` },
  };
}
// The queried fields over the recorded file; fields no query reads (lab_image, lab_commit, client_pins_substrate,
// a function of ax.commit) are carried.
const mergeVersions = (old: any, q: any) => ({ ...old, ...q, gke: { ...old.gke, ...q.gke }, substrate: { ...old.substrate, ...q.substrate }, ax: { ...old.ax, ...q.ax } });

async function planCmd(v: Record<string, any>, d: D): Promise<number> {
  const step = Number(v.step);
  if (step !== 1 && step !== 2) throw new Error("--step must be 1 or 2");
  if (!UUID.test(v["set-id"] ?? "")) throw new Error("--set-id must be a UUID");
  const setDir = join(d.runsRoot, "sets", v["set-id"]);
  if (existsSync(join(setDir, "plan.json"))) throw new Error("plan.json exists for this set; a set is planned once");
  const dirs: Partial<Record<ClusterId, string>> = { a: v["infra-a"], ...(step === 2 ? { b: v["infra-b"] } : {}) };
  if (!dirs.a || (step === 2 && !dirs.b)) throw new Error(`step ${step} needs --infra-a${step === 2 ? " and --infra-b" : ""}`);
  const infra = Object.fromEntries(Object.entries(dirs).map(([k, dir]) => [k, readInfra(dir!)])) as Record<ClusterId, Infra>;
  for (const [k, i] of Object.entries(infra)) assertIdentity(k as ClusterId, i);
  if (step === 2) {
    const where = (i: Infra) => `${i.project}/${i.location}/${i.clusterName}`;
    if (infra.a.owned.kube_context === infra.b.owned.kube_context) throw new Error("--infra-a and --infra-b name the same kube_context");
    if (where(infra.a) === where(infra.b)) throw new Error("--infra-a and --infra-b name the same project, location and cluster");
  }
  const clusters = Object.fromEntries(Object.entries(infra).map(([k, i]) => [k, { infra_run_dir: i.dir, context: i.owned.kube_context, step_run_id: d.uuid() }]));
  mkdirSync(setDir, { recursive: true });
  let aReused: string | null = null, differences: string[] = [];
  if (step === 2) {
    // §4.6: A's half is reused only if A's versions re-read now equal those step 1's run-step snapshotted into its
    // set dir (not the infrastructure run dir's versions.json, which `infra a` rewrites), and step 1's A and B name
    // one lab image.
    const s1 = v["step1-set-id"] ?? "";
    if (!UUID.test(s1)) throw new Error("step 2 needs --step1-set-id, the UUID of step 1's set");
    const s1Plan = readJsonIf(join(d.runsRoot, "sets", s1, "plan.json"));
    if (s1Plan?.step !== 1 || resolve(s1Plan.clusters?.a?.infra_run_dir ?? "") !== resolve(infra.a.dir)) throw new Error(`set ${s1} has no step 1 plan.json whose clusters.a.infra_run_dir is --infra-a`);
    const step1 = readJsonIf(join(d.runsRoot, "sets", s1, "versions-a.json"));
    if (!step1) throw new Error(`set ${s1} has no versions-a.json (run-step on A writes it)`);
    const blocked = await preflight(infra.a, infra.a.owned.kube_context);
    if (blocked) throw new Error(`cannot re-read A's versions for the reuse check: ${blocked}`);
    const cl = new Cluster("a", infra.a.owned.kube_context, infra.a.dir, infra.a, d, false);
    await cl.checkContext();
    const now = mergeVersions(infra.a.versions, await queryVersions(cl));
    writeFileSync(join(setDir, "versions-a-step2.json"), `${JSON.stringify(now, null, 2)}\n`);
    differences = VERSION_FIELDS.filter((f) => at(now, f) === undefined || at(now, f) !== at(step1, f));
    if (!step1.lab_image || step1.lab_image !== infra.b.versions.lab_image) differences.push("lab_image (A's step 1 and B)");
    if (!differences.length) aReused = s1;
  }
  const registry = readJsonIf(join(d.runsRoot, "tenant-runs.json")) ?? [];
  const plan = buildPlan({ step, setId: v["set-id"], clusters, registry, uuid: d.uuid, aReused, differences });
  writeFileSync(join(setDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  d.log(JSON.stringify({ plan: join(setDir, "plan.json"), configurations: plan.configurations.map((c) => `${c.cluster} ${c.kind} c=${c.c}`), a: plan.a ?? null }));
  return 0;
}

// ---- infra (§4.1) ----

async function infraCmd(id: ClusterId, dir: string, v: Record<string, any>, d: D, dry: boolean): Promise<number> {
  const infra = readInfra(dir);
  assertIdentity(id, infra); // `infra a` on B's dir would run A's branch on B
  const blocked = await preflight(infra, infra.owned.kube_context);
  if (blocked) {
    d.log(`[${id}] BLOCKED: ${blocked}${dry ? " (dry run continues; a real run makes no call)" : ""}`);
    if (!dry) return 1;
  }
  const cl = new Cluster(id, infra.owned.kube_context, dir, infra, d, dry);
  const listed = (o: { kind: string; name: string; namespace?: string }) => infra.owned.kubernetes.some((k: any) => k.kind === o.kind && k.name === o.name && k.namespace === o.namespace);
  const record = (o: { kind: string; name: string; namespace?: string }) => {
    if (listed(o)) return;
    d.log(`record ${o.kind} ${o.namespace ? `${o.namespace}/` : ""}${o.name} in the infrastructure run dir`);
    if (!dry) recordOwned(dir, "kubernetes", o);
  };
  const apply = async (doc: string) => { const r = await cl.kubectl(["apply", "-f", "-"], { input: doc, inputLabel: manifestObjects(doc).map((o) => `${o.kind} ${o.name}`).join(", ") }); if (r.code) throw new Error(`kubectl apply exited ${r.code}`); };
  await cl.checkContext();
  const collector = () => render(readFileSync(join(AX, "manifests/k8s/collector.yaml"), "utf8"), {
    APL_RUN_ID: infra.owned.run_id, APL_SHORT_ID: COLLECTOR_TR8, APL_POOL_REPLICAS: "3",
    APL_LAB_IMAGE: infra.versions.lab_image ?? (dry ? "<lab_image>" : ""), APL_WORKER_IMAGE: imageRef(infra, /ateworker-gvisor(:[^/]*)?$/),
  }).split(/^---$/m).filter((doc) => manifestObjects(doc).length);
  if (!dry && !infra.versions.lab_image) throw new Error("versions.json has no lab_image (build phase 6)");
  if (id === "a") {
    if (!listed({ kind: "Pod", name: "apl-collector", namespace: COLLECTOR_NS })) throw new Error(`Pod ${COLLECTOR_NS}/apl-collector is not listed in A's run dir; refusing to delete and recreate it`);
    const pools = listItems((await cl.kubectl(["get", "workerpools", "-A", "-o", "json"])).stdout);
    if (!pools) throw new Error("listing WorkerPools failed");
    const other = pools.filter((p) => `${p.metadata?.namespace}/${p.metadata?.name}` !== `${COLLECTOR_NS}/apl-ax-pool`);
    if (other.length) throw new Stop("BLOCKED", `stop rule 8: ${other.length} other WorkerPool(s) exist on A; ask the owner`);
    const versions = mergeVersions(infra.versions, await queryVersions(cl));
    d.log(`write versions.json (${VERSION_FIELDS.map((f) => `${f}=${at(versions, f) ?? "absent"}`).join(", ")})`);
    if (!dry) writeFileSync(join(dir, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
    // The pool's replicas before the first patch, recorded once under `scaled`, so teardown can restore them.
    if (!(infra.owned.scaled ?? []).some((r: any) => r.namespace === COLLECTOR_NS && r.name === "apl-ax-pool")) {
      const before = parseJson((await cl.kubectl(["-n", COLLECTOR_NS, "get", "workerpool", "apl-ax-pool", "-o", "json"])).stdout)?.spec?.replicas;
      if (!dry && !Number.isInteger(before)) throw new Error("reading WorkerPool apl-ax-pool's replicas before the patch failed");
      d.log(`record scaled WorkerPool ${COLLECTOR_NS}/apl-ax-pool replicas_before=${before ?? "<read at run time>"} in the infrastructure run dir`);
      if (!dry) recordOwned(dir, "scaled", { kind: "WorkerPool", namespace: COLLECTOR_NS, name: "apl-ax-pool", replicas_before: before });
    }
    await cl.kubectl(["-n", COLLECTOR_NS, "patch", "workerpool", "apl-ax-pool", "--type", "merge", "-p", '{"spec":{"replicas":3}}']);
    await cl.kubectl(["-n", COLLECTOR_NS, "scale", "deployment", "floci", "emulate", "--replicas=0"]);
    const docs = collector();
    const np = docs.find((doc) => manifestObjects(doc)[0]!.kind === "NetworkPolicy")!, pod = docs.find((doc) => manifestObjects(doc)[0]!.kind === "Pod")!;
    record(manifestObjects(np)[0]!);
    await apply(np);
    // A Pod's envFrom, volumes and image cannot be patched; it is already listed, so its record stays.
    await cl.kubectl(["-n", COLLECTOR_NS, "delete", "pod", "apl-collector", "--wait=true"]);
    record(manifestObjects(pod)[0]!);
    await apply(pod);
  } else {
    for (const doc of collector()) {
      record(manifestObjects(doc)[0]!);
      await apply(doc);
    }
    if (v.resize !== undefined) {
      if (!["0", "2"].includes(v.resize)) throw new Error("--resize takes 0 or 2");
      const pool = infra.owned.gke_cluster?.node_pool;
      if (!pool) throw new Error("gke_cluster.node_pool is not recorded in B's run dir (§8.3)");
      await cl.gcloud(["container", "clusters", "resize", infra.clusterName ?? "", "--node-pool", pool, "--num-nodes", v.resize, "--project", infra.project ?? "", "--location", infra.location ?? ""]);
    }
  }
  return 0;
}

// ---- run-step (§4.2 to §4.5, §13) ----

interface Tenant { tr: TenantRun; dir: string; ns: string; tr8: string; ips: { emulate: { cluster: string; pod: string }; floci: { cluster: string; pod: string } }; targets?: any[] }
interface Row { run_id: string; cluster: ClusterId; c: number; round: number; task: string; worker?: string; unobserved: Record<string, string>; [k: string]: unknown }
interface Slot { t: Tenant; task: string; bundle?: BundleRef; waitResult: boolean; waitMs: number; policy: string; dead?: boolean; applyAt?: number; resumeAt?: string; resultAt?: string; row: Row }

function orchestrate(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(AX, "orchestrate.ts"), ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  if (r.status !== 0) throw new Error(`orchestrate.ts ${args[0]} exited ${r.status}: ${r.stderr.slice(-400)}`);
}

function serviceIps(json: any, ns: string): Tenant["ips"] {
  const items: any[] = json?.items ?? [];
  const get = (n: string) => {
    const cluster = items.find((i) => i.kind === "Service" && i.metadata?.name === n)?.spec?.clusterIP;
    const pod = items.find((i) => i.kind === "Endpoints" && i.metadata?.name === n)?.subsets?.[0]?.addresses?.[0]?.ip;
    if (!cluster || !pod) throw new Stop("BLOCKED", `no ClusterIP or pod IP for ${n} in ${ns}`);
    return { cluster, pod };
  };
  return { emulate: get("emulate"), floci: get("floci") };
}

// §10: every Pod in the collector namespace whose owner chain reaches WorkerPool apl-ax-pool, on each declared
// containerPort plus 80, as raw TCP probes.
function workerTargets(json: any) {
  const items: any[] = json?.items ?? [];
  const byUid = new Map(items.map((i) => [i.metadata?.uid, i]));
  const reaches = (o: any, depth = 0): boolean => depth < 5 && (o?.metadata?.ownerReferences ?? []).some((r: any) =>
    (r.kind === "WorkerPool" && r.name === "apl-ax-pool") || reaches(byUid.get(r.uid), depth + 1));
  return items.filter((i) => i.kind === "Pod" && i.status?.podIP && reaches(i)).flatMap((p, k) => {
    const ports = new Set<number>([80, ...(p.spec?.containers ?? []).flatMap((c: any) => (c.ports ?? []).map((x: any) => x.containerPort))]);
    return [...ports].map((port) => ({ role: `worker-${k + 1}-${port}`, address: p.status.podIP as string, port, tcp: true, own: false }));
  });
}

// The targets file of tenant i among the MT-ISO tenant runs (§10, Appendix A); `own` marks its own addresses.
function isoTargets(ts: Tenant[], i: number, router: string, workers: object[]) {
  const me = ts[i]!, tgt = ts[(i + 1) % ts.length]!;
  const em = (t: Tenant) => `emulate.${t.ns}.svc.cluster.local`, fl = (t: Tenant) => `floci.${t.ns}.svc.cluster.local`;
  const own = [
    { role: `${me.tr.tenant}-emulate-clusterip`, address: me.ips.emulate.cluster, port: 8080, host: em(me), path: "/_apl/missing", own: true },
    { role: `${me.tr.tenant}-emulate-podip`, address: me.ips.emulate.pod, port: 8080, host: em(me), path: "/_apl/missing", own: true },
    { role: `${me.tr.tenant}-floci-clusterip`, address: me.ips.floci.cluster, port: 4566, host: fl(me), own: true },
    { role: `${me.tr.tenant}-floci-podip`, address: me.ips.floci.pod, port: 4566, host: fl(me), own: true },
  ];
  const others = ts.filter((_, k) => k !== i).flatMap((o) => [
    ...[8080, 8081].flatMap((port) => (["cluster", "pod"] as const).map((k) => ({ role: `${o.tr.tenant}-emulate-${k}ip-${port}`, address: o.ips.emulate[k], port, host: em(o), path: "/_apl/missing", own: false }))),
    ...(["cluster", "pod"] as const).map((k) => ({ role: `${o.tr.tenant}-floci-${k}ip`, address: o.ips.floci[k], port: 4566, host: fl(o), path: "/apl-missing-bucket/apl-missing-object", own: false })),
  ]);
  const routerT = { role: "router", address: router, port: 443, tls: true, host: "atenet-router.ate-system.svc", path: "/apl/missing", headers: { "ate-target-actor": `${tgt.ns}/${taskName(tgt.tr8, "tgt")}` }, own: false };
  return [...own, ...others, routerT, ...workers];
}
// The probe list: every non-own target plus the allowed control, the tenant's own Emulate ClusterIP on 8080.
const probesOf = (targets: any[]) => targets.filter((t) => !t.own || t.role.endsWith("-emulate-clusterip")).map(({ own: _own, ...p }) => p);
const secretValues = (sec: any): string[] => [sec.slack?.tokens, sec.slack?.signing_secret, sec.slack?.client_secret, sec.collector_s3?.secretAccessKey]
  .flatMap(function flat(v: any): string[] { return typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flat) : []; }).filter(Boolean);

class StepRunner {
  stopped: Stopped[] = [];
  observed = new Set<string>();
  rows: Row[] = [];
  rounds: object[] = [];
  roundsAbsent: object[] = [];
  errors: object[] = [];
  events: object[] = [];
  leftoverLog: object[] = [];
  actorProbe: object[] = [];
  private undeleted = new Set<string>(); // tasks whose ax delete failed; their actors are AX's, not leftovers
  detector: { marker?: string; egress?: string } = {};
  private warm?: { fail?: string; actors: number; resumed: number };
  private abortErr?: unknown;
  private revisionChecked = false;
  private secretRecorded = false;
  private isoBreach?: string;

  constructor(readonly plan: MultiPlan, readonly cl: Cluster, readonly stepDir: string, readonly setDir: string, readonly registryFile: string,
    private d: D, readonly labImage: string, readonly labCommit: string | undefined, readonly emulateImage: string, readonly fileTag = "") {
    cl.onOutput = (c, out) => {
      if (this.warm && (c.cmd === cl.axCli || c.args[0] === "ate") && /Unimplemented|error unmarshal/i.test(out)) this.warm.fail ??= "an ax or kubectl ate call returned Unimplemented or an unmarshal error (L-030)";
    };
  }
  get dry() { return this.cl.dry; }

  block(ref: BundleRef, execution: Execution, reason: string) {
    if (this.observed.has(ref.run_id) || this.stopped.some((s) => s.run_id === ref.run_id)) return;
    this.d.log(`[${this.cl.id}] ${execution} ${ref.case} ${ref.task ?? ref.run_id}: ${reason}`);
    this.stopped.push({ run_id: ref.run_id, case: ref.case, execution, reason, at: iso() });
  }
  private kill(s: Slot, execution: Execution, reason: string) {
    s.dead = true;
    if (s.bundle) this.block(s.bundle, execution, reason);
  }
  private event(name: string, task: string) { this.events.push({ event: name, task, at: iso() }); }

  // Polls `fn` every stepMs up to maxMs; a parallel sibling's stop ends the poll.
  private async poll(stepMs: number, maxMs: number, fn: () => Promise<boolean>) {
    for (let t = 0; ; t += stepMs) {
      if (this.abortErr) throw this.abortErr;
      if (await fn()) return true;
      if (t >= maxMs) return false;
      await this.d.sleep(this.dry ? 0 : stepMs);
    }
  }
  private async parallel<T>(xs: T[], fn: (x: T) => Promise<unknown>) {
    const done = await Promise.allSettled(xs.map((x) => fn(x).catch((e) => { this.abortErr ??= e; throw e; })));
    const bad = done.find((r) => r.status === "rejected");
    this.abortErr = undefined;
    if (bad) throw (bad as PromiseRejectedResult).reason;
  }

  private pod(args: string[], input?: string, inputLabel?: string) {
    return this.cl.kubectl(["-n", COLLECTOR_NS, "exec", ...(input === undefined ? [] : ["-i"]), "apl-collector", "--", ...args], input === undefined ? {} : { input, inputLabel });
  }
  private collector(tr8: string, args: string[]) {
    return this.pod(["node", `--env-file=/etc/apl/collector-env/${tr8}`, "--import", "tsx", "profiles/ax/collector.ts", ...args]);
  }
  // Writes a set-dir file and copies it into the collector Pod; returns its Pod path.
  private async put(name: string, value: unknown, runId: string) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(this.setDir, name), text);
    const p = `/tmp/apl/${runId}/${name}`;
    await this.pod(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", p], text, name);
    return p;
  }

  // The registry is shared by every set and cluster: a lock file guards the read-modify-write (held: fail, never
  // wait), and a rename replaces the file, so a crash leaves the old or the new list.
  private register(cfg: Configuration, tr: TenantRun, dir: string) {
    const sec = readJson(join(dir, "secrets.json"));
    const lock = `${this.registryFile}.lock`;
    try {
      closeSync(openSync(lock, "wx"));
    } catch {
      throw new Error(`${lock} exists: another run-step is writing the tenant-run registry (remove the file if none is)`);
    }
    try {
      const reg = readJsonIf(this.registryFile) ?? [];
      reg.push({
        tenant_run_id: tr.tenant_run_id, tr8: tr.tr8, kind: tr.kind, cluster: cfg.cluster, set_id: this.plan.set_id, created_at: iso(),
        run_ids: tr.bundles.map((b) => b.run_id), tasks: tr.tasks, token_sha256: secretValues({ slack: { tokens: sec.slack.tokens } }).map((s) => sha256(s)),
      });
      writeFileSync(`${this.registryFile}.tmp`, `${JSON.stringify(reg, null, 2)}\n`);
      renameSync(`${this.registryFile}.tmp`, this.registryFile);
    } finally {
      unlinkSync(lock);
    }
  }

  // §4.2 steps 1 to 5: each object recorded in the step run dir before its create.
  async setupTenant(cfg: Configuration, tr: TenantRun): Promise<Tenant> {
    const dir = join(this.setDir, "tenants", tr.tenant_run_id), ns = `apl-ax-${tr.tr8}`;
    mkdirSync(dir, { recursive: true });
    orchestrate(["init", "--dir", dir, "--run-id", tr.tenant_run_id]);
    this.register(cfg, tr, dir);
    orchestrate(["manifests", "--tenant", "--dir", dir, "--set-id", this.plan.set_id, "--cluster", cfg.cluster, "--tenant-role", tr.tenant], { APL_EMULATE_IMAGE: this.emulateImage });
    const yaml = join(dir, "tenant.yaml");
    for (const o of manifestObjects(readFileSync(yaml, "utf8"))) recordOwned(this.stepDir, "kubernetes", o);
    recordOwned(this.stepDir, "substrate", { kind: "atespace", name: ns, created_by: "ax apply" });
    const a = await this.cl.kubectl(["apply", "-f", yaml]);
    if (a.code) throw new Stop("BLOCKED", `kubectl apply of tenant ${tr.tenant}'s manifest exited ${a.code}`);
    const w = await this.cl.kubectl(["-n", ns, "wait", "--for=condition=Available", "deployment", "-l", `apl-run=${tr.tenant_run_id}`, "--timeout=180s"]);
    if (w.code) throw new Stop("NOT_RUN", `tenant ${tr.tenant}'s emulators not Available within 180 s (exit ${w.code})`);
    const s = await this.cl.kubectl(["-n", ns, "get", "svc,endpoints", "-o", "json"]);
    const t: Tenant = { tr, dir, ns, tr8: tr.tr8, ips: serviceIps(parseJson(s.stdout), ns) };
    writeFileSync(join(dir, "egress-policy.json"), JSON.stringify(egressPolicy(ns)));
    return t;
  }

  // §4.2 step 6.
  renderTask(cfg: Configuration, t: Tenant, task: string, mode: string, probes?: object[]) {
    const args = ["manifests", "--dir", t.dir, "--task", task, "--mode", mode, "--image", this.labImage, "--emulate-ip", t.ips.emulate.cluster, "--floci-ip", t.ips.floci.cluster,
      "--set-id", this.plan.set_id, "--cluster", cfg.cluster, "--tenant-role", t.tr.tenant];
    if (probes) {
      writeFileSync(join(t.dir, `probes-${task}.json`), JSON.stringify(probes));
      args.push("--probes", join(t.dir, `probes-${task}.json`));
    }
    orchestrate(args);
  }

  // §4.2 step 7 and §6: the Secret holds one key per tenant run of the current configuration.
  async collectorEnv(ts: Tenant[]) {
    if (!this.secretRecorded) recordOwned(this.stepDir, "kubernetes", { kind: "Secret", namespace: COLLECTOR_NS, name: "collector-env-tenants" });
    this.secretRecorded = true;
    const data = Object.fromEntries(ts.map((t) => {
      const e = readJson(join(t.dir, "collector-env.json"));
      return [t.tr8, Buffer.from(`APL_AX_COLLECTOR='${e.APL_AX_COLLECTOR}'\nAPL_AX_ALLOWLIST='${e.APL_AX_ALLOWLIST}'\n`).toString("base64")];
    }));
    const secret = { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { name: "collector-env-tenants", namespace: COLLECTOR_NS, labels: { "apl-run": this.plan.clusters[this.cl.id]!.step_run_id } }, data };
    const r = await this.cl.kubectl(["apply", "-f", "-"], { input: JSON.stringify(secret), inputLabel: `Secret ${COLLECTOR_NS}/collector-env-tenants, keys ${ts.map((t) => t.tr8).join(" ")}` });
    if (r.code) throw new Stop("BLOCKED", `kubectl apply of collector-env-tenants exited ${r.code}`);
    for (const t of ts) {
      const ok = await this.poll(2000, 120_000, async () => (await this.pod(["test", "-f", `/etc/apl/collector-env/${t.tr8}`])).code === 0);
      if (!ok) throw new Stop("BLOCKED", `collector env file for ${t.tr8} not mounted within 120 s`);
    }
  }

  // `bundle` is the planned bundle a failure of this task blocks: its F3-A1, or the MT-ISO of a prober.
  private slot(cfg: Configuration, t: Tenant, task: string, round: number, o: { waitResult?: boolean; waitMs?: number; policy?: string; bundle?: BundleRef } = {}): Slot {
    const bundle = o.bundle ?? t.tr.bundles.find((b) => b.task === task && b.case === "F3-A1");
    return { t, task, bundle, waitResult: o.waitResult ?? true, waitMs: o.waitMs ?? 120_000, policy: o.policy ?? join(t.dir, "egress-policy.json"),
      row: { run_id: bundle?.run_id ?? "", cluster: cfg.cluster, c: cfg.c, round, task, unobserved: {} } };
  }

  private checkActor(actor: any) {
    if (!this.warm) return;
    const state = actor?.status?.state ?? actor?.state;
    if (!actor) this.warm.fail ??= "an actor read did not decode";
    else if (!state || /UNSPECIFIED/.test(String(state))) this.warm.fail ??= `actor ${nameOf(actor)} has state ${state ?? "absent"} (L-030)`;
    else this.warm.actors++;
  }

  // §4.3, one round of c tasks.
  async round(cfg: Configuration, r: number, slots: Slot[], o: { warmup?: boolean; listings?: boolean; beforeResume?: () => Promise<void>; observe: (s: Slot, phaseFile: string) => Promise<void> }) {
    const cl = this.cl;
    cl.where = `${cfg.kind} on ${cfg.cluster}, c = ${cfg.c}, round ${r}`;
    const start = iso();
    if (o.warmup) this.warm = { actors: 0, resumed: 0 };
    const live = () => slots.filter((s) => !s.dead);
    const namespaces = [...new Set(slots.map((s) => s.t.ns))];
    const counts: Record<string, number | null> = {};
    const listing = async (when: string) => {
      if (!o.listings) return;
      for (const ns of namespaces) {
        const out = (await cl.ate(["get", "actors", "-a", ns, "-o", "json"])).stdout;
        writeFileSync(join(this.setDir, `actors-${ns}-r${r}-after-${when}.json`), out);
        const items = listItems(out);
        counts[when] = items?.length ?? null;
        if (when === "delete") counts.leftover_with_worker = items ? items.filter((x) => x?.status?.workerAssignment?.worker).length : null;
      }
    };
    // 1. ax apply, each Workspace and Task recorded first.
    for (const s of slots) {
      const file = join(s.t.dir, `task-${s.task}.yaml`);
      for (const x of manifestObjects(readFileSync(file, "utf8"))) recordOwned(this.stepDir, "ax", { kind: x.kind.toLowerCase(), atespace: x.atespace, name: x.name });
      s.applyAt = Date.now();
      const a = await cl.ax(["apply", "-f", file, "-a", s.t.ns]);
      if (a.code) this.kill(s, "BLOCKED", `ax apply failed: ${grpcCode(a)}`);
    }
    await listing("apply");
    // 2. poll for each actor and attach its policy as it appears (§9.2).
    await this.parallel(live(), async (s) => {
      const found = await this.poll(500, 120_000, async () => (await cl.ate(["get", "actor", s.task, "-a", s.t.ns])).code === 0);
      if (!found) throw new Stop("NOT_RUN", `stop rule 4: actor ${s.task} not listed within 120 s (${cl.where})`);
      recordOwned(this.stepDir, "substrate", { kind: "egress-policy", atespace: s.t.ns, name: s.task, created_by: "kubectl ate create egress-policy" });
      const p = await cl.ate(["create", "egress-policy", s.task, "-a", s.t.ns, "-f", s.policy]);
      if (p.code) return this.kill(s, "BLOCKED", "egress policy not attached");
      s.row.egress_attach_ms = Date.now() - s.applyAt!;
      this.event("policy_attached", s.task);
    });
    await o.beforeResume?.();
    // 3. the c resumes in parallel, then the c results in parallel.
    await this.parallel(live(), async (s) => {
      s.resumeAt = iso();
      this.event("resume_issued", s.task);
      const x = await cl.ax(["resume", "task", s.task, "-a", s.t.ns]);
      if (x.code) this.kill(s, "BLOCKED", `resume failed: ${grpcCode(x)}`);
      else if (this.warm) this.warm.resumed++;
    });
    const e0 = Date.now();
    await this.pod(["true"]);
    const emptyMs = Date.now() - e0;
    await this.parallel(live().filter((s) => s.waitResult), async (s) => {
      const x = await this.collector(s.t.tr8, ["result", "--task", s.task, "--atespace", s.t.ns, "--wait-ms", String(s.waitMs)]);
      s.resultAt = iso();
      this.event(x.code === 0 ? "result_returned" : "result_not_served", s.task);
      if (x.code === 0) s.row.submit_to_result_ms = Date.now() - s.applyAt!;
      else s.row.unobserved.submit_to_result_ms = `result not served within ${s.waitMs / 1000} s`;
      s.row.empty_exec_ms = emptyMs;
    });
    await listing("result");
    // 4. per resumed task: the phase, the actor's worker (R5-1), observe while the actor still serves /apl/result.
    for (const s of live()) {
      const table = (await cl.ax(["get", "tasks", "-a", s.t.ns])).stdout;
      const phase = table.split("\n").map((l) => l.trim().split(/\s+/)).find((cols) => cols[0] === s.task)?.[2];
      const phaseFile = join(this.setDir, `phase-${s.task}.json`);
      writeFileSync(phaseFile, JSON.stringify(phase ? { phase } : {})); // the full `ax get task` holds tokens in clear (L-034)
      const actor = parseJson((await cl.ate(["get", "actor", s.task, "-a", s.t.ns, "-o", "json"])).stdout);
      this.checkActor(actor);
      const worker = actor?.status?.workerAssignment?.worker;
      if (worker) s.row.worker = worker;
      else s.row.unobserved.worker = actor ? "status.workerAssignment.worker is empty" : "actor read failed";
      await o.observe(s, phaseFile);
    }
    // 5. delete the c tasks; save the round's ax-server log.
    for (const s of slots) {
      const x = await cl.ax(["delete", "task", s.task, "-a", s.t.ns]);
      if (x.code) this.undeleted.add(s.task);
      if (x.code) this.errors.push({ at: iso(), where: cl.where, task: s.task, error: `ax delete task failed: ${grpcCode(x)}; it stays listed for teardown` });
    }
    const log = (await cl.kubectl(["-n", "ax-system", "logs", "deployment/ax-server", `--since-time=${start}`, "--tail=-1"])).stdout;
    writeFileSync(join(this.setDir, `ax-server-${cfg.cluster}-c${cfg.c}-r${r}${this.fileTag}.log`), log);
    const iv = serverIntervals(log, slots.map((s) => s.task));
    for (const s of slots.filter((x) => x.bundle?.case === "F3-A1")) {
      const f = iv[s.task]!;
      if ("value" in f) s.row.server_resume_to_running_ms = f.value;
      else s.row.unobserved.server_resume_to_running_ms = f.absent;
      this.rows.push(s.row);
    }
    await listing("delete");
    // §4.5: G (golden actors a new template adds) and L (actors left after delete), before step 6 removes them.
    if (o.listings) this.actorProbe.push({ round: r, tasks: slots.map((s) => s.task), listed: counts,
      G: counts.result == null ? null : counts.result - 1, L: counts.delete ?? null, leftover_holds_worker: counts.leftover_with_worker == null ? null : counts.leftover_with_worker > 0 });
    // 6. leftover actors and templates.
    const leftover = await this.leftovers(namespaces);
    if (cfg.kind === "configuration") {
      // Over every task meant to resume: a round with a dead task did not resume c tasks, so it has no spread.
      const dead = slots.filter((s) => s.dead).map((s) => s.task);
      const spread = dead.length ? { absent: `${dead.join(", ")} did not resume` } : resumeSpread(log, slots.map((s) => s.task));
      if ("value" in spread) this.rounds.push({ cluster: cfg.cluster, c: cfg.c, round: r, resume_spread_ms: spread.value, leftover_actors: leftover });
      else this.roundsAbsent.push({ cluster: cfg.cluster, c: cfg.c, round: r, resume_spread_ms: spread.absent, leftover_actors: leftover });
    }
    if (o.warmup) {
      const w = this.warm!;
      this.warm = undefined;
      const why = w.fail ?? (w.resumed === 0 ? "no task ran" : w.actors === 0 ? "no actor was listed" : undefined);
      if (why && !this.dry) throw new Stop("BLOCKED", `stop rule 1: warm-up preflight failed on cluster ${cl.id} (${why})`);
    }
  }

  // §4.3 step 6: record, delete and mark removed, actors before templates, in every given atespace. A task whose
  // delete failed still owns its actor; it is not a leftover, and teardown deletes the task.
  async leftovers(namespaces: string[]) {
    const undeleted = this.undeleted;
    const found: object[] = [];
    let actors = 0;
    for (const kind of ["actor", "actor-template"] as const) {
      for (const ns of namespaces) {
        const list = async () => listItems((await this.cl.ate(["get", `${kind}s`, "-a", ns, "-o", "json"])).stdout);
        const items = await list();
        if (!items) {
          this.errors.push({ at: iso(), where: this.cl.where, error: `listing ${kind}s in ${ns} failed` });
          continue;
        }
        for (const it of items.filter((x) => !undeleted.has(nameOf(x)))) {
          const name = nameOf(it);
          if (kind === "actor") this.checkActor(it);
          const owned = readJson(join(this.stepDir, "owned-resources.json")).substrate.some((x: any) => x.kind === kind && x.atespace === ns && x.name === name && !x.removed_at);
          if (!owned) recordOwned(this.stepDir, "substrate", { kind, atespace: ns, name, created_by: "AX (left after its task was deleted)" });
          found.push({ kind, atespace: ns, name, ...(kind === "actor" ? { worker: it?.status?.workerAssignment?.worker || null } : {}) });
          if (kind === "actor") actors++;
          const x = await this.cl.ate(["delete", kind, name, "-a", ns]);
          if (x.code) this.errors.push({ at: iso(), where: this.cl.where, error: `kubectl ate delete ${kind} ${name} failed: ${grpcCode(x)}; teardown deletes it` });
        }
        const gone = items.filter((x) => !undeleted.has(nameOf(x)));
        if (!gone.length) continue;
        const again = await list();
        const still = new Set((again ?? gone).map(nameOf)); // a failed second listing proves nothing gone
        for (const it of gone) if (!still.has(nameOf(it))) markRemoved(this.stepDir, { kind, atespace: ns, name: nameOf(it) });
      }
    }
    this.leftoverLog.push({ where: this.cl.where, at: iso(), leftover_actors: actors, found });
    return actors;
  }

  // Runs one collector observe; returns the local bundle dir. A control's bundle stays in the set dir (§10).
  async observe(t: Tenant, ref: BundleRef, args: string[], control?: string): Promise<string | undefined> {
    const podOut = `/tmp/apl/${ref.run_id}/bundle`;
    const r = await this.collector(t.tr8, ["observe", ...args, "--atespace", t.ns, "--run-id", ref.run_id, "--out", podOut]);
    if (r.code !== 0) {
      if (!control) this.block(ref, "NOT_RUN", `collector exited ${r.code}`);
      return;
    }
    const local = join(control ?? join(this.setDir, "bundles"), ref.run_id);
    mkdirSync(dirname(local), { recursive: true });
    await this.cl.kubectl(["cp", `${COLLECTOR_NS}/apl-collector:${podOut}`, local]);
    if (this.dry) return;
    if (!existsSync(join(local, "observations.json"))) {
      if (!control) this.block(ref, "NOT_RUN", "the collector exited 0 but no bundle was copied off the Pod");
      return;
    }
    if (control) return local;
    copyBundle(local, ref.run_id); // writes checksums.sha256 at once (§4.3 step 4)
    this.observed.add(ref.run_id);
    if (!this.revisionChecked) {
      this.revisionChecked = true;
      const rev = readJson(join(local, "observations.json")).candidate_revision;
      if (rev !== this.labCommit) throw new Stop("BLOCKED", `the first bundle's candidate_revision is not the lab image's commit (build §3, phase 6)`);
    }
    return local;
  }

  private facts(cfg: Configuration, withTimed: boolean) {
    const counted = cfg.tenant_runs.reduce((n, t) => n + t.tasks.filter((x) => !(cfg.warmup && x.endsWith("-00"))).length, 0);
    const timed = this.rows.filter((r) => cfg.tenant_runs.some((t) => t.tasks.includes(r.task)) && !r.task.endsWith("-00")
      && typeof r.server_resume_to_running_ms === "number" && typeof r.command_duration_ms === "number").length;
    return { step: this.plan.step, concurrency: cfg.c, tasks_planned: cfg.kind === "mt-iso" ? cfg.tenant_runs.length : counted, ...(withTimed ? { tasks_timed: timed } : {}) };
  }
  private markers(t: Tenant, extra: object[] = []) {
    return { tenant_run_id: t.tr.tenant_run_id, foreign: [...(readJsonIf(this.registryFile) ?? []).filter((e: any) => e.tenant_run_id !== t.tr.tenant_run_id), ...extra] };
  }

  async observeTask(cfg: Configuration, s: Slot, phaseFile: string) {
    if (s.bundle?.case !== "F3-A1") return;
    const id = s.bundle.run_id;
    const phase = await this.put(`phase-${s.task}.json`, readJson(phaseFile), id);
    const facts = await this.put(`run-facts-${s.task}.json`, this.facts(cfg, false), id);
    const local = await this.observe(s.t, s.bundle, ["--case", "F3-A1", "--task", s.task, "--ax-phase-file", phase, "--run-facts", facts]);
    if (!local) return;
    const ev = readJsonIf(join(local, "evidence", "ax-result.json"));
    const f = commandDuration(ev?.body && typeof ev.body === "object" ? ev.body : undefined);
    if ("value" in f) s.row.command_duration_ms = f.value;
    else s.row.unobserved.command_duration_ms = f.absent;
  }

  // The marker control (design 6.4): one extra MT-W01 observation whose markers list the tenant's own first counted task.
  async markerControl(cfg: Configuration, t: Tenant) {
    const ctl = this.plan.controls.find((c) => c.kind === "marker" && c.cluster === this.cl.id && c.tenant_run_id === t.tr.tenant_run_id);
    if (!ctl) return;
    const first = t.tr.tasks.find((x) => !x.endsWith("-00"))!;
    const m = await this.put(`markers-control-${t.tr8}.json`, this.markers(t, [{ tenant_run_id: "marker-control", run_ids: [], tasks: [first], token_sha256: [] }]), ctl.run_id);
    const f = await this.put(`run-facts-control-${t.tr8}.json`, this.facts(cfg, true), ctl.run_id);
    const dir = await this.observe(t, { run_id: ctl.run_id, case: "MT-W01", task: null }, ["--run", "--case", "MT-W01", "--foreign-markers-file", m, "--run-facts", f], join(this.setDir, "controls"));
    if (this.dry) return;
    const n = dir ? readJson(join(dir, "observations.json")).observations?.foreign_marker_count : undefined;
    if (!(typeof n === "number" && n >= 1)) this.detector.marker = `stop rule 1: the marker control did not fire on cluster ${this.cl.id} (foreign_marker_count ${n ?? "absent"})`;
  }

  async runConfiguration(cfg: Configuration) {
    const ts: Tenant[] = [];
    for (const tr of cfg.tenant_runs) ts.push(await this.setupTenant(cfg, tr));
    for (const t of ts) for (const task of t.tr.tasks) this.renderTask(cfg, t, task, "W01-H");
    await this.collectorEnv(ts);
    for (let r = 0; r < ts[0]!.tr.tasks.length; r++) {
      await this.round(cfg, r, ts.map((t) => this.slot(cfg, t, t.tr.tasks[r]!, r)), {
        warmup: cfg.warmup && r === 0, listings: cfg.kind === "probe", observe: (s, phaseFile) => this.observeTask(cfg, s, phaseFile),
      });
    }
    // Run-level bundles after the last round, before the emulators are scaled to 0 (§4.3).
    for (const t of ts) {
      const ref = t.tr.bundles.find((b) => b.case === "MT-W01");
      if (!ref) continue;
      await this.markerControl(cfg, t);
      if (this.detector.marker) { this.block(ref, "BLOCKED", this.detector.marker); continue; }
      const m = await this.put(`markers-${t.tr8}.json`, this.markers(t), ref.run_id);
      const f = await this.put(`run-facts-${t.tr8}.json`, this.facts(cfg, true), ref.run_id);
      await this.observe(t, ref, ["--run", "--case", "MT-W01", "--foreign-markers-file", m, "--run-facts", f]);
    }
    for (const t of ts) await this.cl.kubectl(["-n", t.ns, "scale", "deployment", "floci", "emulate", "--replicas=0"]);
  }

  // design 7.4 and §9.4, §10: the planted control, then each tenant's isolation task with the next tenant's target.
  async runIso(cfg: Configuration) {
    const cl = this.cl;
    const ts: Tenant[] = [];
    for (const tr of cfg.tenant_runs) ts.push(await this.setupTenant(cfg, tr));
    const router = parseJson((await cl.kubectl(["-n", "ate-system", "get", "svc", "atenet-router", "-o", "json"])).stdout)?.spec?.clusterIP;
    if (!router) throw new Stop("BLOCKED", "the atenet-router ClusterIP was not found");
    // On GKE the chain is Pod -> ReplicaSet apl-ax-pool-<hash> -> Deployment apl-ax-pool -> WorkerPool apl-ax-pool.
    const workers = workerTargets(parseJson((await cl.kubectl(["-n", COLLECTOR_NS, "get", "pods,replicasets,deployments,statefulsets", "-o", "json"])).stdout));
    if (!workers.length) throw new Stop("BLOCKED", "no worker Pod of WorkerPool apl-ax-pool was found (§10 refuses an empty list)");
    ts.forEach((t, i) => (t.targets = isoTargets(ts, i, router, workers)));
    for (const t of ts) {
      this.renderTask(cfg, t, taskName(t.tr8, "iso"), "isolation", probesOf(t.targets!));
      this.renderTask(cfg, t, taskName(t.tr8, "tgt"), "term");
    }
    const egressCtl = this.plan.controls.find((c) => c.kind === "egress" && c.cluster === cl.id);
    const t1 = ts[0]!, t2 = ts[1]!;
    const planted = join(t1.dir, "egress-policy-ctl.json");
    if (egressCtl) {
      writeFileSync(planted, JSON.stringify(egressPolicy(t1.ns, t2.ns)));
      this.renderTask(cfg, t1, egressCtl.task!, "isolation", probesOf(t1.targets!.filter((x) => x.role === `${t1.tr.tenant}-emulate-clusterip` || x.role === `${t2.tr.tenant}-emulate-clusterip-8080`)));
    }
    await this.collectorEnv(ts);
    if (egressCtl) {
      // Not fired until its bundle shows a cross-tenant upstream (design 6.4).
      this.detector.egress = `stop rule 1: the egress control did not fire on cluster ${cl.id} (not observed)`;
      await this.isoRound(cfg, 0, t1, egressCtl.task!, undefined, { run_id: egressCtl.run_id, case: "MT-ISO", task: egressCtl.task }, planted);
    }
    for (const [i, t] of ts.entries()) {
      const ref = t.tr.bundles.find((b) => b.case === "MT-ISO")!;
      const down = this.detector.marker ?? this.detector.egress;
      if (down) { this.block(ref, "BLOCKED", down); continue; }
      await this.isoRound(cfg, i + 1, t, taskName(t.tr8, "iso"), ts[(i + 1) % ts.length], ref);
      if (this.isoBreach) throw new Stop("BLOCKED", this.isoBreach);
    }
    for (const t of ts) await cl.kubectl(["-n", t.ns, "scale", "deployment", "floci", "emulate", "--replicas=0"]);
  }

  private gatewayPods = async () => {
    const j = parseJson((await this.cl.kubectl(["-n", "ate-system", "get", "pods", "-l", "app=atenet-egress", "-o", "json"])).stdout);
    return (j?.items ?? []).map((p: any) => ({ name: nameOf(p), restarts: (p.status?.containerStatuses ?? []).reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0) }));
  };

  // One prober with, unless it is the planted control, the next tenant's term-mode target running beside it.
  async isoRound(cfg: Configuration, r: number, t: Tenant, task: string, target: Tenant | undefined, ref: BundleRef, plantedPolicy?: string) {
    // The result wait covers the probes case.ts runs one after another (§4.3 step 3).
    const waitMs = isolationWaitMs(readJson(join(t.dir, `probes-${task}.json`)).length);
    const prober = this.slot(cfg, t, task, r, { policy: plantedPolicy, bundle: plantedPolicy ? undefined : ref, waitMs });
    const tgt = target ? this.slot(cfg, target, taskName(target.tr8, "tgt"), r, { waitResult: false }) : undefined;
    const slots = tgt ? [tgt, prober] : [prober]; // the target first, so its actor and worker are read before the prober is observed
    let podsBefore: { name: string; restarts: number }[] = [];
    await this.round(cfg, r, slots, {
      beforeResume: async () => {
        podsBefore = await this.gatewayPods();
        if (!podsBefore.length) throw new Stop("BLOCKED", "no atenet-egress gateway pod was listed");
      },
      observe: async (s) => {
        if (s.task !== task) return;
        const resumed = Date.parse(s.resumeAt!), returned = s.resultAt ? Date.parse(s.resultAt) : Date.now();
        const window = { from: iso(resumed - 10_000), to: iso(returned + 10_000) };
        if (!this.dry && returned + 10_000 > Date.now()) await this.d.sleep(returned + 10_000 - Date.now()); // the extract is taken no earlier than `to`
        const podsAfter = await this.gatewayPods();
        const args = egressExtractArgs({ kubeconfig: this.cl.kubeconfig, from: window.from, pods: podsBefore });
        const x = await this.cl.call({ cmd: this.cl.kubectlBin, args, env: this.cl.env() });
        const lines = x.stdout.split("\n").filter(Boolean);
        const extract: EgressExtract & Record<string, unknown> = {
          window: { ...window, margin_s: 10, events: { resume_issued: s.resumeAt, result_returned: s.resultAt ?? null } } as EgressExtract["window"],
          source: "kubectl logs -l app=atenet-egress -c envoy --tail=-1 --prefix --max-log-requests=<n>, ate-system",
          pods_before: podsBefore, pods_after: podsAfter, exit_code: x.code, line_count: lines.length, lines,
        };
        const egress = await this.put(`egress-${task}.json`, extract, ref.run_id);
        const targets = await this.put(`targets-${task}.json`, t.targets, ref.run_id);
        // An operator value (design 6.5): other MT-ISO tenants' secrets searched in this task's `ax get task`; output
        // not stored. With no task read or no secret to search for, the count is left out with the reason, never 0.
        const secretFiles = cfg.tenant_runs.filter((x) => x.tenant_run_id !== t.tr.tenant_run_id).map((x) => join(this.setDir, "tenants", x.tenant_run_id, "secrets.json"));
        const foreign = secretFiles.flatMap((f) => secretValues(readJsonIf(f) ?? {}));
        const shown = await this.cl.ax(["get", "task", task, "-a", t.ns, "-o", "json"]);
        const read = parseJson(shown.stdout);
        const absent = shown.code !== 0 ? `ax get task failed: ${grpcCode(shown)}`
          : !read || typeof read !== "object" || !Object.keys(read).length ? "ax get task returned no task"
          : secretFiles.some((f) => !existsSync(f)) || !foreign.length ? "another MT-ISO tenant's secrets.json is missing or holds no secret"
          : undefined;
        const disclosure = await this.put(`disclosure-${task}.json`, { tenant_run_id: t.tr.tenant_run_id, tasks_checked: absent ? 0 : 1,
          ...(absent ? { absent } : { foreign_secret_in_task_count: foreign.filter((v) => shown.stdout.includes(v)).length }), method: "operator string search of ax get task; output not stored" }, ref.run_id);
        const markers = await this.put(`markers-${task}.json`, this.markers(t), ref.run_id);
        // Recorded, not asserted (§10): whether the next tenant's router and worker target ran beside this prober.
        const facts = await this.put(`run-facts-${task}.json`, { ...this.facts(cfg, false), ...(tgt ? { target_ran: !tgt.dead && Boolean(tgt.row.worker) } : {}) }, ref.run_id);
        const own = { emulate: t.targets!.filter((x) => x.own && /emulate/.test(x.role)).map((x) => x.address), floci: t.targets!.filter((x) => x.own && /floci/.test(x.role)).map((x) => x.address) };
        const count = crossTenantUpstreams(extract, own, 0).cross_tenant_upstream_count;
        const args2 = ["--run", "--case", "MT-ISO", "--task", task, "--targets-file", targets, "--egress-log-file", egress, "--disclosure-file", disclosure, "--foreign-markers-file", markers, "--run-facts", facts];
        if (plantedPolicy) {
          const dir = await this.observe(t, ref, args2, join(this.setDir, "controls"));
          const n = dir ? readJson(join(dir, "observations.json")).observations?.cross_tenant_upstream_count : undefined;
          if (this.dry || (typeof n === "number" && n >= 1)) delete this.detector.egress;
          else this.detector.egress = `stop rule 1: the egress control did not fire on cluster ${this.cl.id} (cross_tenant_upstream_count ${n ?? "absent"})`;
          return;
        }
        // Stop rule 3 (the planted control's window excluded): observe this bundle, then stop the step.
        if ("value" in count && count.value > 0) this.isoBreach = `stop rule 3: ${count.value} cross-tenant upstream(s) in ${task}'s probe window`;
        await this.observe(t, ref, args2);
      },
    });
  }
}

async function runStepCmd(planFile: string, id: ClusterId, d: D, dry: boolean, only?: string): Promise<number> {
  let plan: MultiPlan = readJson(planFile);
  const c = plan.clusters[id];
  if (!c) throw new Error(`the plan has no cluster ${id}`);
  const infra = readInfra(c.infra_run_dir);
  assertIdentity(id, infra);
  let mine = plan.configurations.filter((cfg) => cfg.cluster === id);
  let stepRunId = c.step_run_id;
  if (only !== undefined) {
    // §4.7: a fresh step run on fresh copies of the named configurations, recorded in plan.json before any call.
    const kinds = only.split(",") as Kind[];
    if (kinds.some((k) => !KINDS.includes(k))) throw new Error(`--only takes ${KINDS.join(", ")}, comma-separated`);
    if (!existsSync(join(d.runsRoot, c.step_run_id, "owned-resources.json"))) throw new Error(`--only re-runs configurations of a step that ran; cluster ${id}'s first step run has not`);
    const fresh = freshCopies(plan, mine.filter((cfg) => kinds.includes(cfg.kind)), readJsonIf(join(d.runsRoot, "tenant-runs.json")) ?? [], d.uuid);
    if (!fresh.configurations.length) throw new Error(`the plan has no ${kinds.join(" or ")} configuration on cluster ${id}`);
    stepRunId = d.uuid();
    if (!dry) {
      c.step_runs = [...stepRunsOf(c), { step_run_id: stepRunId, only: kinds, created_at: iso(), ...fresh }];
      writeFileSync(`${planFile}.tmp`, `${JSON.stringify(plan, null, 2)}\n`);
      renameSync(`${planFile}.tmp`, planFile);
    }
    mine = fresh.configurations;
    plan = { ...plan, clusters: { ...plan.clusters, [id]: { ...c, step_run_id: stepRunId } }, configurations: mine, controls: fresh.controls };
  }
  const fileTag = stepRunId === c.step_run_id ? "" : `-${stepRunId.slice(0, 8)}`;
  const root = dry ? mkdtempSync(join(tmpdir(), "apl-multi-dry-")) : d.runsRoot;
  const registryFile = join(root, "tenant-runs.json");
  if (dry) {
    d.log(`DRY RUN on cluster ${id}: run dirs under ${root}; nothing below is executed except the context check`);
    if (existsSync(join(d.runsRoot, "tenant-runs.json"))) copyFileSync(join(d.runsRoot, "tenant-runs.json"), registryFile);
  }
  const stepDir = join(root, stepRunId), setDir = join(root, "sets", plan.set_id);
  if (existsSync(join(stepDir, "owned-resources.json"))) throw new Error("this step run dir exists; a step is never resumed (design 14, crash recovery)");
  mkdirSync(join(stepDir, "axhome"), { recursive: true });
  mkdirSync(setDir, { recursive: true });
  // The versions this step ran on, as `plan --step 2` compares them (§4.6); the infra dir's file can be rewritten.
  writeFileSync(join(setDir, `versions-${id}.json`), `${JSON.stringify(infra.versions, null, 2)}\n`);
  copyFileSync(join(infra.dir, "kubeconfig"), join(stepDir, "kubeconfig"));
  chmodSync(join(stepDir, "kubeconfig"), 0o600);
  const l = infra.owned.local ?? {};
  const owned = {
    run_id: stepRunId, short_id: stepRunId.slice(0, 8), kube_context: c.context,
    ...(infra.owned.project ? { project: infra.owned.project } : {}), ...(infra.owned.zone ? { zone: infra.owned.zone } : {}), ...(infra.owned.cluster ? { cluster: infra.owned.cluster } : {}),
    ax: [], substrate: [], kubernetes: [], cluster_scoped: [], scaled: [], scaled_namespaces: [],
    local: { ...(l.bin ? { bin: l.bin } : {}), ...(l.ax_cli ? { ax_cli: l.ax_cli } : {}), ...(l.kubectl ? { kubectl: l.kubectl } : {}) },
  };
  const errs = ownedResourcesErrors(owned);
  if (errs.length) throw new Error(`step run dir would not match run-dir.schema.json: ${errs.join("; ")}`);
  writeFileSync(join(stepDir, "owned-resources.json"), JSON.stringify(owned, null, 2));

  const cl = new Cluster(id, c.context, stepDir, infra, d, dry);
  const emulate = (() => { try { return imageRef(infra, /\/apl-emulate$/); } catch { return dry ? "<apl-emulate image>" : ""; } })();
  const runner = new StepRunner(plan, cl, stepDir, setDir, registryFile, d, infra.versions.lab_image ?? "<lab_image>", infra.versions.lab_commit, emulate, fileTag);
  let stop: Stop | undefined;
  try {
    const blocked = await preflight(infra, c.context)
      ?? (!infra.versions.lab_commit ? "versions.json has no lab_commit (build phase 6)" : null) ?? (!emulate ? "no apl-emulate image in the infrastructure run dir's images list" : null);
    if (blocked) {
      if (!dry) throw new Stop("BLOCKED", `cluster ${id}: ${blocked}`);
      d.log(`[${id}] BLOCKED: ${blocked} (a real run stops here and makes no call)`);
    }
    await cl.checkContext();
    const snap = await cl.call({ cmd: "bash", args: [TEARDOWN, "--snapshot", stepDir, join(stepDir, "pre-snapshot.json")], env: cl.env() });
    if (snap.code) throw new Stop("BLOCKED", `teardown.sh --snapshot exited ${snap.code}`);
    const cm = await cl.kubectl(["-n", "ate-system", "get", "cm", "atenet-egress", "-o", "json"]);
    const diff = gatewayConfigDiff(parseJson(cm.stdout) ?? {}, FIXTURE);
    if (diff.length) throw new Stop("BLOCKED", `stop rule 8: the deployed atenet-egress access-log config differs from the pinned fixture (${diff.join(", ")}); ask the owner`);
    await cl.openPf();
    for (const cfg of mine) await (cfg.kind === "mt-iso" ? runner.runIso(cfg) : runner.runConfiguration(cfg));
  } catch (e) {
    stop = e instanceof Stop ? e : new Stop("BLOCKED", `runner error: ${(e as Error).message}`);
    d.log(`[${id}] STOP: ${stop.message}`);
  }
  cl.pf?.stop?.();
  // teardown.sh keeps its own guard (schema valid, current context = kube_context), so it runs after every stop.
  if (cl.calls > 0) {
    const td = await cl.call({ cmd: "bash", args: [TEARDOWN, stepDir], env: cl.env() }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }) as Result);
    // teardown.sh logs a failed AX or Substrate delete as "failed (continuing)" and goes on to exit 0.
    const status = td.code === 0 && !/UNEXPECTED|failed \(continuing\)/.test(td.stdout) ? "CLEAN" : "INCOMPLETE";
    writeFileSync(join(stepDir, "teardown.json"), JSON.stringify({ exit_code: td.code, status, at: iso() }, null, 2));
    writeFileSync(join(stepDir, "teardown.log"), `${td.stdout}${td.stderr ? `\n--- stderr ---\n${td.stderr}` : ""}`); // resource names only; stays in the private run dir
  }
  if (stop?.scope === "set") d.log(`[${id}] stop rule 2 stops the set: no further step runs until the context is resolved`);
  for (const cfg of mine) for (const tr of cfg.tenant_runs) for (const b of tr.bundles) {
    if (!dry) runner.block(b, stop?.execution ?? "NOT_RUN", stop?.message ?? "planned, not reached");
  }
  writeFileSync(join(stepDir, "stopped.json"), `${JSON.stringify(runner.stopped, null, 2)}\n`);
  const rawFile = join(setDir, "timing-raw.json");
  const raw = readJsonIf(rawFile) ?? { tasks: [], rounds: [], rounds_absent: [] };
  const tag = (xs: object[]) => xs.map((x) => ({ ...x, step_run_id: stepRunId })); // §4.7: which step run a round's spread is from
  writeFileSync(rawFile, `${JSON.stringify({ tasks: [...raw.tasks, ...runner.rows], rounds: [...raw.rounds, ...tag(runner.rounds)], rounds_absent: [...(raw.rounds_absent ?? []), ...tag(runner.roundsAbsent)] }, null, 2)}\n`);
  writeFileSync(join(setDir, `run-step-${id}${fileTag}.json`), `${JSON.stringify({ errors: runner.errors, events: runner.events, leftovers: runner.leftoverLog, actor_probe: runner.actorProbe, detector: runner.detector }, null, 2)}\n`);
  d.log(`[${id}] ${dry ? "dry run done" : "run-step done"}: ${runner.observed.size} observed, ${runner.stopped.length} in stopped.json${stop ? `; stopped: ${stop.message}` : ""}`);
  return stop ? 1 : 0;
}

// ---- report (§11.2 to §11.4) ----

// §11.3: a stopped.json entry as a C4 bundle, checksummed when written.
export function writeStopBundle(e: Stopped, labCommit: string | undefined) {
  const b = assertContract("observation-bundle", {
    schema_version: 1, case_id: e.case, run_id: e.run_id, profile: "ax", mode: "scripted", execution: e.execution, reason: e.reason,
    candidate_revision: labCommit ?? "unknown", fixture_sha256: fixtureSha256(), dependencies_sha256: sha256(readFileSync(join(ROOT, "package-lock.json"), "utf8")),
    seed: 0, mutation: "none", collector: "multi.ts report (not observed: stopped)", collector_methods: [], observed_at: e.at,
    observations: {}, unobserved: {}, evidence: [],
  });
  const dir = artifactDir(e.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "observations.json"), `${JSON.stringify(b, null, 2)}\n`);
  writeChecksums(dir);
  return dir;
}

async function reportCmd(planFile: string, d: D): Promise<number> {
  const plan: MultiPlan = readJson(planFile);
  const setDir = join(d.runsRoot, "sets", plan.set_id);
  const table = readJson(join(AX, "cases.ax.json"));
  const steps = Object.entries(plan.clusters) as [ClusterId, NonNullable<MultiPlan["clusters"]["a"]>][];
  const commit = Object.fromEntries(steps.map(([k, c]) => [k, readInfra(c.infra_run_dir).versions.lab_commit as string | undefined]));
  // §11.2: every step run of each cluster, with the configurations it ran, its stopped.json and its teardown status.
  const runs = steps.flatMap(([k, c]) => stepRunsOf(c).map((s, i) => ({
    cluster: k, step_run_id: s.step_run_id, configurations: i === 0 ? plan.configurations.filter((cfg) => cfg.cluster === k) : s.configurations ?? [],
    stopped: (readJsonIf(join(d.runsRoot, s.step_run_id, "stopped.json")) ?? []) as Stopped[],
    teardown: (readJsonIf(join(d.runsRoot, s.step_run_id, "teardown.json"))?.status ?? "NOT_RUN") as "CLEAN" | "NOT_RUN" | "INCOMPLETE",
  })));
  const WORST = ["CLEAN", "NOT_RUN", "INCOMPLETE"];
  const cleanup = Object.fromEntries(steps.map(([k]) => [k, runs.filter((r) => r.cluster === k).map((r) => r.teardown).reduce((w, x) => (WORST.indexOf(x) > WORST.indexOf(w) ? x : w), "CLEAN")]));
  for (const r of runs) {
    for (const e of r.stopped) if (!existsSync(join(artifactDir(e.run_id), "observations.json"))) writeStopBundle(e, commit[r.cluster]);
  }
  // One bundle per planned bundle: observed over a stop bundle over none, the later step run between equals. The
  // others are superseded and listed, so an earlier stop stays visible without being counted twice.
  const keyOf = (cfg: Configuration, tr: TenantRun, b: BundleRef) => [cfg.cluster, cfg.kind, cfg.c, tr.tenant, b.case, b.task ? taskSuffix(b.task) : ""].join("|");
  const cands = runs.flatMap((run) => run.configurations.flatMap((cfg) => cfg.tenant_runs.flatMap((tr) => tr.bundles.map((b) => {
    const stop = run.stopped.find((e) => e.run_id === b.run_id);
    return { key: keyOf(cfg, tr, b), run, tr, b, stop, rank: stop ? 1 : existsSync(join(artifactDir(b.run_id), "observations.json")) ? 2 : 0 };
  }))));
  const taken = new Map<string, (typeof cands)[number]>();
  for (const x of cands) if (x.rank >= (taken.get(x.key)?.rank ?? 0)) taken.set(x.key, x);
  const superseded = cands.filter((x) => taken.get(x.key) !== x).map((x) => ({
    run_id: x.b.run_id, case: x.b.case, task: x.b.task, step_run_id: x.run.step_run_id,
    ...(x.stop ? { execution: x.stop.execution, reason: x.stop.reason } : { execution: x.rank ? "observed" : "no bundle" }),
    replaced_by: taken.get(x.key)!.b.run_id, replaced_by_step_run_id: taken.get(x.key)!.run.step_run_id,
  }));
  writeFileSync(join(setDir, "superseded.json"), `${JSON.stringify(superseded, null, 2)}\n`);
  const reports: Record<string, { status: Status; reason: string | null }> = {};
  const disagree: object[] = [];
  for (const { b, run } of taken.values()) {
    const dir = artifactDir(b.run_id);
    if (!existsSync(join(dir, "observations.json"))) continue; // the aggregate lists it as NOT_RUN ("planned, no report")
    const ev = spawnSync("python3", [join(AX, "evaluate_ax.py"), b.case, dir], { encoding: "utf8" });
    const verdict = parseJson(ev.stdout.trim().split("\n").pop() ?? "");
    const rep = await generateReport(b.run_id, { expected: table[b.case].expected, limitations: LIMITATIONS, cleanup_status: cleanup[run.cluster] });
    reports[b.run_id] = { status: rep.status, reason: rep.reason ?? null };
    if (!verdict || !agrees(verdict, rep.status)) disagree.push({ run_id: b.run_id, case: b.case, evaluate: verdict?.status ?? "no verdict", report: rep.status });
  }
  if (disagree.length) {
    writeFileSync(join(setDir, "report-stopped.json"), `${JSON.stringify({ rule: "stop rule 5", disagree }, null, 2)}\n`);
    d.log(`stop rule 5: evaluate_ax.py and generateReport() disagree on ${disagree.length} bundle(s); nothing from this set is exported`);
    return 1;
  }
  const exports = Object.keys(reports).map((runId) => exportRun(runId, { outRoot: d.evidenceRoot }));
  writeFileSync(join(setDir, "exports.json"), `${JSON.stringify(exports, null, 2)}\n`);
  // Step 2 with A's half reused: A's row is step 1's c = 1 configuration on A and its reports (§4.6).
  const reused = plan.a && "reused" in plan.a ? plan.a.reused : undefined;
  // §11.4: the plan with each planned bundle replaced by the one taken; a configuration's rounds only from the step
  // runs its taken bundles came from (a round with no step_run_id is the first step run's).
  const effective: MultiPlan = { ...plan, configurations: plan.configurations.map((cfg) => ({ ...cfg, tenant_runs: cfg.tenant_runs.map((tr) => {
    const ws = tr.bundles.map((b) => taken.get(keyOf(cfg, tr, b))!);
    const bySuffix = new Map(ws.flatMap((w) => (w.b.task ? [[taskSuffix(w.b.task), w.b.task] as const] : [])));
    return { ...tr, tenant_run_id: [...new Set(ws.map((w) => w.tr.tenant_run_id))].join("+"), tasks: tr.tasks.map((t) => bySuffix.get(taskSuffix(t)) ?? t), bundles: ws.map((w) => w.b) };
  }) })) };
  const fromTaken = (r: { cluster: string; c: number; step_run_id?: string }) => {
    const cfg = plan.configurations.find((x) => x.kind === "configuration" && x.cluster === r.cluster && x.c === r.c);
    return !cfg || cfg.tenant_runs.some((tr) => tr.bundles.some((b) => taken.get(keyOf(cfg, tr, b))!.run.step_run_id === (r.step_run_id ?? plan.clusters[r.cluster as ClusterId]?.step_run_id)));
  };
  const setRaw = readJsonIf(join(setDir, "timing-raw.json")) ?? { tasks: [], rounds: [] };
  const raw = { ...setRaw, rounds: setRaw.rounds.filter(fromTaken), rounds_absent: (setRaw.rounds_absent ?? []).filter(fromTaken) };
  let aggPlan: Plan = effective as unknown as Plan, aggRaw: TimingRaw = raw;
  if (reused) {
    const one: MultiPlan = readJson(join(d.runsRoot, "sets", reused.set_id, "plan.json"));
    const cfg = one.configurations.find((x) => x.kind === "configuration" && x.cluster === "a" && x.c === 1);
    if (!cfg) throw new Error("step 1's set has no c = 1 configuration on A to reuse");
    for (const b of cfg.tenant_runs.flatMap((t) => t.bundles)) {
      const r = readJsonIf(join(artifactDir(b.run_id), "report.json"));
      if (r) reports[b.run_id] = { status: r.status, reason: r.reason ?? null };
    }
    const oneRaw = readJsonIf(join(d.runsRoot, "sets", reused.set_id, "timing-raw.json")) ?? { tasks: [], rounds: [] };
    aggPlan = { ...effective, configurations: [cfg, ...effective.configurations] } as unknown as Plan;
    const aC1 = (x: any) => x.cluster === "a" && x.c === 1;
    aggRaw = { tasks: [...oneRaw.tasks.filter(aC1), ...raw.tasks], rounds: [...oneRaw.rounds.filter(aC1), ...raw.rounds], rounds_absent: [...(oneRaw.rounds_absent ?? []).filter(aC1), ...(raw.rounds_absent ?? [])] };
  }
  const agg = writeAggregate(aggPlan, reports, aggRaw, { outRoot: d.evidenceRoot });
  d.log(JSON.stringify({ reports: Object.keys(reports).length, superseded, exported: exports.filter((x) => x.status === "EXPORTED").length,
    quarantined: exports.filter((x) => x.status !== "EXPORTED").map((x) => x.run_id), aggregate: agg.status, output: agg.output }));
  return agg.status === "EXPORTED" ? 0 : 1;
}

// ---- CLI ----

export async function main(argv: string[], deps: Deps): Promise<number> {
  const { positionals: [cmd, which], values: v } = parseArgs({
    args: argv, allowPositionals: true,
    options: { step: { type: "string" }, "set-id": { type: "string" }, "infra-a": { type: "string" }, "infra-b": { type: "string" }, "step1-set-id": { type: "string" },
      infra: { type: "string" }, resize: { type: "string" }, plan: { type: "string" }, cluster: { type: "string" }, only: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const d: D = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (s) => console.log(s), runsRoot: join(ROOT, "private-runs", "ax"),
    evidenceRoot: join(ROOT, "docs", "evidence"), uuid: randomUUID, portFree, ...deps };
  const id = (cmd === "infra" ? which : v.cluster) as ClusterId;
  try {
    // plan --step 2 reads cluster A and report writes docs/evidence; neither has a dry mode.
    if ((cmd === "plan" || cmd === "report") && v["dry-run"]) throw new Error(`${cmd} has no --dry-run: it would make its real reads and writes; only infra and run-step take --dry-run`);
    if (cmd === "plan") return await planCmd(v, d);
    if ((cmd === "infra" || cmd === "run-step") && id !== "a" && id !== "b") throw new Error("the cluster must be a or b");
    if (cmd === "infra" && v.infra) return await infraCmd(id, v.infra, v, d, Boolean(v["dry-run"]));
    if (cmd === "run-step" && v.plan) return await runStepCmd(v.plan, id, d, Boolean(v["dry-run"]), v.only);
    if (cmd === "report" && v.plan) return await reportCmd(v.plan, d);
  } catch (e) {
    d.log(`multi.ts ${cmd}: ${e instanceof Stop ? "STOP: " : ""}${(e as Error).message}`);
    return 1;
  }
  d.log("usage: multi.ts plan|infra|run-step|report ... (see the header of profiles/ax/multi.ts)");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2), { exec: realExec }));
