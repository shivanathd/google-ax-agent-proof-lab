# AX profile (optional lane)

This lane runs one existing lab case inside an AX task on Agent Substrate, then judges it with the same assertions as the local lane (F5-R4). It is off by default. `doctor` reports BLOCKED until every prerequisite below is declared. `run` refuses unless doctor is satisfied and the operator passes `authorized=true` (F5-R6).

## What is designed and what has run

| Item | State | Evidence |
|---|---|---|
| `doctor` / `run` gates, zero external calls when blocked | EXECUTED (locally) | `tests/integration/ax-profile.test.ts` |
| Custom runner image (linux/amd64) honouring the runner contract | EXECUTED (locally, `docker run` under amd64 emulation) | same test file, `ax runner contract (docker)` |
| `result.json` written for passing, failing and terminated commands | EXECUTED (locally) | same |
| Manifest rendering and `apl-run` labelling | EXECUTED (locally, text checks only) | same |
| In-cluster Emulate + Floci, NetworkPolicy, run-owned WorkerPool, collector Pod | EXECUTED (cluster, 2026-10-28) | `RESULTS.md` |
| `ax apply` of Task + Workspace | EXECUTED (cluster, run 3, after reinstalling Substrate at v0.6.0); run 1 was BLOCKED by protobuf skew (L-030) | `RESULTS.md` run 3 |
| W01-H case, collector bundle, `evaluate_ax.py` | EXECUTED (cluster, gVisor, run 3): F3-A1 and AX-R1 PASS | `RESULTS.md` §3.3 (2), (3) |
| Sandbox isolation and router identity | EXECUTED (cluster, gVisor, run 3): PASS | `RESULTS.md` §3.3 (5) |
| Termination and resume | EXECUTED (cluster, run 3): eviction SIGTERM and resume PASS; SIGTERM on `ax suspend` and on `ax delete task`, and the result after eviction + suspend/resume, FAIL | `RESULTS.md` §3.3 (4a)–(4e) |
| Timing, submit → Running → result | EXECUTED (cluster, run 3, n = 5): expectation met | `RESULTS.md` §3.3 (6) |
| Substrate reinstall at v0.6.0 and the transfer service account | EXECUTED (cluster, run 3, owner-approved) | `RESULTS.md` §3.1, §3.2 |
| `owned-resources.json` writer → schema → `teardown.sh --dry-run` round trip | EXECUTED (locally, synthetic run dir with placeholder identifiers) | `profiles/ax/tests/run-dir.test.ts` |
| `teardown.sh`, default mode, for real | EXECUTED 2026-10-29 with owner approval, then checked independently with read-only queries (lab namespace, `ax-system`, registry, disk and snapshot prefixes gone; Substrate v0.6.0 and the transfer SA + grants left in place on purpose). `--remove-substrate-iam` and `--restore-substrate-v05` NOT RUN (dry-run only) | `RESULTS.md`, "Teardown" |
| microVM sandbox class | NOT RUN | - |

Three authorized cluster runs happened (`RESULTS.md`). The local tests still run plain Docker containers, not a Substrate sandbox; only run 3's cluster results say anything about gVisor. On Substrate v0.6.0 the collector reads `/apl/result` through the router over mTLS with its own pod certificate (L-045).

## Upstream revisions

| Repo | Deployed in run 3 | Files read |
|---|---|---|
| `google/ax` | `4b7bf6f84cac7eb12f21b87a76c8dc85155dce38` (images from its `make images`, control plane from its `make deploy`) | `README.md`, `docs/runner.md`, `docs/manifests.md`, `docs/sandbox.md`, `pkg/apis/v1alpha1/ax.proto` |
| `agent-substrate/substrate` | `v0.6.0` = `d3f2363590a1`, the release AX's `go.mod` pins (images built from that checkout, installed with its `ate-setup`) | at `d3f2363`: `docs/upgrade.md`, `tools/setup-gcp/README.md`, `cmd/ate-setup/internal/config/config.go`, the Control API protos. `README.md` was first read at `6d7b3f4`, which was never deployed |

