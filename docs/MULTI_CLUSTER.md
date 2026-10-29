Status: DRAFT for EGM review (/egm:egm-review-loop); not yet reviewed.

# Multi-tenant and multi-cluster test design (AX lane)

This is a test design, not a result. Nothing in it has run. It extends the optional AX lane (`profiles/ax/`) with three owner-approved steps and says exactly what would be built, run, recorded and torn down. Every PASS or FAIL it plans comes from an independent collector and the supplied evaluator, never from AX task phase (L-006).

Sources read for this design: [`profiles/ax/README.md`](../profiles/ax/README.md), [`profiles/ax/RESULTS.md`](../profiles/ax/RESULTS.md), `profiles/ax/{case.ts,index.ts,run-dir.ts,run-dir.schema.json,teardown.sh,evaluate_ax.py,cases.ax.json,collector.ts,orchestrate.ts}`, [`LEARNINGS.md`](LEARNINGS.md) L-006 to L-012 and L-030 to L-057, [`CLAIM_LEDGER.md`](CLAIM_LEDGER.md) C-60 to C-70, [`CONTRACTS.md`](spec/active/2026-10-28-agent-proof-lab/contracts/CONTRACTS.md) C4 and C5, and `src/reports/`.

## 1. Scope

| Step | What | Cluster(s) |
|---|---|---|
| 1 | Many tenants: N concurrent tenants, each with its own atespace, lab namespace and Emulate workspace; isolation; timing with n ≥ 30 per configuration | A (existing) |
| 2 | Two clusters: the same case on each; one C5 report per cluster; an all-clusters view that never blends into one green; a protocol-skew check before running; cross-cluster reachability denied | A and a new cluster B |
| 3 | Moving work: suspend on A and resume on B (snapshot portability, UNKNOWN today); drain or evict mid-run with no duplicate business effect | A and B |

Not in scope: microVM sandboxes, the default AX runner, a live model, any change to Substrate on A (router allowlist included), any scale claim. Vendor scale statements from Google AX or Agent Substrate docs may enter the ledger only as DOCUMENTED, with the doc path at a pinned SHA, and are never compared with a lab measurement.

## 2. Starting point (from the repo)

- Cluster A ran AX run 3 (set X, C-60 to C-70): AX `4b7bf6f` on Substrate v0.6.0 (`d3f2363590a1`), 2 × c3-standard-4, amd64, GKE 1.36.4, gVisor, one worker.
- After the 2026-10-29 teardown (`RESULTS.md`, "Teardown"), A still runs Substrate v0.6.0 (11 of 11 pods) and keeps the snapshot transfer service account and its three grants. The lab namespace, `ax-system` (AX itself), the AX cluster-scoped objects, the private Artifact Registry repo and the run's snapshot prefixes are gone. So step 1 must redeploy AX and re-push images before anything runs, each an owner-approved action (section 13).
- Known AX behaviour this design plans around: tasks are created suspended and need `ax resume` (L-047); a new template gets a golden actor that takes worker capacity (L-047); AX templates set no `workerSelector`, so tasks land on any pool (L-039); `ax suspend` and `ax delete task` send no SIGTERM, and after an eviction the actor counts as crashed and is reverted, losing `result.json` (L-048, C-62, C-63, C-66); `ax get task` returns `spec.env` in clear to any AX API caller (L-034, C-69); the v0.6.0 router serves actors only over mTLS to allowlisted SPIFFE IDs (L-045); egress refusals are judged from the egress gateway's log, not from probe byte counts (L-049); run 3 timing measured operator tooling more than AX (L-050).

## 3. Design rules

1. **Evidence exactly as before.** Every result is a C4 bundle written by the collector, judged by `evaluate_ax.py` and by `buildReport()` (`src/reports/report.ts`), with one C5 report per tenant run and per cluster, exported with `exportRun()` (`src/reports/export.ts`) to `docs/evidence/<run_id>/`. If `evaluate_ax.py` and `buildReport()` disagree on a status, the run stops (section 12).
2. **Phase is not outcome.** `ax_task_phase` stays under `recorded_not_asserted` in every case (L-006).
3. **Absent is not zero.** An observation the collector could not make is absent with a reason (C4). A lost `result.json` after eviction makes `command_exit_code` absent, so any assertion on it is UNKNOWN, as C-66 requires.
4. **One clock per interval.** Every timing interval is measured on one named clock. No interval subtracts a timestamp taken on one machine from one taken on another (L-050).
5. **Pre-registration.** Before each step runs, its expectations are committed to the second table of `LEARNINGS.md` ("Expected" column), as was done for the W5 runs.
6. **Identifiers stay private.** Project, cluster names, zone, contexts, registry, bucket and IPs live only in gitignored `private-runs/ax/`. Public files use placeholders (`<project>`, `<cluster-a>`, `<cluster-b>`, `<zone-b>`, `<registry>`, `<snapshot-bucket>`), as `RESULTS.md` does.

