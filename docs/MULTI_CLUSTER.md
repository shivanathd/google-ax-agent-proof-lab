Status: revised after EGM review round 2; pending round 3.

# Multi-tenant and multi-cluster test design (AX lane)

This is a test design, not a result. Nothing in it has run. It extends the optional AX lane (`profiles/ax/`) with three owner-approved steps and says exactly what would be built, run, recorded and torn down. Every PASS or FAIL it plans comes from an independent collector and the supplied evaluator, never from AX task phase (L-006).

Sources read for this design: [`profiles/ax/README.md`](../profiles/ax/README.md), [`profiles/ax/RESULTS.md`](../profiles/ax/RESULTS.md), `profiles/ax/{allowlist.ts,case.ts,collector.ts,orchestrate.ts,index.ts,run-dir.ts,run-dir.schema.json,teardown.sh,evaluate_ax.py,cases.ax.json,runner/main.go,manifests/k8s/emulators.yaml}`, `src/reports/{report.ts,artifacts.ts,export.ts}`, `src/collector/cases/s2.ts`, `src/ledger/db.ts`, `src/adapters/faults/proxy.ts`, the supplied `evals/evaluate.py` and `evals/cases.json`, [`LEARNINGS.md`](LEARNINGS.md) L-006 to L-012, L-019 and L-030 to L-057, [`CLAIM_LEDGER.md`](CLAIM_LEDGER.md) C-60 to C-70, [`CONTRACTS.md`](spec/active/2026-10-28-agent-proof-lab/contracts/CONTRACTS.md) C4 and C5, the two infrastructure run dirs (section 3) and run 3's private operator script.

## 1. Problem statement

AX run 3 (set X, C-60 to C-70) showed one tenant on one cluster with one worker. It says nothing about tenants that share workers, about the same case judged on two clusters, or about work that moves or is evicted mid-run. The owner approved three steps that answer, with lab evidence only:

1. Do tenants that share one cluster and one worker pool keep their egress and their evidence apart, and how long does a W01-H task take as concurrency grows?
2. Does the same case reach the same verdict on two clusters when each is judged on its own?
3. Can a suspended task resume on the other cluster, and does an eviction mid-run produce a duplicate business effect?

Until these run, every AX claim stays at one tenant on one cluster.

## 2. Scope

| Step | What | Cluster(s) |
|---|---|---|
| 1 | Many tenants: up to 4 concurrent tenants, each with its own atespace, namespace and Emulate workspace; isolation; timing with n ≥ 30 tasks per configuration | A |
| 2 | Two clusters: the same case on each; C5 reports per cluster; an all-clusters view that never blends into one green; the warm-up preflight; the network between them recorded as a configuration fact | A and B |
| 3 | Moving work: suspend on A and resume on B (BLOCKED unless the pinned protos document an import path); S2 on AX with AX-adapted definitions, one worker Pod evicted mid-run | A and B |

Not in scope: microVM sandboxes, the default AX runner, a live model, any change to Substrate on A (router allowlist included), any scale claim. Vendor scale statements from Google AX or Agent Substrate docs may enter the ledger only as DOCUMENTED, with the doc path at a pinned SHA, and are never compared with a lab measurement.

## 3. Starting point

- Cluster A ran AX run 3: AX `4b7bf6f` on Substrate v0.6.0 (`d3f2363590a1`), 2 × c3-standard-4, amd64, GKE 1.36.4, gVisor, one worker. Run 3 was torn down on 2026-10-29 (`RESULTS.md`, "Teardown"); its run dir's manifest is retired.
- The same day the owner approved restoring the lane on A and creating cluster B. Two infrastructure run dirs now own what exists (section 8):
  - **A, run dir `41dc91c3`.** Not owned (pre-existing): Substrate v0.6.0 and A's snapshot transfer service account with its three grants. Owned: AX `4b7bf6f` in `ax-system` with its cluster-scoped objects, the private Artifact Registry repo with the AX and lab images, one snapshot prefix, and the collector namespace `apl-ax-6882d106` (ServiceAccount and Pod `apl-collector`, Floci, Emulate, WorkerPool `apl-ax-pool`). The namespace keeps run 3's name so the SPIFFE ID already in A's router allowlist still applies.
  - **B, run dir `34c8957e`.** Owned: cluster B (`gke_cluster`, with a project-level `pre-snapshot.json` taken before B existed), its snapshot bucket with four bindings (two for the `ns/ate-system/sa/ate-api-server` Workload Identity principal, two for A's transfer account), Substrate v0.6.0 (router allowlist already lists `apl-ax-6882d106/apl-collector`; its transfer account is still A's) and AX `4b7bf6f`. `versions.json` records the versions and that they match A's.
- Known AX behaviour this design plans around: tasks are created suspended and need `ax resume` (L-047); a new template gets a golden actor that takes worker capacity (L-047); AX templates set no `workerSelector`, so tasks land on any pool (L-039); `ax suspend` and `ax delete task` send no SIGTERM, and after an eviction the actor counts as crashed and is reverted, losing `result.json` (L-048, C-62, C-63, C-66); `ax get task` returns `spec.env` in clear to any AX API caller (L-034, C-69); the v0.6.0 router serves actors only over mTLS to allowlisted SPIFFE IDs (L-045); egress refusals are judged from the egress gateway's log, not from probe byte counts (L-049); run 3 timing measured operator tooling more than AX (L-050); `/apl/result` serves only the runner's `result.json` (exit code, start and end times, command hash; `runner/main.go`), and only after the command exits.

## 4. Design rules

