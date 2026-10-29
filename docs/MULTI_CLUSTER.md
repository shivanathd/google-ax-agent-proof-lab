Status: accepted at EGM cap after round 5 (owner, 2026-10-29); build in progress.

# Multi-tenant and two-cluster test design (AX lane, steps 1 and 2)

This is a test design, not a result. Nothing in it has run. It extends the optional AX lane (`profiles/ax/`) with two owner-approved steps, many tenants on cluster A and the same case on clusters A and B, and records the answer to the third: its portability question is answered DOCUMENTED from a read of the pinned protos (9.1), and its eviction test moves to a follow-up design (9.2). Every PASS or FAIL planned here comes from an independent collector and the supplied evaluator, never from AX task phase (L-006).

This file says what is tested, what is asserted and what may be claimed. How it is built, run, parsed and torn down is in the build plan, [`MULTI_CLUSTER_BUILD.md`](MULTI_CLUSTER_BUILD.md) ("build §n" below), which is verified by its phase gates and dry run, not by document review.

Sources: [`profiles/ax/README.md`](../profiles/ax/README.md), [`profiles/ax/RESULTS.md`](../profiles/ax/RESULTS.md), the AX lane code under `profiles/ax/`, `src/reports/`, `src/config/endpoints.ts`, the supplied evaluator in `docs/spec/active/2026-10-28-agent-proof-lab/evals/`, [`LEARNINGS.md`](LEARNINGS.md) L-006 to L-012, L-019 and L-030 to L-057, [`CLAIM_LEDGER.md`](CLAIM_LEDGER.md) C-60 to C-70, [`CONTRACTS.md`](spec/active/2026-10-28-agent-proof-lab/contracts/CONTRACTS.md) C4 and C5, and the two infrastructure run dirs (section 3). Upstream files are cited by repo-relative path at the pinned AX `4b7bf6f` and Substrate v0.6.0 `d3f2363`.

## 1. Problem statement

AX run 3 (set X, C-60 to C-70) showed one tenant on one cluster with one worker. It says nothing about tenants that share workers, about the same case judged on two clusters, or about work that moves or is evicted mid-run. The owner approved three steps. This design answers the first two with lab evidence and records the third's answer from the protos:

1. Do tenants that share one cluster and one worker pool keep their egress and their evidence apart, and what are AX's resume-to-running latency and a W01-H command's own run time at c = 1, 2 and 4?
2. Does the same case reach the same verdict on two clusters when each is judged on its own?
3. Can a suspended task resume on the other cluster? Answered from the pinned protos with no cluster call: no documented path (9.1, DOCUMENTED). Whether an eviction mid-run produces a duplicate business effect is deferred (9.2).

Until steps 1 and 2 run, every AX claim stays at one tenant on one cluster.

## 2. Scope

| Step | What | Cluster(s) |
|---|---|---|
| 1 | Many tenants: up to 4 concurrent tenants, each with its own atespace, namespace and Emulate workspace; isolation; timing with 30 or more planned tasks per configuration | A |
| 2 | Two clusters: the same case on B, with A's half taken from step 1 at c = 1 (8.3); C5 reports per cluster; an all-clusters view that never blends into one green; the warm-up preflight; the network between them as one configuration fact | A and B |
| 3 | Moving work: MV-PORT is one DOCUMENTED result from the proto read (9.1); MV-DRAIN is not designed here (9.2) | none |

Not in scope: microVM sandboxes, the default AX runner, a live model, any change to Substrate on A (router allowlist included), any IAM change, any scale claim. Vendor scale statements from Google AX or Agent Substrate docs may enter the ledger only as DOCUMENTED, with the doc path at a pinned SHA, and are never compared with a lab measurement.

## 3. Starting point and ownership

