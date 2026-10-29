Status: build plan for [`MULTI_CLUSTER.md`](MULTI_CLUSTER.md), written after EGM review round 4. Verified by its phase gates and dry run, not by document review.

# Multi-tenant and two-cluster AX runs: build plan

The design (what is tested, what is asserted, what may be claimed) is [`MULTI_CLUSTER.md`](MULTI_CLUSTER.md), cited here as "design §n". This file says how it is built and run. Where the code already does something, it points at the code instead of restating it. If a gate or the dry run contradicts a statement here, the statement is fixed. Upstream files are cited by repo-relative path at AX `4b7bf6f` and Substrate v0.6.0 `d3f2363`.

## 1. Components and command lines

### 1.1 `profiles/ax/multi.ts`

It makes every cluster call for these runs (design rule 9). It reuses `doctor()` and `render()` (`profiles/ax/index.ts`) and `ownedResources()`, `manifestObjects()` and `ownedResourcesErrors()` (`profiles/ax/run-dir.ts`), extended as in §2, rather than copies of them.

| Subcommand | Input | Output | Calls |
|---|---|---|---|
| `plan` | set ID, the two infrastructure run dirs, the tenant-run registry | `private-runs/ax/sets/<set_id>/plan.json`: clusters, configurations, tenant runs by kind (design 6.1), evidence run IDs, tasks per round, controls | none at step 1; at step 2 the read-only queries of §1.3 on A (§4.6) |
| `infra` | one cluster's infrastructure run dir | §4.1 | `kubectl apply`, `scale`, `patch`, `delete`; `gcloud container clusters resize`; the read-only queries of §1.3 |
| `run-step` | `plan.json`, that cluster's infrastructure run dir | the step run dir, tenant run dirs, rendered manifests, `artifacts/runs/<run_id>/` per bundle with its `checksums.sha256`, `timing-raw.json`, log extracts, `stopped.json` | `doctor()`, `teardown.sh --snapshot`, §4.2 to §4.5, then `teardown.sh <step-run-dir>` |
| `report` | the bundles, `stopped.json` | stop bundles (§11.3); per bundle `report.json`, `report.md` and export; then the aggregate (§11.4) | `evaluate_ax.py`, `generateReport()`, `agrees()`, `exportRun()`, `aggregate.ts` |

```
multi.ts plan      --step 1|2 --set-id <uuid> --infra-a <dir> [--infra-b <dir>] [--step1-set-id <uuid>]   # step 2 names step 1's set when A is reused
multi.ts infra     a|b --infra <dir> [--resize 0|2] [--dry-run]                                         # --resize: B's node pool only
multi.ts run-step  --plan <plan.json> --cluster a|b [--dry-run]
multi.ts report    --plan <plan.json>
orchestrate.ts manifests --tenant --dir <tenant-run-dir> --set-id <uuid> --cluster a|b --tenant-role t1|t2|t3|t4
orchestrate.ts manifests --dir <tenant-run-dir> --task <name> --mode W01-H|isolation|term --image <ref>
               --emulate-ip <ip> --floci-ip <ip> --set-id <uuid> --cluster a|b --tenant-role t1|t2|t3|t4 [--probes <file>]
collector.ts observe --case F3-A1 --task <task> --atespace <a> --run-id <uuid> --out <dir> --ax-phase-file <f> --run-facts <f>
collector.ts observe --run --case MT-W01|MT-ISO --atespace <a> --run-id <uuid> --out <dir> --run-facts <f>
               --foreign-markers-file <f> [--task <task> --targets-file <f> --egress-log-file <f> --disclosure-file <f>]
               # MT-ISO requires --task: the probing task (`iso`, or `ctl` for the planted control) whose isolation.json it reads
evaluate_ax.py <case> <bundle-dir>      # unchanged; reads cases.ax.json
```

### 1.2 Environment per cluster

Every value comes from that cluster's infrastructure run dir. Nothing is read from the ambient environment except `APL_AX_AUTHORIZED`.

| `doctor()` variable | Source |
|---|---|
| `APL_AX_KUBECTL` | `local.kubectl` in `owned-resources.json` (`local` accepts extra string keys). It must be `<local.bin>/kubectl`, a client ≥ 1.35, so that `teardown.sh`, which prepends `local.bin` to `PATH`, uses the same client |
| `APL_AX_CONTEXT` | `kube_context` |
| `APL_AX_IMAGE` | `lab_image` in `versions.json` (phase 6) |
| `APL_AX_CLI` | `local.ax_cli` |
| `APL_AX_SUBSTRATE_API` | `api.ate-system.svc.cluster.local:443`, the upstream default named in `index.ts` |
| `APL_AX_AUTHORIZED` | `1`, set by the operator for the session after the owner's go-ahead; never written to a file |

A BLOCKED doctor or a missing opt-in leaves that cluster's rows BLOCKED and makes no call there. A dry run reports a BLOCKED doctor and goes on printing the planned calls, since it makes none.

- Every subprocess (`kubectl`, `kubectl ate`, `ax`, `teardown.sh`) gets `KUBECONFIG=<run-dir>/kubeconfig` in its environment, and `kubectl` calls also pass `--kubeconfig`. `kubectl ate` is the plugin build in `local.bin`, reached through kubectl's plugin mechanism, so the environment pins its cluster whether or not kubectl forwards the flag. kubectl refuses flags before a plugin name, so the runner passes `kubectl ate --kubeconfig <file> …`. The dry run prints, per cluster, `kubectl config current-context` run with that environment and fails unless it equals the plan's context.
- `AX_HOME=<run-dir>/axhome` for every `ax` call, as `teardown.sh` sets it.
- One port-forward per cluster to `svc/ax-server` port 8080, opened with that kubeconfig; `ax --server http://127.0.0.1:<port>` (L-033). If it dies it is reopened once. A second failure stops the step, and the round's remaining bundles are BLOCKED ("AX API unreachable").
- `kubectl ate` opens its own port-forward per call, as in run 3. Its `--endpoint` flag (`cmd/kubectl-ate/internal/cmd/root.go`) could reuse one forward; this plan does not need that optimisation.

### 1.3 `versions.json`

Written by `multi.ts infra` from read-only queries. B's exists; A's is written the same way before step 1.