1. **Evidence exactly as before.** Every result is an independent-collector C4 bundle, judged by `evaluate_ax.py` and by `buildReport()` (`src/reports/report.ts`), with one C5 report per tenant and per cluster, exported with `exportRun()` (`src/reports/export.ts`) to `docs/evidence/<run_id>/`. No report covers two tenants or two clusters. For W01 work a tenant's C5 evidence is one report per task (F3-A1) plus its MT-W01 or MC-W01 report, rolled up into the tenant row with the C5 precedence (section 9.1). Each result gets a claim ID starting at C-80 (section 16.2); vendor claims are DOCUMENTED only. If `evaluate_ax.py` and `buildReport()` disagree on a status under the agreement rule (stop rule 5), the run stops.
2. **Phase is not outcome.** `ax_task_phase` stays under `recorded_not_asserted` in every case (L-006).
3. **Absent is not zero.** An observation the collector could not make is absent with a reason (C4), which makes its assertion UNKNOWN. A lost `result.json` after eviction makes `command_exit_code` absent, as C-66 requires.
4. **One clock per interval.** Every timing interval is measured on one named clock. No interval subtracts a timestamp taken on one machine from one taken on another (L-050).
5. **Pre-registration.** Before each step runs, its expectations (sections 10.6, 11.6, 12) are committed to the second table of `LEARNINGS.md` ("Expected before running"), as was done for the W5 runs.
6. **Identifiers stay private.** Project, cluster names, zones, contexts, registry, buckets, accounts and IPs live only in gitignored `private-runs/ax/`. Public files use placeholders (`<project>`, `<cluster-a>`, `<cluster-b>`, `<zone-b>`, `<registry>`, `<snapshot-bucket>`, `<transfer-sa>`), as `RESULTS.md` does.
7. **Collector values, not operator values.** An assertion uses only what the collector computes from system records: Emulate, Floci, the router, and files of system-written records that the operator copies verbatim (the egress gateway's access log, as for C-67). A value the operator computes or reads from a CLI (a string-search count, `kubectl ate get actors`) is recorded, not asserted, as C-69 was. Records written by the in-sandbox coordinator (ledger exports, worker-start records) are subject-side: the collector reads them with its own credentials, and every report that uses one says so.

## 5. Components, files and build order

### 5.1 The runner

`profiles/ax/multi.ts` makes every cluster call in this design.

| Subcommand | Input | Output | Calls |
|---|---|---|---|
| `plan --step N` | set ID, the two infrastructure run dirs, the tenant-run registry | `private-runs/ax/sets/<set_id>/plan.json` (Appendix A): clusters, configurations, tenant runs, evidence run IDs, tasks per round, targets by role | none |
| `infra <cluster>` | that cluster's infrastructure run dir | A: `versions.json` (read-only queries), pool at R = 3, collector NetworkPolicy. B: `collector.yaml` applied, node pool resized (18). B's own transfer account only under 12.1 | `kubectl apply` and `patch`, `gcloud container clusters resize`; under 12.1 only, `gcloud iam`, bucket IAM bindings, B's `ate-setup` |
| `run-step --plan P` | `plan.json`; per cluster its infrastructure run dir (`kubeconfig`, `versions.json`, `local.bin`) | one step run dir per cluster, tenant run dirs, rendered manifests, per bundle `artifacts/runs/<run_id>/observations.json` and `evidence/`, `timing-raw.json` | per cluster: `doctor()`, `orchestrate.ts init` and `manifests`, `teardown.sh --snapshot`, `kubectl apply`, `ax --server … apply`, `egress.ts` attach, `ax resume`, per task `collector.ts result` then `observe` (copied out with `kubectl cp`) then `ax delete`, `kubectl scale` of finished emulators |
| `report --plan P` | the bundles | via `aggregate.ts`: per bundle `report.json` and `report.md`, exports under `docs/evidence/<run_id>/`, then the set's aggregate | `evaluate_ax.py --cases`, `buildReport()`, the agreement rule, `exportRun()` |

Before any call to a cluster, `run-step` runs `doctor()` (`profiles/ax/index.ts`) with that cluster's environment from its infrastructure run dir (`APL_AX_KUBECTL`, `APL_AX_CONTEXT`, `APL_AX_IMAGE`, `APL_AX_CLI`, `APL_AX_SUBSTRATE_API`) and requires `APL_AX_AUTHORIZED=1`. A BLOCKED doctor or a missing opt-in leaves that cluster's rows BLOCKED and makes no call there. `multi.ts` holds one port-forward per cluster to `ax-server`, opened with that cluster's kubeconfig, and calls `ax --server http://127.0.0.1:<port>` (L-033); `kubectl ate` is the plugin build in the infrastructure run dir's `local.bin`, first on `PATH`, and opens its own port-forward per call, as in run 3.

Per task the order is fixed: apply, attach the egress policy, resume, wait for the result (`collector.ts result --wait-ms 120000`), observe the task's bundle while its actor still serves `/apl/result`, then delete. A run-level bundle (MT-W01, MT-ISO, MC-W01) is observed with `collector.ts observe --run` after the tenant run's last round, before its emulators are scaled to 0.

### 5.2 Files

| Action | File | Change |
|---|---|---|
| Create | `profiles/ax/multi.ts` | the runner (5.1), per-call context guard |
| Create | `profiles/ax/multi-facts.ts` | pure functions: foreign-marker count, gateway-log parsing and upstream counts, IP-to-role redaction, MV-DRAIN facts (12.2), agreement rule, nearest-rank p50 |
| Create | `profiles/ax/egress.ts` | egress policy template, attach, gateway log extract (5.4) |
| Create | `profiles/ax/cases.multi.json` | expectations (9.2) |
| Create | `profiles/ax/manifests/k8s/tenant.yaml` | per tenant: Namespace, Floci and Emulate with requests of 100m CPU and 256Mi per container (limits kept), their Services, Secret `emulate-seed`, NetworkPolicy admitting `atenet-egress` from `ate-system` (as `emulators.yaml`) and the collector by namespace and label |
| Create | `profiles/ax/manifests/k8s/collector.yaml` | rendered from `emulators.yaml`'s collector half: Namespace, ServiceAccount and Pod `apl-collector`, a NetworkPolicy admitting no ingress to it, WorkerPool `apl-ax-pool` (section 6) |
| Create | `src/reports/aggregate.ts` | per-bundle C5 reports and the all-clusters view (11.5) |
| Create | `tests/unit/{ax-multi,multi-facts,aggregate,report-wording}.test.ts` | plan, per-call context guard and dry run; every `multi-facts.ts` function on synthetic inputs; the all-clusters view; AX wording and limitation by profile with local wording unchanged |
| Modify | `profiles/ax/case.ts` | `APL_AX_PROBE_URLS`, router-path and worker-local probes, probe self-report into its own bucket; modes `S2` (12.2) and `mvport` (12.1, only if an import path exists) |
| Modify | `profiles/ax/orchestrate.ts` | modes `S2` and `mvport`, `--probe-urls`, `manifests --tenant` (renders `tenant.yaml`, no ClusterIPs needed), `spec.config` keys `apl-set`, `apl-cluster`, `apl-tenant` |
| Modify | `profiles/ax/collector.ts` | `--run-id`, `--env-file`, `observe --run` (no task, no `/apl/result` capture); cases MT-W01, MT-ISO, MC-W01, MV-PORT, MV-DRAIN; inputs `--foreign-markers-file`, `--targets-file`, `--egress-log-file`, `--disclosure-file`; redaction before any write; `simulated_faults` in the bundle |
| Modify | `profiles/ax/evaluate_ax.py` | optional `--cases FILE`, default `cases.ax.json` |
| Modify | `src/reports/report.ts` | AX wording and one limitation by profile (16.1) |
| Modify | `docs/LEARNINGS.md` | pre-registered expectations, committed before each step |
| Modify | `docs/CLAIM_LEDGER.md` | set XM and one row per result, only when its evidence exists |
| Delete | none | |

Unchanged: `profiles/ax/index.ts`, `allowlist.ts` (tenant namespaces keep its `apl-ax-<8 hex>` form), `run-dir.ts`, `run-dir.schema.json`, `teardown.sh`, `runner/main.go`, `manifests/k8s/emulators.yaml` (the single-run template), `cases.ax.json`, `src/reports/artifacts.ts`, the supplied `evaluate.py` and `cases.json`.

### 5.3 Build order

First, before any code: the proto read of 12.1 (read-only, in the pinned checkouts), recorded in `RESEARCH.md`. It decides whether `mvport`, MV-PORT and B's transfer account are built at all. Then each phase ends when its test gate and the existing `npm test` pass. No cluster call happens before phase 5's gate and the owner's go-ahead, except resizing B's node pool to 0 (section 18).

1. Report wording and limitation, `evaluate_ax.py --cases`. Gate: `report-wording.test.ts`; `evaluate_ax.py` still refuses a table that asserts a recorded-only key.
2. `cases.multi.json`, `multi-facts.ts`, `aggregate.ts`. Gate: `multi-facts.test.ts` (a foreign marker found and not found; the key absent with no foreign tenant run; every IP replaced before a write; router and worker targets counted as cross-tenant upstreams; an MV-DRAIN duplicate found across the two exports; the agreement cases) and `aggregate.test.ts`.
3. `tenant.yaml`, `collector.yaml`, `orchestrate.ts`, `case.ts`, `egress.ts`. Gate: a rendering test (requests present, every placeholder filled, the `atenet-egress` rule and `emulate-seed` present, the namespace matching `allowlist.ts`, `emulators.yaml` byte-identical) and the existing `tests/integration/ax-profile.test.ts`.
4. `collector.ts`. Gate: `observe --task` and `observe --run` on synthetic captures write bundles that pass C4 validation.
5. `multi.ts`. Gate: the plan test, the per-call context guard test, a dry run that prints every planned call and makes none, `npm run validate:package`.

### 5.4 Egress policies and the gateway log (`egress.ts`)

This moves run 3's private operator script's logic into the repo, with no private value in it.

- **Template.** One `http` rule per host: `emulate.<ns>.svc.cluster.local` on ports 8080 and 8081, `floci.<ns>.svc.cluster.local` on 4566, where `<ns>` is the tenant's namespace.
- **Attach.** After `ax apply`, poll every 0.5 s, up to 120 s, until `kubectl ate get actor <task> -a <atespace>` finds the actor; then `kubectl ate create egress-policy <task> -a <atespace> -f <policy>`, record the policy under `substrate` in the step run dir, then `ax resume task`. Within a round the c tasks are handled one after another in tenant order, so their starts are up to c − 1 attach times apart; `egress_attach_ms` records it.
- **Log extract.** For each probe window, `kubectl logs` of the `atenet-egress` Pods in `ate-system` with `--since-time` at the window start, copied verbatim with the window bounds to the file passed as `--egress-log-file`. `multi-facts.ts` parses each access-log line into time, requested authority, upstream host and response code and drops lines outside the window. Only `upstream` (null when the gateway answered itself, L-049) is known from run 3; the other field names are read from the gateway's access-log format in `ate-system` before step 1 and pinned in the parser and its test.

## 6. Collector identity: one per cluster

On Substrate v0.6.0 the collector reads a task's `/apl/result` only through the router, over mTLS, with a SPIFFE ID listed in `--ingress-allowed-spiffe-ids` (L-045). A's allowlist has exactly one lab ID, `apl-ax-6882d106/apl-collector`, and changing it is not approved. B's install lists the same ID, so both clusters are configured the same way.

- Namespace `apl-ax-6882d106`, ServiceAccount `apl-collector`, Pod `apl-collector` on both clusters, owned by that cluster's infrastructure run dir. On B, `multi.ts infra b` applies `collector.yaml`; on A the namespace exists and gains the NetworkPolicy and the new Pod spec.
- Each tenant run's collector environment (`collector-env.json` from `orchestrate.ts manifests`) becomes a Secret `collector-env-<tr8>` in the collector's namespace, owned by the step run dir. The Pod mounts those Secrets through one projected volume, each source `optional: true`, so the Pod starts even before a Secret exists. `run-step` recreates the Pod (same name, same owner) once per configuration, after that configuration's tenants and Secrets are applied, with their names in the volume. It keeps `automountServiceAccountToken: false`. There is no cross-namespace RBAC and no API token: the collector never calls the Kubernetes API.
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
| Tenant-run registry | `private-runs/ax/tenant-runs.json` | experiment-wide; an entry is appended when a tenant run is created (Appendix A) |
| Evidence run | `run_id` (UUID) | one per C4 bundle: one per task (F3-A1, MV-PORT, MV-DRAIN), one per tenant run and case otherwise; keys the bundle, its C5 report and `docs/evidence/<run_id>/` |
| Tenant namespace and atespace | `apl-ax-<tr8>` | the form `allowlist.ts` requires (`apl-ax-[a-f0-9]{8}`); `orchestrate.ts init` derives it from the tenant run ID and uses it as the atespace; the plan refuses a `<tr8>` equal to the collector's `6882d106` or to any registered tenant run's |
| Tenant tasks | W01 `apl-<tr8>-<nn>` (`00` the warm-up); MT-ISO `apl-<tr8>-iso` and target `apl-<tr8>-tgt`; step 3 `apl-<tr8>-mv`, `apl-<tr8>-s2`; Workspace `ws-<task>` | unique across the experiment, so a task name is a usable foreign marker |
| Pool | `apl-ax-6882d106/apl-ax-pool` | owned by the infrastructure run dir; shared by all tenants on the cluster (10.2) |
| Collector | `apl-ax-6882d106/apl-collector` | fixed by the router allowlist (section 6) |
| Collector env | `apl-ax-6882d106/collector-env-<tr8>` | Secret, owned by the step run dir |
| Tenant labels | `apl-run=<tenant_run_id>`, `apl-set=<set_id>`, `apl-cluster=a\|b`, `apl-tenant=t1..t4`, `apl-role=tenant` | on every Kubernetes object in the tenant namespace |
| AX objects | no labels exist (L-008) | `spec.config` keys `apl-run`, `apl-set`, `apl-cluster`, `apl-tenant`; the same in the Workspace's `.apl/run.json` |

Tenants t1 to t4 are roles. Each configuration gets fresh tenant runs (new UUIDs, new namespaces). Earlier tenant runs of the step stay, with their emulators scaled to 0 after collection, until the step's teardown. Every tenant run of the experiment feeds the foreign-marker check through the registry.

## 8. Run dirs, ownership and the context guard

- **Infrastructure run dirs, long-lived.** `41dc91c3` (A) and `34c8957e` (B), as listed in section 3. Before step 1, `multi.ts infra a` writes A's `versions.json` the same way as B's, from read-only queries. Before step 2, `multi.ts infra b` adds the collector namespace, ServiceAccount, Pod, NetworkPolicy and WorkerPool `apl-ax-pool` to B's. B's own transfer account is added only under 12.1. Both are torn down once, after the last step, B first (16.3).
- **Step run dirs, one per step and cluster.** `private-runs/ax/<step_run_id>/` owns every tenant namespace with its objects, atespace, egress policy (listed for the record), AX Task and Workspace, and every `collector-env-<tr8>` Secret of that step on that cluster. It is one per step, not per tenant, because `teardown.sh` diffs each run dir against its own `pre-snapshot.json`, and concurrent tenant run dirs would each see the others' namespaces as unexpected changes. `pre-snapshot.json` is taken with `teardown.sh --snapshot` before the step's first apply. Teardown runs at the end of the step.
- **Set dir.** `private-runs/ax/sets/<set_id>/plan.json` is written before any call. Tenant run dirs (`secrets.json`, `emulate-seed.json`, rendered manifests, as `orchestrate.ts init` and `manifests` write them) sit under it, one per tenant run; they own nothing.
- **Schema unchanged, and only fields it has.** Every `owned-resources.json` validates against `run-dir.schema.json` as it stands: `run_id` is the run dir's own ID, `kube_context` its cluster's context, tenant objects go in `kubernetes`, `ax` and `substrate`. Versions come from `versions.json`, not from the schema. New run dirs leave `substrate_install` absent: the schema requires it to carry a `previous` install, and made-up values there would arm `--restore-substrate-v05`.
- **Context guard, on every call.** Every `kubectl` and `kubectl ate` call passes `--kubeconfig <run-dir>/kubeconfig` (single context, mode 0600, as `index.ts run()` writes it), and before each call the runner checks that this file's context is the plan's context for that step and cluster. Every `ax` call goes to the port-forward the runner opened with that kubeconfig, and the runner refuses an `ax` call whose port belongs to another cluster. The ambient context is never read. A mismatch is a programming error and stops the set. `teardown.sh` is called with `KUBECONFIG` set to the run dir's kubeconfig, as `index.ts` does for `--snapshot`, and keeps its own guard (schema valid and current context equals `kube_context`).

## 9. Cases

### 9.1 Per task: F3-A1, unchanged

Each W01-H task in steps 1 and 2 is one C4 bundle written by `collector.ts observe --case F3-A1 --task <task>` before the task is deleted, and judged by F3-A1 in `cases.ax.json` as it is (`ticket_count` 1, `receipt_count` 1, `receipt_matches_request` true, `completion_reply_count` 1, `command_exit_code` 0). A task with an absent fact is UNKNOWN, never FAIL (design rule 3).

Roll-up uses `aggregate()` from `report.ts` (FAIL > UNKNOWN > BLOCKED > NOT_RUN > PASS): the tenant row over that tenant run's task reports and its MT-W01 or MC-W01 report; the configuration row over its tenant rows; the cluster row over its configurations and its other cases. One absent fact therefore makes that task and its tenant row UNKNOWN. A planned bundle with no report is NOT_RUN.

### 9.2 `profiles/ax/cases.multi.json`

Same rules as `cases.ax.json`: profile `ax`, typed equality only (the supplied `inspect_bundle()`), and no expectation may name a recorded-only key. F3-A1 bundles are judged with `cases.ax.json`, every other case with this table (11.5).

```json
{
  "note": "Multi-tenant and multi-cluster AX expectations (docs/MULTI_CLUSTER.md). Equality only. Recorded keys are never asserted (L-006). W01 tasks are judged one bundle each by F3-A1 in cases.ax.json.",
  "recorded_not_asserted": ["ax_task_phase", "concurrency", "tasks_planned", "tasks_timed", "probe_self_report_reached_count",
    "foreign_secret_in_task_count", "source_actor_running", "restart_path", "worker_start_count", "command_exit_code"],
  "MT-W01": {"profile": "ax", "note": "step 1, c = 2 and 4: one per tenant run after its last round", "expected": {"foreign_marker_count": 0}},
  "MT-ISO": {"profile": "ax", "note": "step 1, own tenant runs after c = 4: cross-tenant reach and shared evidence", "expected": {"cross_tenant_upstream_count": 0, "allowed_control_reached": true, "foreign_marker_count": 0}},
  "MC-W01": {"profile": "ax", "note": "step 2: per cluster, one per tenant run after its last round", "expected": {"foreign_marker_count": 0}},
  "MV-PORT": {"profile": "ax", "note": "step 3, only if an import path exists: suspend on A, resume on B", "expected": {"prepared_marker_same": true, "agent_edit_present": true}},
  "MV-DRAIN": {"profile": "ax", "source_case": "S2", "note": "step 3 on B: S2 expectations, AX-adapted definitions; one worker Pod evicted while the receipt PUT is stalled", "expected": {"ticket_count": 1, "completion_reply_count": 1, "false_success_count": 0, "recovery_evidence_present": true, "duplicate_after_restart_count": 0}}
}
```

MT-W01 is not planned at c = 1: that is the experiment's first tenant run, so the key would be absent and the bundle could only be UNKNOWN.

### 9.3 Observation keys

Asserted keys, each computed by the collector (`multi-facts.ts`) with direct evidence:

| Key | Type | Collected from | Meaning |
|---|---|---|---|
| `foreign_marker_count` | number | every evidence file of this tenant run's bundles, its Floci bucket and its Slack channel | items with a foreign marker: the `run_id` or a task name of any other tenant run in the registry (every step and set so far), or a token found with `SECRET_RULES` (`export.ts`) whose SHA-256 is in another tenant run's token-hash list. The collector gets those IDs, names and hashes (`--foreign-markers-file`), never other tenants' tokens, and no other tenant's Pods need to run. With no other registered tenant run the key is absent with reason "no foreign tenants", never 0 |
| `cross_tenant_upstream_count` | number | egress gateway access log for the probe window, copied verbatim (`--egress-log-file`, 5.4) | entries with a non-null upstream (L-049) that matches, by Service name or address, any target in the targets file other than this tenant's own Emulate and Floci: other tenants' Emulate and Floci, the router path and the worker-local targets |
| `allowed_control_reached` | boolean | same log | the tenant's own Emulate was reached through the gateway in the same window, so the probe ran under a working policy |
| `prepared_marker_same`, `agent_edit_present` | boolean | `mvport.json` in the MV-PORT tenant's bucket on A and on B, each read by its cluster's collector | section 12.1 |
| S2's five keys | as S2 | AX-adapted definitions over `ledger-killed.json`, `ledger-final.json`, the worker-start records, the S3 receipts and the request's thread | section 12.2 |

Recorded, not asserted:

| Key | Collected from | Why not asserted |
|---|---|---|
| `probe_self_report_reached_count` | the probe's own JSON lines in its bucket | the subject's self-report |
| `foreign_secret_in_task_count` | operator string search of `ax get task` for this tenant's tasks against other tenants' secrets; only the count is kept (`--disclosure-file`), the output is not stored, as in run 3 | operator value (design rule 7), as C-69 |
| `source_actor_running` | operator `kubectl ate get actors` on A | operator value (design rule 7); a `true` stops step 3 (stop rule 3) |
| `worker_start_count` | worker-start records in the MV-DRAIN task's bucket | subject-side (design rule 7) |
| `restart_path`, `command_exit_code`, `concurrency`, `tasks_planned`, `tasks_timed`, `ax_task_phase` | runner, `result.json`, plan | context only |

**Addresses.** The collector redacts: before it writes any evidence file, `redactAddresses()` (`multi-facts.ts`) replaces every IP address in a log extract, target list or probe output with a placeholder naming its role from the targets file (for example `<t2-emulate-clusterip>`, `<worker-pod-1>`). `multi.ts` only writes the targets file; the role-to-address mapping stays in the set dir. An address with no role becomes `<unlisted-address>`, and its presence is recorded.

## 10. Step 1: many tenants on cluster A

### 10.1 Layout per tenant

Each tenant run gets: atespace and namespace `apl-ax-<tr8>`; its own Floci and Emulate from `tenant.yaml` (one Emulate workspace, its own per-run fake secrets from `orchestrate.ts init`, rendered by `orchestrate.ts manifests --tenant`); its own egress policy from `egress.ts`, listing only its own Emulate (8080, 8081) and Floci (4566) hosts, attached right after the actor exists and before `ax resume` (L-047, 5.4); and its collector Secret in the collector namespace. No collector and no WorkerPool in the tenant namespace. After its last bundle is observed, its Floci and Emulate are scaled to 0; its objects stay until teardown.

### 10.2 One shared pool, and why

AX templates set no `workerSelector`, so a task can land on any pool (L-039). Per-tenant pools would not pin tenants to their pool, so they would not add isolation. One pool per cluster, the infrastructure-owned `apl-ax-6882d106/apl-ax-pool` (gVisor), set to R = 3 workers by `multi.ts infra` before step 1, makes tenants share workers, which is the setting where cross-tenant isolation matters. Other pools on A were deleted by the run 3 reinstall (RESULTS §3.2); the preflight confirms that no other WorkerPool exists.

### 10.3 Concurrency, actors and capacity

Configurations: c ∈ {1, 2, 4} concurrent tenants on A, each tenant running one W01-H task per round. A round applies all c tasks, attaches and resumes them one after another (5.4), waits for every result or a 120 s timeout, observes each task's bundle, deletes the tasks, then starts the next round (run 3 deleted each task before the next, L-047). Every round the runner lists actors per atespace (`kubectl ate get actors`, recorded): before submit no task actor of the previous round may remain, and after submit there must be c task actors plus the golden actors expected for new templates. Any other count stops that level (stop rule 4). What counts as a new template, and whether golden actors go away when their tasks are deleted, is not known: at the start of step 1 the runner applies two tasks with the same image and command in one tenant, lists actors after each apply and after deleting both, and the actor-count rule uses what it found.

| c | Tenants | Rounds | Tasks (n) | Tasks per tenant run |
|---|---|---|---|---|
| 1 | t1 | 30 | 30 | 30 |
| 2 | t1, t2 | 15 | 30 | 15 |
| 4 | t1 to t4 | 8 | 32 | 8 |

Each configuration starts with one warm-up round (`00`), reported separately and not counted.

Capacity estimate (to be checked, not assumed): 2 × c3-standard-4 is 8 vCPU and 32 GiB before system reservations; Substrate (11 pods) and AX also run there, and their requests are not recorded in the repo. In `emulators.yaml` Floci and Emulate set limits only (500m/768Mi and 500m/512Mi), so their requests equal their limits. `tenant.yaml` adds requests of 100m CPU and 256Mi per container and keeps the limits; `emulators.yaml` stays as it is. Finished tenant runs' emulators are scaled to 0, so at most 4 tenants hold requests at a time. During MT-ISO, with R = 3 workers (run 3's worker template: request 1 CPU and 4Gi, limit 3 CPU), requests total about 0.8 (4 tenants) + 1 (the infrastructure run's own Floci and Emulate in the collector namespace) + 0.5 (collector) + 3 = 5.3 vCPU and 2 + 1.25 + 0.5 + 12 = 15.75 GiB. c = 4 and MT-ISO may still end NOT_RUN (capacity). Actor slots: with 1-CPU tasks a 3-CPU worker refused a fourth actor (L-047), so R = 3 gives about 9 slots for at most 4 task actors plus golden actors.

Preflight before each configuration (read-only): node allocatable minus requested CPU and memory must cover the configuration's requests, and the warm-up round must schedule all c tasks and pass 11.2. Otherwise stop rule 1 or 4 applies.

### 10.4 Isolation (MT-ISO)

After c = 4, four fresh MT-ISO tenant runs (t1 to t4), each with its own evidence run ID. While all four namespaces exist, each tenant in turn runs one `isolation` task (`apl-<tr8>-iso`), and the next tenant runs one `term`-mode task (`apl-<tr8>-tgt`, it makes no egress) as the router-path and worker-local target. No other task runs, so every gateway log entry in the window comes from the probing tenant; the design does not depend on whether the log names the source actor. Each MT-ISO bundle is observed with `observe --run` after its tenant's probe.

- `case.ts isolation` gains `APL_AX_PROBE_URLS` (comma-separated URLs) next to `APL_AX_PROBE_IPS`. Targets: every other MT-ISO tenant's Emulate (8080, 8081) and Floci (4566) by Service name and by ClusterIP; the router path, `atenet-router.ate-system.svc` on 443 with `ate-target-actor` naming the target tenant's running task; the worker-local path, the worker Pods' IPs on the ports their actors listen on (read from the worker Pod spec by the operator); and the run 3 targets. All of them are in the targets file. The probe writes its JSON lines to its own bucket (`apl-evidence/<task>/isolation.json`), kept as `probe_self_report_reached_count`; the verdict comes from the gateway log.
- Disclosure: `foreign_secret_in_task_count` is recorded, not asserted (design rule 7). Cross-tenant disclosure through the AX API itself is not testable here: there is one operator identity, and `ax get task` returns `spec.env` to any caller (L-034). That stays a disclosed limitation (C-69), not a claim.
- Shared evidence: `foreign_marker_count` in every MT-ISO bundle.

### 10.5 Timing

Section 13. Timing is recorded, never asserted. Each bundle records `concurrency`, `tasks_planned` and `tasks_timed`; raw per-task intervals go to the set's timing file.

### 10.6 Pre-registered expectations (step 1)

- F3-A1: PASS for every counted task at c = 1 and c = 2; at c = 4, PASS or NOT_RUN (capacity).
- MT-W01 at c = 2 and c = 4: PASS.
- MT-ISO: PASS for each tenant, or NOT_RUN (capacity).
- Timing: recorded with no PASS or FAIL; no comparison with C-70.

## 11. Step 2: two clusters

### 11.1 Cluster B and its transfer account

B exists (section 3): same project, zone `<zone-b>`, 2 × c3-standard-4, amd64, no autoscaling, the same GKE version as A, Workload Identity on. Substrate v0.6.0 (`d3f2363590a1`) was installed with its own `ate-setup`, from a config derived from A's private install config and the v0.6.0 requirements in L-046: a cluster-wide `--snapshot-location` in B's own bucket, `--ingress-allowed-spiffe-ids` including `apl-ax-6882d106/apl-collector`, `ax-server` as a bootstrap owner, home-built v0.6.0 images (the release images are not public). AX `4b7bf6f` was deployed with `make deploy`, `AX_SNAPSHOTS_BUCKET` pointed at a B-owned prefix (L-031). Images are pulled from the same private repo by digest.

**B's own transfer account (owner decision, round 1, Issue 10), only if 12.1's proto read finds an import path.** It exists only to keep MV-PORT from succeeding through shared snapshot storage, so without an import path it is not created and B keeps using A's account, as today. If it is created (`multi.ts infra b`, before step 3): its grants mirror A's three (RESULTS §3.1) but stay on B: `roles/storage.objectAdmin` and `roles/storage.bucketViewer` on B's snapshot bucket only, and `roles/iam.serviceAccountTokenCreator` on the account for B's `ate-api-server` principal; B's Substrate config is switched to it (`transferGSAName`, redeployed with B's `ate-setup`); and the two bindings for A's account on B's bucket are removed. Every IAM change edits `iam` in B's infrastructure run dir in the same change: a removed binding leaves the list when it leaves the bucket, because `teardown.sh` stops on a listed binding that no longer exists, before it reaches the cluster delete. A's account is never listed there, because `--remove-substrate-iam` deletes every account and binding a run dir lists.