- **Cluster A** ran AX run 3: AX `4b7bf6f` on Substrate v0.6.0 (`d3f2363590a1`), 2 × c3-standard-4, amd64, GKE 1.36.4, gVisor, one worker. Run 3 was torn down on 2026-10-29 (`RESULTS.md`, "Teardown"). The same day the owner approved restoring the lane on A and creating cluster B.
- **A's infrastructure run dir `41dc91c3`.** Not owned: Substrate v0.6.0 and A's snapshot transfer service account with its three grants. Owned: AX `4b7bf6f` in `ax-system` with its cluster-scoped objects, the private Artifact Registry repo with the AX and lab images, one snapshot prefix, and the collector namespace `apl-ax-6882d106` (ServiceAccount and Pod `apl-collector`, Floci, Emulate, WorkerPool `apl-ax-pool`). The namespace keeps run 3's name so the SPIFFE ID already in A's router allowlist still applies.
- **B's infrastructure run dir `34c8957e`.** Owned: cluster B (with a project-level `pre-snapshot.json` taken before B existed), its snapshot bucket with four bindings (two for the `ns/ate-system/sa/ate-api-server` Workload Identity principal, two for A's transfer account), Substrate v0.6.0 (its router allowlist lists `apl-ax-6882d106/apl-collector`; it uses A's transfer account) and AX `4b7bf6f`. `versions.json` records that the versions match A's. This design changes none of B's IAM.
- **Step run dirs**, one per step and cluster, own every tenant object of that step and are torn down at the step's end. **Set dirs** hold plans, tenant-run material and log extracts and own nothing. After the last step, B's infrastructure run dir is torn down, then A's, each followed by an independent read-only check (build §8, §13).
- **Known AX behaviour this design plans around:** tasks are created suspended and need `ax resume` (L-047); every task is a new template, and a new template gets a golden actor that takes worker capacity (L-047, 7.3); AX templates set no `workerSelector`, so tasks land on any pool (L-039); `ax suspend` and `ax delete task` send no SIGTERM (L-048, C-62, C-63); `ax get task` returns `spec.env` in clear to any AX API caller (L-034, C-69); the v0.6.0 router serves actors only over mTLS to allowlisted SPIFFE IDs (L-045); names outside a task's egress policy fail DNS in the sandbox, and egress refusals are judged from the egress gateway's log, not from probe byte counts (L-049); run 3 timing measured operator tooling more than AX (L-050); `/apl/result` serves only the runner's `result.json` (exit code, start and end times, command hash; `profiles/ax/runner/main.go`), and only after the command exits.

## 4. Design rules

1. **Evidence exactly as before.** Every result is an independent-collector C4 bundle, judged by `evaluate_ax.py` and by `generateReport()` (`src/reports/artifacts.ts`, with its checksum check (L-022) and containment check (L-052)), with one C5 report per tenant and per cluster, exported with `exportRun()` to `docs/evidence/<run_id>/`. No report covers two tenants or two clusters. Every expectation lives in one table, `profiles/ax/cases.ax.json` (6.2). A bundle's checksums are written when it is copied off the collector, so the first report already checks them (build §4.3). Each result gets a claim ID starting at C-80 (11.2).
2. **Phase is not outcome.** `ax_task_phase` stays under `recorded_not_asserted` in every case (L-006).
3. **Absent is not zero.** An observation the collector could not make is absent with a reason (C4), which makes its assertion UNKNOWN.
4. **One clock per interval.** No timing interval subtracts a timestamp taken on one machine from one taken on another (L-050).
5. **Pre-registration.** Before each step runs, its expectations (7.5, 8.6) are committed to the "Expected before running" table of `LEARNINGS.md`.
6. **Identifiers stay private.** Project, cluster names, zones, contexts, registry, buckets, accounts and IPs live only in gitignored `private-runs/ax/`. Public files use placeholders (`<project>`, `<cluster-a>`, `<cluster-b>`, `<zone-b>`, `<registry>`, `<snapshot-bucket>`).
7. **Collector values, not operator values.** An assertion uses only what the collector computes from system records: Emulate, Floci, the router, and files of system-written records the operator copies verbatim (the egress gateway's access log, as for C-67). A value the operator computes or reads from a CLI is recorded, not asserted, as C-69 was. Records the in-sandbox coordinator writes (ledger exports, the probe's self-report) are subject-side, and every report that uses one says so.
8. **The lab image is rebuilt.** The changed coordinator and collector code runs from the lab image, so the image is rebuilt from the committed tree, pushed by digest and recorded in both clusters' `versions.json`; every bundle's `candidate_revision` must name that commit (build §3, phase 6).
9. **One cluster driver.** `profiles/ax/multi.ts` makes every cluster call; `index.ts run()` returns BLOCKED and points at it (build §1).

## 5. Collector identity: one per cluster

On Substrate v0.6.0 the collector reads a task's `/apl/result` only through the router, over mTLS, with a SPIFFE ID in `--ingress-allowed-spiffe-ids` (L-045). A's allowlist has exactly one lab ID, `apl-ax-6882d106/apl-collector`, and changing it is not approved; B's lists the same ID. So each cluster has one collector Pod with that identity, owned by its infrastructure run dir, and one Secret, `collector-env-tenants`, holding one key per tenant run of the current configuration. One collector process runs per call, with that tenant's environment and its own output directory. The collector never calls the Kubernetes API, and no ingress reaches it (build §6).

**What this weakens, stated plainly.** One collector process holds every tenant's reader token and S3 key on its cluster. That is a smaller change from run 3 than it looks: Floci accepts any access key (L-037) and Emulate accepts any valid token (L-019), so per-run credentials were labels in run 3 too, and the boundary was which process knows which URL. Separation of tenants' evidence rests on the collector's code (one environment and one output directory per bundle) and is checked by `foreign_marker_count` (6.3). Whether a second, separately allowlisted collector identity could read another tenant's results through the router cannot be tested, because each cluster has one identity. Every report from this design carries that limitation (11.1).

## 6. Cases and keys

### 6.1 Bundles per tenant-run kind

| Tenant-run kind | Tasks | Bundles reported | Rolls up into |
|---|---|---|---|
| Actor probe (step 1, A, before c = 1) | `p1`, `p2` | one F3-A1 per task; no MT-W01 | its own "actor probe" row; no timing |
| Configuration tenant run (step 1 at c = 1, 2, 4; step 2 on B, and on A only if A is rerun (8.3)) | warm-up `00`, then the counted tasks | one F3-A1 per task; one MT-W01 per tenant run | tenant row (warm-up listed separately, excluded) |
| MT-ISO tenant run (step 1, A, after c = 4) | `iso`, `tgt` | one MT-ISO per tenant run | MT-ISO row |
| Controls (6.4) | a second observation of one tenant run; the planted-control task `ctl` | none: kept in the set dir, never reported or ledgered | none |

Roll-up uses `aggregate()` from `report.ts` (FAIL > UNKNOWN > BLOCKED > NOT_RUN > PASS): tenant rows over their task reports and MT-W01 report, configuration rows over tenant rows, cluster rows over configurations and other cases. One absent fact makes that task and its tenant row UNKNOWN. A planned bundle with no report is NOT_RUN.

**6.2 Expectations.** Each W01-H task is judged by F3-A1 as it stands (`ticket_count` 1, `receipt_count` 1, `receipt_matches_request` true, `completion_reply_count` 1, `command_exit_code` 0). Two cases are added to `cases.ax.json`, and its `recorded_not_asserted` list grows to `ax_task_phase`, `step`, `concurrency`, `tasks_planned`, `tasks_timed`, `probe_self_report_reached_count`, `foreign_secret_in_task_count`:

```json
"MT-W01": {"profile": "ax", "note": "steps 1 and 2: one per tenant run after its last round", "expected": {"foreign_marker_count": 0}},
"MT-ISO": {"profile": "ax", "note": "step 1, own tenant runs after c = 4", "expected": {"cross_tenant_upstream_count": 0, "allowed_control_reached": true, "foreign_marker_count": 0}}
```

### 6.3 Asserted keys

| Key | Meaning |
|---|---|
| `foreign_marker_count` | Items in the tenant's own Slack channel and own Floci objects (the probe's `isolation.json` excluded) that carry a marker of any other registered tenant run: its run ID, a task name, or a token whose SHA-256 is in its hash list. The collector gets IDs, names and hashes, never other tenants' tokens. With no other registered tenant run the key is absent ("no foreign tenants"), never 0. |
| `cross_tenant_upstream_count` | Gateway access-log entries in the probe window that record an upstream other than this tenant's own Emulate and Floci addresses. Every other upstream counts, whatever it names. |
| `allowed_control_reached` | The window holds a gateway entry whose upstream is this tenant's own Emulate, so the probe ran under a working policy and the log extract caught it. |