| Field | Query |
|---|---|
| `gke.master`, `gke.nodes` | `gcloud container clusters describe <cluster> --project <p> --location <zone> --format=json`: `currentMasterVersion`, `currentNodeVersion` |
| `kubectl_client` | `$APL_AX_KUBECTL version --client -o json` |
| `substrate.version`, `substrate.commit` | image digests of the `ate-system` Deployments (`kubectl -n ate-system get deployments -o json`), each looked up in the run dir's `images` list, whose `source` names the commit it was built from |
| `substrate.kubectl_ate` | `<local.bin>/kubectl-ate --version` |
| `ax.commit`, `ax.ax_server` | the `ax-server` image digest (`kubectl -n ax-system get deployment ax-server -o json`), looked up in `images` |
| `ax.client_pins_substrate` | the Substrate module version in AX's `go.mod` at `4b7bf6f` |
| `lab_image` | the digest pushed in phase 6 |
| `lab_commit` | the commit that image was built from (`printenv APL_CANDIDATE_REVISION` in phase 6's gate); `run-step` compares the first bundle's `candidate_revision` with it, and stop bundles carry it |

`client_pins_substrate`, `lab_image` and `lab_commit` are not cluster queries; `multi.ts` carries them from the recorded file (`client_pins_substrate` is fixed by `ax.commit`, which is re-read).

A digest missing from `images` is an error: the identity check of the all-clusters view (design 8.4) must not guess.

## 2. Files

| Action | File | Change |
|---|---|---|
| Create | `profiles/ax/multi.ts` | the runner (§1), the context guard (§8.4) |
| Create | `profiles/ax/multi-facts.ts` | pure functions: `foreignMarkerCount()`, `egressExtractArgs()`, `parseEgressLog()`, `crossTenantUpstreams()`, `redactAddresses()`, `serverIntervals()`, `commandDuration()`, `resumeSpread()`, `agrees()`, `p50()` by nearest rank |
| Create | `profiles/ax/egress.ts` | policy template, attach, gateway log extract (§9) |
| Create | `profiles/ax/manifests/k8s/tenant.yaml`, `collector.yaml` | §5 |
| Create | `profiles/ax/tests/fixtures/atenet-egress-access-log.yaml` | the vendored access-log blocks (§9.3) |
| Create | `src/reports/aggregate.ts` | the roll-up only (§11.4) |
| Create | `tests/unit/{report-wording,multi-facts,aggregate,ax-render,ax-multi}.test.ts`, `tests/integration/ax-collector.test.ts` | the gates of §3 |
| Modify | `profiles/ax/cases.ax.json` | MT-W01, MT-ISO and the longer `recorded_not_asserted` list (design 6.2) |
| Modify | `profiles/ax/case.ts` | `APL_AX_PROBES` replaces `APL_AX_PROBE_IPS` (§10); the probe writes `apl-evidence/<task>/isolation.json` to bucket `<task>-receipts` in its own Floci (`resourceNames()` in `src/adapters/floci/clients.ts`), creating the bucket if absent; the relay fix below |
| Modify | `profiles/ax/orchestrate.ts` | `--probes` replaces `--probe-ips`; `manifests --tenant` renders `tenant.yaml` with `render()`; `--set-id`, `--cluster`, `--tenant-role`; `spec.config` and `.apl/run.json` gain `apl-set`, `apl-cluster`, `apl-tenant` next to their current keys |
| Modify | `profiles/ax/collector.ts` | `--run-id`, `--run-facts`, `observe --run` (no task, no `/apl/result` capture), cases MT-W01 and MT-ISO, the four input files, redaction before any write. It still reads `APL_AX_COLLECTOR` and `APL_AX_ALLOWLIST` from an environment set before the process starts (§6) |
| Modify | `profiles/ax/run-dir.ts` | `manifestObjects()` also parses the JSON documents `orchestrate.ts manifests` writes; `ownedResources()` takes a list of atespaces; `recordOwned()` (§8.2) |
| Modify | `profiles/ax/run-dir.schema.json` | §8.3 |
| Modify | `profiles/ax/teardown.sh` | its substrate row filter also skips entries with `removed_at` (one expression) |
| Modify | `profiles/ax/index.ts` | `run()` returns BLOCKED with reason "cluster runs go through profiles/ax/multi.ts (docs/MULTI_CLUSTER_BUILD.md)" and makes no call; `doctor()` and `render()` unchanged |
| Modify | `src/reports/artifacts.ts` | `generateReport()` takes optional `expected` and `limitations`; without them it behaves as today |
| Modify | `src/reports/report.ts` | AX wording and limitation by profile (§11.1); `lanesFrom(local, optional, profile?)`, the new argument optional so the existing caller and `tests/integration/evidence.test.ts` stay as they are |
| Modify | `docs/RESEARCH.md` | the proto read of design 9.1 (file, service or message, field) |
| Modify | `docs/LEARNINGS.md`, `docs/CLAIM_LEDGER.md` | pre-registered expectations before each step; set XM rows only when their evidence exists |

Unchanged: `allowlist.ts`, `runner/main.go`, `runner/Dockerfile.lab`, `manifests/k8s/emulators.yaml`, `evaluate_ax.py`, `src/reports/export.ts`, the supplied `evaluate.py` and `cases.json`.

**The relay fix in `case.ts`.** Emulate's mailbox keeps every delivery of the tenant run (`profiles/ax/emulate/server.mjs`), and `case.ts` relays from `after=0`, so each task would replay earlier tasks' mentions, which the worker accepts inside the 300 s signature window (`MAX_SKEW_SECONDS`, `src/adapters/slack/signature.ts`). The coordinator reads `/_apl/events?after=0` once before posting its own mention and relays only from the highest `seq` found.

## 3. Phases and test gates

Each phase ends when its gate and the existing `npm test` pass. No cluster call happens before phase 6's gate and the owner's go-ahead, except resizing B's node pool to 0.

1. **Reports and cases.** `report.ts` wording, `generateReport()` options, `cases.ax.json`, `RESEARCH.md`. Gate `report-wording.test.ts`: AX strings and limitation for profile `ax`; local strings, `lanes.local` and `lanesFrom()` without a profile unchanged; `generateReport()` with `expected` still refuses a tampered evidence file and an escaping path; a bundle copied with the §4.3 helper and altered afterwards is refused by its first `generateReport()` (the L-022 check runs only when `checksums.sha256` exists); `evaluate_ax.py` loads MT-W01 and MT-ISO and still refuses a table that asserts a recorded-only key.
2. **Facts and roll-up.** `multi-facts.ts`, `aggregate.ts`. Gate `multi-facts.test.ts`:
   - markers found, not found, only in an excluded file, absent with no foreign tenant run, and two tokens in one text both found (global copies of `SECRET_RULES`, whose regexes in `export.ts` are not global);
   - `parseEgressLog()` on lines built from the fixture's five formats; an `ip:port` upstream stripped to its address; null and `-` upstreams not counted; own addresses not counted;
   - incomplete extracts (pod set changed, restart count changed, control line missing) and a self-report mismatch each give absent with the reason;
   - the truncation fixture: a 25-line extract from two pods is parsed whole, and `egressExtractArgs()` refuses to build a command without `--tail=-1`, `--prefix` and `--max-log-requests`;
   - `serverIntervals()` with `workspaceReady=false` gives absent; `commandDuration()` on a `result.json`; `p50()` at n = 29, 30 and 32; `agrees()` on every pair of §11.2.

   `aggregate.test.ts` covers §11.4.
3. **Templates and run dirs.** `tenant.yaml`, `collector.yaml`, `orchestrate.ts`, `case.ts`, `egress.ts`, `run-dir.ts`, the schema, the `teardown.sh` filter. Gate `ax-render.test.ts`:
   - every placeholder of §5 filled and an unknown one refused; requests, the `atenet-egress` rule, `emulate-seed`, the namespace form of `allowlist.ts`, pool replicas 3 and the Secret mounted whole;
   - the policy shape of §9.1; `manifestObjects()` on JSON tasks; `ownedResources()` with two atespaces; `recordOwned()` refusing an entry the schema rejects; the schema cases of §8.3;
   - the relay skipping earlier deliveries; the probe sending its Host header and getting 404 from a local Floci and `profiles/ax/emulate/server.mjs` on each path of §10, and writing `isolation.json` into `<task>-receipts`; no `--probe-ips` or `APL_AX_PROBE_IPS` left;
   - the ConfigMap comparison of §9.3 accepting the fixture and refusing a copy with one field changed.

   The existing `tests/integration/ax-profile.test.ts` (with `run()` now BLOCKED and naming `multi.ts`) and `profiles/ax/tests/run-dir.test.ts` also pass.
4. **Collector.** Gate `ax-collector.test.ts`: `observe` for F3-A1 and `observe --run` for MT-W01 and MT-ISO, on synthetic captures, write bundles that pass C4 validation. Recorded keys come from `--run-facts`, no written file contains an IP, and `candidate_revision` comes from the image environment, not from the env file.
5. **Runner.** Gate `ax-multi.test.ts`:
   - the plan: bundles per tenant-run kind (design 6.1), no MT-W01 for the probe run, and a `<tr8>` equal to the collector's or to a registered one refused;
   - the context guard: another cluster's kubeconfig, port or `gcloud` cluster refused, and `KUBECONFIG` set in every subprocess environment;
   - the setup order of §4.2, each object recorded before its create; a leftover actor recorded, deleted and marked `removed_at` after its round, actor before template;
   - each row of §4.4 producing its listed bundle; `stopped.json` turned into the stop bundles of §11.3, checksummed;
   - a dry run that prints every planned call, makes none, and asserts the resolved context per cluster; `npm run validate:package`.
6. **Lab image.** Build from a clean tree (`git status --porcelain` empty) at the commit that passed gates 1 to 5: `docker buildx build --platform linux/amd64 -f profiles/ax/runner/Dockerfile.lab --build-arg APL_CANDIDATE_REVISION=$(git rev-parse HEAD) .`. Push it to the private repo (the push needs owner approval), resolve the digest, and record `lab_image` as `<registry>/apl-lab@sha256:…` in both clusters' `versions.json`. Gate: `docker run --rm --entrypoint printenv <lab_image> APL_CANDIDATE_REVISION` prints that commit; the existing image test (linux/amd64, runner at `/usr/local/bin/ax-task-runner`) passes on it; the rendered tenant and collector manifests carry that digest. During the run, `run-step` checks that the first bundle's `candidate_revision` equals the commit and stops if it does not.

## 4. Run flow

### 4.1 Infrastructure

- **`multi.ts infra a`.** It writes A's `versions.json`, patches WorkerPool `apl-ax-pool` to `replicas: 3`, and scales the infrastructure run's own Floci and Emulate in `apl-ax-6882d106` to 0. It applies the collector NetworkPolicy, then deletes Pod `apl-collector` and recreates it from `collector.yaml`, because a Pod's `envFrom`, volumes and image cannot be patched. The Pod is already listed in A's run dir, so the record does not change. The preflight lists WorkerPools and stops if any other exists.
- **`multi.ts infra b`.** It applies `collector.yaml` (Namespace, ServiceAccount, Pod, NetworkPolicy, WorkerPool at 3), recording each object in B's run dir before its create. `gcloud container clusters resize <cluster> --node-pool <pool> --num-nodes 0|2` takes the pool name from `gke_cluster.node_pool` in B's run dir (§8.3).
- **B's install (done, recorded in B's run dir; moved from design 8.1).** Substrate v0.6.0 was installed with its own `ate-setup` from a config derived from A's install config and the v0.6.0 requirements in L-046: a cluster-wide `--snapshot-location` in B's own bucket, `--ingress-allowed-spiffe-ids` including the collector, `ax-server` as a bootstrap owner, home-built v0.6.0 images. AX `4b7bf6f` was deployed with `AX_SNAPSHOTS_BUCKET` pointed at a B-owned prefix (L-031).
- **Gateway config.** Before step 1, and before step 2 on B, the deployed `atenet-egress` ConfigMap is read (read-only) and compared with the fixture (§9.3). A difference is stop rule 8.