One path stays open even then: GKE gives the same Workload Identity principal to the same namespace and ServiceAccount in every cluster of one project, and the grants name `ns/ate-system/sa/ate-api-server` with no cluster in it. A's account's impersonation grant and the principal's bindings on A's bucket therefore also match B's `ate-api-server`, and the principal's bindings on B's bucket match A's. A separate transfer account does not separate the clusters; 12.1 stops for the owner on this before MV-PORT runs.

### 11.2 Warm-up preflight (L-030)

The warm-up round of each configuration on each cluster is the protocol preflight; there is no separate tool. Its actor listings (`kubectl ate get actors`, 10.3) must decode every actor with a state other than `UNSPECIFIED` (the L-030 symptom), and no `ax` or `kubectl ate` call in it may return `Unimplemented` or an unmarshal error. A failure, or a vacuous warm-up (no task ran or no actor was listed), leaves that cluster's rows BLOCKED (stop rule 1). A warm-up that could not schedule its tasks is capacity, not protocol (stop rule 4).

The all-clusters view also compares identity across clusters from each `versions.json`: AX commit, `ax-server` digest, lab image digest, Substrate commit. If they differ, the view says "not comparable" next to the statuses; it does not hide them.

### 11.3 Same case on each cluster (MC-W01)

One tenant per cluster, c = 1, 30 tasks plus a warm-up round, A first, then B, in the same session. Per cluster: 30 F3-A1 reports and one MC-W01 report, with the warm-up listed separately. MC-W01's foreign markers are every earlier registered tenant run: step 1's on A, and on B also A's MC-W01 run.

