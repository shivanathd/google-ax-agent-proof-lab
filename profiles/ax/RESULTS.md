# AX lane: authorized cluster runs

Run `6882d106-…` on 2026-10-28, on the owner's existing GKE cluster running Agent Substrate. Identifiers are placeholders: `<project>`, `<cluster>`, `<registry>` (a private Artifact Registry Docker repo created for this run), `<snapshot-bucket>`. Raw evidence, the owned-resource list and the pre-snapshot are in the gitignored `private-runs/ax/<run_id>/`.

**Lane status after run 3: each assertion PASS or FAIL on its own, with cluster evidence (§3.3).** Run 3 reinstalled Substrate at v0.6.0 with the owner-approved transfer service account. Per assertion:

- PASS: (2) W01-H as an AX Task (F3-A1); (3) failing command (AX-R1); (4c) worker eviction delivers SIGTERM (logs only); (4d) resume after `ax suspend` keeps the prepare-once marker and the workspace; (5) isolation from inside the sandbox; (5) router identity.
- FAIL: (4a) `ax suspend` delivers no SIGTERM; (4b) `ax delete task` delivers no SIGTERM; (4e) after worker eviction, then `ax suspend` and resume, the result and the marker are lost (L-048).
- Not PASS/FAIL: (5) secrets in `ax get task`, observed (L-034); (6) timing, expectation met.

Runs 1 and 2 below are kept as they were recorded.

**Run 1 status: BLOCKED.** A second attempt (run 2, below) to upgrade Substrate stopped on IAM prerequisites before changing anything. The AX control plane at the pinned commit cannot create anything on the cluster's Substrate. Its Substrate client (`go.ate.dev/substrate v0.6.0`) and the installed Substrate server (wire-compatible with v0.5.0) use the same gRPC service name with renumbered protobuf fields. The first `ax apply` of a Task failed in `CreateActorTemplate` (L-030). No AX task ever started, so items 2 to 6 have no cluster evidence. Nothing is PASS on the cluster.

## 1. Compatibility checklist (observed)

| Item | Expected | Observed | Verdict |
|---|---|---|---|
| AX commit | `4b7bf6f…` | Images built from `4b7bf6f84cac…` with its `make images`; control plane deployed with its `make deploy` | as planned, with one manifest change (below) |
| Substrate version | `6d7b3f4…` or compatible with AX's client | Server answers `ateapi.Control` (the pinned SHA's CLI calls `substrate.ateapi.v1.Control`: `Unimplemented`). A `kubectl-ate` built at tag v0.6.0 decodes actors wrongly (state `UNSPECIFIED`, empty template); one built at v0.5.0 decodes them correctly. AX's client is v0.6.0 | **incompatible** (L-030) |
| Kubernetes | GKE ≥ 1.36 | Server v1.36.4-gke; kubectl client 1.36.6 installed separately | OK |
| PodCertificate APIs | `PodCertificateRequest` and `ClusterTrustBundle` served | Both served at `certificates.k8s.io/v1beta1` | OK |
| Nodes | x86 | 2 × c3-standard-4, amd64, no autoscaling | OK |
| Substrate API | `svc/api` in `ate-system` | Present (headless), `ate-api-server` 2/2 ready | OK |
| Egress gateway | present | `atenet-egress` 1/1 ready; API server flag `--default-egress-gateway-address=atenet-egress.ate-system.svc:443` | OK |
| Router | reachable from a lab Pod | `atenet-router` plain-HTTP port answers any Pod in the cluster with no client identity (`404 actor … not found` for an unknown target) | OK for the collector; see L-035 |
| Image pull | private repo, by digest, no IAM change | All lab images pulled by the nodes from `<registry>` with the existing node identity | OK |
| `spec.config` key with `-` | accepted | `apl-run` accepted; the Task record was stored before provisioning failed | OK |
| Encoded task size | < 31 KiB | 2.6 KiB | OK |

Manifest change: upstream `deploy/ax-server.yaml` hardcodes `AX_SNAPSHOTS_BUCKET` to a bucket outside this project (L-031). It was pointed at `<snapshot-bucket>/apl-ax-<short-id>/`, an existing in-project bucket that Substrate already uses for snapshots, under a run-owned prefix. Nothing was written there because no actor was created.

## 2. W01-H as an AX Task: BLOCKED

| Step | Result |
|---|---|
| `ax apply` Workspace | created |
| `ax apply` Task | `Internal: provisioning task on substrate: ensuring actor template: creating actor template …: grpc: error unmarshalling request: string field contains invalid UTF-8` |
| `ax get task` | phase `Failed`, condition reason `TemplateCreationFailed` |
| Substrate side | AX's `CreateAtespace` succeeded (same message shape in both versions), so an empty atespace `apl-ax-<short-id>` exists; no template, actor or egress policy was created |