### 4.2 Per tenant run

Each object is added to the step run dir's `owned-resources.json` before it is created (§8.2):

1. `orchestrate.ts init`.
2. `orchestrate.ts manifests --tenant` renders `tenant.yaml`.
3. `kubectl apply` of it.
4. `kubectl wait -n apl-ax-<tr8> --for=condition=Available deployment -l apl-run=<tenant_run_id> --timeout=180s`.
5. Read the Emulate and Floci ClusterIPs and pod IPs (`kubectl get svc,endpoints`) into the targets file.
6. `orchestrate.ts manifests --task` for each task, with those ClusterIPs.
7. Add the tenant's key to `collector-env-tenants` (§6), then wait until its file exists in the Pod.

### 4.3 Per round

1. `ax apply` the c tasks.
2. For each task, poll every 0.5 s, up to 120 s, for its actor, and attach its policy (§9.2) as it appears.
3. Once all c are attached, issue the c `ax resume` calls in parallel and wait for the c results in parallel (`collector.ts result --wait-ms 120000`).
4. For each task:
   - keep only the phase from `ax get task` in `phase-<task>.json` (the full output holds tokens in clear, L-034), and copy it into the Pod;
   - read its actor once (`kubectl ate get actor <task> -a <atespace> -o json`, the call of §9.2) and record `status.workerAssignment.worker` as the task row's `worker` in `timing-raw.json`, or absent with a reason if it is empty (recorded, not asserted; design 7.1, 11.3). The attach poll runs before resume and the cleanup listing after delete, so neither shows the running actor's worker;
   - run `observe` while the actor still serves `/apl/result`;
   - copy the bundle to `artifacts/runs/<run_id>/` and call `writeChecksums()` (`src/reports/report.ts`) on it at once, so its first `generateReport()` already checks it.
5. Delete the c tasks, and save the round's ax-server log extract (§12).
6. Clean up leftover actors:
   - list actors and actor templates in each tenant atespace (`kubectl ate get actors -a <atespace> -o json`, then `get actor-templates`);
   - record each leftover in the step run dir, actors before templates, and delete it with `kubectl ate delete actor|actor-template <name> -a <atespace>`;
   - set `removed_at` on its entry once a second listing no longer shows it;
   - record the counts and each leftover's `status.workerAssignment.worker` in the set dir.

