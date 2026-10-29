Status: revised after EGM review round 1; pending round 2.

# Multi-tenant and multi-cluster test design (AX lane)

This is a test design, not a result. Nothing in it has run. It extends the optional AX lane (`profiles/ax/`) with three owner-approved steps and says exactly what would be built, run, recorded and torn down. Every PASS or FAIL it plans comes from an independent collector and the supplied evaluator, never from AX task phase (L-006).

Sources read for this design: [`profiles/ax/README.md`](../profiles/ax/README.md), [`profiles/ax/RESULTS.md`](../profiles/ax/RESULTS.md), `profiles/ax/{case.ts,collector.ts,orchestrate.ts,index.ts,run-dir.ts,run-dir.schema.json,teardown.sh,evaluate_ax.py,cases.ax.json}`, `src/reports/{report.ts,artifacts.ts,export.ts}`, `src/collector/cases/s2.ts`, `src/adapters/faults/proxy.ts`, the supplied `evals/evaluate.py` and `evals/cases.json`, [`LEARNINGS.md`](LEARNINGS.md) L-006 to L-012, L-019 and L-030 to L-057, [`CLAIM_LEDGER.md`](CLAIM_LEDGER.md) C-60 to C-70, [`CONTRACTS.md`](spec/active/2026-10-28-agent-proof-lab/contracts/CONTRACTS.md) C4 and C5, and the two infrastructure run dirs (section 3).

## 1. Problem statement

AX run 3 (set X, C-60 to C-70) showed one tenant on one cluster with one worker. It says nothing about tenants that share workers, about the same case judged on two clusters, or about work that moves or is evicted mid-run. The owner approved three steps that answer, with lab evidence only:

1. Do tenants that share one cluster and one worker pool keep their egress and their evidence apart, and how long does a W01-H task take as concurrency grows?
2. Does the same case reach the same verdict on two clusters when each is judged on its own, and can either cluster reach the other?
3. Can a suspended task resume on the other cluster, and does an eviction mid-run produce a duplicate business effect?

Until these run, every AX claim stays at one tenant on one cluster.

## 2. Scope

| Step | What | Cluster(s) |
|---|---|---|
| 1 | Many tenants: up to 4 concurrent tenants, each with its own atespace, namespace and Emulate workspace; isolation; timing with n ≥ 30 tasks per configuration | A |
| 2 | Two clusters: the same case on each; C5 reports per cluster; an all-clusters view that never blends into one green; a protocol-skew preflight; cross-cluster reachability | A and B |
| 3 | Moving work: suspend on A and resume on B (snapshot portability, UNKNOWN today); S2 on AX, with the worker Pod evicted mid-run | A and B |

Not in scope: microVM sandboxes, the default AX runner, a live model, any change to Substrate on A (router allowlist included), any scale claim. Vendor scale statements from Google AX or Agent Substrate docs may enter the ledger only as DOCUMENTED, with the doc path at a pinned SHA, and are never compared with a lab measurement.

## 3. Starting point

- Cluster A ran AX run 3: AX `4b7bf6f` on Substrate v0.6.0 (`d3f2363590a1`), 2 × c3-standard-4, amd64, GKE 1.36.4, gVisor, one worker. Run 3 was torn down on 2026-10-29 (`RESULTS.md`, "Teardown"); its run dir's manifest is retired.
- The same day the owner approved restoring the lane on A and creating cluster B. Two infrastructure run dirs now own what exists (section 8):
  - **A, run dir `41dc91c3`.** Not owned (pre-existing): Substrate v0.6.0 and A's snapshot transfer service account with its three grants. Owned: AX `4b7bf6f` in `ax-system` with its cluster-scoped objects, the private Artifact Registry repo with the AX and lab images, one snapshot prefix, and the collector namespace `apl-ax-6882d106` (ServiceAccount and Pod `apl-collector`, Floci, Emulate, WorkerPool `apl-ax-pool`). The namespace keeps run 3's name so the SPIFFE ID already in A's router allowlist still applies.
  - **B, run dir `34c8957e`.** Owned: cluster B (`gke_cluster`, with a project-level `pre-snapshot.json` taken before B existed), its snapshot bucket with four bindings (two for the `ns/ate-system/sa/ate-api-server` Workload Identity principal, two for A's transfer account), Substrate v0.6.0 (router allowlist already lists `apl-ax-6882d106/apl-collector`; its transfer account is still A's) and AX `4b7bf6f`. `versions.json` records the versions and that they match A's.
- Known AX behaviour this design plans around: tasks are created suspended and need `ax resume` (L-047); a new template gets a golden actor that takes worker capacity (L-047); AX templates set no `workerSelector`, so tasks land on any pool (L-039); `ax suspend` and `ax delete task` send no SIGTERM, and after an eviction the actor counts as crashed and is reverted, losing `result.json` (L-048, C-62, C-63, C-66); `ax get task` returns `spec.env` in clear to any AX API caller (L-034, C-69); the v0.6.0 router serves actors only over mTLS to allowlisted SPIFFE IDs (L-045); egress refusals are judged from the egress gateway's log, not from probe byte counts (L-049); run 3 timing measured operator tooling more than AX (L-050).

## 4. Design rules