## 4. Collector identity: one per cluster (weaker than run 3)

On Substrate v0.6.0 the collector can read a task's `/apl/result` only through the router, over mTLS, with a SPIFFE ID listed in `--ingress-allowed-spiffe-ids` (L-045). Run 3 added exactly one ID to A's router allowlist: the collector Pod's identity, ServiceAccount `apl-collector` in namespace `apl-ax-6882d106`. Changing A's allowlist again is not approved. Teardown deleted that namespace but did not touch the router's arguments.

So each cluster has **one** collector identity:

- Namespace `apl-ax-6882d106`, ServiceAccount `apl-collector`, Pod `apl-collector`, on both A and B. On A this re-creates the identity already in the allowlist. On B the same ID is put in the allowlist at install time, so both clusters are configured the same way and A is not changed.
- The namespace name comes from the router allowlist, not from this set's IDs. It is owned by the cluster run (section 6) and carries `apl-role=collector`.
- The collector observes every tenant on its cluster. For each tenant it reads that tenant's `collector-env` Secret through lab-owned namespaced RBAC: in each tenant namespace a Role `apl-collector-read` (`get` on `secrets`, `resourceNames: [collector-env]`) and a RoleBinding to `system:serviceaccount:apl-ax-6882d106:apl-collector`. The Pod gets a projected ServiceAccount token for this (the run 3 Pod had `automountServiceAccountToken: false` and needed none).
- Each tenant's NetworkPolicy admits the collector by namespace and pod label (`kubernetes.io/metadata.name: apl-ax-6882d106` plus `app: apl-collector`) instead of the same-namespace selector in `manifests/k8s/emulators.yaml`.
- `collector.ts observe` runs once per tenant run, with that tenant's config only and a separate output directory, and still emits one C4 bundle per tenant run. One C5 report per tenant and per cluster follows from that.

**What this weakens, stated plainly.** In run 3 each run's collector held only that run's reader token and S3 key. Here one process identity holds every tenant's reader token and S3 key on its cluster. Separation between tenants' evidence therefore rests on the collector's code (per-tenant config, per-tenant output directory, the `foreign_marker_count` check in section 7), not on credentials. A collector bug could mix tenants' evidence without any credential stopping it, and the design cannot test whether one tenant's collector could read another tenant's results through the router, because there is only one collector. The reason is that no Substrate change on A was approved. This is listed under open questions (section 15, Q1), and every report from this design carries it as a limitation.

## 5. Naming and labels

| Thing | Name | Notes |
|---|---|---|
| Set | `set_id` (UUID) | one per execution of a step; groups tenant and cluster runs |
| Cluster run | `cluster_run_id` (UUID), short `<cr8>` | one per cluster per set; its run dir holds `owned-resources.json` |
| Tenant run | `run_id` (UUID), short `<tr8>` | one per tenant per configuration; keys its C4 bundle, C5 report and `docs/evidence/<run_id>/` |
| Tenant namespace and atespace | `apl-ax-<tr8>` | same rule as run 3 (`orchestrate.ts` uses the namespace as the atespace) |
| Tenant tasks | `apl-<tenant>-<nn>` with Workspace `ws-<task>`, e.g. `apl-t2-07` | `nn` is the round number; `ws-` prefix as in `orchestrate.ts` |
| Pool namespace | `apl-ax-<cr8>` with WorkerPool `apl-ax-pool` | shared by all tenants on the cluster (section 8.2) |
| Collector | `apl-ax-6882d106/apl-collector` | fixed by the router allowlist (section 4) |
| Tenant labels | `apl-run=<run_id>`, `apl-set=<set_id>`, `apl-cluster=a\|b`, `apl-tenant=t1..t4`, `apl-role=tenant` | on every Kubernetes object in the tenant namespace |
| Cluster labels | `apl-run=<cluster_run_id>`, `apl-set=<set_id>`, `apl-cluster=a\|b`, `apl-role=collector\|pool` | collector and pool namespaces |
| AX objects | no labels exist (L-008) | `spec.config` keys `apl-run`, `apl-set`, `apl-cluster`, `apl-tenant`; the same in the Workspace's `.apl/run.json` |

Tenants t1 to t4 are roles. Each configuration gets fresh tenant runs (new UUIDs, new namespaces), so no state carries between configurations.