A run-level bundle (MT-W01, MT-ISO) is observed with `observe --run` after the tenant run's last round, before its emulators are scaled to 0. For MT-ISO the collector writes the gateway-log extract into the bundle's evidence with every address replaced by its role (`redactAddresses()`), so the export carries the redacted copy; the verbatim `egress-<task>.json` stays in the set dir (design 11.1).

### 4.4 Failures within a round

| Failure | Effect |
|---|---|
| actor not listed within 120 s, or a task unscheduled for 120 s | stop rule 4 |
| `ResourceExhausted` from any call | stop rule 4 |
| egress policy attach fails | that task is not resumed; its bundle is BLOCKED ("egress policy not attached"); the round continues |
| `ax resume` fails | that task's bundle is BLOCKED ("resume failed: <code>"); the round continues |
| result not served within 120 s | observe anyway: `command_exit_code` is absent, so F3-A1 is UNKNOWN (design rule 3) |
| `observe` exits nonzero or writes no bundle | a `stopped.json` entry, NOT_RUN ("collector exited <code>"); the round continues |
| `ax apply` fails | that task's bundle is BLOCKED ("ax apply failed: <code>"); the round continues |
| a tenant's emulators not Available within 180 s (§4.2 step 4) | the step stops; unobserved bundles NOT_RUN, as capacity |
| a tenant's collector env file not in the Pod within 120 s (§4.2 step 7) | the step stops; unobserved bundles BLOCKED |
| task delete fails | recorded in the set dir; the task stays listed, so teardown deletes it; its actor is not treated as a leftover |
| leftover actor delete fails | the entry keeps no `removed_at`; teardown deletes it |
| port-forward dies twice | the step stops; remaining bundles are BLOCKED ("AX API unreachable") |
| context mismatch | stop rule 2 |

### 4.5 Actor probe