1. **Evidence exactly as before.** Every result is an independent-collector C4 bundle, judged by `evaluate_ax.py` and by `buildReport()` (`src/reports/report.ts`), with one C5 report per tenant and per cluster, exported with `exportRun()` (`src/reports/export.ts`) to `docs/evidence/<run_id>/`. No report covers two tenants or two clusters. For W01 work a tenant's C5 evidence is one report per task (F3-A1) plus its MT-W01 or MC-W01 report, rolled up into the tenant row with the C5 precedence (section 9.1). Each result gets a claim ID starting at C-80 (section 16.2); vendor claims are DOCUMENTED only. If `evaluate_ax.py` and `buildReport()` disagree on a status under the agreement rule (section 14, rule 5), the run stops.
2. **Phase is not outcome.** `ax_task_phase` stays under `recorded_not_asserted` in every case (L-006).
3. **Absent is not zero.** An observation the collector could not make is absent with a reason (C4), which makes its assertion UNKNOWN. A lost `result.json` after eviction makes `command_exit_code` absent, as C-66 requires.
4. **One clock per interval.** Every timing interval is measured on one named clock. No interval subtracts a timestamp taken on one machine from one taken on another (L-050).
5. **Pre-registration.** Before each step runs, its expectations (sections 10.6, 11.6, 12) are committed to the second table of `LEARNINGS.md` ("Expected before running"), as was done for the W5 runs.
6. **Identifiers stay private.** Project, cluster names, zones, contexts, registry, buckets, accounts and IPs live only in gitignored `private-runs/ax/`. Public files use placeholders (`<project>`, `<cluster-a>`, `<cluster-b>`, `<zone-b>`, `<registry>`, `<snapshot-bucket>`, `<transfer-sa>`), as `RESULTS.md` does.
7. **Collector values, not operator values.** An assertion uses only what the collector computes from system records: Emulate, Floci, the router, and files of system-written records that the operator copies verbatim (the egress gateway's access log, as for C-67). A value the operator computes or reads from a CLI (a string-search count, `kubectl ate get actors`) is recorded, not asserted, as C-69 was.

## 5. Components, files and build order

### 5.1 The runner

`profiles/ax/multi.ts` makes every cluster call in this design.

| Subcommand | Input | Output | Calls |
|---|---|---|---|
| `plan --step N` | set ID, the two infrastructure run dirs | `private-runs/ax/sets/<set_id>/plan.json`: clusters, configurations, tenant runs, evidence run IDs, tasks per round, probe targets by role | none |
| `run-step --plan P` | `plan.json`; per cluster its infrastructure run dir (`kubeconfig`, `versions.json`) | one step run dir per cluster, tenant run dirs, rendered manifests, raw timing file `timing-raw.json` | per cluster: `doctor()`, the skew preflight (11.2), `orchestrate.ts init` and `manifests`, `teardown.sh --snapshot`, `kubectl apply`, `ax apply`, egress policy attach, `ax resume`, `ax delete` |
| `observe --plan P` | `plan.json`, operator captures (egress log extract, disclosure count, actor lists) | per bundle `artifacts/runs/<run_id>/observations.json` and `evidence/` | `collector.ts observe` in the collector Pod, one call per bundle |
| `report --plan P` | the bundles | per bundle `report.json` and `report.md` (per tenant and per cluster), exports under `docs/evidence/<run_id>/`, then the set's aggregate | `evaluate_ax.py --cases`, `generateReport()`, the agreement rule, `exportRun()`, `src/reports/aggregate.ts` |

Before any call to a cluster, `run-step` runs `doctor()` (`profiles/ax/index.ts`) with that cluster's environment (`APL_AX_CONTEXT` naming that cluster's context, plus its kubectl, ax CLI and image) and requires `APL_AX_AUTHORIZED=1`. A BLOCKED doctor or a missing opt-in leaves that cluster's rows BLOCKED and makes no call there. Every call then uses that cluster's kubeconfig (context guard, section 8).

### 5.2 Files

| Action | File | Change |
|---|---|---|
| Create | `profiles/ax/multi.ts` | the runner (5.1), the agreement rule, foreign-marker lists, IP-to-role mapping |
| Create | `profiles/ax/skew.ts` | the skew preflight (11.2) |
| Create | `profiles/ax/cases.multi.json` | expectations (9.2) |
| Create | `profiles/ax/manifests/k8s/tenant.yaml` | tenant Floci and Emulate with requests of 100m CPU and 256Mi per container (limits kept), and a NetworkPolicy admitting the collector by namespace and label |
| Create | `src/reports/aggregate.ts` | all-clusters view (11.5) |
| Create | `tests/unit/ax-multi.test.ts` | agreement rule, plan, foreign markers, IP replacement, per-call context guard |
| Create | `tests/unit/ax-skew.test.ts` | skew preflight on synthetic inputs |
| Create | `tests/unit/aggregate.test.ts` | all-clusters view |
| Create | `tests/unit/report-wording.test.ts` | AX wording by profile, local wording unchanged |
| Modify | `profiles/ax/case.ts` | `APL_AX_PROBE_URLS`, router-path and worker-local probes, probe self-report into its own bucket; mode `S2` (12.2) |
| Modify | `profiles/ax/orchestrate.ts` | `init --ns-prefix` (default `apl-ax`), mode `S2`, `--probe-urls`, `spec.config` keys `apl-set`, `apl-cluster`, `apl-tenant` |
| Modify | `profiles/ax/collector.ts` | `--run-id`, `--env-file`; observe cases MT-W01, MT-ISO, MC-W01, MC-XREACH, MV-PORT, MV-DRAIN; inputs `--foreign-markers-file`, `--targets-file`, `--egress-log-file`, `--disclosure-file`; router stage probe; `simulated_faults` in the bundle |
| Modify | `profiles/ax/evaluate_ax.py` | optional `--cases FILE`, default `cases.ax.json` |
| Modify | `src/reports/report.ts` | AX wording by profile (16.1) |
| Modify | `src/reports/artifacts.ts` | `generateReport()` takes optional `expected` and `limitations`; today it reads expectations only from the spec's `cases.json` and passes no limitations |
| Modify | `docs/LEARNINGS.md` | pre-registered expectations, committed before each step |
| Modify | `docs/CLAIM_LEDGER.md` | set XM and one row per result, only when its evidence exists |
| Delete | none | |

Unchanged: `profiles/ax/index.ts` (doctor gains no prerequisite), `run-dir.ts`, `run-dir.schema.json`, `teardown.sh`, `manifests/k8s/emulators.yaml` (the single-run template), `cases.ax.json`, the supplied `evaluate.py` and `cases.json`.

### 5.3 Build order

Each phase ends when its test gate and the existing `npm test` pass. No cluster call happens before phase 6's gate and the owner's go-ahead.

1. Report wording, `generateReport()` options, `evaluate_ax.py --cases`. Gate: `report-wording.test.ts`; `evaluate_ax.py` still refuses a table that asserts a recorded-only key.
2. `cases.multi.json`, the agreement rule, `aggregate.ts`. Gate: `aggregate.test.ts` and the agreement cases in `ax-multi.test.ts`.
3. `tenant.yaml`, `orchestrate.ts`, `case.ts`. Gate: a rendering test (requests present, every placeholder filled, `emulators.yaml` byte-identical) and the existing `tests/integration/ax-profile.test.ts`.
4. `collector.ts`. Gate: unit tests on synthetic captures: a foreign marker found and not found, the key absent with no foreign tenants, every IP replaced before an evidence file is written, a router probe without its positive control giving an absent key.
5. `skew.ts`. Gate: `ax-skew.test.ts`.
6. `multi.ts`. Gate: the plan test, the per-call context guard test, a dry run that prints every planned call and makes none, `npm run validate:package`.

## 6. Collector identity: one per cluster

On Substrate v0.6.0 the collector reads a task's `/apl/result` only through the router, over mTLS, with a SPIFFE ID listed in `--ingress-allowed-spiffe-ids` (L-045). A's allowlist has exactly one lab ID, `apl-ax-6882d106/apl-collector`, and changing it is not approved. B's install lists the same ID, so both clusters are configured the same way.

- Namespace `apl-ax-6882d106`, ServiceAccount `apl-collector`, Pod `apl-collector` on both clusters, owned by that cluster's infrastructure run dir.
- Each tenant run's collector environment (`collector-env.json` from `orchestrate.ts manifests`) becomes a Secret `collector-env-<tr8>` in the collector's own namespace, owned by the step run dir. At the start of each step the collector Pod is recreated with that step's Secrets projected as files. It keeps `automountServiceAccountToken: false`. There is no cross-namespace RBAC and no API token: the collector never calls the Kubernetes API.
- `collector.ts observe --env-file <tenant's file> --run-id <evidence run ID>` runs once per bundle, with its own output directory.
- In the collector namespace a NetworkPolicy selecting the collector Pod admits no ingress; the collector only dials out. Each tenant namespace's NetworkPolicy admits the collector by namespace and pod label (`kubernetes.io/metadata.name: apl-ax-6882d106` plus `app: apl-collector`) instead of the same-namespace selector in `emulators.yaml`. Both clusters run GKE Dataplane V2, which enforces NetworkPolicy.

