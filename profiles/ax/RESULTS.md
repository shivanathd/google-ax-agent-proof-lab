# AX lane: first authorized cluster run

Run `6882d106-…` on 2026-10-28, on the owner's existing GKE cluster running Agent Substrate. Identifiers are placeholders: `<project>`, `<cluster>`, `<registry>` (a private Artifact Registry Docker repo created for this run), `<snapshot-bucket>`. Raw evidence, the owned-resource list and the pre-snapshot are in the gitignored `private-runs/ax/<run_id>/`.

**Lane status: BLOCKED.** A second attempt (run 2, below) to upgrade Substrate stopped on IAM prerequisites before changing anything. The AX control plane at the pinned commit cannot create anything on the cluster's Substrate. Its Substrate client (`go.ate.dev/substrate v0.6.0`) and the installed Substrate server (wire-compatible with v0.5.0) use the same gRPC service name with renumbered protobuf fields. The first `ax apply` of a Task failed in `CreateActorTemplate` (L-030). No AX task ever started, so items 2 to 6 have no cluster evidence. Nothing is PASS on the cluster.

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

## What would unblock it

One of these, each needing owner approval:

1. **Use AX commit `2bfbcb8d2f6b`** (2026-10-26), the last commit that pins Substrate v0.5.0, which matches the installed server. It needs a rebuild and re-push of `ax-server` and `ax-task-runner` (new digests) and a redeploy. The AX docs read for this lane were read at `4b7bf6f`, so they would need re-reading at that commit.
2. **Upgrade Substrate in `ate-system` to v0.6.0**, which AX `4b7bf6f` expects. Approved in run 2, then blocked: it also needs the IAM grants above, and upstream supports it only as a reinstall (run 2 section).

Everything else is in place and Running. Once one option is approved, each task is: render with `orchestrate.ts manifests`, `ax apply`, attach the egress policy as soon as the actor exists, `collector.ts result` and `observe` in the collector Pod, then `evaluate_ax.py`. The operator script that does this, with timestamps for the timing table, is kept with the run's private files because it names the cluster.