One probe tenant run has `apl-<tr8>-p1` in round 1 and `apl-<tr8>-p2` in round 2. Both are rendered as W01-H tasks and run through §4.3, with `kubectl ate get actors -a <atespace> -o json` saved after each apply, result and delete. From these listings the runner records G (the after-result count minus the task's own actor), L (the after-delete count), and whether a leftover holds a worker slot (a non-empty `status.workerAssignment.worker`), before step 6 of §4.3 removes it, under `actor_probe` in the set dir's `run-step-<cluster>.json`.

### 4.6 Step 2 and A's half (design 8.3)

- `multi.ts plan --step 2` re-runs the read-only queries of §1.3 on A into the set dir as `versions-a-step2.json` and compares it field by field with A's `versions.json` recorded for step 1. It also checks that A's and B's `versions.json` name the same `lab_image` digest.
- If both checks pass, the plan has no A configuration. `plan.json` records `"a": {"reused": {"set_id": "<step 1 set_id>", "c": 1}}`, and the all-clusters view takes A's row from that configuration's reports.
- If either check fails, the plan lists the differing fields (`"a": {"rerun": {"differences": [...]}}`), and A is planned first exactly as B: one tenant, c = 1, a warm-up round and 30 counted tasks. If A's doctor is BLOCKED, the versions cannot be re-read and `plan --step 2` refuses rather than guess.
- `ax-multi.test.ts` (phase 5) covers both outcomes of the plan.

## 5. Templates and placeholders

`render()` (`index.ts`) replaces `${APL_*}` placeholders and refuses an unknown one. The templates use only these:

| Placeholder | `tenant.yaml` | `collector.yaml` |
|---|---|---|
| `${APL_RUN_ID}` | the tenant run ID (labels) | the infrastructure run ID (labels) |
| `${APL_SHORT_ID}` | `<tr8>` (namespace `apl-ax-<tr8>`) | `6882d106` |
| `${APL_SET_ID}`, `${APL_CLUSTER}`, `${APL_TENANT}` | labels `apl-set`, `apl-cluster` (`a` or `b`), `apl-tenant` (`t1` to `t4`) | not used |
| `${APL_FLOCI_IMAGE}`, `${APL_EMULATE_IMAGE}` | digest-pinned images, as in `index.ts` | not used |
| `${APL_COLLECTOR_NS}` | `apl-ax-6882d106`, in the NetworkPolicy's namespace selector | not used |
| `${APL_LAB_IMAGE}` | not used | `lab_image` from `versions.json` |
| `${APL_WORKER_IMAGE}` | not used | the v0.6.0 worker image digest in that cluster's `images` list |
| `${APL_POOL_REPLICAS}` | not used | `3` |

**`tenant.yaml`, per tenant:**

- the Namespace;
- Floci and Emulate, with requests of 100m CPU and 256Mi per container and `emulators.yaml`'s limits, and their Services;
- Secret `emulate-seed`;
- a NetworkPolicy admitting `atenet-egress` from `ate-system` (as in `emulators.yaml`) and the collector by namespace and pod label (`kubernetes.io/metadata.name: apl-ax-6882d106` plus `app: apl-collector`).

Every object carries the labels `apl-run`, `apl-set`, `apl-cluster`, `apl-tenant` and `apl-role=tenant`.

**`collector.yaml`, derived from `emulators.yaml`'s collector half:**

- Namespace, ServiceAccount, and Pod `apl-collector` (`automountServiceAccountToken: false`, `restartPolicy: Never`, the pod-identity and servicedns-CA projected volumes as in `emulators.yaml`);
- Secret `collector-env-tenants`, mounted whole at `/etc/apl/collector-env`: no `subPath`, so key changes reach the running Pod, and `optional: true`, so the Pod starts before the Secret exists;
- a NetworkPolicy admitting no ingress to the Pod;
- WorkerPool `apl-ax-pool` (gVisor, with `emulators.yaml`'s template resources).

On A, `infra a` applies only its Pod and NetworkPolicy documents. Both clusters run Dataplane V2, which enforces NetworkPolicy.

## 6. Collector Secret and process

- Each tenant run's `collector-env.json` (from `orchestrate.ts manifests`) becomes key `<tr8>` of `collector-env-tenants`, as two dotenv lines (`APL_AX_COLLECTOR='<json>'`, `APL_AX_ALLOWLIST='<json>'`). `run-step` sets the keys to the current configuration's tenant runs. The Secret is owned by the step run dir.
- One process runs per call, with its own output directory: `kubectl exec apl-collector -- node --env-file=/etc/apl/collector-env/<tr8> --import tsx profiles/ax/collector.ts …`. The environment must be set before any module loads, because `allowlist.ts` installs its address rule from `process.env.APL_AX_ALLOWLIST` when it is imported.
- `APL_CANDIDATE_REVISION` comes from the image (`ENV` in `Dockerfile.lab`), which `kubectl exec` inherits. The env files never set it, `node --env-file` does not override a variable that is already set, and the phase 4 gate checks this.

## 7. Naming and labels

| Thing | Name | Notes |
|---|---|---|
| Set | `set_id` (UUID) | one per execution of a step |
| Infrastructure run | `41dc91c3…` (A), `34c8957e…` (B) | long-lived |
| Step run | `step_run_id` (UUID) | one per step and cluster |
| Tenant run | `tenant_run_id` (UUID), short `<tr8>` | one per tenant per configuration; names the namespace |
| Tenant-run registry | `private-runs/ax/tenant-runs.json` | an entry is appended when a tenant run is created |
| Evidence run | `run_id` (UUID) | one per C4 bundle; keys the bundle, its report and `docs/evidence/<run_id>/` |
| Namespace and atespace | `apl-ax-<tr8>` | the form `allowlist.ts` requires; the plan refuses `6882d106` and any registered `<tr8>` |
| Tasks | W01 `apl-<tr8>-<nn>` (`00` is the warm-up); probe `apl-<tr8>-p1`, `-p2`; MT-ISO `apl-<tr8>-iso`, target `apl-<tr8>-tgt`; planted control `apl-<tr8>-ctl`; Workspace `ws-<task>` | unique across the experiment, so a task name is a usable foreign marker |
| Pool, collector, collector env | `apl-ax-6882d106/apl-ax-pool`, `/apl-collector`, `/collector-env-tenants` | the pool and collector are owned by the infrastructure run dir; the Secret by the step run dir |
| AX objects | no labels (L-008) | `spec.config` keys `apl-run`, `mode`, `apl-set`, `apl-cluster`, `apl-tenant`; `.apl/run.json` keys `apl-run`, `task`, `mode` and the same three |

## 8. Run dirs and the context guard

### 8.1 Contents

- **Infrastructure run dirs**, as in design section 3. Before step 2, B's gains the collector namespace, ServiceAccount, Pod, NetworkPolicy and WorkerPool.
- **Step run dir** `private-runs/ax/<step_run_id>/` holds (a step run dir that exists is never reused: a crashed step is replanned):
  - `owned-resources.json`, listing every tenant namespace with its objects, the atespace, the egress policy (for the record), AX Task and Workspace, leftover actors and templates, and `collector-env-tenants`. It copies `project`, `zone` or `cluster`, and `local` (`bin`, `ax_cli`, `kubectl`) from the cluster's infrastructure run dir, because `teardown.sh` reads `local.bin` and `local.ax_cli` from the run dir it is given;
  - `kubeconfig` (mode 0600, a copy of the infrastructure run dir's, whose current context the guard checks) and `axhome/`;
  - `pre-snapshot.json`, from `teardown.sh --snapshot` before the step's first apply;
  - `stopped.json`, and `teardown.json` (teardown's exit code and `CLEAN` or `INCOMPLETE`, the cleanup status `report` passes on).
- **Set dir** `private-runs/ax/sets/<set_id>/` holds `plan.json`; the tenant run dirs (`secrets.json`, `emulate-seed.json`, rendered manifests), which own nothing; `timing-raw.json`; the ax-server and gateway log extracts; the targets, markers and disclosure files; and the controls' bundles.
- New run dirs leave `substrate_install` absent: the schema requires it to carry a `previous` install, and made-up values there would arm `--restore-substrate-v05`.

### 8.2 Recording one object at a time

`recordOwned(runDir, section, entry)` in `run-dir.ts` reads `owned-resources.json`, appends the entry and validates the result with `ownedResourcesErrors()`. It then writes the result to a temporary file in the same directory and renames it over the old one. It runs before every create, and a validation failure is a programming error that stops the set. `removed_at` is set the same way.

### 8.3 Schema changes

- `substrate[].kind` gains `actor` and `actor-template`. The `if` becomes `{"properties": {"kind": {"enum": ["egress-policy", "actor", "actor-template"]}}}`, so those three kinds require `atespace` and `atespace` rows still may not carry one.
- `substrate[]` gains an optional `removed_at` (string). `teardown.sh`'s substrate rows skip entries that have it.
- `gke_cluster` gains an optional `node_pool`.
- `teardown.sh` deletes substrate rows in recorded order with atespaces last (`sorted()` is stable), so recording actors before templates fixes the delete order.

### 8.4 The context guard, on every call

- **`kubectl` and `kubectl ate`.** Every call passes `--kubeconfig <run-dir>/kubeconfig` and gets `KUBECONFIG` (§1.2). Before each call the runner checks that file's context is the plan's for that step and cluster.
- **`ax`.** Every call goes to the port-forward opened with that kubeconfig. A call whose port belongs to the other cluster is refused.
- **`gcloud`.** Every call passes `--project`, `--location` and the cluster name from that cluster's infrastructure run dir (`project`, `zone`, `gke_cluster` or `cluster`). A call naming another cluster is refused.

The ambient kube context and gcloud configuration are never read. A mismatch stops the set (stop rule 2). `teardown.sh` keeps its own guard: the schema must be valid and the current context must equal `kube_context`; so `run-step` still runs it after a guard refusal whenever it has made a cluster call.

## 9. Egress policies and the gateway log (`egress.ts`)

This moves the logic of run 3's private operator script into the repo, with no private value in it. Policy shapes and log formats are read from the pinned Substrate checkout.

### 9.1 Policy

An `EgressPolicy` (`pkg/proto/ateapipb/ateapi.proto`) is a singleton named `default` under its actor. Its `rules` are an unordered set of allows, and traffic that matches no rule is refused. An `http` rule is evaluated per request on the authority (Host) and port, and the gateway resolves the name and dials it. A hostname must be a DNS name, never an IP (`HttpRule.hostnames`). `kubectl ate create egress-policy` (`cmd/kubectl-ate/internal/cmd/egress_policy.go`) takes one strictly parsed YAML or JSON document. The template, for tenant namespace `<ns>`:

```yaml
rules:
- http: {hostnames: ["emulate.<ns>.svc.cluster.local"], ports: {numbers: [8080, 8081]}}
- http: {hostnames: ["floci.<ns>.svc.cluster.local"], ports: {numbers: [4566]}}
```

The planted control's policy (design 6.4) adds `- http: {hostnames: ["emulate.<foreign ns>.svc.cluster.local"], ports: {numbers: [8080]}}`.

### 9.2 Attach

After `ax apply`, the runner polls every 0.5 s, up to 120 s, until `kubectl ate get actor <task> -a <atespace>` finds the actor. It then runs `kubectl ate create egress-policy <task> -a <atespace> -f <policy>`, records the policy under `substrate`, and logs the operator event `policy_attached`.

### 9.3 Log format and the fixture

The gateway's Envoy config is key `envoy.yaml` of ConfigMap `atenet-egress` in `ate-system` (`manifests/ate-install/atenet-egress.yaml`, container `envoy`, label `app=atenet-egress`). It writes these JSON lines to stdout:

| Leg | When | Fields |
|---|---|---|
| `clienthello` | per connection that matched no filter chain (response flag `NR`) | `leg`, `time`, `actor`, `sni`, `chain`, `destination`, `flags`, `details` |
| `mitm` | per intercepted HTTPS request | `leg`, `time`, `actor`, `sni`, `authority`, `method`, `path`, `protocol`, `status`, `grpc_status`, `flags`, `duration_ms`, `bytes_sent`, `bytes_rcvd`, `upstream`, `upstream_failure`, `termination` |
| `cleartext` | per cleartext HTTP request | as `mitm`, without `sni` |
| `passthrough` | per TLS passthrough connection, unfiltered | `leg`, `time`, `actor`, `sni`, `dialed`, `flags`, `duration_ms`, `bytes_sent`, `bytes_rcvd`, `upstream`, `upstream_failure`, `termination` |

- **The CONNECT line.** The outer CONNECT leg writes a text line, `[egress] authority=… peer_san=… peer_serial=… code=… flags=… up_bytes=… down_bytes=…`, with no upstream. It is kept and never counted.
- **Filtering.** `mitm` and `cleartext` log a request only on status ≥ 400 (runtime key `access_log.min_status`, default 400), on any response flag, on a non-OK gRPC status, or in a 1% sample (`access_log.sample`). Raising that level at the admin port would change Substrate, so probes draw 404s (§10).
- **Upstream.** `upstream` is `%UPSTREAM_HOST%`, an `ip:port`. `parseEgressLog()` strips the port before matching, and treats null and `-` as no upstream: the gateway answered itself (L-049). `cross_tenant_upstream_count` counts `mitm`, `cleartext` and `passthrough` entries that have an upstream.

These blocks are vendored, dedented and otherwise unchanged, in `profiles/ax/tests/fixtures/atenet-egress-access-log.yaml`. Its header names the source repo, path and commit and keeps the Apache-2.0 header. The tests build their log lines from it, and the preflight of §4.1 compares the deployed ConfigMap's access-log blocks with it.

### 9.4 Extract, window and completeness

- **Window.** The bounds come from the probing task's operator events: `from` = `resume_issued` − 10 s, `to` = `result_returned` + 10 s. The runner does not resume the next prober before the previous `to`, and takes the extract no earlier than `to`. The window is a filter, not a measured interval: the margin absorbs the offset between the operator's clock and the node's, and no other task that makes egress runs inside it.
- **Extract.** The runner lists the gateway pods with their restart counts (`kubectl -n ate-system get pods -l app=atenet-egress -o json`) at `from` and again after `to`. It then runs `kubectl --kubeconfig <kc> -n ate-system logs -l app=atenet-egress -c envoy --since-time=<from> --tail=-1 --prefix --max-log-requests=<pod count>`. With a selector, `kubectl logs` keeps only the last 10 lines per pod unless `--tail` is given. The lines are copied verbatim to the `--egress-log-file`, with the window, events, margin, both pod lists and the line count.
- **Completeness.** The extract is complete only if kubectl exited 0, both pod lists name the same pods with the same restart counts, and the window holds the allowed control's entry. Otherwise `cross_tenant_upstream_count` and `allowed_control_reached` are absent, with the reason. `parseEgressLog()` drops lines whose `time` falls outside the window.

## 10. Probes and controls

`APL_AX_PROBES` is a JSON list. An HTTP probe is `{role, address, port, host?, path?, tls?}`; a raw TCP probe is `{role, address, port, tcp: true}`. Names outside the policy fail DNS in the sandbox (L-049), so every probe dials an address. HTTP probes use `node:http`, or `node:https` when `tls` is set, with the target's Service name as the Host header. Every target, the tenant's own included (`own: true`), is in the targets file. `redactAddresses()` maps each address to its role; an address with no role becomes `<unlisted-address>`, and its presence is recorded.

| Target | Address, port and Host | Path |
|---|---|---|
| each other MT-ISO tenant's Emulate | ClusterIP and pod IP, 8080 and 8081, Host `emulate.<ns>.svc.cluster.local` | `/_apl/missing` |
| each other MT-ISO tenant's Floci | ClusterIP and pod IP, 4566, Host `floci.<ns>.svc.cluster.local` | an object in a bucket that does not exist |
| the router | the `atenet-router` ClusterIP, 443, TLS, Host `atenet-router.ate-system.svc`, header `ate-target-actor: apl-ax-<target tr8>/apl-<target tr8>-tgt` | `/apl/missing` |
| the workers | each Pod in `apl-ax-6882d106` whose owner chain reaches WorkerPool `apl-ax-pool` (the runner refuses an empty list): its pod IP on every `containerPort` its spec declares, plus 80, the lab runner's port (`EXPOSE 80` in `Dockerfile.lab`), raw TCP | none |
| the allowed control | the tenant's own Emulate ClusterIP, 8080 | `/_apl/missing` |
| run 3's probes | as in `isolation()` in `case.ts`; by-name ones fail DNS and stay in the self-report | as in `case.ts` |

- **Self-report.** It counts a target as reached when an HTTP probe gets that target's expected 404.
- **Planted control.** Task `apl-<tr8>-ctl` in tenant t1 runs under the planted policy of §9.1 and sends one probe to t2's Emulate ClusterIP with t2's Host. It runs before the four MT-ISO probes and is observed with `observe --run --case MT-ISO` into the set dir. Its count must be at least 1, and its window is excluded from stop rule 3.
- **Marker control.** One tenant run is observed again with its own first task added to the markers file. It runs once on each cluster for the whole experiment, before that cluster's first counted MT-W01 is observed (design 6.4).

## 11. Reports

### 11.1 Wording by profile (`report.ts`)

For profile `ax` only, four strings change:

| String | Today | For profile `ax` |
|---|---|---|
| `MODE_LABEL.scripted` | "local integration run (scripted driver)" | "AX task (scripted driver)" |
| non-green banner | "NOT A SUCCESS: local core <status>" | "NOT A SUCCESS: AX lane <status>" |
| `lanes.local` reason | "local core: required assertions only" | "AX lane: required assertions only" |
| markdown status line | "- Local core: **<status>**" | "- AX lane: **<status>**" |

The fixed limitation "Grants live in the worker-written ledger; …" becomes, for profile `ax` only: "Ledger facts come from an export the in-sandbox coordinator wrote to the task's bucket; the collector reads it with its own credentials but cannot open the sandbox's ledger." The key `lanes.local` stays, and the local lane's wording does not change. `multi.ts report` passes the limitations of design 11.1.

### 11.2 Per bundle

For each planned bundle, `multi.ts report`:

1. writes its stop bundle if `stopped.json` lists it (§11.3);
2. runs `evaluate_ax.py <case> <dir>`;
3. calls `generateReport(run_id, { expected, limitations, cleanup_status })`, with the case's expectations from `cases.ax.json` and the cleanup status from teardown;
4. applies `agrees()`;
5. calls `exportRun(run_id, { outRoot: join(ROOT, "docs/evidence") })`.

The agreement rule:

- evaluate PASS agrees only with report PASS;
- evaluate FAIL whose every reason is `Missing observation: <key>` agrees with report UNKNOWN;
- evaluate BLOCKED agrees with report NOT_RUN or BLOCKED;
- any other pair must be the same status, and a pair where exactly one side is PASS always disagrees.

Stop rules 5 and 6 fire here, after teardown (design section 10).

### 11.3 Stop bundles

Each `stopped.json` entry becomes a C4 bundle, checksummed when written:

| Field | Value |
|---|---|
| `schema_version` | 1 |
| `case_id`, `run_id` | the planned ones |
| `profile`, `mode` | "ax", "scripted" |
| `execution`, `reason` | BLOCKED or NOT_RUN, and the reason, from the entry |
| `candidate_revision` | the lab image's commit |
| `fixture_sha256`, `dependencies_sha256`, `seed`, `mutation` | computed as `collector.ts` does; 0; "none" |
| `collector`, `collector_methods` | "multi.ts report (not observed: stopped)", [] |
| `observed_at` | the stop time |
| `observations`, `unobserved`, `evidence` | {}, {}, [] |

### 11.4 `src/reports/aggregate.ts`

- **Input:** `plan.json`, every planned bundle's `report.json`, and `timing-raw.json`.
- **Rows:** one per planned bundle. A planned bundle with no report is NOT_RUN ("planned, no report"), never dropped. Tenant, configuration, cluster and overall rows use `aggregate()` from `report.ts`, and the overall line names each cluster (design 8.4).
- **Output:** `docs/evidence/<set_id>/aggregate.json`, `aggregate.md`, `timing.json` and `checksums.sha256`. Before writing, each is scanned with `SECRET_RULES` and the private-terms list, and quarantined on a finding, as `exportRun()` does.
- **Gate:** one FAIL among PASS rows gives FAIL; a missing planned row gives NOT_RUN; UNKNOWN outranks BLOCKED; all PASS gives PASS with every cluster named.

## 12. Timing parsing

- **ax-server log.** After each round the runner runs `kubectl --kubeconfig <kc> -n ax-system logs deployment/ax-server --since-time=<round start> --tail=-1` and saves the output verbatim as `ax-server-<cluster>-c<c>-r<round>.log` in the set dir. It stays private, because its lines hold worker IPs.
- **`serverIntervals()`.** For each task, the interval runs from `msg="resuming actor on Substrate worker" actor=<task>` to the next `msg="task successfully reconciled and running"` with the same `actor`, using their `time=` fields (slog text handler; `internal/controller/reconciler.go`, `cmd/ax-server/main.go`). It is absent, with a reason, if either line is missing. It is also absent if the running line has `workspaceReady=false`: the readiness poll (`workspaceReadyPollInterval` 500 ms, `defaultWorkspaceReadyTimeout` 15 s) timed out.
- **`commandDuration()`.** `ended_at − started_at` from the `result.json` the collector captured into the F3-A1 bundle's evidence (RFC 3339 with nanoseconds, `stamp()` in `runner/main.go`). Absent if that file is absent.
- **Operator intervals.** `egress_attach_ms` runs from the start of `ax apply` to the attach returning. `submit_to_result_ms` runs from the start of `ax apply` to the collector's `result` exec returning HTTP 200. An empty exec is timed each round and reported beside it, not subtracted.
- **`resumeSpread()`.** Per round, the latest minus the earliest "resuming actor" line of its tasks (0 at c = 1). A round with a task's line missing goes to `rounds_absent` in `timing-raw.json` with the reason, not into `rounds`.
- **Summary.** Per configuration (cluster, step, c) and per headline, n is the number of counted tasks with that headline present. Each headline reports p50 by nearest rank (the ⌈n/2⌉-th value: the 15th at n = 30, the 16th at n = 32), max, and `n_below_planned: true` when n < 30. `tasks_timed` in the run facts is the number of counted tasks with both headlines present. Per-tenant breakdowns show p50 and max only, and warm-up rounds are listed separately.

## 13. Teardown mechanics

- **End of each step, per cluster.** `run-step` calls `teardown.sh <step-run-dir>` in default mode, with `KUBECONFIG` set to the run dir's kubeconfig. These are kubectl, `kubectl ate` and `ax` deletes only, with no prompts. In the script's order:
  1. AX tasks and Workspaces, per atespace;
  2. substrate rows other than egress policies and `removed_at` entries (leftover actors, then templates), then the atespaces;
  3. Kubernetes objects by exact name (`collector-env-tenants` included), then the tenant namespaces;
  4. the diff against the step's `pre-snapshot.json`.

  Egress policies go with their actor.
- **After the last step, B first, run by the operator.** `teardown.sh <B's infrastructure run dir>` runs from the operator's terminal, because the script keeps gcloud's interactive delete confirmations. In order:
  1. the objects B's run dir lists;
  2. B's four recorded bindings, then its bucket;
  3. cluster B, with its PersistentVolume disks noted before and deleted after;
  4. the diff against B's project-level `pre-snapshot.json`.

  No `--remove-substrate-iam`: B lists no account. The script runs under `set -e`, so a failed step exits before the diff. The independent check runs anyway, and the run dir is not `CLEAN` until it passes.
- **B's expected diff.** B's pre-snapshot was taken after A's Artifact Registry repo existed, and B is torn down before A, so the repo gives no line. Only `compute_disks` lines for A's node boot disks can be expected, if GKE recreated an A node in between. `teardown.sh` reports them as UNEXPECTED, and the operator accepts one only if A's node pool names that disk, recording why. Any other line keeps the run dir from `CLEAN`.
- **Then A, run by the operator.** `teardown.sh <A's infrastructure run dir>` deletes what it lists, then diffs against A's `pre-snapshot.json`. It lists its AX task and Workspace; the collector namespace with Floci, Emulate, the pool and the collector; `ax-system` with its cluster-scoped objects; the snapshot prefix; and the Artifact Registry repo. It leaves Substrate v0.6.0 and A's transfer account and grants in place.
- **Independent check, every run dir.** Read-only queries, independent of the script's own report, confirm that each listed resource is gone, `removed_at` entries included.

## Appendix A. File formats

One compact example per file. Values are illustrative, and private values are placeholders.

| File | Where | Example |
|---|---|---|
| `plan.json` | set dir | `{"set_id": "<uuid>", "step": 1, "clusters": {"a": {"infra_run_dir": "41dc91c3-…", "context": "<context-a>", "step_run_id": "<uuid>"}}, "configurations": [{"cluster": "a", "c": 2, "rounds": 15, "tenant_runs": [{"kind": "configuration", "tenant": "t1", "tenant_run_id": "<uuid>", "tr8": "1a2b3c4d", "tasks": ["apl-1a2b3c4d-00", "apl-1a2b3c4d-01"], "bundles": [{"run_id": "<uuid>", "case": "F3-A1", "task": "apl-1a2b3c4d-01"}, {"run_id": "<uuid>", "case": "MT-W01", "task": null}]}]}]}` |
| `versions.json` | infrastructure run dir | `{"cluster": "<cluster-a>", "gke": {"master": "1.36.4-gke.<n>", "nodes": "1.36.4-gke.<n>"}, "kubectl_client": "v1.36.6", "substrate": {"version": "v0.6.0", "commit": "d3f2363…", "kubectl_ate": "v0.6.0 build"}, "ax": {"commit": "4b7bf6f…", "ax_server": "<registry>/ax-server@sha256:…", "client_pins_substrate": "v0.6.0"}, "lab_image": "<registry>/apl-lab@sha256:…"}` |
| `tenant-runs.json` | `private-runs/ax/` | `[{"tenant_run_id": "<uuid>", "tr8": "1a2b3c4d", "kind": "configuration", "cluster": "a", "set_id": "<uuid>", "created_at": "<iso>", "run_ids": ["<uuid>"], "tasks": ["apl-1a2b3c4d-01"], "token_sha256": ["<hex>"]}]` |
| `--foreign-markers-file` | set dir | `{"tenant_run_id": "<uuid>", "foreign": [<every other tenant-runs.json entry>]}` |
| `--targets-file` | set dir | `[{"role": "t2-emulate-clusterip", "address": "<ip>", "port": 8080, "host": "emulate.apl-ax-5e6f7a8b.svc.cluster.local", "path": "/_apl/missing", "own": false}, {"role": "worker-1-80", "address": "<pod-ip>", "port": 80, "tcp": true, "own": false}, {"role": "t1-emulate-clusterip", "address": "<ip>", "port": 8080, "host": "emulate.apl-ax-1a2b3c4d.svc.cluster.local", "path": "/_apl/missing", "own": true}]` |
| `--disclosure-file` | set dir | `{"tenant_run_id": "<uuid>", "tasks_checked": 8, "foreign_secret_in_task_count": 0, "method": "operator string search of ax get task; output not stored"}` |
| `--egress-log-file` | set dir, `egress-<task>.json` per probing task | `{"window": {"from": "<iso>", "to": "<iso>", "margin_s": 10, "events": {"resume_issued": "<iso>", "result_returned": "<iso>"}}, "source": "kubectl logs -l app=atenet-egress -c envoy --tail=-1 --prefix --max-log-requests=<n>, ate-system", "pods_before": [{"name": "<pod>", "restarts": 0}], "pods_after": [{"name": "<pod>", "restarts": 0}], "exit_code": 0, "line_count": 42, "lines": ["<access-log line, verbatim>"]}` |
| `--run-facts` | set dir | `{"step": 1, "concurrency": 2, "tasks_planned": 15, "tasks_timed": 15}` |
| `stopped.json` | step run dir | `[{"run_id": "<uuid>", "case": "F3-A1", "execution": "NOT_RUN", "reason": "stop rule 4: ResourceExhausted at c = 4, round 3", "at": "<iso>"}]` |
| `timing-raw.json` | set dir | `{"tasks": [{"run_id": "<uuid>", "cluster": "a", "c": 2, "round": 3, "task": "apl-1a2b3c4d-03", "server_resume_to_running_ms": 2100, "command_duration_ms": 8400, "egress_attach_ms": 9000, "submit_to_result_ms": 19700, "empty_exec_ms": 600, "worker": "<worker-pod>", "unobserved": {}}], "rounds": [{"cluster": "a", "c": 2, "round": 3, "resume_spread_ms": 180, "leftover_actors": 0}]}` |
| `timing.json` | `docs/evidence/<set_id>/` | `{"set_id": "<uuid>", "configurations": [{"cluster": "a", "step": 1, "case": "F3-A1", "c": 2, "server_resume_to_running_ms": {"n": 30, "p50": 2100, "max": 2600}, "command_duration_ms": {"n": 30, "p50": 8400, "max": 9100}, "resume_spread_ms": {"p50": 180, "max": 400}, "operator": {"submit_to_result_ms": {"p50": 19700, "max": 21000}}, "warmup": [{"task": "apl-1a2b3c4d-00", "server_resume_to_running_ms": 2900}]}], "raw": <timing-raw.json rows>}` |

## Appendix B. The proto read for MV-PORT (moved from design 9.1)

Done read-only during review rounds 3 and 4, and recorded in `docs/RESEARCH.md` (§2):

- AX `4b7bf6f`, `pkg/apis/v1alpha1/ax.proto`: service `AX` is Task, Workspace and Model CRUD plus `SuspendTask` and `ResumeTask`. No import, export, snapshot or restore RPC.
- Substrate `d3f2363`, `pkg/proto/ateapipb/ateapi.proto`: service `Control` has no import or restore RPC. Its suspend and resume RPCs act on an existing actor (the comments describe checkpointing a running actor), and an actor can be seeded from a snapshot only through `Actor.source_tag`. A `Tag`'s `source_actor` is required, names the suspended actor whose snapshot it captures, and must be in the tag's own atespace (`CreateTagRequest` validation), so a tag can only capture an actor of the same control plane.
- Substrate `d3f2363`, `pkg/proto/objectstorepb/v1/objectstore.proto` (public): `NodeProvider` is the plugin API a storage platform implements on every node; atelet calls `FetchSnapshot` and `UploadSnapshot` to move a snapshot's files by `snapshot_uri`. `ControlProvider` (`CleanupSnapshot`, `CopySnapshot`) is likewise called by ate-api-server. Both are plugin interfaces Substrate calls, keyed by a storage URI; neither is a client API that registers a snapshot as an actor or a tag in another control plane, so neither is a documented import path.

## Appendix C. Settings carried from `emulators.yaml` (design decision 4)

`emulators.yaml` is frozen as run 3's record: only the BLOCKED `run()` (`index.ts`), `tests/integration/ax-profile.test.ts` and `profiles/ax/tests/run-dir.test.ts` read it. `tenant.yaml` and `collector.yaml` (§5) carry these settings from it unchanged:

- **L-032:** `enableServiceLinks: false` on every Pod template (Floci, Emulate, collector), because service links set `FLOCI_PORT=tcp://<ip>:4566`, which Floci reads as its own port. Keep the comment that says so.
- `automountServiceAccountToken: false` on every Pod and on the collector ServiceAccount.
- Floci: `FLOCI_SERVICES_UI_ENABLED=false`, port 4566, TCP readiness probe on 4566 every 2 s.
- Emulate: `APL_EMULATE_BASE_URL=http://emulate.apl-ax-<tr8>.svc.cluster.local:8080`, `APL_EMULATE_SEED` from Secret `emulate-seed`, ports 8080 and 8081, readiness `GET /_apl/health` on 8081 every 2 s.
- Limits: Floci 500m and 768Mi, Emulate 500m and 512Mi, collector 500m and 512Mi.
- Collector Pod: `restartPolicy: Never`, `command: ["sleep", "infinity"]`, and the `podidentity` (podCertificate) and `servicedns-ca` (clusterTrustBundle) projected volumes, as written there.
- WorkerPool: `sandboxClasses: [gvisor]`, template limits 3 CPU and 4Gi, requests 1 CPU and 4Gi.