Before run 3 the cluster ran Substrate `main` @ `603e006236f5` (v0.5.0-45), which AX `4b7bf6f` cannot talk to (L-030). Both projects say they are pre-stable and may break. Re-read these files at the SHA you deploy.

## Prerequisites (`lab profile doctor ax`)

| Id | Variable | Satisfied when |
|---|---|---|
| `ax.kubectl` | `APL_AX_KUBECTL` | It names a kubectl client ≥ 1.35, installed separately from the host binary (the host has 1.34). Doctor runs `version --client -o json` with `KUBECONFIG=/dev/null`, so the probe cannot reach a server. Doctor runs nothing when the variable is unset. |
| `ax.kube-context` | `APL_AX_CONTEXT` | Set to the owner-approved context. Doctor never reads the ambient current-context. |
| `ax.image` | `APL_AX_IMAGE` | `repo@sha256:<64 hex>`. Substrate rejects tag-only images. |
| `ax.cli` | `APL_AX_CLI` | The path exists. Task and Workspace are AX control-plane objects applied with `ax apply`, not Kubernetes objects. |
| `ax.substrate-api` | `APL_AX_SUBSTRATE_API` | Declared, normally `api.ate-system.svc.cluster.local:443`. It cannot be verified offline; `run` checks it first with `kubectl get svc api -n ate-system`. |
| `ax.authorized` | `APL_AX_AUTHORIZED` | Exactly `1`, set only after the owner approves a cluster run. |

When every prerequisite holds, doctor returns `NOT_RUN`, never `PASS`. An authorized `run` stops at `UNKNOWN` after applying, because AX does not read the command's exit status back (L-006). Only the independent collector can turn the run into PASS or FAIL.

## Runner (`runner/`)

A from-scratch Go runner (`main.go`, one dependency: `gopkg.in/yaml.v3`) on `alpine:3.22`, both pinned by index digest. Build it with:

```bash
docker buildx build --platform linux/amd64 --load -t apl-ax-runner:dev profiles/ax/runner
```

It implements the contract in `docs/runner.md`:

- `/usr/local/bin/ax-task-runner` is the entrypoint and PID 1.
- `:80` serves `/healthz` (always 200) and `/readyz` (503 until the workspace is prepared, then 200).
- `127.0.0.1:8099` serves `/metadata/v1alpha1/ax/task` and `/metadata/v1alpha1/ax/workspace` (404 when no workspace is bound). The runner refuses a non-loopback metadata address.
- `AX_TASK_YAML` and `AX_WORKSPACE_YAML` are decoded leniently: unknown fields are ignored. `--task-file` and `--workspace-file` work for local testing.
- The workspace is prepared once: git clones, `spec.files`, skills path, MCP config. Paths that escape the workspace are rejected. A marker at `<workspace>/.apl/prepared` makes later boots skip preparation.
- `spec.command` runs in its own process group with cwd = workspace, `AX_METADATA_URL` and `spec.env`.
- When the command exits, the runner writes `<workspace>/.apl/result.json` atomically and stays up:

  ```json
  {"exit_code": 0, "started_at": "RFC3339", "ended_at": "RFC3339", "command_sha256": "hex"}
  ```

  `exit_code` is 128+N when signal N killed the command, and 127 when it could not start. `command_sha256` is SHA-256 of the argv joined with NUL bytes.
- On SIGTERM the runner signals the process group, waits `--grace` (default 10 s, matching the default runner), sends SIGKILL to the group, then exits 0.

Deviations from the default runner:

- **No guest services.** `spec.debug: true` only logs a warning, so `ax ssh` never works with this image. The manifests set `debug: false`.
- **No git in the image.** A Workspace with `spec.git` fails preparation, so the task stays not-ready and the command never starts. The lab passes code through the image and `spec.files`.
- **Different file locations.** MCP config goes to `<workspace>/.apl/mcp.json`, and the prepare marker lives on the durable workspace volume rather than under `/ax`.
- **Extra endpoint.** `GET :80/apl/result` returns `result.json` (404 before it exists). An in-cluster collector can read the outcome through the Substrate router without debug access.
- **No zombie reaping.** Orphans that leave the command's process group are not reaped (marked `shortcut:` in the code).