### 11.4 The network between the clusters (configuration fact, not a test)

Checked read-only on 2026-10-29 (`gcloud container clusters describe`, `gcloud compute networks describe`, `gcloud compute firewall-rules list`): both clusters are in the same VPC and subnet, VPC-native, on Dataplane V2, with public control-plane endpoints. Their pod ranges are distinct and their Service ranges are identical, so the other cluster's ClusterIPs name local Services or nothing. The VPC firewall admits ingress to each cluster's nodes from that cluster's own pod range and from the VPC's internal range, which holds the node addresses but neither pod range: pod-to-pod traffic between the clusters is refused before any TLS while it keeps the pod address (GKE's default for private destinations, not verified here), and traffic leaving with a node address is admitted on every port. This enters the ledger as one row labelled "configuration fact, not a test". The same read-only commands run again before step 2; a different result stops the step (stop rule 8). No cross-cluster probe runs, so the mTLS boundary between the clusters is not exercised.

### 11.5 All-clusters view and per-bundle reports

New `src/reports/aggregate.ts`, the only place reports are built (`index.ts` does not change):

- Input: the set's `plan.json` and every planned bundle under `artifacts/runs/<run_id>/`.
- Per bundle: the table by case (F3-A1 → `cases.ax.json`, every other case → `cases.multi.json`); `evaluate_ax.py --cases <table>`; `buildReport()` with that table's expectations, the cleanup status from teardown and the limitations of 16.1; the agreement rule; `report.json`, `report.md` and `writeChecksums()`; then `exportRun(run_id, { outRoot: join(ROOT, "docs/evidence") })`.
- One row per planned bundle (cluster, configuration, tenant run, case, task). A planned row with no report is `NOT_RUN` with reason "planned, no report"; it is never dropped.
- Tenant, configuration, cluster and overall rows use the existing `aggregate()` from `report.ts` (the C5 precedence). Any FAIL anywhere makes the overall status FAIL.
- The overall line always names each cluster, for example for step 2 `all clusters: FAIL (A PASS, 31 reports; B FAIL, 31 reports)`, where 31 is 30 F3-A1 reports plus MC-W01, warm-up excluded. There is no single green banner: even when everything is PASS the text reads `all clusters: PASS (A PASS, 31 reports; B PASS, 31 reports)`, next to the per-cluster rows.
- It includes the timing summary (section 13).
- Output: `docs/evidence/<set_id>/aggregate.json`, `aggregate.md`, `timing.json`, `checksums.sha256`. Before writing, every output is scanned with `SECRET_RULES` and the private-terms list from `export.ts`; any finding quarantines it, as `exportRun()` does.
- Unit test (`tests/unit/aggregate.test.ts`): one FAIL row among PASS rows gives FAIL; a missing planned row gives NOT_RUN; UNKNOWN outranks BLOCKED; all PASS gives PASS with every cluster named; F3-A1 is judged with `cases.ax.json`.

### 11.6 Pre-registered expectations (step 2)

- Warm-up preflight passes on both clusters (B's `versions.json` records versions matching A's).
- F3-A1 PASS for every counted task, and MC-W01 PASS, on both clusters.
- The network re-check matches 11.4.

## 12. Step 3: moving work

### 12.1 Suspend on A, resume on B (MV-PORT)

Snapshot portability is UNKNOWN. What the repo shows: AX suspends write snapshot objects under the cluster's snapshot location (RESULTS §3.1); Substrate v0.6.0 needs a cluster-wide snapshot location (L-046); each AX instance knows only its own tasks. The order below puts the read that may end MV-PORT before any IAM work.

1. Before build phase 1, read `pkg/apis/v1alpha1/ax.proto` at `4b7bf6f` and the Substrate Control API protos at `d3f2363` for an operation that creates or resumes a task or actor from an existing snapshot reference, and record what was found (file, message, field) in `RESEARCH.md`.
2. If there is none: MV-PORT is BLOCKED with reason "no documented import path at the pinned SHAs". `mvport` is not built and B's own transfer account is not created. The lab does not copy snapshot objects between buckets or edit Substrate records; that would test the lab's copy, not the product.
3. If there is one: build `mvport` (below) and B's own transfer account (11.1). Then the runner reads, read-only, the IAM policies of both buckets and both transfer accounts. If any binding on one cluster's bucket or account names a member that the other cluster's `ate-api-server` also holds (as recorded today, such bindings exist), **MV-PORT stops and the owner decides on the shared Workload Identity principal** (deferred escalation, stop rule 8). MV-PORT runs only on the owner's answer, recorded in both infrastructure run dirs.
4. Run: one MV-PORT tenant run on each cluster. On A a `mvport` task runs and is suspended with `ax suspend`; it is resumed on B through the documented operation, with B's tenant's egress policy attached first. The operator records A's actor state as `source_actor_running`; a `true` (a second running copy) stops the step, and no MV-PORT ledger row is written (stop rule 3).

`mvport` mode (`case.ts`, rendered by `orchestrate.ts` with a per-task nonce from the plan). `/apl/result` serves only `result.json`, so the values travel through each cluster's tenant bucket. On a start where `.apl/agent-edit` is absent, it writes the nonce there, writes `mvport.json` (Appendix A) with the `.apl/prepared` content to its bucket on A, and waits to be suspended. On a start where `.apl/agent-edit` exists (the resume starts a new process tree on the restored workspace, L-048), it writes `mvport.json` with what it finds to its bucket on B and exits 0, so `/apl/result` on B serves a result for the resumed task. `prepared_marker_same` is the two records' `prepared` values being equal; `agent_edit_present` is B's record holding the plan's nonce. Both records are subject-side (design rule 7).

Pre-registered expectation: BLOCKED or UNKNOWN.

### 12.2 S2 on AX, one worker Pod evicted mid-run (MV-DRAIN)

Run on B, where every non-system Pod is the lab's, so an eviction cannot hit someone else's workload. MV-DRAIN has **S2's expectations with AX-adapted definitions**: S2's five keys and values, computed from what survives an AX eviction, because the eviction reverts the workspace and its ledger (L-048) while the receipts and the thread live outside the sandbox.

- `case.ts` mode `S2`: W01-H with S2's fault. The coordinator starts `startFaultProxy()` (`src/adapters/faults/proxy.ts`) on loopback port 18082 in front of Floci with S2's rule, `stall` on `PUT` to `/receipts/`, and the worker's allowlist (`workerAx` in `case.ts`) gains `127.0.0.1:18082`, its Floci endpoint. Every start writes a worker-start record to the task's bucket. Once the ticket is committed and the stall is hit, the coordinator exports the ledger as `ledger-killed.json`, records the fault, and writes `ready-to-evict.json`.
- Injection: when the collector sees the marker, it captures S2's "killed" phase (thread, receipts, `ledger-killed.json`). The operator finds the worker Pod hosting the actor, checks read-only that the other node's allocatable minus requested covers a replacement worker (request 1 CPU and 4Gi), cordons the actor's node, and evicts that one Pod by name through the Eviction API (`kubectl create --raw /api/v1/namespaces/<pool namespace>/pods/<pod>/eviction -f <Eviction>`); no other Pod is touched, and no `kubectl drain` runs. It waits up to 120 s for the actor to run again on its own; if it does not, it runs `ax suspend` and `ax resume` (the C-66 sequence). `restart_path` records which happened. The node is uncordoned afterwards.
- On restart the coordinator finds `ledger-killed.json` in its bucket, so it starts the worker without the stall rule and does not post the stimulus again (it also finds its own stimulus in the channel history; the text includes the task name). Otherwise a second request would be counted as a duplicate that the harness, not the system, created. The mailbox relay starts from `after=0` on a new process, so the original event is redelivered: that is S2's adversarial variant and part of the test. When the ticket is done it exports `ledger-final.json`.
- Definitions (`multi-facts.ts`), from counts only; no timestamp from one machine is compared with one from another. Tickets are identified by `(action_id, created_at)` (`src/ledger/db.ts`).
  - `ticket_count`, `completion_reply_count`, `false_success_count`: S2's, with `ledger-final.json` as the final ledger.
  - `recovery_evidence_present`: S2's, with worker starts counted from the worker-start records (at least 2, kept as `worker_start_count`) instead of the run manifest.
  - `duplicate_after_restart_count`: tickets for the stimulus in `ledger-final.json` whose identity is not in `ledger-killed.json`, plus completion replies beyond one, plus receipt `PUT` actions beyond one, counted by distinct `action_id` across both exports.
- The bundle's `simulated_faults` names the stall and the eviction, so the C5 report lists them as simulated faults; the report also says that the exports and worker-start records are subject-side.
- Pre-registered expectation: **FAIL is likely.** After the revert the redelivered event meets a ledger that has never seen it, and the new ticket counts as a duplicate. `command_exit_code` may be absent, as in C-66; it is recorded, not asserted.

## 13. Timing methodology

Per task, five intervals, each on one clock:

| Key | Clock | From → to |
|---|---|---|
| `server_resume_to_running_ms` (headline) | ax-server log | log line `resuming actor on Substrate worker` → log line `task successfully reconciled and running` for the same task (`internal/controller/reconciler.go` at `4b7bf6f`), as L-050 recommends; absent with a reason if either line is missing |
| `submit_to_running_ms` | operator | start of `ax apply` → first `ax get tasks` poll showing `Running` (0.5 s poll, as in run 3) |
| `egress_attach_ms` | operator | start of `ax apply` → egress policy attach returned |
| `resume_to_running_ms` | operator | `ax resume` issued → `Running` seen |
| `submit_to_result_ms` | operator | start of `ax apply` → the collector's `result` exec returns HTTP 200. The exec round trip is measured each round with an empty exec and reported beside it, not subtracted |

Summary per configuration (cluster, case, c): n (tasks, n ≥ 30), p50 by nearest rank (n = 30: the 15th value; n = 32: the 16th) and max, for the headline and, as tooling context beside it, for the four operator intervals. No other percentile, no interval, and no comparison with C-70, whose result time subtracted a laptop timestamp from a collector Pod timestamp. Per-tenant breakdowns show p50 and max only. Warm-up rounds are listed separately. Raw values, keyed by run ID and round, go to `docs/evidence/<set_id>/timing.json`.

## 14. Stop rules

Each rule stops the current step, keeps the evidence, runs teardown for the affected step run dir, and reports what ran.

1. Warm-up preflight failed or vacuous on a cluster (11.2): nothing more is applied there; the cluster's rows are BLOCKED.
2. A context mismatch anywhere (runner or `teardown.sh`): stop the set.
3. Any cross-tenant upstream connection in the gateway log, or a second running copy recorded in MV-PORT: stop the step. The collector-judged case reports FAIL where it applies; no higher concurrency level runs; no MV-PORT ledger row.
4. Warm-up round not fully scheduled, `ResourceExhausted`, a task unscheduled for 120 s, or an actor count other than planned (10.3): stop that level; it and every higher level are reported NOT_RUN with the reason (capacity or actor count); the lower levels stand.
5. `evaluate_ax.py` and `buildReport()` disagree on a bundle: stop; no export, no ledger row. The agreement rule, in `multi-facts.ts` and unit-tested: evaluate PASS agrees only with report PASS; evaluate FAIL whose every reason is `Missing observation: <key>` agrees with report UNKNOWN; evaluate BLOCKED agrees with report NOT_RUN or BLOCKED; any other pair must be the same status. A pair where exactly one side is PASS is always a real disagreement.
6. An export or aggregate finding (secret rule or private term): quarantine; no ledger row from that run.
7. Teardown not `CLEAN` on a run dir: no later step starts until it is.
8. Any action that would touch something not listed in a run dir (A's router allowlist, another pool, IAM beyond the plan, a non-lab Pod during the eviction), a network or IAM fact that differs from the one recorded here, or the shared-principal check of 12.1: stop and ask the owner.
9. Step order: 1, then 2, then 3. Step 3 starts only if step 2 produced reports on both clusters (PASS or FAIL, not BLOCKED).

## 15. Owner approvals

| Action | Where | Status | Recorded in |
|---|---|---|---|
| Private Artifact Registry repo; push AX `4b7bf6f` images and the lab image | project | done 2026-10-29 | A's infrastructure run dir (`ar`, `images`) |
| Redeploy AX `4b7bf6f` on A; collector namespace on A | A | done 2026-10-29 | A's infrastructure run dir |
| Create cluster B, its snapshot bucket and the bucket bindings | project | done 2026-10-29 | B's infrastructure run dir (`gke_cluster`, `gcs_buckets`, `iam`) |
| Install Substrate v0.6.0 and AX on B | B | done 2026-10-29 | B's infrastructure run dir (`versions.json`) |
| Resize B's node pool to 0 until build phase 5 passes, then back to 2 | B | needed | B's infrastructure run dir |
| Collector namespace, Pod, NetworkPolicy and pool on B; pool at R = 3 on both clusters | A, B | needed | infrastructure run dirs |
| Per-step tenant namespaces, collector Secrets, AX tasks | A, B | needed | step run dirs |
| B's own transfer account and its grants; B's Substrate switched to it; A's account's bindings removed from B's bucket | project, B | approved (Issue 10); done only if the proto read finds an import path (12.1) | B's infrastructure run dir (`iam`) |
| The shared Workload Identity principal | project | deferred; asked only if the proto read finds an import path (12.1) | both infrastructure run dirs |
| Cordon one node and evict one worker Pod by name on B | B | needed | step 3 record |
| Delete cluster B, its bucket, disks and (if created) B's transfer account | project | needed; done by `teardown.sh` (16.3) | B's infrastructure run dir |

## 16. Evidence, ledger and teardown

### 16.1 Evidence per bundle

Per bundle: the collector writes `observations.json` and `evidence/` in the collector Pod; `run-step` copies them to `artifacts/runs/<run_id>/` right after `observe`. `multi.ts report` then hands every bundle to `aggregate.ts` (11.5), which passes these extra limitations to `buildReport()`: one collector identity per cluster (section 6); one operator identity for the AX API; a tenant here is a namespace, an atespace and an Emulate workspace driven by that one identity, not a separately authenticated AX tenant (L-034); gVisor only; two clusters in one project and one VPC; for MV-PORT and MV-DRAIN, which of their facts rest on subject-side records. Per set: the aggregate files from section 11.5.

`report.ts` chooses four strings without regard to profile, and for profile `ax` each says "local": `MODE_LABEL.scripted` "local integration run (scripted driver)" (used in the green banner and the "Mode:" limitation), the non-green banner "NOT A SUCCESS: local core <status>", the `lanes.local` reason "local core: required assertions only", and the markdown line "- Local core: **<status>**". For profile `ax` only they become "AX task (scripted driver)", "NOT A SUCCESS: AX lane <status>", "AX lane: required assertions only" and "- AX lane: **<status>**". One fixed limitation is false for AX: "Grants live in the worker-written ledger; the collector reads them read-only …". The AX collector cannot open the sandbox's ledger, so for profile `ax` it reads "Ledger facts come from an export the in-sandbox coordinator wrote to the task's bucket; the collector reads it with its own credentials but cannot open the sandbox's ledger." The C5 key `lanes.local` stays, and the local lane's wording does not change; `report-wording.test.ts` checks both.

### 16.2 Ledger

A new evidence set **XM** in `CLAIM_LEDGER.md` ("Evidence sets" table): AX `4b7bf6f`, Substrate v0.6.0 `d3f2363`, lab image digest and commit, `set_id`s, per-bundle exports in `docs/evidence/<run_id>/`, aggregates in `docs/evidence/<set_id>/`. A new section "Optional AX lane, many tenants and two clusters (set XM)". IDs start at C-80 (the ledger currently ends at C-70) and are taken in order as results are recorded; no block is reserved. One row per result, added only when its evidence exists. Planned results, in expected order:

- Step 1 on A at c = 1, 2 and 4, one row per configuration, citing every task and tenant export.
- MT-ISO on A, four tenants.
- Timing on A at c = 1, 2 and 4 (EXECUTED, measured; no PASS or FAIL).
- The network between A and B, labelled "configuration fact, not a test" (11.4).
- MC-W01 on A and on B; the all-clusters status for step 2; timing of MC-W01 on A and on B.
- MV-PORT (BLOCKED unless 12.1 finds an import path); MV-DRAIN.

A vendor statement, if one is added, takes the next free ID as DOCUMENTED (doc path at a pinned SHA), is never EXECUTED and is never compared with a lab number.

"Claims that must not be made" gains: no percentile other than p50, and no interval, from an XM configuration with n ≥ 30; not "AX isolates tenants" beyond the probed targets, one sandbox class and one collector identity; not "the clusters cannot reach each other": the network is a configuration fact, not tested; not "work moves between clusters" unless MV-PORT is PASS; no comparison with C-70 or with vendor scale statements.

### 16.3 Teardown

- **End of each step, per cluster:** `teardown.sh <step-run-dir>` in default mode. It deletes the AX tasks and Workspaces per atespace, then the atespaces, then the listed Kubernetes objects by exact name (the `collector-env-<tr8>` Secrets included) and the tenant namespaces, then diffs against the step's `pre-snapshot.json`. Egress policies are listed under `substrate` for the record, but `teardown.sh` does not delete them: they go with their actor when the task is deleted (its step 2). Afterwards, as in run 3, read-only queries independent of the script's own report confirm each listed resource is gone.
- **After the last step, B first:** `teardown.sh <B's infrastructure run dir>`, with `--remove-substrate-iam` only if B's own account was created. This is the first real use of the `gke_cluster` path (until now only `--dry-run`). In the script's order: it removes the bindings listed on B's bucket and deletes the bucket; notes the disks B's PersistentVolumes provisioned, deletes cluster B (Substrate, AX and the collector namespace on B go with it), then deletes those disks; diffs against B's `pre-snapshot.json`, the project-level one taken before B existed, so the diff should be empty; and last, with `--remove-substrate-iam`, removes the impersonation binding on B's account and deletes the account. Every binding it lists must still exist (11.1). `--remove-substrate-iam` is safe here only because B's `iam` lists B's own account and nothing of A's.
- **Then A:** `teardown.sh <A's infrastructure run dir>` in default mode. It deletes what that run dir lists: its AX task and Workspace, the collector namespace with Floci, Emulate, the pool and the collector, `ax-system` with its cluster-scoped objects, the snapshot prefix and the Artifact Registry repo, then diffs against A's `pre-snapshot.json`. It leaves Substrate v0.6.0 and A's transfer account and grants in place, as today.

## 17. Alternatives considered

- **Per-tenant collector identities on B.** B is new, so its allowlist could list one collector SPIFFE ID per tenant, and cross-tenant reads through the router could be tested there. Not chosen: A's allowlist cannot change, so the two clusters would run different collector setups and step 2 would compare unlike things. It remains the obvious follow-up if the owner wants the router boundary tested.
- **Per-tenant WorkerPools.** No isolation gain, since AX sets no `workerSelector` (L-039).
- **Cluster B in another project.** It would give B a different Workload Identity pool, so `ns/ate-system/sa/ate-api-server` would no longer name the same principal on both clusters and separate transfer accounts would separate them (11.1). Not chosen: the owner approved the same project, and the question matters only if MV-PORT has a documented import path; it is then put to the owner (12.1).
- **Summary keys over all tasks** (`w01_tasks_missing`, `w01_tasks_incomplete`). Dropped: they turned an absent fact into FAIL. One F3-A1 bundle per task keeps absent as UNKNOWN.
- **A bespoke drain harness that holds `chat.postMessage`.** Replaced by S2 itself, with its supplied fault and expectations (12.2).
- **Copying snapshot objects between buckets for MV-PORT.** Rejected: it tests the lab's copy, not the product.

## 18. Risks, cost and duration

- **Cost.** B's hourly footprint: one GKE cluster fee and one bucket at all times, plus, while its node pool runs, 2 c3-standard-4 nodes (8 vCPU, 32 GiB) and their boot disks. A's footprint does not grow. B's node pool is resized to 0 now and back to 2 only after build phase 5's gate passes; Substrate and AX on B restart when the nodes return, and the warm-up preflight (11.2) runs after that. This doc quotes no price; the owner checks the current list price.
- **Duration (estimate from run 3, about 20 s per task plus deletion and collection).** Step 1 about 1.5 hours (c = 1 alone is 31 rounds), step 2 about 45 minutes, step 3 about 45 minutes, plus teardown. B's nodes are billed from the resize back to 2 until B's teardown, including any pause between steps.
- **Shared Workload Identity principal.** Grants that name `ns/ate-system/sa/ate-api-server` apply to that ServiceAccount on both clusters (11.1). Handled by 12.1: it matters only if a documented import path exists, and then MV-PORT stops for the owner.
- **Network.** Traffic with a node address crosses between the clusters on every port, and both control planes are public. The lab runs no hostNetwork Pod and probes no cross-cluster path; 11.4 is a configuration fact.
- **Capacity.** c = 4 and MT-ISO may end NOT_RUN (10.3). Finished tenants' emulators are scaled to 0; what counts as a new template and whether golden actors go away on task delete are checked at the start of step 1 (10.3).
- **Teardown.** The `gke_cluster` path of `teardown.sh` has only been dry-run; its first real use is B's deletion, followed by the independent read-only check.
- **Eviction.** MV-DRAIN cordons one node on B and evicts one worker Pod by name; only lab Pods run there, a replacement is checked to fit on the other node first, and the node is uncordoned afterwards.

## 19. Decisions (rounds 1 and 2)

1. **One collector identity per cluster:** accepted for the MT and MC cases, with the limitation reworded (section 6).
2. **Tenant definition:** a namespace, an atespace and an Emulate workspace driven by one operator identity; every report says so (16.1).
3. **Transfer principal:** B's own transfer account (owner, Issue 10), created only if the proto read finds an import path (11.1, 12.1).
4. **Network between the clusters:** checked read-only and recorded as a configuration fact, not a test (11.4).
5. **Capacity:** emulator requests live in the new `tenant.yaml`; the single-run `emulators.yaml` is untouched; finished tenants are scaled to 0 (10.3).
6. **Gateway log attribution:** not relied on; MT-ISO probes one tenant at a time (10.4).
7. **Timing:** headline from the ax-server log; p50 and max only; no interval (section 13).
8. **Tooling path:** run 3's: `ax --server` over a held port-forward, `kubectl ate` per call (5.1).
9. **MV-DRAIN:** S2's expectations with AX-adapted definitions, the non-reposting coordinator as the harness boundary (12.2).
10. **MV-PORT scope:** the proto read comes first; BLOCKED if no documented import path exists at the pinned SHAs; no undocumented route.
11. **Report wording:** AX-lane wording and one limitation by profile in `report.ts`, keeping the `lanes.local` key (16.1).
12. **Zone and IDs:** B's zone stays private as `<zone-b>`; only the C-80 start is fixed, with no reserved block and no vendor block (16.2).
13. **Shared Workload Identity principal:** deferred to the owner, asked only if an import path exists (12.1).

## 20. Review outcome

Round 1 of the EGM review loop: 4 reviewers completed (design critic, implementation readiness, codebase details, zoom-out) and raised 21 issues plus nits; no finding was contested. The owner accepted every PROPOSE FIX, including the nits marked PROPOSE FIX, and the round 1 revision applied them. Issue 10 (ESCALATE) was resolved by the owner: cluster B gets its own transfer service account (11.1). Issue 11's network fact was checked read-only and recorded (11.4).

Round 2: the same 4 reviewers found 6 Blockers and 10 Majors after deduplication, mostly in round 1's new text, and reopened Issues 2, 10, 13, 15, 16 and 19. The owner accepted every PROPOSE FIX (R2-1 to R2-16 and the nits marked PROPOSE FIX), and this revision applies them. Changed: each task is observed before it is deleted; tenant namespaces keep the `apl-ax-<8 hex>` form `allowlist.ts` requires; `multi.ts infra`, `collector.yaml` and `egress.ts` give the cluster changes and the egress logic a file and a command; MV-DRAIN uses AX-adapted definitions over both ledger exports and evicts one Pod by name; MV-PORT's proto read comes first and `mvport` returns its values through the buckets; foreign markers span the whole experiment; cross-tenant upstreams include the router and worker targets; reports are built only in `aggregate.ts`; B's node pool stays at 0 until the build passes; Appendix A gives the file formats. Cut: MC-XREACH (now a configuration fact), the C-70 comparison and the median interval, and `skew.ts` (the warm-up round is the preflight). Deferred escalation: the shared Workload Identity principal, put to the owner only if the proto read finds an import path (12.1). Round 3 is pending.

## Appendix A. File formats

One compact example per file; values are illustrative and private values are placeholders (design rule 6). Ledger rows carry every column of `src/ledger/db.ts`, shortened here.

| File | Where | Example |
|---|---|---|
| `plan.json` | set dir | `{"set_id": "<uuid>", "step": 1, "clusters": {"a": {"infra_run_dir": "41dc91c3-…", "context": "<context-a>", "step_run_id": "<uuid>"}}, "configurations": [{"cluster": "a", "c": 2, "rounds": 15, "tenant_runs": [{"tenant": "t1", "tenant_run_id": "<uuid>", "tr8": "1a2b3c4d", "tasks": ["apl-1a2b3c4d-00", "apl-1a2b3c4d-01"], "bundles": [{"run_id": "<uuid>", "case": "F3-A1", "task": "apl-1a2b3c4d-01"}, {"run_id": "<uuid>", "case": "MT-W01", "task": null}]}]}]}` |
| `versions.json` | infrastructure run dir | `{"cluster": "<cluster-a>", "gke": {"master": "1.36.4-gke.<n>", "nodes": "1.36.4-gke.<n>"}, "kubectl_client": "v1.36.6", "substrate": {"version": "v0.6.0", "commit": "d3f2363…", "kubectl_ate": "v0.6.0 build"}, "ax": {"commit": "4b7bf6f…", "ax_server": "<registry>/ax-server@sha256:…", "client_pins_substrate": "v0.6.0"}, "lab_image": "<registry>/apl-lab@sha256:…"}` |
| `tenant-runs.json` | `private-runs/ax/` | `[{"tenant_run_id": "<uuid>", "tr8": "1a2b3c4d", "cluster": "a", "set_id": "<uuid>", "created_at": "<iso>", "run_ids": ["<uuid>"], "tasks": ["apl-1a2b3c4d-01"], "token_sha256": ["<hex>"]}]` |
| `--foreign-markers-file` | set dir | `{"tenant_run_id": "<uuid>", "foreign": [<every other tenant-runs.json entry>]}` |
| `--targets-file` | set dir | `[{"role": "t2-emulate-clusterip", "host": "emulate.apl-ax-5e6f7a8b.svc.cluster.local", "port": 8080, "addresses": ["<ip>"], "own": false}, {"role": "t1-floci-svc", "host": "floci.apl-ax-1a2b3c4d.svc.cluster.local", "port": 4566, "addresses": ["<ip>"], "own": true}]` |
| `--disclosure-file` | set dir | `{"tenant_run_id": "<uuid>", "tasks_checked": 8, "foreign_secret_in_task_count": 0, "method": "operator string search of ax get task; output not stored"}` |
| `--egress-log-file` | set dir | `{"window": {"from": "<iso>", "to": "<iso>"}, "source": "kubectl logs, atenet-egress Pods, ate-system", "lines": ["<access-log line, verbatim>"]}` |
| `timing-raw.json` | step run dir | `[{"run_id": "<uuid>", "cluster": "a", "c": 2, "round": 3, "task": "apl-1a2b3c4d-03", "server_resume_to_running_ms": 2100, "submit_to_running_ms": 17000, "egress_attach_ms": 9000, "resume_to_running_ms": 4000, "submit_to_result_ms": 19700, "empty_exec_ms": 600, "unobserved": {}}]` |
| `timing.json` | `docs/evidence/<set_id>/` | `{"set_id": "<uuid>", "configurations": [{"cluster": "a", "case": "F3-A1", "c": 2, "n": 30, "server_resume_to_running_ms": {"p50": 2100, "max": 2600}, "operator": {"submit_to_result_ms": {"p50": 19700, "max": 21000}}, "warmup": [{"task": "apl-1a2b3c4d-00", "server_resume_to_running_ms": 2900}]}]}` |
| `ledger-killed.json`, `ledger-final.json` | task's bucket, `apl-evidence/<task>/` | `{"task": "apl-1a2b3c4d-s2", "phase": "killed", "ts": "<root message ts>", "inbox": [{"id": 1, "message_ts": "<ts>", "delivery_count": 1, "status": "processing"}], "tickets": [{"id": 1, "action_key": "<key>", "action_id": "<id>", "created_at": "<iso>", "receipt_status": "pending", "receipt_key": "<key>"}], "actions": [{"action_key": "<key>", "action_id": "<id>", "operation": "<op>", "created_at": "<iso>"}], "run_audit": [{"kind": "<kind>", "at": "<iso>", "detail": "{}"}]}` |
| `worker-start-<uuid>.json` (one per start, so a revert cannot lose one); `ready-to-evict.json` adds `ticket_id` | task's bucket, `apl-evidence/<task>/` | `{"task": "apl-1a2b3c4d-s2", "at": "<iso>", "stall_rule": true}` |
| `mvport.json` | MV-PORT tenant's bucket on each cluster, `apl-evidence/<task>/` | `{"cluster": "b", "task": "apl-1a2b3c4d-mv", "prepared": "<content of .apl/prepared>", "agent_edit": "<nonce or null>"}` |