## 6. Run dirs, owned resources and the context guard

- One run dir per cluster: `private-runs/ax/<cluster_run_id>/`, with the existing layout (`owned-resources.json`, `pre-snapshot.json`, `kubeconfig`). `owned-resources.json` keeps the current schema unchanged: `run_id` is the cluster run ID, `kube_context` is that cluster's context, and the lists name every tenant namespace, the collector and pool namespaces, the per-tenant Role and RoleBinding, AX objects per atespace, Substrate atespaces and egress policies, and the cloud entries owned by that cluster run.
- One set dir: `private-runs/ax/sets/<set_id>/plan.json`, written before any call, listing clusters, tenants, run IDs, configurations and planned task counts. Tenant run dirs (`secrets.json`, `emulate-seed.json`, rendered manifests) sit under it, one per tenant run, as `orchestrate.ts init` and `manifests` already write them.
- **Context guard.** Every cluster call made by the new runner passes `--kubeconfig <cluster-run-dir>/kubeconfig` (single context, mode 0600, as `index.ts run()` writes it). The ambient context is never read. A call whose target cluster differs from the plan's cluster for that step is a programming error and stops the set. `teardown.sh` keeps its own guard (schema valid and current context equals `kube_context`).

## 7. Cases (`profiles/ax/cases.multi.json`)

Same rules as `cases.ax.json`: profile `ax`, typed equality only (the supplied `inspect_bundle()`), and no expectation may name a recorded-only key. `evaluate_ax.py` gains one optional argument, `--cases FILE`, defaulting to `cases.ax.json`.

```json
{
  "note": "Multi-tenant and multi-cluster AX expectations (docs/MULTI_CLUSTER.md). Equality only. Recorded keys are never asserted (L-006).",
  "recorded_not_asserted": ["ax_task_phase", "concurrency", "tasks_planned", "tasks_timed", "probe_self_report_reached_count",
    "substrate_server_version", "ax_substrate_client_version", "completion_reply_count", "command_exit_code", "result_after_eviction_present",
    "restart_path"],
  "MT-W01": {"profile": "ax", "note": "step 1: one tenant run of k W01-H tasks under concurrency c", "expected": {"w01_tasks_missing": 0, "w01_tasks_incomplete": 0, "foreign_marker_count": 0}},
  "MT-ISO": {"profile": "ax", "note": "step 1: cross-tenant reach, disclosure and shared evidence", "expected": {"cross_tenant_upstream_count": 0, "allowed_control_reached": true, "foreign_secret_in_task_count": 0, "foreign_marker_count": 0}},
  "MC-W01": {"profile": "ax", "note": "step 2: same as MT-W01 at c = 1, run on each cluster", "expected": {"w01_tasks_missing": 0, "w01_tasks_incomplete": 0, "foreign_marker_count": 0}},
  "MC-XREACH": {"profile": "ax", "note": "step 2: nothing on one cluster reaches the other", "expected": {"cross_cluster_upstream_count": 0, "allowed_control_reached": true, "cross_cluster_router_accepted": false}},
  "MV-PORT": {"profile": "ax", "note": "step 3: suspend on A, resume on B", "expected": {"prepared_marker_same": true, "agent_edit_present": true, "source_actor_running": false}},
  "MV-DRAIN": {"profile": "ax", "note": "step 3: evict the worker mid-run (S2-style); no duplicate business effect", "expected": {"receipt_count": 1, "extra_completion_reply_count": 0, "duplicate_after_restart_count": 0}}
}
```

Observation keys, each collected by the collector with direct evidence:

| Key | Type | Collected from | Meaning |
|---|---|---|---|
| `w01_tasks_missing` | number | plan file (written before the run) and collector results | planned tasks minus tasks for which the collector observed anything |
| `w01_tasks_incomplete` | number | per task, the F3-A1 facts (`ticket_count`, `receipt_count`, `receipt_matches_request`, `completion_reply_count`, `command_exit_code`), each from the same sources as `collector.ts` uses today | observed tasks whose five facts are not exactly 1, 1, true, 1, 0. Per-task facts are written as evidence files `evidence/task-<nn>-*.json` and referenced by this key |
| `foreign_marker_count` | number | every evidence file of this tenant run, its Floci bucket and its Slack channel | items that contain another tenant's `run_id`, task name, or a token whose SHA-256 is in another tenant's token-hash list. The collector gets other tenants' IDs and token hashes, never their tokens (`--foreign-markers-file`) |
| `cross_tenant_upstream_count` | number | egress gateway access log for the probe window, captured by the operator (`--egress-log-file`) | entries whose upstream is another tenant's Emulate or Floci host or ClusterIP and is not null (L-049) |
| `allowed_control_reached` | boolean | same log plus the probe's own report | the tenant's own Emulate API was reached in the same window, so the probe ran with a working policy |
| `foreign_secret_in_task_count` | number | operator string search of `ax get task` for this tenant's tasks against other tenants' secrets; only the count is kept (`--disclosure-file`), the output is not stored, as in run 3 | other tenants' secrets present in this tenant's task |
| `cross_cluster_upstream_count` | number | as `cross_tenant_upstream_count`, targets on the other cluster | |
| `cross_cluster_router_accepted` | boolean | collector `GET /apl/result` to the other cluster's router pod IP with its own certificate | true only for HTTP 200 |
| `prepared_marker_same`, `agent_edit_present`, `source_actor_running` | boolean | runner `/apl/result` on B plus a file the task writes into its own bucket; `kubectl ate get actors` on A captured by the operator | section 10.1 |
| `receipt_count` | number | S3 ListObjects on the task's bucket (`<task>-receipts`, outside the sandbox) | business effect outside the sandbox |
| `extra_completion_reply_count` | number | `conversations.replies` on the request's thread | completion replies beyond the first |
| `duplicate_after_restart_count` | number | S3 and thread, timestamped after the eviction | receipts plus replies created after the eviction beyond those needed to complete the one request |

## 8. Step 1: many tenants on cluster A

### 8.1 Layout per tenant

Each tenant run gets: atespace and namespace `apl-ax-<tr8>`; its own Floci and Emulate (one Emulate workspace, its own per-run fake secrets from `orchestrate.ts init`); its own egress policy listing only its own Emulate (8080, 8081) and Floci (4566) hosts, attached right after the actor exists and before `ax resume` (L-047); the Role and RoleBinding for the shared collector. No collector and no WorkerPool in the tenant namespace.

### 8.2 One shared pool, and why

AX templates set no `workerSelector`, so a task can land on any pool (L-039). Per-tenant pools would not pin tenants to their pool, so they would not add isolation. One run-owned pool per cluster (`apl-ax-<cr8>/apl-ax-pool`, gVisor, R workers) makes tenants share workers, which is the setting where cross-tenant isolation matters. Other pools on A were deleted by the run 3 reinstall (RESULTS §3.2), so none needs scaling; the preflight confirms that `scaled` stays empty.

### 8.3 Concurrency levels and capacity

Configurations: c ∈ {1, 2, 4} concurrent tenants on A, each tenant running one W01-H task per round. A round submits all c tasks at once, waits for every result or a 120 s timeout, deletes the tasks, then starts the next round (run 3 deleted each task before the next, L-047).

| c | Tenants | Rounds | Tasks (n) | Tasks per tenant run |
|---|---|---|---|---|
| 1 | t1 | 30 | 30 | 30 |
| 2 | t1, t2 | 15 | 30 | 15 |
| 4 | t1 to t4 | 8 | 32 | 8 |

Each configuration starts with one warm-up round that is reported separately and not counted.