**What MT-W01 guards against.** A marker of another tenant run reaching this tenant's own evidence, either through the lab's evidence path (the collector or the in-sandbox coordinator writing or relaying another tenant's data into this tenant's channel or objects) or through workspace or environment leakage across tasks (a workspace or env that carries another tenant's files or values). It looks only at this tenant's own Slack channel and Floci objects; reads through the AX API (L-034) or the router (section 5) are outside it.

### 6.4 Assumptions and controls

- **The gateway assumption.** `cross_tenant_upstream_count` sees only traffic that leaves the sandbox through the egress gateway. The design assumes every connection a gVisor actor makes does (L-049); a path that bypassed the gateway would be invisible to this key, and the claim boundary says so (11.3). **The tested probe set.** For HTTP the gateway routes by the Host header, not by the dialled address, so an HTTP probe is an (address, Host, port) triple: other tenants' Emulate and Floci by ClusterIP and pod IP, each with that tenant's own Host, and the router by ClusterIP with its Host. Only the raw TCP probes, the worker Pods by pod IP, are address-based. A foreign address sent with the tenant's own Host is not tested. By-name probes fail DNS in the sandbox and never reach the gateway (L-049); they stay in the self-report only.
- **Controls, which must be able to fail.** The marker control runs once on each cluster for the whole experiment, before that cluster's first counted MT-W01 is observed (A in step 1 at c = 1, B in step 2): that tenant run gets one extra observation, with a markers file that also lists its own first task name, and its `foreign_marker_count` must be at least 1. The egress control runs once on each cluster that runs MT-ISO (A in this design), before the first MT-ISO probe: one extra isolation task runs under a lab policy that also allows one foreign tenant's Emulate, and its `cross_tenant_upstream_count` must be at least 1. Neither control's bundle is reported. A control that does not fire withdraws the results that depend on its detector (stop rule 1).
- **Self-report against the log.** If the probe's self-report says it reached a foreign target while the log shows no cross-tenant upstream, or the log extract is incomplete, `cross_tenant_upstream_count` is absent with that reason and the tenant's MT-ISO is UNKNOWN. A count above 0 is FAIL whatever the self-report says.

**6.5 Recorded, not asserted.** `probe_self_report_reached_count`, from the probe's JSON lines in its own bucket, is the subject's self-report. `foreign_secret_in_task_count`, an operator string search of `ax get task` against other tenants' secrets keeping only the count, is an operator value (rule 7), as C-69. `step`, `concurrency`, `tasks_planned`, `tasks_timed` and `ax_task_phase` are context. The collector replaces every IP address in what it writes with a role placeholder (build §10).

### 6.6 Timing

Timing is recorded, never asserted, and bundles carry none: raw values go to the set dir and the summary to `docs/evidence/<set_id>/timing.json` (build §12).

| Key | Clock | Meaning |
|---|---|---|
| `server_resume_to_running_ms` (headline 1) | ax-server log | AX control-plane latency from "resuming actor" to "task successfully reconciled and running". It includes AX's workspace readiness poll (build §12). When the running line reports `workspaceReady=false` the value is absent: the poll timed out and the line does not mean ready. |
| `command_duration_ms` (headline 2) | the runner in the sandbox | `ended_at − started_at` from the task's `result.json`: the command's own time. |
| `submit_to_result_ms` | operator | tooling context only, reported beside the headlines with the measured exec round trip |
| `resume_spread_ms` (per round) | ax-server log | latest minus earliest "resuming actor" of the round's tasks: the overlap actually reached |

A task is timed for a headline when that headline is present. Each configuration reports n, p50 by nearest rank and max per headline. When fewer than 30 tasks are timed it reports the actual n and says so. No other percentile, no interval, and no comparison with C-70.

## 7. Step 1: many tenants on cluster A

**7.1 Layout per tenant and one shared pool.** Each tenant run gets atespace and namespace `apl-ax-<tr8>`, its own Floci and Emulate (one Emulate workspace, its own fake secrets), its own egress policy allowing only its own Emulate (8080, 8081) and Floci (4566), attached after the actor exists and before `ax resume` (L-047), and its key in the collector Secret. Its emulators are scaled to 0 after its last bundle, and its objects stay until the step's teardown. Each configuration gets fresh tenant runs. Every tenant run of the experiment is registered, so later runs check for its markers.

All tenants share the infrastructure-owned pool `apl-ax-6882d106/apl-ax-pool` (gVisor), set to R = 3 workers. AX sets no `workerSelector` (L-039), so per-tenant pools would not pin tenants and would add no isolation, while one shared pool lets tenants share workers, which is where isolation matters. With R = 3 and no placement rule, tenants share the pool but need not share a worker, so each task actor's worker (`status.workerAssignment.worker`) is recorded from the actor listing, not asserted (build §4.3). The preflight confirms no other WorkerPool exists on A (RESULTS §3.2).

**7.2 Configurations.** A round runs its c tasks together: the c policies are attached as the actors appear, the c resumes are issued in parallel and the c results polled in parallel, then each bundle is observed and the c tasks are deleted. c is what was submitted together; the overlap reached is measured (`resume_spread_ms`) and reported as p50 and max beside c.

| c | Tenants | Rounds | Planned tasks (n) | Tasks per tenant run |
|---|---|---|---|---|
| 1 | t1 | 30 | 30 | 30 |
| 2 | t1, t2 | 15 | 30 | 15 |
| 4 | t1 to t4 | 8 | 32 | 8 |

Each configuration starts with one warm-up round (`00`), reported separately and not counted.

**7.3 Actors and capacity.** AX gives every task its own ActorTemplate (`taskTemplateName()` and `ReconcileDelete()` in `internal/controller/reconciler.go`), so every task is a new template. G, the golden actors a new template adds (L-047 saw one), and L, the actors left after a task is deleted, are not known. The actor probe tenant run measures both and records whether a leftover actor still holds a worker slot. After every round's deletes, in every configuration, the runner lists each tenant atespace, records any leftover actor or template in the step run dir, deletes it and marks it removed. So leftovers cannot accumulate across 30 rounds. Actor counts are recorded, not asserted, and no stop rule fires on them; capacity stops (stop rule 4) still apply.

Capacity, to be checked, not assumed: 2 × c3-standard-4 is 8 vCPU and 32 GiB before system reservations, and Substrate (11 pods) and AX also run there with requests the repo does not record. Tenant emulators request 100m CPU and 256Mi per container (limits as in `emulators.yaml`). The infrastructure run's own idle Floci and Emulate are scaled to 0 before step 1, and finished tenants' emulators are scaled to 0, so at most 4 tenants hold requests at a time. During MT-ISO, with R = 3 workers of run 3's template (request 1 CPU and 4Gi), requests total about 0.8 + 0.5 (collector) + 3 = 4.3 vCPU and 2 + 0.5 + 12 = 14.5 GiB. Actor slots: a 3-CPU worker refused a fourth 1-CPU actor (L-047), so R = 3 gives about 9 slots for at most 4 task actors plus their golden actors. c = 4 and MT-ISO may still end NOT_RUN (capacity). Before each configuration a read-only preflight checks that node allocatable minus requested covers its requests, and the warm-up round must schedule all c tasks and pass 8.2.

**7.4 Isolation (MT-ISO).** After c = 4, four fresh MT-ISO tenant runs. While all four namespaces exist, each tenant t_i in turn runs one `isolation` task while tenant t_j, j = i mod 4 + 1, runs one `term`-mode task that makes no egress, as the router and worker target. No other task runs, so every gateway entry in the window comes from the prober; the log's `actor` field should agree, but the design does not rest on it. The probes are the tested set of 6.4, the allowed control (the tenant's own Emulate) and run 3's probes. HTTP probes ask for a path their target answers with 404, because the gateway logs request legs only at status ≥ 400 (or a response flag) plus a 1% sample, and raising that level would change Substrate (build §9). The verdict comes from the gateway log; the probe's own JSON lines are kept as the self-report. `foreign_secret_in_task_count` is recorded. Cross-tenant disclosure through the AX API is not testable with one operator identity (L-034), so it stays a disclosed limitation (C-69).