Prepared and verified up to the cluster boundary:

- In the lab namespace: Emulate (one workspace, seeded per run) and Floci behind ClusterIP Services, a NetworkPolicy that admits only Substrate's egress gateway and the collector Pod, a run-owned WorkerPool (gVisor, 1 worker), and the collector Pod. All Running; the collector reached Emulate, Floci and the router.
- Egress policy for the task actor, drafted from the Substrate API at v0.6.0: `http` rules for the Emulate host on ports 8080 and 8081 and the Floci host on 4566 only. Never applied, because no actor was created.
- AX-lane endpoint allowlist (`profiles/ax/allowlist.ts`): scheme/host/port tuples whose cluster hosts must be Services in this run's namespace and must resolve to exactly the ClusterIPs pinned when the run was set up. Loaded with `node --import` only into processes the AX case starts. The local lane's loopback rule is unchanged and still the default (`src/config/endpoints.ts`).

Local rehearsal (runc on the laptop, **not** gVisor, **not** AX): the same lab image ran under its own runner with `AX_TASK_YAML`, against the same Emulate image and the pinned Floci image on a Docker network whose aliases and static IPs mimic the cluster Service names and pinned ClusterIPs. `apl-case W01-H` exited 0 about 3 s after start. The collector, in a separate container with the reader token and different S3 keys, produced a bundle that `profiles/ax/evaluate_ax.py F3-A1` judged **PASS**: `ticket_count 1`, `receipt_count 1`, `receipt_matches_request true`, `completion_reply_count 1`, `command_exit_code 0`. The rehearsal's `ax_task_phase` was a placeholder: no AX existed there. This shows the code path and the evaluator wiring work. It is not AX evidence.

Phase is not outcome (L-006): `cases.ax.json` lists `ax_task_phase` under `recorded_not_asserted`, and `evaluate_ax.py` refuses an expectation that names it. The only phase AX ever reported in this run was `Failed`, from a provisioning error, before any command existed.

## 3. Command result: BLOCKED

Not run on the cluster. Locally (runc), the runner wrote `exit_code` 1 to `result.json` when the first rehearsal's case failed. What AX reports for a failing command remains unobserved.

## 4. Termination and resume: BLOCKED

Not run on the cluster. Locally (runc, `docker stop`): a command trapping SIGTERM recorded `exit_code 42` within 1 s; a command ignoring SIGTERM was SIGKILLed after the 10 s grace and recorded `137`. Suspend/resume and the prepare-once marker under Substrate snapshots: unobserved.

## 5. Isolation: BLOCKED (sandbox), partial (control plane)

The in-sandbox probes (`apl-case isolation`: GCE metadata by IP and name, public HTTP and HTTPS, Kubernetes API, Substrate API, AX server, an unlisted Emulate port, raw TCP) were never run, because no sandbox existed. Observed without a sandbox:

- The stored Task (`ax get task`) contains the worker's bot token, the coordinator's setup token and the signing secret, as `spec.env` must. It does **not** contain the collector's reader token or the collector's S3 key (checked by string search against the run's secrets).
- `spec.env` is returned in clear by `ax get task` to any AX API caller (L-034).

## 6. Timing: BLOCKED

No task reached Running, so there is no submit → Running → result measurement. The only setup timing observed: the run's worker pool showed 1/1 Ready at its first check, 41 s after apply. Benchmark and demo worker pools were scaled to 0 for the run (recorded replicas 3, 1, 2, 0), so the only worker pool was the run's own.

## Run 2: Substrate upgrade to v0.6.0 (2026-10-28): BLOCKED on IAM

The owner approved upgrading Substrate in `ate-system` to the release AX `4b7bf6f` requires. That is tag `v0.6.0` = `d3f2363590a1`: AX's `go.mod` pins `go.ate.dev/substrate v0.6.0`, and `go mod download -json` resolves it to that commit with the same `h1:` sum as AX's `go.sum`. The cluster runs Substrate `main` @ `603e006236f5` (`v0.5.0-45`, 2026-10-16), built from source with `ko` (from the install record in the ate-setup cache).

The upgrade stopped before any cluster change, at what Substrate v0.6.0 requires of a GKE install:

| Requirement at v0.6.0 | Source | On this cluster | Needs |
|---|---|---|---|
| A snapshot transfer Google service account that ate-api-server's credential exchange impersonates. ate-setup refuses to deploy ate-api-server on GKE without `storage.transferGSAName`, and the server "refuses to start without one" | `cmd/ate-setup/internal/config/config.go` `RequireTransferServiceAccount`; `tools/setup-gcp/README.md`; introduced by Substrate commit `e7cfad2e` (2026-10-21) | No such account; the only service account in the project is the default compute one | **IAM (not approved):** create the account; grant `roles/iam.serviceAccountTokenCreator` on it to the `ate-system/ate-api-server` Workload Identity principal; grant it `roles/storage.objectAdmin` and `roles/storage.bucketViewer` on the snapshot bucket |
| Workload Identity on the cluster | same README | Enabled (`<project>.svc.id.goog`, nodes `GKE_METADATA`); ate-api-server's principal already has object admin and bucket viewer on the snapshot bucket | nothing |
| Asset bucket `<bucket>-assets` | same README | Absent | Only for micro-VM workers; the lab uses gVisor |

Two more findings that matter even once IAM is granted:

- **Upgrading in place is unsupported.** v0.6.0's `docs/upgrade.md` says a minor upgrade before 1.0 is "No. Reinstall", and `tools/setup-gcp/README.md` says "Substrate does not support upgrading a cluster in place yet". A reinstall deletes the demo and benchmark atespaces, which this lab does not own.
- **Stored records would misread.** ate-api-server stores each record as the serialized API protobuf (`substrate.actors.proto bytea`). Between `603e0062` and `v0.6.0` the `Actor` fields `actor_template`, `worker_selector`, `source_tag` and `status` moved from 4–7 to 2–5, and `ActorTemplate` field 6 changed from `sandbox_config` to `resources`. An in-place v0.6.0 server would read the four suspended demo actors with no template and state `UNSPECIFIED`, which is what the v0.6.0 `kubectl-ate` already showed in run 1 (L-030). Their records survive only as bytes the old server can read, and only until a new server rewrites them.

Before stopping, a rollback baseline was taken in the private run dir: image digests and args of every Substrate workload, CRDs (all `v1alpha1`), RBAC, the `sandboxconfig-assets` admission policy (Substrate has no webhooks), ConfigMap and Secret names, all WorkerPools, the Substrate API records (7 atespaces, 4 actors, all `SUSPENDED`, 9 templates, 9 tags), and a `pg_dump` of the bundled database. Nothing was changed, so nothing needs rolling back, and `teardown.sh` was not changed. Items 2 to 6 were not rerun: they need a working AX task, and none can be created until AX and Substrate agree.

## What would unblock it (as written after run 2)

Run 3 took option 2. One of these, each needing owner approval:

1. **Use AX commit `2bfbcb8d2f6b`** (2026-10-26), the last commit that pins Substrate v0.5.0, which matches the installed server. It needs a rebuild and re-push of `ax-server` and `ax-task-runner` (new digests) and a redeploy. The AX docs read for this lane were read at `4b7bf6f`, so they would need re-reading at that commit.
2. **Upgrade Substrate in `ate-system` to v0.6.0**, which AX `4b7bf6f` expects. Approved in run 2, then blocked: it also needs the IAM grants above, and upstream supports it only as a reinstall (run 2 section).

Everything else is in place and Running. Once one option is approved, each task is: render with `orchestrate.ts manifests`, `ax apply`, attach the egress policy as soon as the actor exists, `collector.ts result` and `observe` in the collector Pod, then `evaluate_ax.py`. The operator script that does this, with timestamps for the timing table, is kept with the run's private files because it names the cluster.

## Run 3: Substrate reinstalled at v0.6.0, AX tests executed (2026-10-28)

Owner approval for run 3, exact scope: create the snapshot transfer service account `<transfer-sa>` with three grants, and reinstall Substrate in `ate-system` at v0.6.0 (`d3f2363590a1`), accepting that the demo and benchmark atespaces and their four suspended actors are destroyed. Nothing else in IAM, no API enabling, no cluster or node-pool change. Raw evidence for every row below is in the private run dir (`tasks/<task>/`, `health-v060.txt`, `reinstall-timeline.txt`, `timing-summary.json`).

### 3.1 IAM (approval (a))

| Member | Role | Resource |
|---|---|---|
| ate-api-server Workload Identity principal (`ns/ate-system/sa/ate-api-server`) | `roles/iam.serviceAccountTokenCreator` | `<transfer-sa>` |
| `<transfer-sa>` | `roles/storage.objectAdmin` | `<snapshot-bucket>` (bucket level) |
| `<transfer-sa>` | `roles/storage.bucketViewer` | `<snapshot-bucket>` (bucket level) |

Bucket and account policies were saved before and after; the bucket diff is exactly the two added bindings, nothing removed. All four objects are recorded in `owned-resources.json` (`iam`). They worked: AX suspends wrote snapshot objects under the new cluster snapshot location.

### 3.2 Reinstall (approval (b))

Steps, all with Substrate's own installer, `ate-setup`, and a dedicated kubeconfig:

1. Rollback snapshot right before the change (`substrate-rollback/pre-reinstall-<timestamp>/`): image digests and args, manifests (both Substrate namespaces with ConfigMaps, CRDs, RBAC, admission policy, SandboxConfigs, WorkerPools as YAML and JSON), API records read with `kubectl-ate` v0.5.0 (7 atespaces, 4 actors all `SUSPENDED`, 9 templates, 9 tags), `pg_dump -Fc` (mode 0600).
2. Images: no public v0.6.0 release images exist (`ghcr.io/agent-substrate/substrate/*` denies anonymous pulls), so `VERSION=v0.6.0 ate-setup publish release-images` built every image from the `d3f2363` checkout into the cluster's existing Substrate image repo (8 min; the Envoy egress module is Rust, built under amd64 emulation).
3. `ate-setup delete ate-system` from the `603e006` checkout, the build that installed it (68 s).
4. `ate-setup deploy ate-system --config substrate-v060-install.yaml` from the `d3f2363` checkout: the old install record's settings plus what v0.6.0 requires (L-046). The first deploy timed out: atelet refused the nodes' image cache. After deleting `/var/lib/ate/image-cache` on both nodes, as its error says, the retry succeeded.
5. `deploy atenet` once more to add the collector's SPIFFE ID to the router allowlist (L-045).

| | Before | After |
|---|---|---|
| Build | `main` @ `603e006236f5` (v0.5.0-45) | `v0.6.0` @ `d3f2363590a1` |
| Components | api-server 2/2, controller, router, egress, credential provider, atelet 2/2, postgres | same plus `ate-idp-server` 2/2; all Ready, every image `…:v0.6.0@sha256` |
| `kubectl-ate` | v0.5.0 | v0.6.0 lists atespaces, actors, workers, egress policies |
| Router | plain HTTP open to any Pod (L-035) | mTLS only, SPIFFE allowlist (L-045) |
| Authorization | none | enforced; `ate-client` and AX's `ax-server` are bootstrap owners (L-046) |

What survived: nothing of the old Substrate state. All 7 atespaces, 4 suspended actors, 9 templates and 9 tags are gone with the database volume, and deleting the CRDs deleted every WorkerPool: the four demo and benchmark pools (already scaled to 0) and the lab's own pool. The demo namespaces remain, empty of workloads. The lab namespace (Emulate, Floci, collector) and `ax-system` were untouched; `ax-server` was restarted. The lab's gVisor WorkerPool was recreated with the v0.6.0 worker image (Ready in 6 s). The pre-reinstall `pg_dump` and manifests are the only copy of the old records; `teardown.sh --restore-substrate-v05` uses them.

### 3.3 Results

AX creates every task suspended; the operator script resumes it right after attaching the egress policy (L-047). The task image is the lab image built from commit `d10d3e6`. Every task ran in a gVisor sandbox (`sandboxClass: gvisor` on the actor) on the run's single worker.

| Test | Result | Evidence |
|---|---|---|
| (2) W01-H as an AX Task (F3-A1) | **PASS** | `evaluate_ax.py F3-A1`: ticket_count 1, receipt_count 1, receipt_matches_request true, completion_reply_count 1, command_exit_code 0. Bundle `profile: "ax"`, collected by the collector Pod with its own reader token, S3 keys and pod certificate. `ax_task_phase` recorded (`Running`), not asserted |
| (3) Failing command (AX-R1) | **PASS** | `result.json` exit_code 3; AX phase `Running` at the same moment. Phase and outcome disagree, as expected (L-006) |
| (4a) `ax suspend` delivers SIGTERM | **FAIL** | Suspend is a 40 ms checkpoint; no SIGTERM, no `result.json` (`404` before and after) |
| (4b) `ax delete task` delivers SIGTERM | **FAIL** | Actor log goes from the command's boot line straight to `Actor terminated` |
| (4c) Worker eviction delivers SIGTERM | **PASS** (logs) | Deleting the worker Pod: runner logged `stop requested` 0.65 s later; trap exited 42; the SIGTERM-ignoring command was killed after exactly 10.0 s, exit 137 |
| (4d) Resume after `ax suspend` keeps the prepare-once marker and the workspace | **PASS** | Same marker timestamp on both boots, `workspace already prepared; skipping`, new process (pid 9 → 8) |
| (4e) State after eviction, then `ax suspend` and resume | **FAIL** | The actor crashed when the runner exited; AX reverted it to its last snapshot, and the next start had a new marker and no `result.json` (L-048) |
| (5) Isolation from inside the sandbox | **PASS** | `169.254.169.254` (HTTP and raw TCP) `EHOSTUNREACH`; `metadata.google.internal`, `example.com` (HTTP and HTTPS), `kubernetes.default.svc`, `api.ate-system.svc`, `ax-server.ax-system…` `ENOTFOUND`; raw TCP to the `ax-postgres` and `ax-server` ClusterIPs answered only by the egress gateway's own `400` (Envoy `upstream` null); unlisted Emulate port `403`. Allowed control (Emulate API) reached. L-049 |
| (5) Router identity | **PASS** | From the collector Pod: no client certificate → TLS alert `certificate required`; its own allowlisted certificate → `200` |
| (5) Secrets (L-034) | observed | `ax get task` still returns the worker token, setup token and signing secret in clear; the collector's reader token and S3 key are absent (string search, output not stored) |
| (6) Timing, n = 5 | **met** | Table below |

Timing, W01-H tasks `apl-t1`…`apl-t5`, run back to back, each deleted before the next. Laptop clock for submit (start of `ax apply`) and phase (0.5 s polling of `ax get tasks`); collector Pod clock for the result. Nodes: 2 × c3-standard-4 (4 vCPU, 16 GiB, amd64, GKE 1.36.4). The only WorkerPool was the run's (1 worker, 3 CPU); demo and benchmark pools no longer existed.

| ms | run 1 | 2 | 3 | 4 | 5 | min | median | max |
|---|---|---|---|---|---|---|---|---|
| submit → Running | 17042 | 16977 | 16808 | 16968 | 16874 | 16808 | 16968 | 17042 |
| submit → result observed | 19876 | 19720 | 19613 | 19807 | 19696 | 19613 | 19720 | 19876 |
| of which submit → egress policy attached | 8800 | 8916 | 8845 | 8940 | 8817 | 8800 | 8845 | 8940 |
| of which resume issued → Running seen | 4015 | 3979 | 3988 | 3944 | 3935 | 3935 | 3979 | 4015 |
| Running → result observed | 2834 | 2743 | 2805 | 2839 | 2822 | 2743 | 2822 | 2839 |
| ax-server log: resume → running | 2162 | 2141 | 2138 | 2130 | 2119 | 2119 | 2138 | 2162 |

Against the pre-registered expectation "Task reaches Running in tens of seconds": **met**, at 17 s. Most of it is operator tooling, not AX or Substrate: every `kubectl ate` call opens its own port-forward, and the policy step takes about 9 s. AX's own server logs put create → suspended at about 15 ms and resume → running at about 2.1 s.

### 3.4 Still running, and teardown

Running: Substrate v0.6.0 in `ate-system`; AX in `ax-system`; the lab namespace (Emulate, Floci, collector, one gVisor worker); the transfer service account and its grants. No task is running. Teardown was not run; `--dry-run` was tested for each mode:

- `teardown.sh <run-dir>`: deletes the AX tasks and workspaces, the run's atespace, the lab namespace and `ax-system` with the AX ClusterRole, ClusterRoleBinding and PV, the run's snapshot prefixes and the Artifact Registry repo. It leaves Substrate v0.6.0 and the transfer service account and grants in place and prints them, because the v0.6.0 api-server will not start without them. Its diff treats the reinstall's own changes (`reinstall-delta.json`) as expected.
- `--remove-substrate-iam`: also removes exactly the three recorded grants, then the account. It warns that Substrate v0.6.0 breaks.
- `--restore-substrate-v05` (since the final review it also needs `--yes-clear-node-image-cache`, and the cache is cleared by Pods labelled `apl-run=<run_id>` that the script creates and deletes by that label): also deletes v0.6.0, clears the nodes' image cache, deploys the recorded `603e006` build with its install record, restores the pre-reinstall `pg_dump`, recreates the demo WorkerPools at their recorded replicas, switches `kubectl-ate` back to v0.5.0, then removes the account and grants. Never executed. Whether the restored suspended actors resume is UNKNOWN, because the actor-identity keys are regenerated on install.

## Teardown (2026-10-29, owner-approved default mode)

`profiles/ax/teardown.sh <run-dir>` (default mode) ran with the run's dedicated kubeconfig and exited 0, after the run dir was brought into line with `run-dir.schema.json` (`kube_context` added, an empty `atespace` field removed; the original manifest is kept beside it in the gitignored run dir). The script's post-snapshot diff against `pre-snapshot.json` reported no unexpected changes; every difference traced to the owner-accepted Substrate reinstall (`reinstall-delta.json`).

Checked independently afterwards, with read-only queries rather than the script's own report:

| Resource | After teardown |
|---|---|
| Lab namespace `apl-ax-<short>` and `ax-system` | NotFound |
| ClusterRole and ClusterRoleBinding `ax-server`, the 10 GiB PersistentVolume and its Compute disk | NotFound / absent |
| Private Artifact Registry repo `<registry>` (all four images) | absent |
| Run-owned snapshot prefixes in `<snapshot-bucket>` | 0 objects |
| Substrate v0.6.0 in `ate-system` | left in place on purpose; 11 of 11 pods Running |
| Transfer service account and its three grants | left in place on purpose (the v0.6.0 API server needs them) |

`ax delete task` returned NotFound for tasks already removed during the runs; the script continued, as designed. The demo and benchmark WorkerPools were deleted by the Substrate reinstall, so there was nothing to restore. Remaining owner options: `--remove-substrate-iam` (breaks Substrate v0.6.0) or `--restore-substrate-v05 --yes-clear-node-image-cache` (previous build plus the pre-reinstall database dump; whether the old demo actors resume is unknown).

## Run 4: many tenants and two clusters (set XM, 2026-10-30)

Design: [`docs/MULTI_CLUSTER.md`](../../docs/MULTI_CLUSTER.md) (cases, keys, pre-registered expectations, claim limits); build plan: [`docs/MULTI_CLUSTER_BUILD.md`](../../docs/MULTI_CLUSTER_BUILD.md); decision: ADR-13. Every cluster call went through `profiles/ax/multi.ts`. Claims C-80 to C-90 in [`CLAIM_LEDGER.md`](../../docs/CLAIM_LEDGER.md); learnings L-058 to L-067.

| Set | Step | Clusters | Aggregate (`aggregate.md`, `aggregate.json`, `timing.json`) |
|---|---|---|---|
| `e0ab865c-94a8-48fd-a06b-1226991e27f9` | 1, many tenants | A | [`docs/evidence/e0ab865c-…/`](../../docs/evidence/e0ab865c-94a8-48fd-a06b-1226991e27f9/aggregate.md) |
| `7d9ea2cc-40c6-4cf6-ab7e-c5dcaae33407` | 2, same case on two clusters | A and B | [`docs/evidence/7d9ea2cc-…/`](../../docs/evidence/7d9ea2cc-40c6-4cf6-ab7e-c5dcaae33407/aggregate.md) |

Each aggregate lists every bundle by run ID; each bundle's export is `docs/evidence/<run_id>/`. The raw evidence (ax-server log extracts, gateway-log extracts, the two planted controls, superseded stop bundles, step run dirs) names the clusters and stays in the gitignored `private-runs/ax/sets/<set_id>/`. The actor probe's G = 0 and L = 0 rest on the private actor listings (`actors-apl-ax-a2de0159-r{0,1}-*.json` in the step 1 set dir), not on exported files.

### 4.1 Setup

| | Cluster A | Cluster B |
|---|---|---|
| Cluster | the run 3 cluster | created for this design (same project, VPC and subnet as A; design 8.1, 8.5) |
| Nodes | c3-standard-4, amd64. Node pool 2 → 3 for the run (owner approval, 2026-10-30). Before the third node (operator, read-only `kubectl`, 2026-10-30), CPU requests on the 2 × 3.92 = 7.84 allocatable vCPU were `ate-system` 2.10, `kube-system` 1.30, `ax-system` 0.20 and GKE-managed agents about 0.17 (`gke-managed-cim` 0.105, `gke-managed-otel` 0.05, `gmp-system` 0.011): about 3.77, leaving about 4.07 vCPU for the lab against the design's 4.3. After two 1-CPU workers and the collector the nodes had about 0.75 and 0.50 vCPU free, so neither could take the third 1-CPU worker (L-059) | c3-standard-4, amd64. Node pool 0 → 3 for step 2: 3 rather than the design's 2, to match A |
| GKE | 1.36.4 | 1.36.4 |
| Substrate | v0.6.0 `d3f2363` | v0.6.0 `d3f2363` |
| AX | `4b7bf6f`, `ax-server@sha256:41665100…` | same commit and digest |
| Lab image | `<registry>/apl-lab@sha256:0b48d9d1…`, built from `bf05d51` with `git archive`; all 16 runner contract tests passed on it | same digest |
| WorkerPool `apl-ax-pool` | gVisor, R = 3 for the run | gVisor, R = 3 |

`kubectl` client v1.36.6. Two runner commits landed during the run, `3868bff` (`run-step --only`, the GKE worker chain) and `52843a4` (teardown treats NotFound as gone); neither changed anything inside the image. Every bundle records `candidate_revision` `bf05d51` with `tree_sha: UNKNOWN` and `dirty: true`: the image was built from a `git archive`, which carries no repository metadata, so the evidence binds to the commit and the image digest, not to a tree (ADR-9).

Approvals: design §12 lists those the run needed. A's node pool 2 → 3 was outside the design and was approved by the owner on 2026-10-30; B's 3 nodes instead of 2 also differ from §12. Both resizes were done outside `multi.ts`, whose `infra --resize` takes only 0 or 2.

### 4.2 What ran

1. **Step 1 on A.** Actor probe (2 tasks), then c = 1 (1 tenant, warm-up + 30 tasks), c = 2 (2 tenants, warm-up + 15 each), c = 4 (4 tenants, warm-up + 8 each), each with one MT-W01 per tenant, then MT-ISO (4 tenants, one probe each). The marker control ran before c = 1's MT-W01 and the egress control before the first MT-ISO probe.
2. **Step 2 on A.** A's half was to be reused from step 1 (design 8.3). The plan check refused it (L-064), so A was re-run first in the same session, as the design's fallback: 1 tenant, c = 1, warm-up + 30 tasks and MT-W01.
3. **Step 2 on B.** 1 tenant, c = 1, warm-up + 30 tasks and MT-W01, after the marker control.

### 4.3 Step 1 results (A, 3 nodes, R = 3)

`all clusters: PASS (A PASS, 105 of 105 planned reports)`. Warm-ups are not counted.

| Configuration | Tenants | Counted F3-A1 | MT-W01 | Status |
|---|---|---|---|---|
| Actor probe, c = 1 | 1 | 2 PASS | - | PASS |
| c = 1 | 1 | 30 PASS | 1 PASS | PASS |
| c = 2 | 2 | 30 PASS (15 each) | 2 PASS | PASS |
| c = 4 | 4 | 32 PASS (8 each) | 4 PASS | PASS |
| MT-ISO | 4 | - | - | 4 PASS |

- **F3-A1.** Every bundle, warm-ups included, has `command_exit_code` 0 and `ticket_count` 1.
- **MT-W01.** `foreign_marker_count` 0 for each tenant at c = 1, 2 and 4. Marker control (one extra observation whose markers file lists the tenant's own first task): counted 4, so the detector can fail. `foreign_secret_in_task_count` is absent, not 0: "not collected: disclosure".
- **MT-ISO.** For each of the four tenants: `cross_tenant_upstream_count` 0, `allowed_control_reached` true, `target_ran` true, `probe_self_report_reached_count` 0, `foreign_marker_count` 0. Egress control (one isolation task under a lab policy that also allows one foreign tenant's Emulate): `cross_tenant_upstream_count` 1, so the detector can fail. `foreign_secret_in_task_count` is absent ("not computable: ax get task returned no task"), recorded only.
- **Actor probe.** G = 0 and L = 0 in both rounds (one actor listed after apply and after the result, none after delete); no leftover held a worker. Every round's leftover check in both steps found 0 actors.
- **Worker co-residency** (recorded, not asserted). At c = 2 the two tenants' task actors shared a worker in 3 of 15 counted rounds (3 of 16 including the warm-up round); at c = 4 at least two shared a worker in 8 of 8 counted rounds (9 of 9 including the warm-up round; 3 workers, 4 tasks). Other rounds show only a shared pool.

Timing (recorded, not asserted; nearest-rank p50 and max; warm-ups excluded):

| c | n | ax-server log: resume → running, ms (AX's clock) | `result.json` command duration, ms (sandbox clock) | resume spread within a round, ms |
|---|---|---|---|---|
| 1 | 30 | p50 2114, max 2174 | p50 3812, max 4066 | p50 0, max 0 |
| 2 | 30 | p50 2131, max 2165 | p50 3930, max 4410 | p50 0, max 4 |
| 4 | 32 | p50 2177, max 2226 | p50 4250, max 4925 | p50 5, max 23 |

`timing.json` also holds operator-clock values (egress attach, submit → result, empty exec) and every task's raw values. Neither headline is end-to-end task latency.

### 4.4 Step 2 results (A re-run, B)

`all clusters: BLOCKED (A PASS, 31 of 31 planned reports; B BLOCKED, 31 of 31 planned reports)`. Both clusters' `versions.json` name the same AX commit, `ax-server` digest, lab image digest and Substrate commit.

| Cluster | Counted F3-A1 | MT-W01 | Status |
|---|---|---|---|
| A | 30 PASS | PASS (`foreign_marker_count` 0) | PASS |
| B | 29 PASS, 1 BLOCKED | PASS (`foreign_marker_count` 0; 29 of 30 tasks timed) | BLOCKED |

- **The BLOCKED task.** `apl-a64f9fba-06` on B (run `6648320f-7097-43bb-aaec-668dc0ea2fdf`): reason "egress policy not attached". `kubectl ate create egress-policy` for that task failed and the runner did not capture the command's stderr (L-067), so why it failed is UNKNOWN. The task was deleted without being resumed; its round has no resume spread.
- **No retry.** The operator did not re-run B until it was green: re-running a configuration until it passes is retry-until-pass, and the one BLOCKED task stands. So the two clusters did not reach the same verdict. B's row is a BLOCKED, not a FAIL: the `kubectl ate create egress-policy` call against B's Substrate API failed and its stderr was not captured (L-067), so the cause is not determined (a Substrate-side fault is not excluded).
- **Marker control on B.** Counted 4 (kept in the set dir, not exported), so B's MT-W01 detector can fail.

| Cluster | n | ax-server log: resume → running, ms | `result.json` command duration, ms |
|---|---|---|---|
| A | 30 | p50 2117, max 2181 | p50 3893, max 3992 |
| B | 29 (below the planned 30, flagged `n_below_planned`) | p50 2120, max 6165 | p50 3785, max 3922 |

On B the warm-up (6134 ms) and the first counted task (6165 ms) were slow; the other 28 counted tasks were at most 2159 ms.

### 4.5 Pre-registered expectations vs observed

| Expectation (design 7.5, 8.6) | Observed | Verdict |
|---|---|---|
| Actor probe G = 1, L = 0 or 1 | G = 0, L = 0 | G missed (recorded, not asserted) |
| F3-A1 PASS for every counted task at c = 1, 2, 4 | 92 of 92 PASS (plus the 2 probe tasks) | met |
| MT-W01 PASS at c = 1, 2, 4 | 7 of 7 PASS | met |
| MT-ISO PASS for each of four tenants | 4 of 4 PASS | met |
| c = 4 and MT-ISO fit on 2 × c3-standard-4 (design 7.3; no NOT_RUN for capacity) | did not fit: the third worker could not schedule on 2 nodes; fitted after A's node pool went to 3 (L-059) | missed |
| Both controls fire | marker 4, egress 1 on A; marker 4 on B | met |
| resume → running p50 at c = 1 about 2.1 s | 2114 ms | met |
| resume → running p50 at c = 4 above c = 1's | 2177 vs 2114 ms | met (no trend claim) |
| A's `versions.json` unchanged, so A's half reused | reuse refused on a name-format difference with the same digest (L-064); A re-run | missed |
| Warm-up preflight passes on B (design 8.2) | warm-up PASS; 8.2's checks (every actor decoded, no `Unimplemented` or unmarshal error) are not separately recorded | partly evidenced |
| F3-A1 PASS for every counted task on B, MT-W01 PASS | 29 PASS, 1 BLOCKED; MT-W01 PASS | missed (one BLOCKED) |
| All-clusters view PASS for both | BLOCKED | missed |

### 4.6 Stops and reruns

| What stopped | Reason | What followed |
|---|---|---|
| Step 1 dry run | Run-dir `images[].name` held bare names, so `imageRef()` found nothing (L-060) | Fixed before any cluster change; schema description added (`8e4805e`) |
| Step 1 MT-ISO, first run | BLOCKED: "no worker Pod of WorkerPool apl-ax-pool was found"; the worker lookup stopped at ReplicaSet and missed GKE's Deployment (L-061) | Fixed in `3868bff`; MT-ISO re-run with `run-step --only mt-iso`, which produced the four observed bundles. The four earlier stop bundles are listed in the set's `superseded.json` and not exported |
| Step 1 teardown | Reported INCOMPLETE: teardown re-deleted tasks `multi.ts` had already deleted, and AX's NotFound counted as a failure (L-062) | Fixed in `52843a4`; teardown re-run, CLEAN. Independent check: 0 of 85 Kubernetes objects and 0 of 12 atespaces left. The step run dir's diff also listed 3 compute disks: B's new node boot disks (L-063) |
| Step 2, A's reuse | Refused: step 1's snapshot recorded `ax.ax_server` as a bare name, step 2's as the full repository path; same digest `41665100…` (L-064) | The design's fallback, not an override of the guard: A re-run first |
| Step 2, B's first run | Stopped before any cluster call: B's run dir listed no `apl-emulate` image (L-065) | Run-dir data fixed; B re-run with `run-step --only configuration`. The 32 stop bundles (31 F3-A1, 1 MT-W01) are listed in `superseded.json` and not exported |
| Step 2, B task `-06` | BLOCKED: egress policy not attached (L-067) | Not retried (4.4) |
| Overnight | `gcloud` credentials expired; non-interactive `kubectl` and `gcloud` failed with "Reauthentication failed" (L-058) | Owner re-login; no cluster change happened |

The re-run rule applied: a configuration was re-run only after a fix for a known, recorded cause and before it produced any observation (MT-ISO after the worker-lookup fix; B's first step run, which made no cluster call). An observed BLOCKED with an unknown cause (B task `-06`) was not re-run, to avoid retry-until-pass.

Every step run ended CLEAN: step 1's two after the teardown re-run, step 2's A and B on the first teardown. B's first step run made no cluster call.

### 4.7 Infrastructure changes and their state now

| Change | State after the runs |
|---|---|
| A node pool 2 → 3 | restored to 2 |
| A WorkerPool `apl-ax-pool` → R = 3 | restored to 1 |
| B node pool 0 → 3 | scaled back to 0 |
| B after about 19 h at 0 nodes | Substrate (6 deployments, postgres on a PVC) and AX (`ax-server`, `ax-postgres` on a PVC) came back Available with no intervention (L-066) |

Neither cluster is torn down. B's deletion (cluster, bucket and its bindings, disks) and A's infrastructure-run-dir teardown (design §12) await the owner.