**What this weakens, stated plainly.** One collector process holds every tenant's reader token and S3 key on its cluster. That is a smaller change from run 3 than it looks: Floci accepts any access key (L-037) and Emulate accepts any valid token (L-019), so per-run credentials were labels in run 3 too, and the boundary was which process knows which URL. Separation of tenants' evidence rests on the collector's code (one environment file and one output directory per bundle) and is checked by `foreign_marker_count` (section 9). What cannot be tested is whether a second, separately allowlisted collector identity could read another tenant's results through the router, because each cluster has one identity. Every report from this design carries that limitation.

## 7. Naming and labels

| Thing | Name | Notes |
|---|---|---|
| Set | `set_id` (UUID) | one per execution of a step |
| Infrastructure run | `41dc91c3…` (A), `34c8957e…` (B) | long-lived; own the shared resources (section 8) |
| Step run | `step_run_id` (UUID) | one per step and cluster; owns that step's tenant objects |
| Tenant run | `tenant_run_id` (UUID), short `<tr8>` | one per tenant per configuration; names the namespace |
| Evidence run | `run_id` (UUID) | one per C4 bundle: one per task (F3-A1), one per tenant run and case otherwise; keys the bundle, its C5 report and `docs/evidence/<run_id>/` |
| Tenant namespace and atespace | `apl-mt-<tr8>` | prefix distinct from the collector's `apl-ax-` (`orchestrate.ts init --ns-prefix apl-mt`); `orchestrate.ts` uses the namespace as the atespace |
| Tenant tasks | `apl-<tr8>-<nn>`, Workspace `ws-<task>` | `nn` is the round, `00` the warm-up; unique across the set, so a task name is a usable foreign marker |
| Pool | `apl-ax-6882d106/apl-ax-pool` | owned by the infrastructure run dir; shared by all tenants on the cluster (10.2) |
| Collector | `apl-ax-6882d106/apl-collector` | fixed by the router allowlist (section 6) |
| Collector env | `apl-ax-6882d106/collector-env-<tr8>` | Secret, owned by the step run dir |
| Tenant labels | `apl-run=<tenant_run_id>`, `apl-set=<set_id>`, `apl-cluster=a\|b`, `apl-tenant=t1..t4`, `apl-role=tenant` | on every Kubernetes object in the tenant namespace |
| AX objects | no labels exist (L-008) | `spec.config` keys `apl-run`, `apl-set`, `apl-cluster`, `apl-tenant`; the same in the Workspace's `.apl/run.json` |

Tenants t1 to t4 are roles. Each configuration gets fresh tenant runs (new UUIDs, new namespaces). Earlier tenant runs of the step stay until the step's teardown; nothing else carries over, and their IDs feed the foreign-marker check.

## 8. Run dirs, ownership and the context guard

- **Infrastructure run dirs, long-lived.** `41dc91c3` (A) and `34c8957e` (B), as listed in section 3. Before step 1, A's gets a `versions.json` written the same way as B's, from read-only queries. Before step 2, B's gains the collector namespace, ServiceAccount, Pod, NetworkPolicy and WorkerPool `apl-ax-pool`, and B's own transfer account (11.1). Both are torn down once, after the last step, B first (16.3).
- **Step run dirs, one per step and cluster.** `private-runs/ax/<step_run_id>/` owns every tenant namespace with its objects, atespace, egress policy (listed for the record), AX Task and Workspace, and every `collector-env-<tr8>` Secret of that step on that cluster. It is one per step, not per tenant, because `teardown.sh` diffs each run dir against its own `pre-snapshot.json`, and concurrent tenant run dirs would each see the others' namespaces as unexpected changes. `pre-snapshot.json` is taken with `teardown.sh --snapshot` before the step's first apply. Teardown runs at the end of the step.
- **Set dir.** `private-runs/ax/sets/<set_id>/plan.json` is written before any call. Tenant run dirs (`secrets.json`, `emulate-seed.json`, rendered manifests, as `orchestrate.ts init` and `manifests` write them) sit under it, one per tenant run; they own nothing.
- **Schema unchanged, and only fields it has.** Every `owned-resources.json` validates against `run-dir.schema.json` as it stands: `run_id` is the run dir's own ID, `kube_context` its cluster's context, tenant objects go in `kubernetes`, `ax` and `substrate`. Versions come from `versions.json`, not from the schema. New run dirs leave `substrate_install` absent: the schema requires it to carry a `previous` install, and made-up values there would arm `--restore-substrate-v05`.
- **Context guard, on every call.** Every cluster call passes `--kubeconfig <run-dir>/kubeconfig` (single context, mode 0600, as `index.ts run()` writes it), and before each call the runner checks that this file's context is the plan's context for that step and cluster. The ambient context is never read. A mismatch is a programming error and stops the set. `teardown.sh` is called with `KUBECONFIG` set to the run dir's kubeconfig, as `index.ts` does for `--snapshot`, and keeps its own guard (schema valid and current context equals `kube_context`).

## 9. Cases

### 9.1 Per task: F3-A1, unchanged

Each W01-H task in steps 1 and 2 is one C4 bundle written by `collector.ts observe --case F3-A1 --task <task>` and judged by F3-A1 in `cases.ax.json` as it is (`ticket_count` 1, `receipt_count` 1, `receipt_matches_request` true, `completion_reply_count` 1, `command_exit_code` 0). A task with an absent fact is UNKNOWN, never FAIL (rule 3).

Roll-up uses `aggregate()` from `report.ts` (FAIL > UNKNOWN > BLOCKED > NOT_RUN > PASS): the tenant row over that tenant run's task reports and its MT-W01 or MC-W01 report; the configuration row over its tenant rows; the cluster row over its configurations and its other cases. One absent fact therefore makes that task and its tenant row UNKNOWN. A planned bundle with no report is NOT_RUN.

### 9.2 `profiles/ax/cases.multi.json`

Same rules as `cases.ax.json`: profile `ax`, typed equality only (the supplied `inspect_bundle()`), and no expectation may name a recorded-only key.