Capacity estimate (to be checked, not assumed): 2 × c3-standard-4 is 8 vCPU and 32 GiB before system reservations; Substrate (11 pods) and AX also run there, and their requests are not recorded in the repo. In `emulators.yaml` Floci and Emulate set limits only (500m/768Mi and 500m/512Mi), so their requests equal their limits: 1 vCPU per tenant, 4 vCPU at c = 4. The tenant template therefore adds requests of 100m CPU and 256Mi per container, keeping the limits. With R = 3 workers (run 3's worker template: request 1 CPU and 4Gi, limit 3 CPU), requests at c = 4 total about 0.8 + 0.5 (collector) + 3 = 4.3 vCPU and 2 + 0.5 + 12 = 14.5 GiB. Actor slots: with 1-CPU tasks a 3-CPU worker refused a fourth actor (L-047), so R = 3 gives about 9 slots for at most 4 task actors plus up to 4 golden actors.

Preflight before each configuration (read-only): node allocatable minus requested CPU and memory must cover the configuration's requests; the warm-up round must schedule all c tasks; `kubectl ate get actors` per atespace is recorded. If the warm-up round gets `ResourceExhausted` or a task stays unscheduled for 120 s, the stop rule in section 12 applies.

### 8.4 Isolation (MT-ISO)

Run once per tenant while all four tenant namespaces exist and no other task runs, so every gateway log entry in the window comes from the probing tenant (whether the log names the source actor is open question Q6).

- `case.ts isolation` gains `APL_AX_PROBE_URLS` (comma-separated URLs) next to the existing `APL_AX_PROBE_IPS`. Targets: every other tenant's Emulate (8080, 8081) and Floci (4566) by Service name and by ClusterIP, plus the run 3 targets. The probe also writes its JSON lines to its own bucket (`apl-evidence/<task>/isolation.json`); the collector records that as the subject's self-report (`probe_self_report_reached_count`), and judges from the gateway log.
- Disclosure: `foreign_secret_in_task_count` as in section 7. Cross-tenant disclosure through the AX API itself is not testable here: there is one operator identity, and `ax get task` returns `spec.env` to any caller (L-034). That stays a disclosed limitation (C-69), not a claim.
- Shared evidence: `foreign_marker_count` in every MT-W01 and MT-ISO bundle.

### 8.5 Timing

Section 11. Timing is recorded, never asserted. Each tenant run's bundle records `concurrency`, `tasks_planned` and `tasks_timed`; raw per-task intervals go to the set's timing file.

## 9. Step 2: two clusters

### 9.1 Cluster B

Created only with owner approval (section 13): same project, zone `<zone-b>`, 2 × c3-standard-4, amd64, no autoscaling, GKE 1.36 (same minor as A), Workload Identity on. Substrate v0.6.0 (`d3f2363590a1`) installed with its own `ate-setup`, from a config derived from A's private install config and the v0.6.0 requirements in L-046: a cluster-wide `--snapshot-location` under a B-only prefix, `--ingress-allowed-spiffe-ids` including `apl-ax-6882d106/apl-collector`, `ax-server` as a bootstrap owner, home-built v0.6.0 images (the release images are not public). AX `4b7bf6f` deployed with `make deploy`, `AX_SNAPSHOTS_BUCKET` pointed at a B run-owned prefix (L-031). Images are pulled from the same private repo by digest.

The transfer service account: RESULTS §3.1 records the grant's member as `ns/ate-system/sa/ate-api-server`, with no cluster in it. B's `ate-api-server` may therefore already hold the same impersonation right, with no new IAM. That is convenient and it is also a cross-cluster path at the storage layer (open question Q3).

### 9.2 Protocol-skew doctor check (L-030)

New `profiles/ax/skew.ts <cluster-run-dir>`: read-only calls through the pinned kubeconfig, output `<cluster-run-dir>/skew.json`. It records and compares:

1. AX's Substrate client: the `go.ate.dev/substrate` version in `go.mod` of the AX checkout at the deployed commit (path from `local` in the run dir), and the `ax-server` image digest.
2. The server: the image tag of every Deployment and DaemonSet in `ate-system` (all must carry the same version tag) and `substrate_install.current.commit` from the run dir.
3. The operator's `kubectl-ate`: its reported version.
4. A wire probe: `kubectl ate get atespaces -o json` must succeed without `Unimplemented` or an unmarshal error, and every listed actor must decode with a state other than `UNSPECIFIED` (the L-030 symptom). With no actors the probe part is recorded as UNKNOWN (vacuous), not as a pass.

Result: `ok: true` only if 1, 2 and 3 name the same release and 4 shows no decode failure. Otherwise `ok: false` with the versions found and nothing else.

`lab profile doctor ax` gains prerequisite `ax.protocol-skew`: satisfied when `APL_AX_SKEW_REPORT` names a `skew.json` with `ok: true` for the same `kube_context`, taken within the last 60 minutes. Doctor still makes no server call (it only reads the file), so its `external_calls: 0` property holds. A unit test feeds synthetic inputs: v0.6.0 client against a `v0.5.0-45` server (the run 1 state), mixed tags, and an `Unimplemented` probe must each give `ok: false`; matching inputs give `ok: true`.

The all-clusters view also compares identity across clusters: AX commit, `ax-server` digest, lab image digest, Substrate commit. If they differ, the view says "not comparable" next to the statuses; it does not hide them.

### 9.3 Same case on each cluster (MC-W01)

One tenant per cluster, c = 1, 30 tasks plus a warm-up round, A first, then B, in the same session. Each cluster yields one tenant run, hence one C4 bundle and one C5 report per cluster.

### 9.4 Cross-cluster reachability (MC-XREACH)

From a tenant sandbox on each cluster, probes to the other cluster's targets (taken read-only from the other cluster's kubeconfig by the operator): Emulate and Floci pod IPs and ClusterIPs, the router pod IP, the Kubernetes API endpoint. Judged from the local egress gateway log as in MT-ISO. From the collector Pod (a plain Pod, not sandboxed): `GET /apl/result` to the other cluster's router pod IP with the collector's own certificate, which the other cluster's CA did not issue; expected refused (`cross_cluster_router_accepted: false`). Whether the two clusters share a VPC, which decides whether plain-pod IP traffic can cross at all, is open question Q4.