**7.5 Pre-registered expectations (step 1).** Actor probe: G = 1, L = 0 or 1, recorded. F3-A1: PASS for every counted task at c = 1, 2 and 4. MT-W01 at c = 1, 2 and 4: PASS. MT-ISO: PASS for each of the four tenants. The capacity estimate of 7.3 predicts that c = 4 and MT-ISO fit; a NOT_RUN (capacity) there is recorded as a missed prediction, not as FAIL. Both controls fire. Timing, recorded and not asserted: `server_resume_to_running_ms` p50 at c = 1 about 2.1 s (the value L-050 saw in run 3's ax-server log), and at c = 4 a p50 above c = 1's. Neither is a PASS or FAIL, and no claim compares XM timing with C-70.

## 8. Step 2: two clusters

**8.1 Cluster B.** B exists (section 3): same project, zone `<zone-b>`, 2 × c3-standard-4, amd64, no autoscaling, A's GKE version, Workload Identity on. Substrate v0.6.0 and AX `4b7bf6f` were installed on B with snapshots in B's own bucket and the collector in the router allowlist, as recorded in B's run dir (install settings: build §4.1). Images come from the same private repo by digest. The collector namespace and pool are added to B before step 2.

**8.2 Warm-up preflight (L-030).** The warm-up round of each configuration on each cluster is the protocol preflight. Its actor listings must decode every actor with a state other than `UNSPECIFIED` (the L-030 symptom), and no `ax` or `kubectl ate` call in it may return `Unimplemented` or an unmarshal error. A failure, or a vacuous warm-up (no task ran or no actor was listed), leaves that configuration and every later one on that cluster BLOCKED, and earlier configurations stand (stop rule 1). A warm-up that could not schedule its tasks is capacity (stop rule 4).

**8.3 Same case on each cluster.** Step 2 runs on B only: one tenant, c = 1, 30 tasks plus a warm-up round, giving 30 F3-A1 reports and one MT-W01 report recording `step` 2. A's half is step 1's c = 1 configuration on A (30 F3-A1 reports and its MT-W01), the same case at the same c, so rerunning it would add time and no information. The reuse holds only if A's `versions.json`, re-read before step 2, is identical to the one recorded for step 1, and both clusters' `versions.json` name the same lab image digest (build §4.6). Otherwise A is rerun first, in the same session and exactly as B. B's foreign markers are every earlier registered tenant run: step 1's on A, and A's step 2 tenant run if A was rerun.

**8.4 The all-clusters view.** Built from per-bundle reports by the roll-up only (build §11). A's row is step 1's c = 1 configuration unless A was rerun (8.3). The two clusters reach the same verdict when their cluster rows have the same status, each rolled up from its 30 counted F3-A1 reports and its MT-W01 report. The overall line always names each cluster, for example `all clusters: FAIL (A PASS, 31 reports; B FAIL, 31 reports)` (30 F3-A1 plus MT-W01, warm-up excluded). There is no single green banner: even all PASS reads `all clusters: PASS (A PASS, 31 reports; B PASS, 31 reports)`. Any FAIL anywhere makes the overall status FAIL. The view compares identity across clusters from each `versions.json` (AX commit, `ax-server` digest, lab image digest, Substrate commit) and says "not comparable" next to the statuses if they differ.

**8.5 The network between the clusters (configuration fact, not a test).** Observed by read-only `gcloud` queries on 2026-10-29: both clusters are in the same VPC and subnet, VPC-native, on Dataplane V2, with public control-plane endpoints; their pod ranges are distinct and their Service ranges identical; the VPC firewall admits ingress to each cluster's nodes from that cluster's own pod range and from the VPC's internal range, which holds the node addresses but neither pod range. Inferred from those facts, not observed: the other cluster's ClusterIPs name local Services or nothing; pod-to-pod traffic between the clusters is refused before any TLS while it keeps the pod address (GKE's default for private destinations, not verified here); and traffic leaving with a node address is admitted on every port. This enters the ledger as one row labelled "configuration fact, not a test", which states the observed facts as facts and the inferences as inferences. No verdict reads it, so it is not re-checked. No cross-cluster probe runs, so the mTLS boundary between the clusters is not exercised.

**8.6 Pre-registered expectations (step 2).** A's `versions.json` is unchanged since step 1 and B's matches it, so A's half is reused. Warm-up preflight passes on B. F3-A1 PASS for every counted task, and MT-W01 PASS, on B; the all-clusters view reads PASS for both clusters.

## 9. Step 3: one DOCUMENTED result and a deferred design

**9.1 Suspend on A, resume on B (MV-PORT): DOCUMENTED.** MV-PORT asks whether the pinned protos document an operation that creates or resumes a task or actor from a snapshot made in another control plane. The read, done read-only during review rounds 3 and 4 (file, service and field: build Appendix B), found none:

- AX `4b7bf6f`: service `AX` is Task, Workspace and Model CRUD plus suspend and resume, with no import, export, snapshot or restore RPC.
- Substrate `d3f2363`: service `Control` has no import or restore RPC. An actor is seeded from a snapshot only through a tag, and a tag can only capture an actor of its own control plane.
- Substrate `d3f2363`: the object-store interfaces are plugin APIs that Substrate calls, keyed by a storage URI; neither registers a snapshot as an actor or a tag in another control plane.

Result: no documented cross-cluster import path at the pinned SHAs. MV-PORT is one ledger row (11.2) labelled DOCUMENTED (source read at the pinned SHAs), citing the read as recorded in `docs/RESEARCH.md`; no bundle, task mode or cluster call. It is not BLOCKED, because no execution was planned and then stopped: the answer is a read of the source, which is what DOCUMENTED records. No undocumented route is tried: copying snapshot objects or editing Substrate records would test the lab's copy, not the product.

**9.2 Eviction mid-run (MV-DRAIN): deferred.** MV-DRAIN, S2 on AX with one worker Pod evicted mid-run, is not designed here. A follow-up design, written after steps 1 and 2 have run, must answer what round 3 found. Duplicates must be counted from effects outside the sandbox (thread replies, S3 receipt objects, stimuli), because the eviction reverts the workspace and its ledger (L-048), so every ticket in a post-eviction ledger export looks new; the revert itself must be recorded as a fact, not inferred. Its run flow (guarded commands, the actor-to-Pod lookup, before and after phases merged into one bundle, a completion condition, an uncordon on every exit) is its own. It gets its own EGM review. Until then this design has no MV-DRAIN case, key, file, expectation, ledger row or stop rule.

## 10. Stop rules

Each rule stops the current step, keeps the evidence, runs teardown for the affected step run dir and reports what ran. A stop records every planned bundle it leaves unobserved as BLOCKED or NOT_RUN with its reason (build §11).

1. Warm-up preflight failed or vacuous on a cluster (8.2): nothing more is applied there; that configuration and every later one on that cluster are BLOCKED, and earlier configurations stand. A control of 6.4 that did not fire: every result on that cluster that depends on its detector is BLOCKED (the marker control: MT-W01 and MT-ISO; the egress control: MT-ISO), and results that do not depend on it stand.
2. A context mismatch anywhere (runner, `gcloud` or `teardown.sh`): stop the set.
3. Any cross-tenant upstream in the gateway log within an MT-ISO probe window (the planted control's window excluded): stop the step. The collector-judged case reports FAIL where it applies; no higher concurrency level runs.
4. Capacity: a warm-up round not fully scheduled, `ResourceExhausted`, or a task unscheduled for 120 s. That level's unobserved bundles and every higher level's are NOT_RUN (capacity); bundles already observed, and the lower levels, stand. An actor probe that cannot schedule makes all of step 1 NOT_RUN. MT-ISO counts as the level after c = 4: if c = 4 stopped, MT-ISO is NOT_RUN with c = 4's reason. If MT-ISO's own tasks cannot be scheduled, its four rows are NOT_RUN and c = 1 to 4 stand.
5. At report time, `evaluate_ax.py` and `generateReport()` disagree on a bundle under the agreement rule (build §11). Reporting stops: nothing from that set is exported or ledgered until the owner resolves it. Teardown has already run and is not affected.
6. At report time, an export or aggregate finding (secret rule or private term): that output is quarantined and no ledger row comes from it; other bundles continue.
7. Teardown not `CLEAN` on a run dir: no later step starts until it is.
8. Any action that would touch something not listed in a run dir (A's router allowlist, another pool, any IAM), or a deployed gateway access-log config that differs from the pinned one: stop and ask the owner.
9. Step order: 1, then 2.

## 11. Claim boundaries

**11.1 Limitations on every report.** One collector identity per cluster (section 5); one operator identity for the AX API; a tenant is a namespace, an atespace and an Emulate workspace driven by that one identity, not a separately authenticated AX tenant (L-034); gVisor only; two clusters in one project and one VPC; isolation judged only on traffic through the egress gateway (6.4); isolation verdicts rest on a gateway-log extract the operator copies verbatim into the set dir's `egress-<task>.json`, which stays private, and the public copy in the MT-ISO export is redacted (addresses replaced by roles), so the verdict cannot be re-derived from public files; B's Substrate uses A's snapshot transfer identity; the Workload Identity principal `ns/ate-system/sa/ate-api-server` is the same identity on both clusters because both are in one project, so its direct bindings on B's bucket also apply to A's ate-api-server; one collector Secret holds every tenant's fake credentials on its cluster.

**11.2 Ledger.** A new evidence set **XM** in `CLAIM_LEDGER.md`: AX `4b7bf6f`, Substrate v0.6.0 `d3f2363`, lab image digest and commit, `set_id`s, per-bundle exports in `docs/evidence/<run_id>/`, aggregates in `docs/evidence/<set_id>/`, under a new section "Optional AX lane, many tenants and two clusters (set XM)". IDs start at C-80 (the ledger ends at C-70) and are taken in order as results are recorded; no block is reserved. One row per result, added only when its evidence exists. Planned, in expected order: (1) MV-PORT, DOCUMENTED (source read at the pinned SHAs), "no documented import path at the pinned SHAs", citing `RESEARCH.md` (9.1), recordable first because its evidence is the proto read; (2) step 1 on A at c = 1, 2 and 4, one row per configuration, citing every task and tenant export; (3) MT-ISO on A, four tenants; (4) timing on A at c = 1, 2 and 4 (EXECUTED, measured; no PASS or FAIL), both headlines with their n and the measured resume spread; (5) the network between A and B, "configuration fact, not a test" (8.5); (6) step 2 on B, one row citing its 30 F3-A1 exports and its MT-W01 export (and the same for A if A was rerun); the all-clusters status for step 2, naming A's half as the step 1 c = 1 row when it is reused; and timing of step 2 on B (and on A if rerun). A vendor statement, if added, takes the next free ID as DOCUMENTED (doc path at a pinned SHA), is never EXECUTED and is never compared with a lab number.

**11.3 Claims that must not be made.** The ledger's list gains: no percentile other than p50, no interval, and no n larger than the actual timed n, from an XM configuration; neither headline as end-to-end task latency (one is AX control-plane latency, the other the command's own run time); each configuration's raw p50 and max may be shown side by side, but no claim that either headline rises or falls with c; no concurrency claim beyond the measured resume spread; "tenants shared a worker" only for tenant pairs whose task actors were observed on the same worker in the same round, and otherwise only "tenants shared a pool" (7.1); not "AX isolates tenants" beyond the probed (address, Host, port) triples and raw TCP addresses, probed one tenant at a time and not under concurrent load, traffic through the gateway, one sandbox class and one collector identity; from MT-W01, no more than that no marker of another tenant run appeared in this tenant's own Slack channel and Floci objects (6.3); not "the clusters cannot reach each other" (a configuration fact, not a test); not "work moves between clusters" (MV-PORT: no documented import path); nothing about eviction (9.2); no comparison with C-70 or with vendor scale statements.

## 12. Owner approvals

| Action | Status |
|---|---|
| Private Artifact Registry repo and AX images; AX on A; collector namespace on A; cluster B with its bucket and bindings; Substrate and AX on B | done 2026-10-29, recorded in the infrastructure run dirs |
| Push the rebuilt lab image by digest (build phase 6) | needed |
| Resize B's node pool to 0 until build phase 6 passes, then back to 2 | to 0: done 2026-10-29; back to 2: needed |
| Collector namespace, Pod, NetworkPolicy and pool on B; pool at R = 3 on both clusters; A's collector Pod recreated and its idle emulators scaled to 0 | needed |
| Per-step tenant namespaces, collector Secret, AX tasks, removal of leftover golden actors | needed |
| Delete cluster B, its bucket with its four recorded bindings, and its disks | needed; operator-run `teardown.sh` |
| Tear down A's infrastructure run dir (AX in `ax-system`, the collector namespace, the snapshot prefix, the Artifact Registry repo), leaving Substrate and A's transfer account | needed; operator-run `teardown.sh` |

## 13. Alternatives considered

- **Per-tenant collector identities on B.** B's allowlist could list one SPIFFE ID per tenant, so cross-tenant reads through the router could be tested there. Not chosen: it is a new test outside the approved steps and needs a per-tenant collector setup. It is the obvious follow-up if the owner wants the router boundary tested.
- **Per-tenant WorkerPools.** No isolation gain, since AX sets no `workerSelector` (L-039).
- **Summary keys over all tasks.** Dropped: they turned an absent fact into FAIL. One F3-A1 bundle per task keeps absent as UNKNOWN.
- **A cross-cluster probe instead of a configuration fact (decision 3).** Node-address traffic is admitted on every port, so a meaningful probe needs a hostNetwork Pod or a route the lab does not run, and no approved step asks for it. The fact is recorded once instead.
- **A continuous pipeline of c tasks in flight instead of rounds (decision 6).** It would raise overlap but mix rounds, deletions and golden-actor cleanup, and make each task's gateway and server-log window ambiguous. Rounds keep each window clean, and the measured spread shows how much overlap they reach.
- **Timing from the operator clock or from Substrate events (decision 7).** An operator clock end to end is what L-050 rejected. Substrate actor events would need a second log parser for no extra clarity. The ax-server log gives control-plane time, `result.json` gives command time, each on one clock.
- **Run-dir granularity.** One run dir per tenant run fails because `teardown.sh` diffs each run dir against its own pre-snapshot, so concurrent tenant run dirs would see each other's namespaces as unexpected. One run dir per set would span two clusters, while the teardown guard holds one context. So there is one per step and cluster.

## 14. Risks, cost and duration

- **Cost.** B costs one GKE cluster fee and one bucket at all times, plus, while its node pool runs, 2 c3-standard-4 nodes and their boot disks. A's footprint does not grow. B's node pool stays at 0 until build phase 6 passes; Substrate and AX on B restart when the nodes return, and the warm-up preflight runs after that. This doc quotes no price.
- **Duration** (estimate from run 3, about 20 s per task plus deletion and collection): step 1 about 1.5 hours, step 2 about 25 minutes on B (about 45 if A is rerun), plus teardown. B's nodes are billed from the resize back to 2 until B's teardown, including any pause between steps.
- **Network.** Node-address traffic crosses between the clusters on every port, and both control planes are public. The lab runs no hostNetwork Pod and probes no cross-cluster path.
- **Capacity and gateway sampling.** c = 4 and MT-ISO may end NOT_RUN (7.3). A probe target that answered 2xx would be forwarded unseen, so every HTTP probe draws a 404, and a build gate checks those 404s.
- **One snapshot identity across clusters.** B's Substrate writes and reads snapshots with A's transfer account, so a compromise of either cluster's snapshot path holds a credential that reaches both clusters' snapshot storage. Not changed here (no IAM change); stated on every report (11.1) and removed with B's bindings at teardown.
- **One Workload Identity principal on both clusters.** `ns/ate-system/sa/ate-api-server` is the same principal on A and B, because both clusters are in one project, and it has direct bindings on B's bucket, so A's ate-api-server holds the same access to B's bucket as B's does. No IAM change is made; the bindings are removed with B's bucket at teardown, and every report states it (11.1).
- **B at 0 nodes and back.** A read-only check on 2026-10-29 found B at 0 nodes since 15:36 UTC, with both of its state stores on bound PersistentVolumeClaims: `ate-system/data-postgres-0` (500Gi) and `ax-system/data-ax-postgres-0` (10Gi). If Substrate or AX on B does not come back when the nodes return (a store that does not reattach, a Pod that does not become ready, or a failed warm-up preflight), B's rows are BLOCKED and the owner is asked. A reinstall is not approved.
- **One collector Secret per cluster.** Anyone who can read Secrets in `apl-ax-6882d106` reads every current tenant's reader token and S3 key. They are fake, per-run values, and the Secret is deleted at the step's teardown; stated on every report.
- **Crash recovery.** Every object is recorded before it is created, so a runner crash leaves at worst a listed object that was never created, whose delete fails harmlessly. Recovery is `teardown.sh` on the step run dir plus the independent check. A crashed configuration is rerun from the start with fresh tenant runs, never resumed. Its planned bundles with no report are NOT_RUN.
- **Teardown.** The `gke_cluster` path of `teardown.sh` has only been dry-run; its first real use is B's deletion, followed by the independent check.

## 15. Decisions and review history

1. One collector identity per cluster, one Secret mounted whole, one collector process per call (section 5).
2. A tenant is a namespace, an atespace and an Emulate workspace driven by one operator identity (11.1).
3. The network between the clusters is one configuration fact, not a test, and is not re-checked (8.5).
4. Emulator requests live in the tenant template; `emulators.yaml` is frozen as run 3's record, read only by the BLOCKED `run()` and its existing tests, and the new templates carry its L-032 settings (build Appendix C); idle emulators are scaled to 0 (7.3).
5. The gateway log's attribution is not relied on; only (address, Host, port) HTTP probes and raw TCP address probes are tested; probes draw 404s (6.4, 7.4).
6. Rounds run their c tasks together and report the measured overlap (7.2).
7. Timing: two headlines, ax-server log and `result.json`, p50 and max, actual n (6.6).
8. `multi.ts` is the one cluster driver; `index.ts run()` returns BLOCKED (rule 9).
9. One expectations table, `cases.ax.json`; reports by `generateReport()`; the aggregate only rolls up (6.2).
10. Leftover golden actors are removed after every round; actor counts are recorded, not stopped on (7.3).
11. The lab image is rebuilt from the committed tree and pinned by digest (rule 8).
12. B's zone stays private; only the C-80 start is fixed (11.2).
13. Step 3: MV-PORT DOCUMENTED by the proto read, MV-DRAIN deferred to its own design and review, no IAM change for B (section 9).
14. Design and build plan are separate files; only the design goes to review (round 4, R4-19).
15. Step 2 runs only on B; A's half is step 1's c = 1 result while A's versions and the lab image digest are unchanged, else A is rerun (8.3).

Review history (full findings in the EGM review artifacts):

- **Round 1:** 21 issues plus nits; every PROPOSE FIX accepted.
- **Round 2:** 6 Blockers, 10 Majors; every PROPOSE FIX accepted.
- **Round 3:** 3 Blockers, 17 Majors; step 3 split out (MV-PORT BLOCKED, MV-DRAIN deferred); the other fixes applied.
- **Round 4:** 4 Blockers, 15 Majors. The doc was split into design and build plan (R4-19), and every other PROPOSE FIX and listed nit was applied in the file it belongs to. Removed: the second expectations table (R4-8), `index.ts run()` as a second driver and the `emulators.yaml` byte-identity test (R4-9), and the network baseline and re-check (R4-10).
- **Round 5 (cap):** no Blockers, 10 Majors. Accepted by the owner at the cap with every PROPOSE FIX and listed nit applied: design wording here, mechanics in the build plan. MV-PORT is now DOCUMENTED, and step 2 runs only on B.