## Files added for the cluster run

- `case.ts` (`apl-case`): in-sandbox coordinator + worker for W01-H, and the isolation probes.
- `allowlist.ts`: the AX endpoint allowlist (lab-namespace Service hosts pinned to their ClusterIPs), loaded with `node --import`. The local loopback rule stays the default.
- `collector.ts`: the independent collector (plain Pod): `result` polls `/apl/result` through the router, `observe` writes a C4 bundle.
- `cases.ax.json` + `evaluate_ax.py`: expectations (ADR-12) and the supplied evaluator run against them.
- `orchestrate.ts`: operator-side generator for per-run secrets, the Emulate seed, the collector env and AX manifests, written to the gitignored run dir.
- `emulate/`: the in-cluster Emulate image (pinned base, lockfile, repository patch, loopback callback mailbox).
- `runner/Dockerfile.lab`: the runner plus the lab code, used by both the task and the collector Pod.
- `teardown.sh`: deletes exactly what `owned-resources.json` lists, restores scaled worker pools, then diffs a post-snapshot against the pre-snapshot (modes below).
- `run-dir.schema.json` + `run-dir.ts`: the one definition of `owned-resources.json`, its writer (`ownedResources()`, called by `index.ts`) and the validator `teardown.sh` runs. `tests/run-dir.test.ts` round-trips writer → teardown `--dry-run`.

## In-cluster placement (as deployed in run 3)

```
kube context <kube-context>
├── ate-system              Substrate v0.6.0 (d3f2363), reinstalled by run 3 with its ate-setup; Control API svc/api:443,
│                           atenet-egress, atenet-router (mTLS, SPIFFE allowlist incl. the collector)
├── ax-system               AX control plane at 4b7bf6f, deployed by the lab with AX's make deploy (L-031)
├── atespace apl-ax-<short-id>   per task: AX Workspace ws-<task>, Task <task>, egress policy  (orchestrate.ts)
└── namespace apl-ax-<short-id>  Floci + Emulate Deployments/Services, NetworkPolicy, gVisor WorkerPool,
                                 collector Pod (own ServiceAccount, tokens, S3 keys, pod certificate)
```

`index.ts run()` renders the same namespace from `manifests/k8s/emulators.yaml` but names its atespace `apl-<run-id>` and its objects `apl-ws-<run-id>` / `apl-task-<run-id>` (`manifests/ax/task.yaml`). Run 3 drove the cluster with `orchestrate.ts` and an operator script kept in the private run dir.

- **Namespace-local emulators.** Emulate and Floci run in the run's namespace. The task reaches them by cluster DNS (`floci.apl-ax-<short-id>.svc.cluster.local:4566`, `emulate.apl-ax-<short-id>.svc.cluster.local:8080`). There is no tunnel to the laptop. Floci uses the digest pinned in `compose.yaml`. The Emulate image (`emulate/`) wraps the pinned npm package and is pinned by digest (`APL_EMULATE_IMAGE`).
- **Substrate networking.** Actors are default-deny and send outbound traffic through `atenet-egress` (in `ate-system`, as the NetworkPolicy assumes). The egress policy was written against the Substrate v0.6.0 API: `http` rules for the Emulate host on 8080 and 8081 and the Floci host on 4566 only. AX creates every task suspended, so the policy is attached as soon as the actor exists and the task is resumed after that (L-047).
- **Collector.** A plain Pod in the run namespace, with its own credentials. It reads Floci and Emulate state directly, plus `/apl/result` through the Substrate router over mTLS with its own pod certificate (L-045). It writes the C4 bundle. Task phase `Running` or `Succeeded` is never an observation of success.
- **Manifests.** `${APL_*}` placeholders are filled by `render()` in `index.ts`, and an unknown placeholder is an error. Rendered copies and `owned-resources.json` go to gitignored `private-runs/ax/<run-id>/`. No real project, cluster, registry, bucket, account or kube context appears in this directory.

## Version-compatibility checklist (run 3, observed)