```json
{
  "note": "Multi-tenant and multi-cluster AX expectations (docs/MULTI_CLUSTER.md). Equality only. Recorded keys are never asserted (L-006). W01 tasks are judged one bundle each by F3-A1 in cases.ax.json.",
  "recorded_not_asserted": ["ax_task_phase", "concurrency", "tasks_planned", "tasks_timed", "probe_self_report_reached_count",
    "foreign_secret_in_task_count", "cross_cluster_router_stage", "source_actor_running", "restart_path", "command_exit_code"],
  "MT-W01": {"profile": "ax", "note": "step 1, c = 2 and 4: one per tenant run after its last round", "expected": {"foreign_marker_count": 0}},
  "MT-ISO": {"profile": "ax", "note": "step 1, own tenant runs after c = 4: cross-tenant reach and shared evidence", "expected": {"cross_tenant_upstream_count": 0, "allowed_control_reached": true, "foreign_marker_count": 0}},
  "MC-W01": {"profile": "ax", "note": "step 2: per cluster, one per tenant run after its last round", "expected": {"foreign_marker_count": 0}},
  "MC-XREACH": {"profile": "ax", "note": "step 2: own tenant run per cluster; nothing on one cluster reaches the other", "expected": {"cross_cluster_upstream_count": 0, "allowed_control_reached": true, "cross_cluster_router_accepted": false}},
  "MV-PORT": {"profile": "ax", "note": "step 3: suspend on A, resume on B", "expected": {"prepared_marker_same": true, "agent_edit_present": true}},
  "MV-DRAIN": {"profile": "ax", "source_case": "S2", "note": "step 3 on B: S2 on AX, worker Pod evicted while the receipt PUT is stalled", "expected": {"ticket_count": 1, "completion_reply_count": 1, "false_success_count": 0, "recovery_evidence_present": true, "duplicate_after_restart_count": 0}}
}
```

MT-W01 is not planned at c = 1: with no foreign tenant run the key is absent, so the bundle could only be UNKNOWN.

### 9.3 Observation keys

Asserted keys, each computed by the collector with direct evidence:

| Key | Type | Collected from | Meaning |
|---|---|---|---|
| `foreign_marker_count` | number | every evidence file of this tenant run's bundles, its Floci bucket and its Slack channel | items with a foreign marker: the `run_id` or a task name of any other tenant run in the plan that existed on either cluster before or during this one, or a token found with `SECRET_RULES` (`export.ts`) whose SHA-256 is in another tenant's token-hash list. The collector gets those IDs, names and hashes (`--foreign-markers-file`), never other tenants' tokens. With no foreign tenant run the key is absent with reason "no foreign tenants", never 0 |
| `cross_tenant_upstream_count` | number | egress gateway access log for the probe window, copied verbatim by the operator (`--egress-log-file`) | entries whose upstream is another tenant's Emulate or Floci, by Service name or address, and is not null (L-049) |
| `allowed_control_reached` | boolean | same log | the tenant's own Emulate was reached through the gateway in the same window, so the probe ran under a working policy |
| `cross_cluster_upstream_count` | number | as `cross_tenant_upstream_count` | upstream is a target on the other cluster |
| `cross_cluster_router_accepted` | boolean | collector `GET /apl/result` to the other cluster's router pod IP with its own certificate, verifying the server with the other cluster's servicedns CA | true only for HTTP 200. Written only if the positive control (same code and certificate, to its own cluster's router for a running task, in the same window) returned 200; otherwise absent with that reason, so UNKNOWN |
| `prepared_marker_same`, `agent_edit_present` | boolean | collector on B (`/apl/result`) and the file the task wrote into its own bucket on A | section 12.1 |
| S2's five keys | as S2 | S2's definitions in `src/collector/cases/s2.ts`, computed from the coordinator's ledger exports in the task's bucket, the S3 receipts and the request's thread | section 12.2 |

Recorded, not asserted:

| Key | Collected from | Why not asserted |
|---|---|---|
| `probe_self_report_reached_count` | the probe's own JSON lines in its bucket | the subject's self-report |
| `foreign_secret_in_task_count` | operator string search of `ax get task` for this tenant's tasks against other tenants' secrets; only the count is kept (`--disclosure-file`), the output is not stored, as in run 3 | operator value (rule 7), as C-69 |
| `cross_cluster_router_stage` | the collector's router probe | where the request stopped: `tcp`, `server_verification`, `client_certificate` or `http_<status>`; context for the asserted key |
| `source_actor_running` | operator `kubectl ate get actors` on A | operator value (rule 7); a `true` stops step 3 (rule 3) |
| `restart_path`, `command_exit_code`, `concurrency`, `tasks_planned`, `tasks_timed`, `ax_task_phase` | runner, `result.json`, plan | context only |

**Addresses.** Before the collector writes any evidence file, every IP address in a log extract, target list or probe output is replaced by a placeholder naming its role from the plan's target list (for example `<t2-emulate-clusterip>`, `<b-router-pod>`). The mapping stays in the set dir. An address with no role becomes `<unlisted-address>`, and its presence is recorded.

## 10. Step 1: many tenants on cluster A

### 10.1 Layout per tenant

Each tenant run gets: atespace and namespace `apl-mt-<tr8>`; its own Floci and Emulate from `tenant.yaml` (one Emulate workspace, its own per-run fake secrets from `orchestrate.ts init`); its own egress policy listing only its own Emulate (8080, 8081) and Floci (4566) hosts, attached right after the actor exists and before `ax resume` (L-047); and its collector Secret in the collector namespace. No collector and no WorkerPool in the tenant namespace.

### 10.2 One shared pool, and why

AX templates set no `workerSelector`, so a task can land on any pool (L-039). Per-tenant pools would not pin tenants to their pool, so they would not add isolation. One pool per cluster, the infrastructure-owned `apl-ax-6882d106/apl-ax-pool` (gVisor), set to R = 3 workers before step 1, makes tenants share workers, which is the setting where cross-tenant isolation matters. Other pools on A were deleted by the run 3 reinstall (RESULTS §3.2); the preflight confirms that no other WorkerPool exists.

### 10.3 Concurrency, actors and capacity

Configurations: c ∈ {1, 2, 4} concurrent tenants on A, each tenant running one W01-H task per round. A round submits all c tasks at once, waits for every result or a 120 s timeout, deletes the tasks, then starts the next round (run 3 deleted each task before the next, L-047). Every round the runner lists actors per atespace (`kubectl ate get actors`, recorded): before submit no task actor of the previous round may remain, and after submit there must be c task actors plus at most one golden actor per new template (L-047). Any other count stops that level (section 14, rule 4).

| c | Tenants | Rounds | Tasks (n) | Tasks per tenant run |
|---|---|---|---|---|
| 1 | t1 | 30 | 30 | 30 |
| 2 | t1, t2 | 15 | 30 | 15 |
| 4 | t1 to t4 | 8 | 32 | 8 |

Each configuration starts with one warm-up round (`00`), reported separately and not counted.

Capacity estimate (to be checked, not assumed): 2 × c3-standard-4 is 8 vCPU and 32 GiB before system reservations; Substrate (11 pods) and AX also run there, and their requests are not recorded in the repo. In `emulators.yaml` Floci and Emulate set limits only (500m/768Mi and 500m/512Mi), so their requests equal their limits. `tenant.yaml` adds requests of 100m CPU and 256Mi per container and keeps the limits; `emulators.yaml` stays as it is. Tenant runs stay until the step ends (section 8), so c = 4 runs with 1 + 2 + 4 = 7 tenant namespaces present and MT-ISO with 11. With R = 3 workers (run 3's worker template: request 1 CPU and 4Gi, limit 3 CPU), requests during MT-ISO total about 2.2 (11 tenants) + 1 (the infrastructure run's own Floci and Emulate in the collector namespace, requests equal to limits) + 0.5 (collector) + 3 = 6.7 vCPU and 5.5 + 1.25 + 0.5 + 12 = 19.25 GiB. c = 4 and MT-ISO may therefore end NOT_RUN (capacity). Actor slots: with 1-CPU tasks a 3-CPU worker refused a fourth actor (L-047), so R = 3 gives about 9 slots for at most 4 task actors plus golden actors.

Preflight before each configuration (read-only): node allocatable minus requested CPU and memory must cover the configuration's requests, and the warm-up round must schedule all c tasks. Otherwise the stop rule in section 14 applies.

### 10.4 Isolation (MT-ISO)

After c = 4, four fresh MT-ISO tenant runs (t1 to t4), each with its own evidence run ID. While all four namespaces exist, each tenant in turn runs one `isolation` task, and the next tenant runs one `term`-mode task (it makes no egress) as the router-path and worker-local target. No other task runs, so every gateway log entry in the window comes from the probing tenant; the design does not depend on whether the log names the source actor.

- `case.ts isolation` gains `APL_AX_PROBE_URLS` (comma-separated URLs) next to `APL_AX_PROBE_IPS`. Targets: every other MT-ISO tenant's Emulate (8080, 8081) and Floci (4566) by Service name and by ClusterIP; the router path, `atenet-router.ate-system.svc` on 443 with `ate-target-actor` naming the target tenant's running task; the worker-local path, the worker Pods' IPs on the ports their actors listen on (read from the worker Pod spec by the operator); and the run 3 targets. The probe writes its JSON lines to its own bucket (`apl-evidence/<task>/isolation.json`), kept as `probe_self_report_reached_count`; the verdict comes from the gateway log.
- Disclosure: `foreign_secret_in_task_count` is recorded, not asserted (rule 7). Cross-tenant disclosure through the AX API itself is not testable here: there is one operator identity, and `ax get task` returns `spec.env` to any caller (L-034). That stays a disclosed limitation (C-69), not a claim.
- Shared evidence: `foreign_marker_count` in every MT-ISO bundle.

### 10.5 Timing

Section 13. Timing is recorded, never asserted. Each bundle records `concurrency`, `tasks_planned` and `tasks_timed`; raw per-task intervals go to the set's timing file.

### 10.6 Pre-registered expectations (step 1)

- F3-A1: PASS for every counted task at c = 1 and c = 2; at c = 4, PASS or NOT_RUN (capacity).
- MT-W01 at c = 2 and c = 4: PASS.
- MT-ISO: PASS for each tenant, or NOT_RUN (capacity).
- Timing: recorded with no PASS or FAIL. At c = 1, submit to result near C-70's 19.7 s median, since the tooling path is run 3's (section 13).

## 11. Step 2: two clusters

### 11.1 Cluster B and its own transfer account

B exists (section 3): same project, zone `<zone-b>`, 2 × c3-standard-4, amd64, no autoscaling, the same GKE version as A, Workload Identity on. Substrate v0.6.0 (`d3f2363590a1`) was installed with its own `ate-setup`, from a config derived from A's private install config and the v0.6.0 requirements in L-046: a cluster-wide `--snapshot-location` in B's own bucket, `--ingress-allowed-spiffe-ids` including `apl-ax-6882d106/apl-collector`, `ax-server` as a bootstrap owner, home-built v0.6.0 images (the release images are not public). AX `4b7bf6f` was deployed with `make deploy`, `AX_SNAPSHOTS_BUCKET` pointed at a B-owned prefix (L-031). Images are pulled from the same private repo by digest.

**Owner decision (round 1, Issue 10): B gets its own transfer service account.** This is new IAM, approved by the owner, created when the runs start and deleted with cluster B at teardown. Its grants mirror A's three (RESULTS §3.1) but stay on B: `roles/storage.objectAdmin` and `roles/storage.bucketViewer` on B's snapshot bucket only, and `roles/iam.serviceAccountTokenCreator` on the account for B's `ate-api-server` principal. B's Substrate config is switched to it (`transferGSAName`, redeployed with B's `ate-setup`), and the two bindings for A's account on B's bucket are removed. All of it is recorded in B's infrastructure run dir under `iam`; A's account is never listed there, because `--remove-substrate-iam` deletes every account and binding a run dir lists. Neither transfer account can then write the other cluster's bucket, so MV-PORT cannot succeed through shared snapshot storage by way of the transfer accounts.

One path stays open and is not closed by this decision: GKE gives the same Workload Identity principal to the same namespace and ServiceAccount in every cluster of one project, and the grants name `ns/ate-system/sa/ate-api-server` with no cluster in it. A's account's impersonation grant and the principal's bindings on A's bucket therefore also match B's `ate-api-server`, and the principal's bindings on B's bucket match A's. Section 18 says how this is checked before step 3.

### 11.2 Protocol-skew preflight (L-030)

`profiles/ax/skew.ts <infra-run-dir>` runs inside `multi.ts run-step` before anything is applied on that cluster, and writes `<step-run-dir>/skew.json`. It is a runner preflight only, not a doctor prerequisite. It compares:

1. AX's Substrate client: `ax.client_pins_substrate` and the `ax.ax_server` digest from `versions.json`, and the live `ax-server` Deployment's image digest.
2. The server: `substrate.version` and `substrate.commit` from `versions.json`, and the image tag of every Deployment and DaemonSet in `ate-system` (all must carry the same version tag).
3. The operator's `kubectl-ate`: its reported version and `substrate.kubectl_ate`.
4. A wire probe: the preflight applies a scratch Task and Workspace through AX in a scratch atespace, so AX creates a template and Substrate a golden actor. It then runs `kubectl ate get atespaces -o json` and lists the actors, and requires no `Unimplemented`, no unmarshal error, and every listed actor decoding with a state other than `UNSPECIFIED` (the L-030 symptom). Then it deletes the scratch objects. They are listed in the step run dir before they are applied.

Status: `ok` only if 1, 2 and 3 name the same release and 4 decoded at least one actor with no failure; `mismatch`, with the versions found, otherwise; `unknown` if the probe listed no actor (vacuous). Only `ok` lets the step run on that cluster; `mismatch` and `unknown` leave its rows BLOCKED. Unit test on synthetic inputs: a v0.6.0 client against a `v0.5.0-45` server (the run 1 state), mixed tags, and an `Unimplemented` probe each give `mismatch`; no actors gives `unknown`; matching inputs give `ok`.

The all-clusters view also compares identity across clusters: AX commit, `ax-server` digest, lab image digest, Substrate commit. If they differ, the view says "not comparable" next to the statuses; it does not hide them.

### 11.3 Same case on each cluster (MC-W01)

One tenant per cluster, c = 1, 30 tasks plus a warm-up round, A first, then B, in the same session. Per cluster: 30 F3-A1 reports and one MC-W01 report, with the warm-up listed separately.

### 11.4 Cross-cluster reachability (MC-XREACH)

**Network fact, checked read-only on 2026-10-29** (`gcloud container clusters describe`, `gcloud compute networks describe`, `gcloud compute firewall-rules list`): both clusters are in the same VPC and the same subnet, VPC-native, on Dataplane V2, with public control-plane endpoints. Their pod ranges are distinct and their Service ranges are identical. The VPC firewall admits ingress to each cluster's nodes from that cluster's own pod range and from the VPC's internal range, which holds the node addresses but neither pod range. So:

- Pod-to-pod traffic between the clusters is refused by the VPC firewall before any TLS, as long as it keeps the pod address, which is GKE's default for private destinations (not verified on these clusters).
- Traffic that leaves with a node address (a hostNetwork Pod, or anything translated to the node address) is admitted to the other cluster's nodes on every port. The lab runs no hostNetwork Pod; this is listed under risks (section 18).
- The other cluster's ClusterIPs are not addressable: the same addresses name local Services or nothing. ClusterIPs are therefore not MC-XREACH targets.

MC-XREACH is its own tenant run per cluster, after MC-W01. From that tenant's sandbox, probes go to the other cluster's Emulate and Floci pod IPs, router pod IP, node IPs and Kubernetes API endpoint (taken read-only from the other cluster's kubeconfig by the operator) and are judged from the local gateway log as in MT-ISO. From the collector Pod, the router probe of section 9.3 runs with its stage recorded. Given the network fact, the expected stage is `tcp`: a `false` then shows that the network refuses, not that the other router refuses a foreign certificate, and the report says so. The mTLS boundary between the clusters is not exercised. The same read-only commands run again in step 2's preflight; a different result stops the step (rule 8).

### 11.5 All-clusters view

New `src/reports/aggregate.ts`:

- Input: the set's `plan.json` and the exported `docs/evidence/<run_id>/report.json` of every planned bundle.
- One row per planned bundle (cluster, configuration, tenant run, case, task). A planned row with no report is `NOT_RUN` with reason "planned, no report"; it is never dropped.
- Tenant, configuration, cluster and overall rows use the existing `aggregate()` from `report.ts` (the C5 precedence). Any FAIL anywhere makes the overall status FAIL.
- The overall line always names each cluster, for example for step 2 `all clusters: FAIL (A PASS, 32 reports; B FAIL, 32 reports)`, where 32 is 30 F3-A1 reports plus MC-W01 plus MC-XREACH, warm-up excluded. There is no single green banner: even when everything is PASS the text reads `all clusters: PASS (A PASS, 32 reports; B PASS, 32 reports)`, next to the per-cluster rows.
- It includes the timing summary (section 13).
- Output: `docs/evidence/<set_id>/aggregate.json`, `aggregate.md`, `timing.json`, `checksums.sha256`. Before writing, every output is scanned with `SECRET_RULES` and the private-terms list from `export.ts`; any finding quarantines it, as `exportRun()` does.
- Unit test (`tests/unit/aggregate.test.ts`): one FAIL row among PASS rows gives FAIL; a missing planned row gives NOT_RUN; UNKNOWN outranks BLOCKED; all PASS gives PASS with every cluster named.

### 11.6 Pre-registered expectations (step 2)

- Skew preflight `ok` on both clusters (B's `versions.json` records versions matching A's).
- F3-A1 PASS for every counted task, and MC-W01 PASS, on both clusters.
- MC-XREACH: `cross_cluster_upstream_count` 0 and `allowed_control_reached` true; `cross_cluster_router_accepted` false at stage `tcp`, labelled as refused by the network.

## 12. Step 3: moving work

### 12.1 Suspend on A, resume on B (MV-PORT)

Snapshot portability is UNKNOWN. What the repo shows: AX suspends write snapshot objects under the cluster's snapshot location (RESULTS §3.1); Substrate v0.6.0 needs a cluster-wide snapshot location (L-046); each AX instance knows only its own tasks. With B's own transfer account (11.1), a resume on B cannot borrow A's snapshot objects through the transfer accounts; the Workload Identity principal path is checked first (section 18).

1. Read `pkg/apis/v1alpha1/ax.proto` at `4b7bf6f` and the Substrate Control API protos at `d3f2363` for an operation that creates or resumes a task or actor from an existing snapshot reference, and record what was found (file, message, field) in `RESEARCH.md`.
2. If there is none: MV-PORT is BLOCKED with reason "no documented import path at the pinned SHAs". The lab does not copy snapshot objects between buckets or edit Substrate records; that would test the lab's copy, not the product.
3. If there is one: on A run a `term`-mode task that also writes an agent edit file into the workspace, `ax suspend` it, then resume it on B through that operation. The collector on B reads `/apl/result`, the collector on A the task's own bucket; the operator records A's actor state as `source_actor_running`. A recorded `true` (a second running copy) stops the step, and no MV-PORT ledger row is written (rule 3).

Pre-registered expectation: BLOCKED or UNKNOWN.

### 12.2 S2 on AX, worker Pod evicted mid-run (MV-DRAIN)

Run on B, where every non-system Pod is the lab's, so an eviction cannot hit someone else's workload. This is the public S2 challenge itself, run as an AX task; only the kill differs.

- `case.ts` gains mode `S2`: W01-H with S2's fault. The in-sandbox coordinator starts `startFaultProxy()` (`src/adapters/faults/proxy.ts`) between the worker and Floci with S2's rule, `stall` on `PUT` to `/receipts/`, so the ticket commits and the receipt never lands. When the ticket is committed and the stall is hit, the coordinator exports the ledger with `run_audit` (`apl-evidence/<task>/ledger-killed.json`) to the task's bucket, records the fault, and writes a ready-to-evict marker.
- Injection: when the collector sees the marker, it captures S2's "killed" phase (thread, receipts, the killed export). The operator then runs `kubectl drain <worker-node> --pod-selector=<worker pod labels>`, which cordons the node and evicts only the worker Pod; that eviction is S2's kill. It waits up to 120 s for the actor to run again on its own; if it does not, it runs `ax suspend` and `ax resume` (the C-66 sequence). `restart_path` records which happened. The node is uncordoned afterwards.
- On restart the coordinator starts without the stall rule and does not post the stimulus again: it first looks for its own stimulus in the channel history (the text includes the task name). Otherwise a second request would be counted as a duplicate that the harness, not the system, created. It records each worker start in the bucket and exports the final ledger. The mailbox relay starts from `after=0` on a new process, so the original event is redelivered: that is S2's adversarial variant and part of the test.
- Judged by S2's own facts and expectations, from counts only (tickets with the same action key, completion replies, receipt PUT actions); no timestamp from one machine is compared with one from another. The bundle's `simulated_faults` names the stall and the eviction, so the C5 report lists them as simulated faults.
- Pre-registered expectation: **FAIL is likely.** The worker's idempotency ledger lives in the workspace (`/workspace/.apl/ledger.db` in `case.ts`), and after an eviction AX reverted the workspace to its last snapshot (L-048). The redelivered event would then meet a ledger that has never seen it, while the receipt and the thread live outside the sandbox and are not reverted. `command_exit_code` may be absent, as in C-66; it is recorded, not asserted.

## 13. Timing methodology

Per task, five intervals, each on one clock:

| Key | Clock | From → to |
|---|---|---|
| `submit_to_running_ms` | operator | start of `ax apply` → first `ax get tasks` poll showing `Running` (0.5 s poll, as in run 3) |
| `egress_attach_ms` | operator | start of `ax apply` → egress policy attach returned |
| `resume_to_running_ms` | operator | `ax resume` issued → `Running` seen |
| `server_resume_to_running_ms` | ax-server log | log line `resuming actor on Substrate worker` → log line `task successfully reconciled and running` for the same task (`internal/controller/reconciler.go` at `4b7bf6f`), as L-050 recommends; absent with a reason if either line is missing |
| `submit_to_result_ms` | operator | start of `ax apply` → the collector's `result` exec returns HTTP 200. The exec round trip is measured each round with an empty exec and reported beside it, not subtracted |

The operator path is run 3's: each `kubectl ate` call opens its own port-forward, as when C-70 was measured; there is no shared port-forward. Step-1 c = 1 is therefore measured the same way as C-70, and a comparison says no more than that.

Summary per configuration (cluster, case, c). n counts tasks (n ≥ 30): min, p50 and p90 by nearest rank (n = 30: the 15th and 27th values; n = 32: the 16th and 29th), and max. The 95% interval for the median is taken over rounds, because tasks in one round share a submit instant and workers: each round contributes its median task value, and the distribution-free interval comes from order statistics of those round values. 30 rounds (c = 1): 10th and 21st, coverage 95.7%; 15 rounds (c = 2): 4th and 12th, 96.5%; 8 rounds (c = 4): 1st and 8th, 99.2%, because no narrower pair reaches 95%. No p95 or p99. Per-tenant breakdowns show min, median and max only. Warm-up rounds are listed separately. Raw values, keyed by run ID and round, go to `docs/evidence/<set_id>/timing.json`.

## 14. Stop rules

Each rule stops the current step, keeps the evidence, runs teardown for the affected step run dir, and reports what ran.

1. Skew preflight not `ok` on a cluster (`mismatch` or `unknown`): nothing is applied there; the cluster's rows are BLOCKED.
2. A context mismatch anywhere (runner or `teardown.sh`): stop the set.
3. Any cross-tenant or cross-cluster upstream connection in the gateway log, or a second running copy recorded in MV-PORT: stop the step. The collector-judged case reports FAIL where it applies; no higher concurrency level runs; no MV-PORT ledger row.
4. Warm-up round not fully scheduled, `ResourceExhausted`, a task unscheduled for 120 s, or an actor count other than planned (10.3): stop that level; it and every higher level are reported NOT_RUN with the reason (capacity or actor count); the lower levels stand.
5. `evaluate_ax.py` and `buildReport()` disagree on a bundle: stop; no export, no ledger row. The agreement rule, in `multi.ts` and unit-tested: evaluate PASS agrees only with report PASS; evaluate FAIL whose every reason is `Missing observation: <key>` agrees with report UNKNOWN; evaluate BLOCKED agrees with report NOT_RUN or BLOCKED; any other pair must be the same status. A pair where exactly one side is PASS is always a real disagreement.
6. An export or aggregate finding (secret rule or private term): quarantine; no ledger row from that run.
7. Teardown not `CLEAN` on a run dir: no later step starts until it is.
8. Any action that would touch something not listed in a run dir (A's router allowlist, another pool, IAM beyond the plan, a non-lab Pod during the drain), or a network or IAM fact that differs from the one recorded here: stop and ask the owner.
9. Step order: 1, then 2, then 3. Step 3 starts only if step 2 produced reports on both clusters (PASS or FAIL, not BLOCKED).

## 15. Owner approvals

| Action | Where | Status | Recorded in |
|---|---|---|---|
| Private Artifact Registry repo; push AX `4b7bf6f` images and the lab image | project | done 2026-10-29 | A's infrastructure run dir (`ar`, `images`) |
| Redeploy AX `4b7bf6f` on A; collector namespace on A | A | done 2026-10-29 | A's infrastructure run dir |
| Create cluster B, its snapshot bucket and the bucket bindings | project | done 2026-10-29 | B's infrastructure run dir (`gke_cluster`, `gcs_buckets`, `iam`) |
| Install Substrate v0.6.0 and AX on B | B | done 2026-10-29 | B's infrastructure run dir (`versions.json`) |
| B's own transfer account and its grants; B's Substrate switched to it; A's account's bindings removed from B's bucket | project, B | approved (Issue 10); done when the runs start | B's infrastructure run dir (`iam`) |
| Collector namespace, Pod, NetworkPolicy and pool on B; pool at R = 3 on both clusters | A, B | needed | infrastructure run dirs |
| Per-step tenant namespaces, collector Secrets, AX tasks, the skew preflight's scratch task | A, B | needed | step run dirs |
| Cordon the node and evict the worker Pod on B | B | needed | step 3 record |
| Delete cluster B, its bucket, disks and B's transfer account | project | needed; done by `teardown.sh` (16.3) | B's infrastructure run dir |

## 16. Evidence, ledger and teardown

### 16.1 Evidence per bundle

Per bundle: the collector writes `observations.json` and `evidence/` in the collector Pod; the runner copies them to `artifacts/runs/<run_id>/`, runs `evaluate_ax.py --cases` and `generateReport()` with the table's expectations, the cleanup status from teardown and these extra limitations: one collector identity per cluster (section 6); one operator identity for the AX API; a tenant here is a namespace, an atespace and an Emulate workspace driven by that one identity, not a separately authenticated AX tenant (L-034); gVisor only; two clusters in one project and one VPC; for MC-XREACH, refused by the network before TLS. It then applies the agreement rule, writes checksums and runs `exportRun(run_id, { outRoot: "docs/evidence" })`. Per set: the aggregate files from section 11.5.

`report.ts` chooses four strings without regard to profile, and for profile `ax` each says "local": `MODE_LABEL.scripted` "local integration run (scripted driver)" (used in the green banner and the "Mode:" limitation), the non-green banner "NOT A SUCCESS: local core <status>", the `lanes.local` reason "local core: required assertions only", and the markdown line "- Local core: **<status>**". For profile `ax` only they become "AX task (scripted driver)", "NOT A SUCCESS: AX lane <status>", "AX lane: required assertions only" and "- AX lane: **<status>**". The C5 key `lanes.local` stays, and the local lane's wording does not change; `report-wording.test.ts` checks both.

### 16.2 Ledger

A new evidence set **XM** in `CLAIM_LEDGER.md` ("Evidence sets" table): AX `4b7bf6f`, Substrate v0.6.0 `d3f2363`, lab image digest and commit, `set_id`s, per-bundle exports in `docs/evidence/<run_id>/`, aggregates in `docs/evidence/<set_id>/`. A new section "Optional AX lane, many tenants and two clusters (set XM)". IDs start at C-80 (the ledger currently ends at C-70) and are taken in order as results are recorded; no block is reserved. One row per result, added only when its evidence exists. Planned results, in expected order:

- Step 1 on A at c = 1, 2 and 4, one row per configuration, citing every task and tenant export.
- MT-ISO on A, four tenants.
- Timing on A at c = 1, 2 and 4 (EXECUTED, measured; no PASS or FAIL).
- The skew preflight refuses a mismatched pair (EXECUTED locally, synthetic inputs); then on A and on B (versions recorded).
- MC-W01 on A and on B; MC-XREACH from A and from B (labelled as refused by the network); the all-clusters status for step 2; timing of MC-W01 on A and on B.
- MV-PORT; MV-DRAIN.

A vendor statement, if one is added, takes the next free ID as DOCUMENTED (doc path at a pinned SHA), is never EXECUTED and is never compared with a lab number.

"Claims that must not be made" gains: no percentile except p50 and p90 from an XM configuration with n ≥ 30; not "AX isolates tenants" beyond the probed targets, one sandbox class and one collector identity; not "the clusters cannot reach each other" beyond the probed targets and the recorded network fact; not "work moves between clusters" unless MV-PORT is PASS; no comparison with vendor scale statements.

### 16.3 Teardown

- **End of each step, per cluster:** `teardown.sh <step-run-dir>` in default mode. It deletes the AX tasks and Workspaces per atespace, then the atespaces, then the listed Kubernetes objects by exact name (the `collector-env-<tr8>` Secrets included) and the tenant namespaces, then diffs against the step's `pre-snapshot.json`. Egress policies are listed under `substrate` for the record, but `teardown.sh` does not delete them: they go with their actor when the task is deleted (its step 2). Afterwards, as in run 3, read-only queries independent of the script's own report confirm each listed resource is gone.
- **After the last step, B first:** `teardown.sh <B's infrastructure run dir> --remove-substrate-iam`. This is the first real use of the `gke_cluster` path (until now only `--dry-run`). It removes the recorded bindings on B's bucket and deletes the bucket, notes the disks B's PersistentVolumes provisioned, deletes cluster B (Substrate, AX and the collector namespace on B go with it), deletes those disks, then removes the impersonation binding on B's transfer account and deletes the account. B's `pre-snapshot.json` is the project-level one taken before B existed, so the diff should be empty. `--remove-substrate-iam` is safe here only because B's `iam` lists B's own account and nothing of A's.
- **Then A:** `teardown.sh <A's infrastructure run dir>` in default mode. It deletes what that run dir lists: its AX task and Workspace, the collector namespace with Floci, Emulate, the pool and the collector, `ax-system` with its cluster-scoped objects, the snapshot prefix and the Artifact Registry repo, then diffs against A's `pre-snapshot.json`. It leaves Substrate v0.6.0 and A's transfer account and grants in place, as today.

## 17. Alternatives considered

- **Per-tenant collector identities on B.** B is new, so its allowlist could list one collector SPIFFE ID per tenant, and cross-tenant reads through the router could be tested there. Not chosen: A's allowlist cannot change, so the two clusters would run different collector setups and step 2 would compare unlike things. It remains the obvious follow-up if the owner wants the router boundary tested.
- **Per-tenant WorkerPools.** No isolation gain, since AX sets no `workerSelector` (L-039).
- **Cluster B in another project or VPC.** Stronger separation, but the owner approved the same project, and the recorded network fact already refuses pod-to-pod traffic between the clusters.
- **A shared port-forward to cut tooling noise.** Dropped: it would change the measured path and make c = 1 unlike C-70 (section 13).
- **Summary keys over all tasks** (`w01_tasks_missing`, `w01_tasks_incomplete`). Dropped: they turned an absent fact into FAIL. One F3-A1 bundle per task keeps absent as UNKNOWN.
- **A bespoke drain harness that holds `chat.postMessage`.** Replaced by S2 itself, with its supplied fault and expectations (12.2).
- **Copying snapshot objects between buckets for MV-PORT.** Rejected: it tests the lab's copy, not the product.

## 18. Risks, cost and duration

- **Cost.** Cluster B adds two c3-standard-4 nodes, one GKE cluster fee and one bucket from its creation on 2026-10-29 until its teardown; A's footprint does not grow. This doc quotes no price; the owner checks the current list price.
- **Duration (estimate from C-70, about 20 s per task plus deletion and collection).** Step 1 about 1.5 hours (c = 1 alone is 31 rounds), step 2 about 1 hour, step 3 about 45 minutes, plus teardown. B is billed for the whole span, including any pause between steps.
- **Shared Workload Identity principal.** Grants that name `ns/ate-system/sa/ate-api-server` apply to that ServiceAccount on both clusters (11.1). Before step 3, the runner reads, read-only, the IAM policies of both buckets and both transfer accounts. If any binding on one cluster's bucket or account names a member that the other cluster's `ate-api-server` also holds, MV-PORT does not run and rule 8 applies: the owner decides. As recorded today such bindings exist (A's account's impersonation grant, and the principal's bindings on both buckets), so this decision is expected to be needed.
- **Network.** Traffic with a node address crosses between the clusters on every port, and both control planes are public. The lab runs no hostNetwork Pod and does not probe that path; MC-XREACH's result is limited to what it probed.
- **Capacity.** c = 4 and MT-ISO may end NOT_RUN (10.3).
- **Teardown.** The `gke_cluster` path of `teardown.sh` has only been dry-run; its first real use is B's deletion, followed by the independent read-only check.
- **Drain.** MV-DRAIN cordons a node on B; only lab Pods run there, and the node is uncordoned afterwards.

## 19. Decisions (round 1; formerly open questions)

1. **One collector identity per cluster:** accepted for the MT and MC cases, with the limitation reworded (section 6).
2. **Tenant definition:** a namespace, an atespace and an Emulate workspace driven by one operator identity; every report says so (16.1).
3. **Transfer principal:** owner decision, B's own transfer account (11.1); the shared Workload Identity principal is handled under risks (section 18).
4. **Network between the clusters:** checked read-only and recorded (11.4).
5. **Capacity:** emulator requests live in the new `tenant.yaml`; the single-run `emulators.yaml` is untouched (10.3).
6. **Gateway log attribution:** not relied on; MT-ISO probes one tenant at a time (10.4).
7. **Timing independence:** n counts tasks; the median's interval is over rounds (section 13).
8. **Tooling path:** run 3's path, so no bridge configuration (section 13).
9. **MV-DRAIN:** S2 itself on AX, with the non-reposting coordinator as the harness boundary (12.2).
10. **MV-PORT scope:** BLOCKED if no documented import path exists at the pinned SHAs; no undocumented route.
11. **Report wording:** AX-lane wording by profile in `report.ts`, keeping the `lanes.local` key (16.1).
12. **Zone and IDs:** B's zone stays private as `<zone-b>`; only the C-80 start is fixed, with no reserved block and no vendor block (16.2).

## 20. Review outcome

Round 1 of the EGM review loop: 4 reviewers completed (design critic, implementation readiness, codebase details, zoom-out) and raised 21 issues plus nits; no finding was contested. The owner accepted every PROPOSE FIX, including the nits marked PROPOSE FIX, and this revision applies them. Issue 10 (ESCALATE) was resolved by the owner: cluster B gets its own transfer service account (11.1). Issue 11's network fact was checked read-only and recorded (11.4). Round 2 is pending.