### 9.5 All-clusters view

New `src/reports/aggregate.ts`:

- Input: the set's `plan.json` and the exported `docs/evidence/<run_id>/report.json` of every planned tenant run.
- One row per planned (cluster, case, configuration, tenant run). A planned row with no report is `NOT_RUN` with reason "planned, no report"; it is never dropped.
- Per-cluster status and overall status use the existing `aggregate()` from `report.ts` (FAIL > UNKNOWN > BLOCKED > NOT_RUN > PASS, the C5 precedence). Any FAIL anywhere makes the overall status FAIL.
- The overall line always names each cluster, for example `all clusters: FAIL (A FAIL, B PASS)`. There is no single green banner: even when everything is PASS the text reads `all clusters: PASS (A PASS, 9 reports; B PASS, 3 reports)`, next to the per-cluster rows.
- It includes the timing summary (section 11).
- Output: `docs/evidence/<set_id>/aggregate.json`, `aggregate.md`, `timing.json`, `checksums.sha256`. Before writing, every output is scanned with `SECRET_RULES` and the private-terms list from `export.ts`; any finding quarantines it, as `exportRun()` does.
- Unit test (`tests/unit/aggregate.test.ts`): one FAIL row among PASS rows gives FAIL; a missing planned row gives NOT_RUN; UNKNOWN outranks BLOCKED; all PASS gives PASS with every cluster named.

## 10. Step 3: moving work

### 10.1 Suspend on A, resume on B (MV-PORT)

Snapshot portability is UNKNOWN. What the repo shows: AX suspends write snapshot objects under the cluster's snapshot location (RESULTS §3.1); Substrate v0.6.0 needs a cluster-wide snapshot location (L-046); each AX instance knows only its own tasks.

1. Read `pkg/apis/v1alpha1/ax.proto` at `4b7bf6f` and the Substrate Control API protos at `d3f2363` for an operation that creates or resumes a task or actor from an existing snapshot reference, and record what was found (file, message, field) in `RESEARCH.md`.
2. If there is none: MV-PORT is BLOCKED with reason "no documented import path at the pinned SHAs". The lab does not copy snapshot objects between prefixes or edit Substrate records; that would test the lab's copy, not the product.
3. If there is one: on A run a `term`-mode task that also writes an agent edit file into the workspace, `ax suspend` it, then resume it on B through that operation. The collector on B reads `/apl/result` and the task's own bucket; the operator records A's actor state. Expected as in section 7. Any second running copy (`source_actor_running: true`) is FAIL.

Pre-registered expectation: BLOCKED or UNKNOWN.

### 10.2 Drain or evict mid-run (MV-DRAIN), S2-style

Run on B, where every non-system Pod is the lab's, so an eviction cannot hit someone else's workload.

- `case.ts` gains mode `W01-H-hold`: W01-H with the worker's loopback Slack proxy (`startWorkerSlackProxy`, owned by the coordinator) holding `chat.postMessage` for 30 s. That opens S2's window: receipt committed, reply not yet sent.
- On restart the coordinator must not post the stimulus again: it first looks for its own stimulus in the channel history (the text includes the task name). Otherwise a second request would be counted as a duplicate that the harness, not the system, created. The mailbox relay starts from `after=0` on a new process, so the original event is redelivered: that is S2's adversarial variant and is part of the test.
- Injection: when the collector sees the receipt object in the task's bucket, the operator runs `kubectl drain <worker-node> --pod-selector=<worker pod labels>`, which cordons the node and evicts only the worker Pod. Then it waits up to 120 s for the actor to run again on its own; if it does not, it runs `ax suspend` and `ax resume` (the C-66 sequence). `restart_path` records which happened. The node is uncordoned afterwards.
- Pre-registered expectation: **FAIL is likely.** The worker's idempotency ledger lives in the workspace (`/workspace/.apl/ledger.db` in `case.ts`), and after an eviction AX reverted the workspace to its last snapshot (L-048). The redelivered event would then meet a ledger that has never seen it, while the receipt and the thread live outside the sandbox and are not reverted. `command_exit_code` may be absent, as in C-66; it is recorded, not asserted, so its absence makes nothing PASS.

## 11. Timing methodology

Per task, five intervals, each on one clock:

| Key | Clock | From → to |
|---|---|---|
| `submit_to_running_ms` | operator | start of `ax apply` → first `ax get tasks` poll showing `Running` (poll every 250 ms; resolution stated) |
| `egress_attach_ms` | operator | start of `ax apply` → egress policy attach returned |
| `resume_to_running_ms` | operator | `ax resume` issued → `Running` seen |
| `server_resume_to_running_ms` | ax-server log | resume received → running, as L-050 recommends |
| `submit_to_result_ms` | operator | start of `ax apply` → the collector's `result` exec returns HTTP 200. The exec round trip is measured each round with an empty exec and reported beside it, not subtracted |

To reduce tooling noise (L-050) the runner holds one long-lived port-forward per cluster to `ax-server` and one to the Substrate API, shared by all calls, instead of one per `kubectl ate` call. This differs from run 3, so step-1 c = 1 numbers are not compared with C-70 except to say so.

Summary per configuration (cluster, case, c), over all n tasks (n ≥ 30): min, p50 and p90 by nearest rank (for n = 30 the 15th and 27th values; for n = 32 the 16th and 29th), max, and a distribution-free 95% interval for the median from order statistics (n = 30: 10th and 21st values, coverage 95.7%; n = 32: 10th and 23rd). No p95 or p99. Tasks in one round are not independent; the summary says how many rounds produced the n tasks. Per-tenant breakdowns, which have fewer than 30 tasks, show min, median and max only. Warm-up rounds are listed separately. Raw values, keyed by run ID and round, go to `docs/evidence/<set_id>/timing.json`.

## 12. Stop rules

Each rule stops the current step, keeps the evidence, runs teardown for the affected cluster, and reports what ran.

