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
| W01-H case, collector bundle, `evaluate_ax.py` | EXECUTED (cluster, gVisor, run 3): F3-A1 and AX-R1 PASS | `RESULTS.md` run 3 |
| Behaviour under gVisor, Substrate egress, suspend/resume, eviction | EXECUTED (cluster, run 3); microVM never run | `RESULTS.md` run 3 |

Three authorized cluster runs happened (`RESULTS.md`). The local tests still run plain Docker containers, not a Substrate sandbox; only run 3's cluster results say anything about gVisor. On Substrate v0.6.0 the collector reads `/apl/result` through the router over mTLS with its own pod certificate (L-045).

## Pinned upstream revisions (read 2026-10-28)

| Repo | Commit | Files read |
|---|---|---|
| `google/ax` | `4b7bf6f84cac7eb12f21b87a76c8dc85155dce38` | `README.md`, `docs/runner.md`, `docs/manifests.md`, `docs/sandbox.md`, `pkg/apis/v1alpha1/ax.proto` |
| `agent-substrate/substrate` | `6d7b3f49f6154d52a1de46c94a1481868a5ed042` | `README.md` |

Both projects say they are pre-stable and may break. Re-read these files at the SHA you deploy.

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
- `teardown.sh`: deletes exactly what `owned-resources.json` lists, restores scaled worker pools, then diffs a post-snapshot against the pre-snapshot.

## In-cluster placement (as deployed; superseded design notes below)

```
kube context $APL_AX_CONTEXT
├── ate-system        Substrate (pre-installed; Control API svc/api:443)
├── ax-system         AX control plane (pre-installed)
├── atespace apl-<run-id>    AX Workspace apl-ws-<run-id>, Task apl-task-<run-id>  (manifests/ax/task.yaml)
└── namespace apl-<run-id>   Floci + Emulate Deployments/Services, NetworkPolicy  (manifests/k8s/emulators.yaml)
                             collector Job (owned by the collector builder, separate identity)
```

- **Namespace-local emulators.** Emulate and Floci run in the run's namespace. The task reaches them by cluster DNS (`floci.apl-<id>.svc.cluster.local:4566`, `emulate.apl-<id>.svc.cluster.local:8080`). There is no tunnel to the laptop. Floci uses the digest pinned in `compose.yaml`. The Emulate image wraps the pinned npm package, must be built by the lab in W6 and is pinned by digest (`APL_EMULATE_IMAGE`).
- **Substrate networking.** Actors are default-deny and send outbound traffic through `atenet-egress`. The task cannot reach the emulators until an egress policy allows those two services. Write that policy from Substrate's `docs/egress-traffic.md` at the pinned SHA. It is not drafted here because that doc has not been read yet. The NetworkPolicy assumes the egress gateway runs in `ate-system`; verify that before W6.
- **Collector.** A Job in the run namespace, with its own credentials. It reads Floci and Emulate state directly, plus `/apl/result` through the Substrate router (the router's ingress SPIFFE allowlist must include the collector). It writes the C4 bundle. Task phase `Running` or `Succeeded` is never an observation of success.
- **Manifests.** `${APL_*}` placeholders are filled by `render()` in `index.ts`, and an unknown placeholder is an error. Rendered copies and `owned-resources.json` go to gitignored `private-runs/ax/<run-id>/`. No real project, cluster or registry name appears in this directory.

## Version-compatibility checklist (fill before W6)

- [ ] AX commit deployed = `4b7bf6f…` or re-read the five files above at the new SHA. Record `ax version`.
- [ ] Substrate commit deployed = `6d7b3f4…` or re-read at the new SHA.
- [ ] GKE ≥ 1.36 with `PodCertificateRequest` and `ClusterTrustBundle` APIs. On 1.36 they are beta APIs that must be enabled, and node pools created before enabling them must be replaced. 1.37+ serves them by default.
- [ ] `APL_AX_KUBECTL` client ≥ 1.35.
- [ ] Nodes are x86 (c3), so the image manifest includes `linux/amd64`.
- [ ] `kubectl get svc api -n ate-system` succeeds and the AX server in `ax-system` is healthy.
- [ ] Image pushed to a registry the cluster can pull, referenced by digest.
- [ ] Egress policy for the two emulator services drafted from the pinned Substrate docs.
- [ ] `ax apply` accepts `spec.config` keys containing `-` (`apl-run`), and the whole encoded task stays under 31 KiB.

## Tests to run once authorized (W6)

1. **Command result.** Run one passing case and one deliberately failing case. The collector must report PASS and FAIL from emulator state plus `/apl/result`. AX task phase is recorded but never used. Expect phase and outcome to disagree for the failing case.
2. **Termination.** `ax delete task` (or suspend) on a long-running command that traps SIGTERM, then on one that ignores it. Expect `exit_code` 128+15 or the trap's code, and 137 after about 10 s. Measure stop latency.
3. **Isolation.**
   - From inside the task, try to reach the AX/Substrate control plane, another atespace's actor, and a public host outside the egress policy. All must fail.
   - The metadata port must not be reachable from the collector.
   - The task env must not contain the collector's or simulator's credentials.
4. **Resume.** Suspend and resume: `.apl/prepared` is unchanged, agent edits survive, and the command restarts with a new process tree.
5. **Same assertions.** The case's `cases.ax.json` expectations equal the local lane's, apart from documented `profile: ax` fields.

## Teardown (DESIGNED)

1. Before applying, snapshot the resource inventory: `gcloud asset search-all-resources` for the approved scope, plus `kubectl get all,netpol,cm,secret -A -l apl-run=<id>` (expected empty). Keep it in `private-runs/ax/<id>/pre.json`.
2. Run `ax delete task apl-task-<id> -a apl-<id>`, then `ax delete workspace apl-ws-<id> -a apl-<id>`.
3. Run `kubectl delete all,netpol,cm,secret,job -n apl-<id> -l apl-run=<id>`, then `kubectl delete namespace apl-<id>`. Only names listed in `owned-resources.json` are deleted; never delete by a broader selector.
4. Re-list with the same commands into `post.json` and diff against `pre.json`. Teardown passes only when the diff is empty, apart from unrelated changes that are recorded as such.
5. Remove the pushed image digest only if this run pushed it.