- [x] AX deployed at `4b7bf6f84cac`, built with its `make images` and deployed with its `make deploy`. One manifest change: `AX_SNAPSHOTS_BUCKET` pointed at a run-owned prefix of `<snapshot-bucket>` (L-031).
- [x] Substrate at `v0.6.0` = `d3f2363590a1`, the version AX's client pins. The installed `603e006` (v0.5.0-45) was wire-incompatible (L-030), so run 3 reinstalled it (in-place upgrade is unsupported upstream).
- [x] Substrate v0.6.0 on GKE needs the snapshot transfer service account `<transfer-sa>` and its three grants (L-043); created with owner approval and recorded in `owned-resources.json` (`iam`).
- [x] GKE 1.36.4 serves `PodCertificateRequest` and `ClusterTrustBundle` at `certificates.k8s.io/v1beta1`.
- [x] `APL_AX_KUBECTL` client 1.36.6, installed separately.
- [x] Nodes: 2 × c3-standard-4, amd64, no autoscaling.
- [x] `kubectl get svc api -n ate-system` succeeds; `ate-api-server` 2/2, all v0.6.0 components Ready; `ax-server` healthy after a restart.
- [x] Images in a private repo `<registry>`, referenced by digest, pulled with the existing node identity.
- [x] Egress policy for the two emulator services, from the v0.6.0 API, attached per task.
- [x] `spec.config` key `apl-run` accepted; encoded task 2.6 KiB (< 31 KiB).
- [ ] `ax version` output: not recorded in `RESULTS.md`.

## Tests (pre-registered before run 3; results in `RESULTS.md` §3.3)

1. **Command result.** Run one passing case and one deliberately failing case. The collector must report PASS and FAIL from emulator state plus `/apl/result`. AX task phase is recorded but never used. Expect phase and outcome to disagree for the failing case.
2. **Termination.** `ax delete task` (or suspend) on a long-running command that traps SIGTERM, then on one that ignores it. Expect `exit_code` 128+15 or the trap's code, and 137 after about 10 s. Measure stop latency.
3. **Isolation.**
   - From inside the task, try to reach the AX/Substrate control plane, another atespace's actor, and a public host outside the egress policy. All must fail.
   - The metadata port must not be reachable from the collector.
   - The task env must not contain the collector's or simulator's credentials.
4. **Resume.** Suspend and resume: `.apl/prepared` is unchanged, agent edits survive, and the command restarts with a new process tree.
5. **Same assertions.** The case's `cases.ax.json` expectations equal the local lane's, apart from documented `profile: ax` fields.

## Run dir (`private-runs/ax/<run-id>/`, gitignored)

| File | Written by | Read by |
|---|---|---|
| `owned-resources.json` | `index.ts run()` via `ownedResources()`, before anything is applied; run 3's was assembled by the operator | `teardown.sh`, after validating it |
| `pre-snapshot.json` | `teardown.sh --snapshot <run-dir> pre-snapshot.json` (`run()` calls it before applying) | `teardown.sh` post-snapshot diff |
| `kubeconfig` | `run()`: single-context `kubectl config view --minify --flatten`, mode 0600 | the snapshot |
| `reinstall-delta.json` (optional) | operator, around a Substrate reinstall | `teardown.sh` diff: those lines are expected |
| rendered manifests, `secrets.json`, `emulate-seed.json`, `collector-env.json` | `index.ts` / `orchestrate.ts` | `kubectl` / `ax apply` / the collector |

`owned-resources.json` is defined once, in `run-dir.schema.json`:

- **Required:** `run_id`, `kube_context` (the context the run applied to), and the lists `ax` (`{kind: task|workspace, atespace, name}`), `substrate` (`{kind: atespace|egress-policy, name, atespace}`; an atespace has no `atespace`), `kubernetes` (`{kind, name, namespace}`; a `Namespace` has no `namespace`), `cluster_scoped` (`{kind, name}`), `scaled` (`{kind: WorkerPool, namespace, name, replicas_before}`) and `scaled_namespaces`. Lists may be empty.
- **Optional, each needing `project`:** `ar` (`{location, repo}`), `gcs_snapshot_prefix(es)` (`gs://<bucket>/<prefix>/`), `iam` (a `service-account` `{email}` or an `iam-binding` `{resource_type: bucket|service-account, resource, member, role}`), `gke_cluster` (`{name, location}`, a whole cluster the run created) and `gcs_buckets` (`gs://<bucket>`, whole buckets the run created).
- **Optional:** `substrate_install` (`repo`, `current` and `previous` `{version, commit, config}`, `previous.rollback_dir`), needed by `--restore-substrate-v05`; `local` (`bin` prepended to `PATH`, `ax_cli`, `bin_v050`, `docker_config`); `images`, `short_id`, `zone`, `cluster` (informational).

Any other key is an error. Run `node profiles/ax/run-dir.ts <run-dir>/owned-resources.json` to check a file; errors name schema paths, never values.

## Teardown (`teardown.sh`; only `--dry-run` has ever run)

`profiles/ax/teardown.sh <run-dir> [mode] [--dry-run]`. Before any action it refuses unless `owned-resources.json` validates against the schema **and** the current kube context equals its `kube_context`. It then pins that context in `<run-dir>/teardown-kubeconfig` for every later call. Identifiers come only from the run dir. `--dry-run` prints every command and makes no cluster or cloud call (it does read the local kubeconfig).

| Mode | What it does | Risk |
|---|---|---|
| (default) | `ax delete` each Task, then each Workspace, through its own port-forward to `ax-server`; `kubectl ate delete` the run's egress policies and atespaces; deletes the listed namespaced objects by exact name, then the listed namespaces and cluster-scoped objects; restores each `scaled` WorkerPool to `replicas_before` (or deletes it with `--delete-benchmarks`); removes the run's `gs://` snapshot prefixes and the `ar` repo; takes a post-snapshot and diffs it against `pre-snapshot.json`. Leaves Substrate v0.6.0, `<transfer-sa>` and its grants in place and prints them | Deletes only listed names, but for run 3 the list includes `ax-system` and AX's ClusterRole, ClusterRoleBinding and PV. A pool the reinstall removed cannot be restored here (reported). gcloud deletes keep their interactive confirmation |
| `--remove-substrate-iam` | Default, plus removes exactly the recorded `iam-binding`s, then the recorded service account | Substrate v0.6.0's `ate-api-server` refuses to start without the account; snapshots and restarts fail from then on |
| `--restore-substrate-v05 --yes-clear-node-image-cache` | Default, plus: clone Substrate at the recorded commits; `ate-setup delete ate-system` with the current build; clear `/var/lib/ate/image-cache` on every node; `ate-setup deploy` the previous build with its recorded config; `pg_restore` the pre-reinstall dump; recreate the scaled WorkerPools from the rollback manifests; switch `kubectl-ate` back; then `--remove-substrate-iam` | Replaces the running Substrate; everything created on v0.6.0 is lost. The cache wipe is one privileged Pod per node (`hostPath /var/lib/ate`, namespace `default`, labels `apl-run=<run-id>,apl-role=image-cache-wipe`); only Pods with those labels are waited on and deleted, but the cache removal itself affects the whole node. Without `--yes-clear-node-image-cache` a real run refuses; `--dry-run` prints a warning. Whether restored suspended actors resume is UNKNOWN (actor-identity keys are regenerated on install). Never executed |

`--snapshot <run-dir> <out.json>` takes a snapshot only, with the same schema and context checks.

A run that created its own cluster and bucket (`gke_cluster`, `gcs_buckets`) takes its `pre-snapshot.json` with `--project-snapshot <run-dir> <out.json>` before the cluster exists (project-level only: clusters, buckets, disks, registries; schema check, no context check). Default mode then also removes exactly the recorded `iam-binding`s on those buckets, deletes each bucket with its objects, deletes the cluster, then deletes the Compute disks its PersistentVolumes had provisioned, and diffs project-level state only. IAM the run reused (for example `<transfer-sa>` and its Workload Identity grant) is left alone. Only `--dry-run` of this path has run (`tests/run-dir.test.ts`).