1. `skew.json` not `ok` on a cluster: nothing is applied there; the cluster's rows are BLOCKED.
2. A context mismatch anywhere (runner or `teardown.sh`): stop the set.
3. Any cross-tenant or cross-cluster upstream connection in the gateway log: stop the step, report FAIL; no higher concurrency level runs.
4. Warm-up round not fully scheduled, or `ResourceExhausted`, or a task unscheduled for 120 s: stop that level; it and every higher level are reported NOT_RUN (capacity) with the reason; the lower levels stand.
5. `evaluate_ax.py` and `buildReport()` disagree on a tenant run's status: stop; no export, no ledger row.
6. An export or aggregate finding (secret rule or private term): quarantine; no ledger row from that run.
7. Teardown not `CLEAN` on a cluster: no later step starts until it is.
8. Any action that would touch something not listed in a run dir (A's router allowlist, another pool, IAM beyond the plan, a non-lab Pod during the drain): stop and ask the owner.
9. Step order: 1, then 2, then 3. Step 3 starts only if step 2 produced a report on both clusters (PASS or FAIL, not BLOCKED).

## 13. Owner approvals needed before running

| Action | Cluster | Recorded in |
|---|---|---|
| Re-create a private Artifact Registry repo and push AX `4b7bf6f` images and the lab image | project | A's run dir `ar` (removed by A's teardown, which runs after B's) |
| Redeploy AX `4b7bf6f` (`make deploy`, snapshot prefix per L-031) | A | A's run dir |
| Create collector, pool and tenant namespaces, RBAC, WorkerPool | A, B | each cluster's run dir |
| Create cluster B | project | B's run dir `cluster` (informational) |
| Install Substrate v0.6.0 and AX on B | B | B's run dir |
| Any IAM for B (none if Q3 confirms the shared principal) | project | B's run dir `iam` |
| Cordon and evict the worker Pod on B | B | step 3 record |
| Delete cluster B after teardown | project | outside `teardown.sh`; verified with a read-only listing |

## 14. Evidence, ledger and teardown

### 14.1 Evidence per run

Per tenant run: the collector writes `observations.json` and `evidence/` in the collector Pod; the runner copies them to `artifacts/runs/<run_id>/`, builds the C5 report with `buildReport()` using `cases.multi.json` expectations, the cleanup status from teardown and these extra limitations (single collector identity, section 4; one operator identity for the AX API; gVisor only; two clusters in one project), writes checksums, then `exportRun(run_id, { outRoot: "docs/evidence" })`. Per set: the aggregate files from section 9.5.

`buildReport()` labels mode `scripted` as "local integration run" and the markdown says "Local core". For profile `ax` both are wrong. The fix is to choose the label by profile (`ax`: "AX task (scripted driver)", status line "AX lane"), local wording unchanged, with a unit test.

### 14.2 Ledger

A new evidence set **XM** in `CLAIM_LEDGER.md` ("Evidence sets" table): AX `4b7bf6f`, Substrate v0.6.0 `d3f2363`, lab image digest and commit, `set_id`s, per-run exports in `docs/evidence/<run_id>/`, aggregates in `docs/evidence/<set_id>/`. A new section "Optional AX lane, many tenants and two clusters (set XM)". IDs C-80 to C-109 are reserved here (the ledger currently ends at C-70); a row is added only when its evidence exists, one row per result:

| ID | Result |
|---|---|
| C-80, C-81, C-82 | MT-W01 on A at c = 1, 2, 4 (one row per configuration, citing every tenant run's export) |
| C-83 | MT-ISO on A, four tenants |
| C-84, C-85, C-86 | Timing on A at c = 1, 2, 4 (EXECUTED, measured; no PASS or FAIL) |
| C-87 | Skew check refuses a mismatched pair (EXECUTED locally, synthetic inputs) |
| C-88, C-89 | Skew check on A, on B (versions recorded) |
| C-90, C-91 | MC-W01 on A, on B |
| C-92, C-93 | MC-XREACH from A, from B |
| C-94 | All-clusters view status for step 2 |
| C-95, C-96 | Timing of MC-W01 on A, on B |
| C-97 | MV-PORT |
| C-98 | MV-DRAIN |
| C-99 | spare |
| C-100 to C-109 | DOCUMENTED vendor statements only (doc path at a pinned SHA; never EXECUTED, never compared with lab numbers) |

"Claims that must not be made" gains: no percentile except p50 and p90 from an XM configuration with n ≥ 30; not "AX isolates tenants" beyond the probed targets, one sandbox class and one collector identity; not "work moves between clusters" unless C-97 is PASS; no comparison with vendor scale statements.

### 14.3 Teardown per cluster

`teardown.sh <cluster-run-dir>` in default mode, B first, then A. It deletes exactly the listed names: AX tasks and workspaces per atespace, egress policies and atespaces, tenant namespaces with their Role and RoleBinding, the collector and pool namespaces, AX on that cluster with its cluster-scoped objects, the cluster's snapshot prefixes, and (A only) the Artifact Registry repo; then it diffs against that cluster's `pre-snapshot.json`. On A it leaves Substrate v0.6.0 and the transfer service account in place, as today. B's `pre-snapshot.json` is taken after B's Substrate install, so the install is not in B's diff; it goes away when cluster B is deleted (section 13). Afterwards, as in run 3, read-only queries independent of the script's own report confirm each listed resource is gone.

## 15. Open questions for EGM review

1. **Single collector identity per cluster** (section 4). It weakens per-tenant collector independence: evidence separation rests on code, not credentials, and cross-tenant reads through the router cannot be tested. The reason is that no change to A's router allowlist is approved. Is this acceptable for C-80 to C-83, and is the limitation wording strong enough?
2. **Tenant definition.** A tenant here is an atespace plus a namespace plus an Emulate workspace, all driven by one operator identity. Is that a meaningful tenant without per-tenant AX API identities, given L-034?
3. **Shared transfer principal.** The recorded IAM member names no cluster, so B's `ate-api-server` may impersonate the same transfer account and reach the same bucket as A. Accept that (no new IAM) or require a separate account for B? Either way, should it be reported as a cross-cluster data path?
4. **Network between clusters.** Do A and B share a VPC? If yes, plain Pods can reach the other cluster's pod IPs and MC-XREACH's collector probe is meaningful; if no, it is trivially refused and should be labelled so.
5. **Capacity numbers.** R = 3 workers, added container requests (100m, 256Mi) and c ≤ 4 are estimates from L-047 and the manifests. Is changing the emulators' requests acceptable, given it differs from run 3's template?
6. **Gateway log attribution.** Does the egress gateway's access log name the source actor? If not, MT-ISO must stay one probing tenant at a time (as designed); if yes, probes could run concurrently.
7. **Timing independence.** Tasks in one round share a submit instant and workers. Is n counted in tasks with the round count stated enough, or should n count rounds (30 rounds per level, 120 tasks at c = 4)?
8. **Changed tooling path.** Shared port-forwards make step-1 numbers not comparable with C-70. Keep run 3's per-call port-forwards for one c = 1 configuration as a bridge?
9. **MV-DRAIN fairness.** Is holding `chat.postMessage` in the coordinator-owned proxy a fair way to open the S2 window, and is the non-reposting coordinator the right boundary between harness and system?
10. **MV-PORT scope.** If no import path exists at the pinned SHAs, is BLOCKED the right label, or should the design try an undocumented route? This draft says no.
11. **Report wording.** Is choosing the mode label and status line by profile in `report.ts` the smallest acceptable change, or should AX reports keep the current text with a limitation line?
12. **Zone and set size.** May B's zone appear in public files (this draft keeps it private as `<zone-b>`), and is a 30-ID reserved block right?
