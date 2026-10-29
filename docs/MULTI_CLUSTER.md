Status: revised after EGM review round 3; pending round 4.

# Multi-tenant and two-cluster test design (AX lane, steps 1 and 2)

This is a test design, not a result. Nothing in it has run. It extends the optional AX lane (`profiles/ax/`) with two owner-approved steps, many tenants on cluster A and the same case on clusters A and B, and says exactly what would be built, run, recorded and torn down. The third approved step, moving work between clusters, is split out: its portability test is BLOCKED by a read of the pinned protos (12.1), and its eviction test moves to a follow-up design (12.2). Every PASS or FAIL planned here comes from an independent collector and the supplied evaluator, never from AX task phase (L-006).

Sources read for this design: [`profiles/ax/README.md`](../profiles/ax/README.md), [`profiles/ax/RESULTS.md`](../profiles/ax/RESULTS.md), `profiles/ax/{allowlist.ts,case.ts,collector.ts,orchestrate.ts,index.ts,run-dir.ts,run-dir.schema.json,teardown.sh,evaluate_ax.py,cases.ax.json,runner/main.go,manifests/k8s/emulators.yaml,emulate/server.mjs}`, `src/reports/{report.ts,artifacts.ts,export.ts}`, `src/config/endpoints.ts`, `src/collector/drive.ts`, `src/adapters/slack/signature.ts`, the supplied evaluator in `docs/spec/active/2026-10-28-agent-proof-lab/evals/` (`evaluate.py`, `cases.json`), [`LEARNINGS.md`](LEARNINGS.md) L-006 to L-012, L-019 and L-030 to L-057, [`CLAIM_LEDGER.md`](CLAIM_LEDGER.md) C-60 to C-70, [`CONTRACTS.md`](spec/active/2026-10-28-agent-proof-lab/contracts/CONTRACTS.md) C4 and C5, the two infrastructure run dirs (section 3) and run 3's private operator script. Upstream files are cited where used, from the pinned AX `4b7bf6f` and Substrate v0.6.0 `d3f2363` checkouts.

## 1. Problem statement

AX run 3 (set X, C-60 to C-70) showed one tenant on one cluster with one worker. It says nothing about tenants that share workers, about the same case judged on two clusters, or about work that moves or is evicted mid-run. The owner approved three steps. This design answers the first two with lab evidence and records the third's answer from the protos:

1. Do tenants that share one cluster and one worker pool keep their egress and their evidence apart, and how long does a W01-H task take as concurrency grows?
2. Does the same case reach the same verdict on two clusters when each is judged on its own?
3. Can a suspended task resume on the other cluster? Answered BLOCKED with no cluster call: the pinned protos document no import path (12.1). Whether an eviction mid-run produces a duplicate business effect is deferred to a follow-up design (12.2).

Until steps 1 and 2 run, every AX claim stays at one tenant on one cluster.

## 2. Scope

| Step | What | Cluster(s) |
|---|---|---|
| 1 | Many tenants: up to 4 concurrent tenants, each with its own atespace, namespace and Emulate workspace; isolation; timing with n ≥ 30 tasks per configuration | A |
| 2 | Two clusters: the same case on each; C5 reports per cluster; an all-clusters view that never blends into one green; the warm-up preflight; the network between them recorded as a configuration fact | A and B |
| 3 | Moving work: MV-PORT is one BLOCKED result from the proto read (12.1); MV-DRAIN is not designed here (12.2) | none |

Not in scope: microVM sandboxes, the default AX runner, a live model, any change to Substrate on A (router allowlist included), any IAM change, any scale claim. Vendor scale statements from Google AX or Agent Substrate docs may enter the ledger only as DOCUMENTED, with the doc path at a pinned SHA, and are never compared with a lab measurement.

## 3. Starting point

- Cluster A ran AX run 3: AX `4b7bf6f` on Substrate v0.6.0 (`d3f2363590a1`), 2 × c3-standard-4, amd64, GKE 1.36.4, gVisor, one worker. Run 3 was torn down on 2026-10-29 (`RESULTS.md`, "Teardown"); its run dir's manifest is retired.
- The same day the owner approved restoring the lane on A and creating cluster B. Two infrastructure run dirs now own what exists (section 8):
  - **A, run dir `41dc91c3`.** Not owned (pre-existing): Substrate v0.6.0 and A's snapshot transfer service account with its three grants. Owned: AX `4b7bf6f` in `ax-system` with its cluster-scoped objects, the private Artifact Registry repo with the AX and lab images, one snapshot prefix, and the collector namespace `apl-ax-6882d106` (ServiceAccount and Pod `apl-collector`, Floci, Emulate, WorkerPool `apl-ax-pool`). The namespace keeps run 3's name so the SPIFFE ID already in A's router allowlist still applies.
  - **B, run dir `34c8957e`.** Owned: cluster B (`gke_cluster`, with a project-level `pre-snapshot.json` taken before B existed), its snapshot bucket with four bindings (two for the `ns/ate-system/sa/ate-api-server` Workload Identity principal, two for A's transfer account), Substrate v0.6.0 (router allowlist already lists `apl-ax-6882d106/apl-collector`; it uses A's transfer account) and AX `4b7bf6f`. `versions.json` records the versions and that they match A's. This design changes none of B's IAM: the bucket and its four bindings stay exactly as recorded in B's run dir until B's teardown removes them (16.3).
- Known AX behaviour this design plans around: tasks are created suspended and need `ax resume` (L-047); every task is a new template, and a new template gets a golden actor that takes worker capacity (L-047, 10.3); AX templates set no `workerSelector`, so tasks land on any pool (L-039); `ax suspend` and `ax delete task` send no SIGTERM (L-048, C-62, C-63); `ax get task` returns `spec.env` in clear to any AX API caller (L-034, C-69); the v0.6.0 router serves actors only over mTLS to allowlisted SPIFFE IDs (L-045); egress refusals are judged from the egress gateway's log, not from probe byte counts (L-049); run 3 timing measured operator tooling more than AX (L-050); `/apl/result` serves only the runner's `result.json` (exit code, start and end times, command hash; `runner/main.go`), and only after the command exits.

## 4. Design rules

1. **Evidence exactly as before.** Every result is an independent-collector C4 bundle, judged by `evaluate_ax.py` and by `generateReport()` (`src/reports/artifacts.ts`, which runs its checksum check (L-022) and containment check (L-052) and then `buildReport()`), with one C5 report per tenant and per cluster, exported with `exportRun()` (`src/reports/export.ts`) to `docs/evidence/<run_id>/`. No report covers two tenants or two clusters. For W01 work a tenant's C5 evidence is one report per task (F3-A1) plus its MT-W01 report, rolled up into the tenant row with the C5 precedence (section 9.1). Each result gets a claim ID starting at C-80 (16.2); vendor claims are DOCUMENTED only. If `evaluate_ax.py` and the report disagree on a status under the agreement rule (stop rule 5), the run stops.
2. **Phase is not outcome.** `ax_task_phase` stays under `recorded_not_asserted` in every case (L-006).
3. **Absent is not zero.** An observation the collector could not make is absent with a reason (C4), which makes its assertion UNKNOWN. A `result.json` the collector cannot read (as after the eviction in C-66) makes `command_exit_code` absent.
4. **One clock per interval.** Every timing interval is measured on one named clock. No interval subtracts a timestamp taken on one machine from one taken on another (L-050).
5. **Pre-registration.** Before each step runs, its expectations (10.6, 11.6) are committed to the second table of `LEARNINGS.md` ("Expected before running"), as was done for the W5 runs.
6. **Identifiers stay private.** Project, cluster names, zones, contexts, registry, buckets, accounts and IPs live only in gitignored `private-runs/ax/`. Public files use placeholders (`<project>`, `<cluster-a>`, `<cluster-b>`, `<zone-b>`, `<registry>`, `<snapshot-bucket>`), as `RESULTS.md` does.
7. **Collector values, not operator values.** An assertion uses only what the collector computes from system records: Emulate, Floci, the router, and files of system-written records that the operator copies verbatim (the egress gateway's access log, as for C-67). A value the operator computes or reads from a CLI (a string-search count, `kubectl ate get actors`) is recorded, not asserted, as C-69 was. Records written by the in-sandbox coordinator (ledger exports, the probe's self-report) are subject-side: the collector reads them with its own credentials, and every report that uses one says so.

## 5. Components, files and build order

### 5.1 The runner

`profiles/ax/multi.ts` makes every cluster call in this design. It is the one cluster driver for these runs and supersedes `index.ts run()` for them; it reuses `doctor()` and `render()` (`index.ts`) and `ownedResources()` and `manifestObjects()` (`run-dir.ts`), extended as in 5.2, rather than copies of them.

| Subcommand | Input | Output | Calls |
|---|---|---|---|
| `plan` | set ID, the two infrastructure run dirs, the tenant-run registry | `private-runs/ax/sets/<set_id>/plan.json` (Appendix A): clusters, configurations, tenant runs, evidence run IDs, tasks per round, targets by role | none |
| `infra` | that cluster's infrastructure run dir | A: `versions.json` (read-only queries), pool at R = 3, the infrastructure run's own Floci and Emulate scaled to 0, collector NetworkPolicy and Pod spec. B: `collector.yaml` applied, node pool resized (18), the network check of 11.4 | `kubectl apply`, `scale` and `patch`, `gcloud container clusters resize`, the read-only `gcloud` commands of 11.4 |
| `run-step` | `plan.json`; the cluster's infrastructure run dir (`kubeconfig`, `versions.json`, `local.bin`) | one step run dir per cluster, tenant run dirs, rendered manifests, per bundle `artifacts/runs/<run_id>/observations.json` and `evidence/`, the set's `timing-raw.json` and log extracts, `stopped.json` | `doctor()`, `teardown.sh --snapshot`, the tenant setup and round below; `kubectl scale` of finished emulators; `kubectl logs` of ax-server (13) and the gateway (5.4) |
| `report` | the bundles, `stopped.json` | BLOCKED and NOT_RUN bundles for planned bundles a stop left unobserved; per bundle `report.json`, `report.md` and its export; then the set's aggregate (11.5) | `evaluate_ax.py --cases`, `generateReport()`, the agreement rule, `exportRun()`, `aggregate.ts` |

New and changed command lines:

```
multi.ts plan      --step 1|2 --set-id <uuid> --infra-a <dir> [--infra-b <dir>]
multi.ts infra     a|b --infra <dir> [--baseline] [--dry-run]
multi.ts run-step  --plan <plan.json> --cluster a|b [--dry-run]
multi.ts report    --plan <plan.json>
orchestrate.ts manifests --tenant --dir <tenant-run-dir> --set-id <uuid> --cluster a|b --tenant-role t1|t2|t3|t4
orchestrate.ts manifests --dir <tenant-run-dir> --task <name> --mode W01-H|isolation|term --image <ref>
               --emulate-ip <ip> --floci-ip <ip> --set-id <uuid> --cluster a|b --tenant-role t1|t2|t3|t4 [--probes <file>]
collector.ts observe --case F3-A1 --task <task> --atespace <a> --run-id <uuid> --out <dir> --ax-phase-file <f> --run-facts <f>
collector.ts observe --run --case MT-W01|MT-ISO --atespace <a> --run-id <uuid> --out <dir> --run-facts <f>
               --foreign-markers-file <f> [--targets-file <f> --egress-log-file <f> --disclosure-file <f>]
evaluate_ax.py [--cases <table>] <case> <bundle-dir>
```

Before any call to a cluster, `run-step` runs `doctor()` (`profiles/ax/index.ts`) with that cluster's environment from its infrastructure run dir (`APL_AX_KUBECTL`, `APL_AX_CONTEXT`, `APL_AX_IMAGE`, `APL_AX_CLI`, `APL_AX_SUBSTRATE_API`) and requires `APL_AX_AUTHORIZED=1`. A BLOCKED doctor or a missing opt-in leaves that cluster's rows BLOCKED and makes no call there. `multi.ts` holds one port-forward per cluster to `ax-server`, opened with that cluster's kubeconfig, and calls `ax --server http://127.0.0.1:<port>` (L-033); `kubectl ate` is the plugin build in the infrastructure run dir's `local.bin`, first on `PATH`, and opens its own port-forward per call, as in run 3.

**Per tenant run, in this order**, each object added to the step run dir's `owned-resources.json` before it is created: (1) `orchestrate.ts init`; (2) `orchestrate.ts manifests --tenant`, which renders `tenant.yaml` with `render()`; (3) `kubectl apply` of it; (4) `kubectl wait -n apl-ax-<tr8> --for=condition=Available deployment -l apl-run=<tenant_run_id> --timeout=180s`; (5) read the Emulate and Floci ClusterIPs and pod IPs (`kubectl get svc,endpoints`) into the targets file; (6) `orchestrate.ts manifests --task` for each task, with those ClusterIPs; (7) the tenant's key in the collector Secret (section 6). The collector Pod is not recreated during a step.

**Per round** (10.3): apply the c tasks; poll for the c actors in parallel, attaching each egress policy as its actor appears; once all are attached, issue the c `ax resume` calls in parallel and wait for the c results in parallel (`collector.ts result --wait-ms 120000`); per task, keep only the phase from `ax get task` in `phase-<task>.json` (the full output holds the task's tokens in clear, L-034), copy it into the collector Pod and observe the bundle with `--ax-phase-file` while the actor still serves `/apl/result`; then delete the c tasks. A run-level bundle (MT-W01, MT-ISO) is observed with `observe --run` after the tenant run's last round, before its emulators are scaled to 0.

### 5.2 Files

| Action | File | Change |
|---|---|---|
| Create | `profiles/ax/multi.ts` | the runner (5.1), the per-call context guard (8) |
| Create | `profiles/ax/multi-facts.ts` | pure functions: `foreignMarkerCount()`, `parseEgressLog()` and `crossTenantUpstreams()` (5.4, 9.3), `redactAddresses()`, `serverIntervals()` and `resumeSpread()` over ax-server log lines (13), `agrees()` (stop rule 5), `p50()` by nearest rank |
| Create | `profiles/ax/egress.ts` | egress policy template, attach, gateway log extract (5.4) |
| Create | `profiles/ax/cases.multi.json` | expectations (9.2) |
| Create | `profiles/ax/manifests/k8s/tenant.yaml` | per tenant: Namespace, Floci and Emulate with requests of 100m CPU and 256Mi per container (limits kept), their Services, Secret `emulate-seed`, NetworkPolicy admitting `atenet-egress` from `ate-system` (as `emulators.yaml`) and the collector by namespace and label |
| Create | `profiles/ax/manifests/k8s/collector.yaml` | rendered from `emulators.yaml`'s collector half: Namespace, ServiceAccount and Pod `apl-collector` with Secret `collector-env-tenants` mounted as a whole volume at `/etc/apl/collector-env` (no `subPath`, so key changes reach the running Pod; `optional: true`, so the Pod starts before the Secret exists), a NetworkPolicy admitting no ingress to it, WorkerPool `apl-ax-pool` (section 6) |
| Create | `src/reports/aggregate.ts` | the roll-up only: tenant, configuration, cluster and overall rows, the all-clusters view, the timing summary (11.5) |
| Create | `tests/unit/{report-wording,multi-facts,aggregate,ax-render,ax-multi}.test.ts`, `tests/integration/ax-collector.test.ts` | the gates of 5.3 |
| Modify | `profiles/ax/case.ts` | `APL_AX_PROBES`, a JSON list of `{role, url, headers}` or `{role, tcp: "host:port"}`, so the router probe can carry `ate-target-actor`; the probe writes its JSON lines to `apl-evidence/<task>/isolation.json` in its own bucket; the relay fix below |
| Modify | `profiles/ax/orchestrate.ts` | `--probes`, `manifests --tenant` (renders `tenant.yaml` with `render()`), `--set-id`, `--cluster`, `--tenant-role`; `spec.config` and `.apl/run.json` gain `apl-set`, `apl-cluster` and `apl-tenant` next to their current keys (`apl-run` and `mode` in `spec.config`; `apl-run`, `task` and `mode` in `.apl/run.json`) |
| Modify | `profiles/ax/collector.ts` | `--run-id`, `--run-facts`, `observe --run` (no task, no `/apl/result` capture); cases MT-W01 and MT-ISO; inputs `--foreign-markers-file`, `--targets-file`, `--egress-log-file`, `--disclosure-file`; redaction before any write. It keeps reading `APL_AX_COLLECTOR` and `APL_AX_ALLOWLIST` from its environment, set before the process starts (section 6) |
| Modify | `profiles/ax/run-dir.ts` | `manifestObjects()` also parses the JSON documents `orchestrate.ts manifests` writes; `ownedResources()` takes a list of atespaces, each with its AX objects |
| Modify | `profiles/ax/run-dir.schema.json` | `substrate` kinds gain `actor` and `actor-template`, with `atespace` required as for `egress-policy` (the golden-actor fallback, section 8) |
| Modify | `profiles/ax/index.ts` | a comment marking `run()` superseded by `multi.ts` for cluster runs; no behaviour change |
| Modify | `profiles/ax/evaluate_ax.py` | optional `--cases FILE`, default `cases.ax.json` |
| Modify | `src/reports/artifacts.ts` | `generateReport()` takes optional `expected` and `limitations`; without them it behaves as today (the spec's `cases.json`, no extra limitations) |
| Modify | `src/reports/report.ts` | AX wording and one limitation by profile (16.1); `lanesFrom(local, optional)` gains a `profile` argument for the `lanes.local` reason |
| Modify | `docs/RESEARCH.md` | the proto read of 12.1 (file, message, field) |
| Modify | `docs/LEARNINGS.md` | pre-registered expectations, committed before each step |
| Modify | `docs/CLAIM_LEDGER.md` | set XM and one row per result, only when its evidence exists |
| Delete | none | |

Unchanged: `allowlist.ts` (tenant namespaces keep its `apl-ax-<8 hex>` form), `teardown.sh`, `runner/main.go`, `manifests/k8s/emulators.yaml` (the single-run template), `cases.ax.json`, `src/reports/export.ts`, the supplied `evaluate.py` and `cases.json`.

**The relay fix in `case.ts`.** Emulate's mailbox keeps every delivery of the tenant run (`emulate/server.mjs`) and `case.ts` relays from `after=0`, so each task would replay earlier tasks' mentions, which the worker accepts inside the 300 s signature window (`MAX_SKEW_SECONDS`, `src/adapters/slack/signature.ts`). The coordinator reads `/_apl/events?after=0` once before posting its own mention and relays only from the highest `seq` found.

### 5.3 Build order

The proto read is done (12.1); recording it in `RESEARCH.md` is part of phase 1. Each phase ends when its test gate and the existing `npm test` pass. No cluster call happens before phase 5's gate and the owner's go-ahead, except resizing B's node pool to 0 (section 18).

1. Report wording, `generateReport()` options, `evaluate_ax.py --cases`, `RESEARCH.md`. Gate: `report-wording.test.ts` (AX wording and limitation for profile `ax`; local wording and the `lanes.local` key unchanged; `generateReport()` with `expected` still refuses a tampered evidence file and an escaping path, as `tests/integration/evidence.test.ts` checks today); `evaluate_ax.py` still refuses a table that asserts a recorded-only key.
2. `cases.multi.json`, `multi-facts.ts`, `aggregate.ts`. Gate: `multi-facts.test.ts` (a foreign marker found, not found, and only in an excluded file; the key absent with no foreign tenant run; every IP replaced, an unlisted one as `<unlisted-address>`; `parseEgressLog()` on the pinned format of 5.4, skipping the CONNECT text line; upstreams other than the tenant's own counted, its own and null ones not; `serverIntervals()` and `resumeSpread()` on slog text lines; `agrees()` on every pair of stop rule 5; `p50()` at n = 30 and 32) and `aggregate.test.ts` (11.5).
3. `tenant.yaml`, `collector.yaml`, `orchestrate.ts`, `case.ts`, `egress.ts`, `run-dir.ts` and its schema. Gate: `ax-render.test.ts` (requests present, every placeholder filled, the `atenet-egress` rule and `emulate-seed` present, the namespace matching `allowlist.ts`, `emulators.yaml` byte-identical, the policy shape of 5.4, the Secret mounted whole; `manifestObjects()` on JSON tasks; `ownedResources()` with two atespaces and a leftover `actor`; the relay skipping earlier deliveries; the 404 probe paths of 5.4 against a local Floci and `emulate/server.mjs`), the existing `tests/integration/ax-profile.test.ts` and `profiles/ax/tests/run-dir.test.ts`.
4. `collector.ts`. Gate: `ax-collector.test.ts`: `observe` for F3-A1 and `observe --run` for MT-W01 and MT-ISO on synthetic captures write bundles that pass C4 validation, with recorded keys from `--run-facts` and no IP in any written file.
5. `multi.ts`. Gate: `ax-multi.test.ts`: the plan (bundles per configuration; a `<tr8>` equal to the collector's or a registered one refused); the per-call context guard (a kubeconfig, port or `gcloud` cluster of the other cluster refused); the setup order of 5.1 with each object recorded before its create; the table chosen by case (F3-A1 → `cases.ax.json`); `stopped.json` turned into BLOCKED and NOT_RUN bundles; a dry run that prints every planned call and makes none; `npm run validate:package`.

### 5.4 Egress policies and the gateway log (`egress.ts`)

This moves run 3's private operator script's logic into the repo, with no private value in it. The policy shape and the log format are read from the pinned Substrate checkout.

- **Policy.** An `EgressPolicy` (`pkg/proto/ateapipb/ateapi.proto`) is a singleton named `default` under its actor; `rules` is an unordered set of allows, and traffic that matches no rule is refused. An `http` rule allows cleartext HTTP, matched per request on the authority and port; the gateway resolves the name and dials it. `kubectl ate create egress-policy` (`cmd/kubectl-ate/internal/cmd/egress_policy.go`) takes one YAML or JSON document, parsed strictly, with metadata optional. The template, for tenant namespace `<ns>`:

  ```yaml
  rules:
  - http: {hostnames: ["emulate.<ns>.svc.cluster.local"], ports: {numbers: [8080, 8081]}}
  - http: {hostnames: ["floci.<ns>.svc.cluster.local"], ports: {numbers: [4566]}}
  ```
- **Attach.** After `ax apply`, poll every 0.5 s, up to 120 s, until `kubectl ate get actor <task> -a <atespace>` finds the actor; then `kubectl ate create egress-policy <task> -a <atespace> -f <policy>`, and record the policy under `substrate` in the step run dir. Resumes follow once all c policies of the round are attached (5.1).
- **Log format.** The gateway's Envoy config is the `atenet-egress` ConfigMap (`manifests/ate-install/atenet-egress.yaml`, container `envoy`, label `app=atenet-egress`). It writes JSON lines to stdout for three legs: `cleartext` and `mitm`, per request (`time`, `actor`, `authority`, `method`, `path`, `status`, `flags`, `upstream`; `upstream` is `%UPSTREAM_HOST%`, null when the gateway answered itself, L-049), and `clienthello`, per connection that matched no filter chain (`time`, `actor`, `destination`, `chain`, `flags`). The outer CONNECT leg's text line (`[egress] authority=… code=…`) has no upstream; it is kept, not counted. The request legs log only status ≥ 400, a response flag or a gRPC error, plus a 1% sample of the rest (runtime keys `access_log.min_status`, default 400, and `access_log.sample`); raising the level at the admin port would change Substrate, which is out of scope. So every HTTP probe, the allowed control included, asks for a path its target answers with 404 (`/_apl/missing` on Emulate's 8080 and 8081, a missing bucket on Floci's 4566, `/apl/missing` through the router to the runner), and any request the gateway forwards is logged. Before step 1, and before step 2 on B, the runner reads the deployed ConfigMap (read-only) and stops if these fields or filters differ from the pinned file.
- **Log extract.** For each probe window: `kubectl --kubeconfig <run-dir>/kubeconfig -n ate-system logs -l app=atenet-egress -c envoy --since-time=<window start>`, copied verbatim with the window bounds to the file passed as `--egress-log-file`. `parseEgressLog()` drops lines outside the window.

## 6. Collector identity: one per cluster

On Substrate v0.6.0 the collector reads a task's `/apl/result` only through the router, over mTLS, with a SPIFFE ID listed in `--ingress-allowed-spiffe-ids` (L-045). A's allowlist has exactly one lab ID, `apl-ax-6882d106/apl-collector`, and changing it is not approved. B's install lists the same ID, so both clusters are configured the same way.

- Namespace `apl-ax-6882d106`, ServiceAccount `apl-collector`, Pod `apl-collector` on both clusters, owned by that cluster's infrastructure run dir. On B, `multi.ts infra b` applies `collector.yaml`; on A the namespace exists and gains the NetworkPolicy and the new Pod spec.
- Each tenant run's collector environment (`collector-env.json` from `orchestrate.ts manifests`) becomes key `<tr8>` of one Secret, `collector-env-tenants`, in the collector's namespace, owned by the step run dir, as two dotenv lines (`APL_AX_COLLECTOR='<json>'`, `APL_AX_ALLOWLIST='<json>'`). `run-step` sets its keys to the current configuration's tenant runs. The Pod mounts the whole Secret as a volume, so changed keys reach the running Pod without recreating it; before a tenant's first observe the runner waits until its key's file exists there. The Pod keeps `automountServiceAccountToken: false`. There is no cross-namespace RBAC and no API token: the collector never calls the Kubernetes API.
- One collector process per call (`result` or one bundle's `observe`), with its environment set before any module loads: `kubectl exec apl-collector -- node --env-file=/etc/apl/collector-env/<tr8> --import tsx profiles/ax/collector.ts observe …`, with its own output directory. `allowlist.ts` installs its address rule when it is imported, from `process.env.APL_AX_ALLOWLIST`, so an environment read later would leave the rule uninstalled.
- In the collector namespace a NetworkPolicy selecting the collector Pod admits no ingress; the collector only dials out. Each tenant namespace's NetworkPolicy admits the collector by namespace and pod label (`kubernetes.io/metadata.name: apl-ax-6882d106` plus `app: apl-collector`) instead of the same-namespace selector in `emulators.yaml`. Both clusters run GKE Dataplane V2, which enforces NetworkPolicy.

**What this weakens, stated plainly.** One collector process holds every tenant's reader token and S3 key on its cluster. That is a smaller change from run 3 than it looks: Floci accepts any access key (L-037) and Emulate accepts any valid token (L-019), so per-run credentials were labels in run 3 too, and the boundary was which process knows which URL. Separation of tenants' evidence rests on the collector's code (one environment and one output directory per bundle) and is checked by `foreign_marker_count` (section 9). What cannot be tested is whether a second, separately allowlisted collector identity could read another tenant's results through the router, because each cluster has one identity. Every report from this design carries that limitation.

## 7. Naming and labels

| Thing | Name | Notes |
|---|---|---|
| Set | `set_id` (UUID) | one per execution of a step |
| Infrastructure run | `41dc91c3…` (A), `34c8957e…` (B) | long-lived; own the shared resources (section 8) |
| Step run | `step_run_id` (UUID) | one per step and cluster; owns that step's tenant objects |
| Tenant run | `tenant_run_id` (UUID), short `<tr8>` | one per tenant per configuration; names the namespace |
| Tenant-run registry | `private-runs/ax/tenant-runs.json` | experiment-wide; an entry is appended when a tenant run is created (Appendix A) |
| Evidence run | `run_id` (UUID) | one per C4 bundle: one per task (F3-A1), one per tenant run and case otherwise; keys the bundle, its C5 report and `docs/evidence/<run_id>/` |
| Tenant namespace and atespace | `apl-ax-<tr8>` | the form `allowlist.ts` requires (`apl-ax-[a-f0-9]{8}`); `orchestrate.ts init` derives it from the tenant run ID and uses it as the atespace; the plan refuses a `<tr8>` equal to the collector's `6882d106` or to any registered tenant run's |
| Tenant tasks | W01 `apl-<tr8>-<nn>` (`00` the warm-up); actor probe `apl-<tr8>-p1`, `apl-<tr8>-p2`; MT-ISO `apl-<tr8>-iso` and target `apl-<tr8>-tgt`; Workspace `ws-<task>` | unique across the experiment, so a task name is a usable foreign marker |
| Pool | `apl-ax-6882d106/apl-ax-pool` | owned by the infrastructure run dir; shared by all tenants on the cluster (10.2) |
| Collector | `apl-ax-6882d106/apl-collector` | fixed by the router allowlist (section 6) |
| Collector env | `apl-ax-6882d106/collector-env-tenants` | Secret, one key per tenant run of the current configuration, owned by the step run dir |
| Tenant labels | `apl-run=<tenant_run_id>`, `apl-set=<set_id>`, `apl-cluster=a\|b`, `apl-tenant=t1..t4`, `apl-role=tenant` | on every Kubernetes object in the tenant namespace |
| AX objects | no labels exist (L-008) | `spec.config` keys `apl-run`, `mode`, `apl-set`, `apl-cluster`, `apl-tenant`; the Workspace's `.apl/run.json` keys `apl-run`, `task`, `mode` and the same three |

Tenants t1 to t4 are roles. Each configuration gets fresh tenant runs (new UUIDs, new namespaces). Earlier tenant runs of the step stay, with their emulators scaled to 0 after collection, until the step's teardown. Every tenant run of the experiment feeds the foreign-marker check through the registry.

## 8. Run dirs, ownership and the context guard

- **Infrastructure run dirs, long-lived.** `41dc91c3` (A) and `34c8957e` (B), as listed in section 3. Before step 1, `multi.ts infra a` writes A's `versions.json` the same way as B's, from read-only queries, and `multi.ts infra b --baseline` writes B's network baseline (11.4). Before step 2, `multi.ts infra b` adds the collector namespace, ServiceAccount, Pod, NetworkPolicy and WorkerPool `apl-ax-pool` to B's. Both are torn down once, after the last step, B first (16.3).
- **Step run dirs, one per step and cluster.** `private-runs/ax/<step_run_id>/` owns every tenant namespace with its objects, atespace, egress policy (listed for the record), AX Task and Workspace, and the `collector-env-tenants` Secret of that step on that cluster. Each object is recorded before it is created (5.1). It is one per step, not per tenant, because `teardown.sh` diffs each run dir against its own `pre-snapshot.json`, and concurrent tenant run dirs would each see the others' namespaces as unexpected changes. `pre-snapshot.json` is taken with `teardown.sh --snapshot` before the step's first apply. After the step's last task delete, the runner lists actors and actor templates in each tenant atespace and records any it finds (golden actors AX did not remove, 10.3) under `substrate` as `actor` or `actor-template`, so `teardown.sh` deletes them before the atespace, which must be empty. Teardown runs at the end of the step.
- **Set dir.** `private-runs/ax/sets/<set_id>/` holds `plan.json`, written before any call; the tenant run dirs (`secrets.json`, `emulate-seed.json`, rendered manifests, as `orchestrate.ts init` and `manifests` write them), which own nothing; and `timing-raw.json`, the ax-server and gateway log extracts and the targets, markers and disclosure files.
- **Schema, with one change.** Every `owned-resources.json` validates against `run-dir.schema.json`, whose only change is the two `substrate` kinds above: `run_id` is the run dir's own ID, `kube_context` its cluster's context, tenant objects go in `kubernetes`, `ax` and `substrate`. Versions come from `versions.json`, not from the schema. New run dirs leave `substrate_install` absent: the schema requires it to carry a `previous` install, and made-up values there would arm `--restore-substrate-v05`.
- **Context guard, on every call.** Every `kubectl` and `kubectl ate` call passes `--kubeconfig <run-dir>/kubeconfig` (single context, mode 0600, as `index.ts run()` writes it), and before each call the runner checks that this file's context is the plan's context for that step and cluster. Every `ax` call goes to the port-forward the runner opened with that kubeconfig, and the runner refuses an `ax` call whose port belongs to another cluster. Every `gcloud` call passes `--project`, `--location` and the cluster name from that cluster's infrastructure run dir (`project`, `zone`, `gke_cluster` or `cluster`), and the runner refuses one whose cluster is not the plan's. The ambient kube context and gcloud configuration are never read. A mismatch is a programming error and stops the set. `teardown.sh` is called with `KUBECONFIG` set to the run dir's kubeconfig, as `index.ts` does for `--snapshot`, and keeps its own guard (schema valid and current context equals `kube_context`).

## 9. Cases

### 9.1 Per task: F3-A1, unchanged

Each W01-H task in steps 1 and 2 is one C4 bundle written by `collector.ts observe --case F3-A1 --task <task>` before the task is deleted, and judged by F3-A1 in `cases.ax.json` as it is (`ticket_count` 1, `receipt_count` 1, `receipt_matches_request` true, `completion_reply_count` 1, `command_exit_code` 0). A task with an absent fact is UNKNOWN, never FAIL (design rule 3).

Roll-up uses `aggregate()` from `report.ts` (FAIL > UNKNOWN > BLOCKED > NOT_RUN > PASS): the tenant row over that tenant run's task reports and its MT-W01 report; the configuration row over its tenant rows; the cluster row over its configurations and its other cases. One absent fact therefore makes that task and its tenant row UNKNOWN. A planned bundle with no report is NOT_RUN.

### 9.2 `profiles/ax/cases.multi.json`

Same rules as `cases.ax.json`: profile `ax`, typed equality only (the supplied `inspect_bundle()`), and no expectation may name a recorded-only key. F3-A1 bundles are judged with `cases.ax.json`, every other case with this table (11.5).

```json
{
  "note": "Multi-tenant and two-cluster AX expectations (docs/MULTI_CLUSTER.md). Equality only. Recorded keys are never asserted (L-006). W01 tasks are judged one bundle each by F3-A1 in cases.ax.json.",
  "recorded_not_asserted": ["ax_task_phase", "step", "concurrency", "tasks_planned", "tasks_timed", "probe_self_report_reached_count", "foreign_secret_in_task_count"],
  "MT-W01": {"profile": "ax", "note": "steps 1 and 2: one per tenant run after its last round; the bundle records the step", "expected": {"foreign_marker_count": 0}},
  "MT-ISO": {"profile": "ax", "note": "step 1, own tenant runs after c = 4: cross-tenant reach and shared evidence", "expected": {"cross_tenant_upstream_count": 0, "allowed_control_reached": true, "foreign_marker_count": 0}}
}
```

MT-W01 is planned for every tenant run of steps 1 and 2. The actor probe's tenant run (10.3) comes first, so even c = 1 in step 1 has a registered foreign tenant run.

### 9.3 Observation keys

Asserted keys, each computed by the collector (`multi-facts.ts`) with direct evidence:

| Key | Type | Collected from | Meaning |
|---|---|---|---|
| `foreign_marker_count` | number | the tenant's own Slack channel (history and threads, reader token) and every object in its own Floci (`<task>-receipts` buckets, `apl-evidence/` exports) except `isolation.json`, which names other tenants by design; files the collector or operator wrote are not searched | items with a foreign marker: the `run_id` or a task name of any other tenant run in the registry (every step and set so far), or a token found with `SECRET_RULES` (`export.ts`) whose SHA-256 is in another tenant run's `token_sha256` list (the SHA-256 of each Slack token, the signing secret and the client secret in its `secrets.json`). The collector gets those IDs, names and hashes (`--foreign-markers-file`), never other tenants' tokens, and no other tenant's Pods need to run. With no other registered tenant run the key is absent with reason "no foreign tenants", never 0 |
| `cross_tenant_upstream_count` | number | egress gateway access log for the probe window, copied verbatim (`--egress-log-file`, 5.4) | request-leg entries with a non-null `upstream` (L-049) that is not one of this tenant's own Emulate and Floci addresses (ClusterIPs and pod IPs, `own: true` in the targets file). Every other upstream counts, whatever it names |
| `allowed_control_reached` | boolean | same log | a request-leg entry in the window whose upstream is this tenant's own Emulate (the control probe's 404, 5.4), so the probe ran under a working policy |

**Negative control.** `foreign_marker_count` must be able to fail. Once per cluster, right after one tenant run's MT-W01 bundle and before its emulators are scaled to 0, the runner observes that run again with a markers file that also lists that run's own first task name as foreign; its stimulus names the task, so the count must be at least 1, or the step stops (stop rule 1). That bundle stays in the set dir and is neither reported nor ledgered.

Recorded, not asserted:

| Key | Collected from | Why not asserted |
|---|---|---|
| `probe_self_report_reached_count` | the probe's own JSON lines in its bucket | the subject's self-report |
| `foreign_secret_in_task_count` | operator string search of `ax get task` for this tenant's tasks against other tenants' secrets; only the count is kept (`--disclosure-file`), the output is not stored, as in run 3 | operator value (design rule 7), as C-69 |
| `step`, `concurrency`, `tasks_planned`, `tasks_timed`, `ax_task_phase` | `--run-facts`, `--ax-phase-file` | context only |

**Addresses.** The collector redacts: before it writes any evidence file, `redactAddresses()` (`multi-facts.ts`) replaces every IP address in a log extract, target list or probe output with a placeholder naming its role from the targets file (for example `<t2-emulate-clusterip>`, `<worker-pod-1>`). `multi.ts` only writes the targets file; the role-to-address mapping stays in the set dir. An address with no role becomes `<unlisted-address>`, and its presence is recorded.

## 10. Step 1: many tenants on cluster A

### 10.1 Layout per tenant

Each tenant run gets: atespace and namespace `apl-ax-<tr8>`; its own Floci and Emulate from `tenant.yaml` (one Emulate workspace, its own per-run fake secrets from `orchestrate.ts init`, rendered by `orchestrate.ts manifests --tenant`); its own egress policy from `egress.ts`, listing only its own Emulate (8080, 8081) and Floci (4566) hosts, attached right after the actor exists and before `ax resume` (L-047, 5.4); and its key in the collector Secret. No collector and no WorkerPool in the tenant namespace. After its last bundle is observed, its Floci and Emulate are scaled to 0; its objects stay until teardown.

### 10.2 One shared pool, and why

AX templates set no `workerSelector`, so a task can land on any pool (L-039). Per-tenant pools would not pin tenants to their pool, so they would not add isolation. One pool per cluster, the infrastructure-owned `apl-ax-6882d106/apl-ax-pool` (gVisor), set to R = 3 workers by `multi.ts infra` before step 1, makes tenants share workers, which is the setting where cross-tenant isolation matters. Other pools on A were deleted by the run 3 reinstall (RESULTS §3.2); the preflight confirms that no other WorkerPool exists.

### 10.3 Concurrency, actors and capacity

Configurations: c ∈ {1, 2, 4} concurrent tenants on A, each tenant running one W01-H task per round. A round runs its c tasks together (5.1): the c policies are attached as the actors appear, the c resumes are issued in parallel and the c results polled in parallel; then each bundle is observed and the c tasks are deleted before the next round starts (run 3 deleted each task before the next, L-047). c is the number of tasks submitted together; the overlap they reach is measured, not assumed: each round records `resume_spread_ms` (13), and each configuration is reported with the p50 and max of its spread next to c.

| c | Tenants | Rounds | Tasks (n) | Tasks per tenant run |
|---|---|---|---|---|
| 1 | t1 | 30 | 30 | 30 |
| 2 | t1, t2 | 15 | 30 | 15 |
| 4 | t1 to t4 | 8 | 32 | 8 |

Each configuration starts with one warm-up round (`00`), reported separately and not counted.

**Actor counts.** AX gives every task its own ActorTemplate in the task's atespace, named `<task>-tmpl-<digest of image and env>`, and deleting a task deletes its actor and then its templates (`taskTemplateName()` and `ReconcileDelete()` in `internal/controller/reconciler.go` at `4b7bf6f`). So every task is a new template. Unknown are G, the golden actors a new template adds (L-047 saw one), and L, how many remain after their task is deleted. Before c = 1 a probe tenant run on A measures them: `apl-<tr8>-p1` in round 1 and `apl-<tr8>-p2` in round 2, rendered as W01-H tasks, owned by step 1's step run dir, run through the full per-task order, with `kubectl ate get actors` (recorded) after each apply, result and delete. G and L must each be 0 or 1. The rule is then fixed: in an atespace with d deleted tasks, the count is L × d before a round's submit and L × d + (1 + G) per submitted task once the round's policies are attached. Any other count, or a G or L outside 0 and 1, is stop rule 4. Leftovers are removed at teardown (section 8).

Capacity estimate (to be checked, not assumed): 2 × c3-standard-4 is 8 vCPU and 32 GiB before system reservations; Substrate (11 pods) and AX also run there, and their requests are not recorded in the repo. In `emulators.yaml` Floci and Emulate set limits only (500m/768Mi and 500m/512Mi), so their requests equal their limits. `tenant.yaml` adds requests of 100m CPU and 256Mi per container and keeps the limits; `emulators.yaml` stays as it is. `multi.ts infra a` scales the infrastructure run's own idle Floci and Emulate in the collector namespace to 0 before step 1 (teardown deletes them as listed, so nothing is restored). Finished tenant runs' emulators are scaled to 0, so at most 4 tenants hold requests at a time. During MT-ISO, with R = 3 workers (run 3's worker template: request 1 CPU and 4Gi, limit 3 CPU), requests total about 0.8 (4 tenants) + 0.5 (collector) + 3 = 4.3 vCPU and 2 + 0.5 + 12 = 14.5 GiB. c = 4 and MT-ISO may still end NOT_RUN (capacity). Actor slots: with 1-CPU tasks a 3-CPU worker refused a fourth actor (L-047), so R = 3 gives about 9 slots for at most 4 task actors plus their golden actors.

Preflight before each configuration (read-only): node allocatable minus requested CPU and memory must cover the configuration's requests, and the warm-up round must schedule all c tasks and pass 11.2. Otherwise stop rule 1 or 4 applies.

### 10.4 Isolation (MT-ISO)

After c = 4, four fresh MT-ISO tenant runs (t1 to t4), each with its own evidence run ID. While all four namespaces exist, each tenant t_i in turn (i = 1 to 4) runs one `isolation` task (`apl-<tr8>-iso`) while tenant t_j, j = i mod 4 + 1 (so t4's target is t1), runs one `term`-mode task (`apl-<tr8>-tgt`, which makes no egress) as the router-path and worker-local target; the target task is deleted when the prober's window ends. No other task runs, so every gateway log entry in the window comes from the probing tenant; the log's `actor` field should agree, but the design does not rest on it. Each MT-ISO bundle is observed with `observe --run` after its tenant's probe.

- Probes (`APL_AX_PROBES`): every other MT-ISO tenant's Emulate (8080, 8081) and Floci (4566), each by Service name and by ClusterIP; the router path, `https://atenet-router.ate-system.svc/apl/missing` with header `ate-target-actor: apl-ax-<target tr8>/apl-<target tr8>-tgt`; the worker-local path, raw TCP to each worker Pod IP on the ports its actors listen on (read from the worker Pod spec by the operator); the allowed control, the tenant's own Emulate; and the run 3 probes. HTTP probes ask for the 404 paths of 5.4. Every target, the tenant's own addresses (`own: true`) included, is in the targets file. The probe writes its JSON lines to `apl-evidence/<task>/isolation.json` in its own bucket, kept as `probe_self_report_reached_count`; the verdict comes from the gateway log.
- Disclosure: `foreign_secret_in_task_count` is recorded, not asserted (design rule 7). Cross-tenant disclosure through the AX API itself is not testable here: there is one operator identity, and `ax get task` returns `spec.env` to any caller (L-034). That stays a disclosed limitation (C-69), not a claim.
- Shared evidence: `foreign_marker_count` in every MT-ISO bundle, over the scope of 9.3.

### 10.5 Timing

Section 13. Timing is recorded, never asserted. Each bundle records `concurrency`, `tasks_planned` and `tasks_timed`; per-task intervals go only to the set's `timing-raw.json`.

### 10.6 Pre-registered expectations (step 1)

- Actor probe: G = 1, L = 0 or 1.
- F3-A1: PASS for every counted task at c = 1 and c = 2; at c = 4, PASS or NOT_RUN (capacity).
- MT-W01 at c = 1, 2 and 4: PASS.
- MT-ISO: PASS for each tenant, or NOT_RUN (capacity).
- The planted-marker control finds its marker.
- Timing: recorded with no PASS or FAIL; no comparison with C-70.

## 11. Step 2: two clusters

### 11.1 Cluster B

B exists (section 3): same project, zone `<zone-b>`, 2 × c3-standard-4, amd64, no autoscaling, the same GKE version as A, Workload Identity on. Substrate v0.6.0 (`d3f2363590a1`) was installed with its own `ate-setup`, from a config derived from A's private install config and the v0.6.0 requirements in L-046: a cluster-wide `--snapshot-location` in B's own bucket, `--ingress-allowed-spiffe-ids` including `apl-ax-6882d106/apl-collector`, `ax-server` as a bootstrap owner, home-built v0.6.0 images (the release images are not public). AX `4b7bf6f` was deployed with `make deploy`, `AX_SNAPSHOTS_BUCKET` pointed at a B-owned prefix (L-031). Images are pulled from the same private repo by digest. B's IAM is not changed: its bucket and four bindings stay as recorded in its run dir, and its Substrate keeps using A's transfer account.

### 11.2 Warm-up preflight (L-030)

The warm-up round of each configuration on each cluster is the protocol preflight; there is no separate tool. Its actor listings (`kubectl ate get actors`, 10.3) must decode every actor with a state other than `UNSPECIFIED` (the L-030 symptom), and no `ax` or `kubectl ate` call in it may return `Unimplemented` or an unmarshal error. A failure, or a vacuous warm-up (no task ran or no actor was listed), leaves that cluster's rows BLOCKED (stop rule 1). A warm-up that could not schedule its tasks is capacity, not protocol (stop rule 4).

The all-clusters view also compares identity across clusters from each `versions.json`: AX commit, `ax-server` digest, lab image digest, Substrate commit. If they differ, the view says "not comparable" next to the statuses; it does not hide them.

### 11.3 Same case on each cluster (MT-W01, step 2)

One tenant per cluster, c = 1, 30 tasks plus a warm-up round, A first, then B, in the same session. Per cluster: 30 F3-A1 reports and one MT-W01 report recording `step` 2, with the warm-up listed separately. Its foreign markers are every earlier registered tenant run: step 1's on A, and on B also A's step 2 tenant run.

### 11.4 The network between the clusters (configuration fact, not a test)

Checked read-only on 2026-10-29 (`gcloud container clusters describe`, `gcloud compute networks describe`, `gcloud compute firewall-rules list`): both clusters are in the same VPC and subnet, VPC-native, on Dataplane V2, with public control-plane endpoints. Their pod ranges are distinct and their Service ranges are identical, so the other cluster's ClusterIPs name local Services or nothing. The VPC firewall admits ingress to each cluster's nodes from that cluster's own pod range and from the VPC's internal range, which holds the node addresses but neither pod range: pod-to-pod traffic between the clusters is refused before any TLS while it keeps the pod address (GKE's default for private destinations, not verified here), and traffic leaving with a node address is admitted on every port. This enters the ledger as one row labelled "configuration fact, not a test". No cross-cluster probe runs, so the mTLS boundary between the clusters is not exercised.

Owner and baseline: before step 1, `multi.ts infra b --baseline` reruns these read-only commands into `network-baseline.json` in B's infrastructure run dir and stops for the owner if the result does not match this paragraph; before step 2, `multi.ts infra b` reruns them into `network-check.json` and compares field by field, and any difference stops the step (stop rule 8).

### 11.5 Per-bundle reports and the all-clusters view

Reports are built per bundle by `generateReport()` (`src/reports/artifacts.ts`), so its checksum check (L-022) and containment check (L-052) apply to every AX bundle. `multi.ts report`, for each planned bundle: if a stop left it unobserved, write its BLOCKED or NOT_RUN bundle from `stopped.json` (section 14); choose the table (F3-A1 → `cases.ax.json`, every other case → `cases.multi.json`); run `evaluate_ax.py --cases <table> <case> <dir>`; call `generateReport(run_id, { expected, limitations, cleanup_status })` with that table's expectations, the limitations of 16.1 and the cleanup status from teardown; apply the agreement rule; then `exportRun(run_id, { outRoot: join(ROOT, "docs/evidence") })`.

New `src/reports/aggregate.ts` does only the roll-up:

- Input: the set's `plan.json`, every planned bundle's `report.json` and the set's `timing-raw.json`.
- One row per planned bundle (cluster, step, configuration, tenant run, case, task). A planned bundle with no report (a crash, not a recorded stop) is `NOT_RUN` with reason "planned, no report"; it is never dropped.
- Tenant, configuration, cluster and overall rows use the existing `aggregate()` from `report.ts` (the C5 precedence). Any FAIL anywhere makes the overall status FAIL.
- The overall line always names each cluster, for example for step 2 `all clusters: FAIL (A PASS, 31 reports; B FAIL, 31 reports)`, where 31 is 30 F3-A1 reports plus MT-W01, warm-up excluded. There is no single green banner: even when everything is PASS the text reads `all clusters: PASS (A PASS, 31 reports; B PASS, 31 reports)`, next to the per-cluster rows.
- It includes the timing summary (section 13).
- Output: `docs/evidence/<set_id>/aggregate.json`, `aggregate.md`, `timing.json`, `checksums.sha256`. Before writing, every output is scanned with `SECRET_RULES` and the private-terms list from `export.ts`; any finding quarantines it, as `exportRun()` does.
- Unit test (`tests/unit/aggregate.test.ts`): one FAIL row among PASS rows gives FAIL; a missing planned row gives NOT_RUN; UNKNOWN outranks BLOCKED; all PASS gives PASS with every cluster named.

### 11.6 Pre-registered expectations (step 2)

- Warm-up preflight passes on both clusters (B's `versions.json` records versions matching A's).
- F3-A1 PASS for every counted task, and MT-W01 PASS, on both clusters.
- The network re-check matches the baseline.

## 12. Step 3: one BLOCKED result and a deferred design

### 12.1 Suspend on A, resume on B (MV-PORT): BLOCKED

MV-PORT was to be BLOCKED if the pinned protos document no operation that creates or resumes a task or actor from an existing snapshot. The read was done during EGM review round 3, read-only, in the local checkouts:

- AX `4b7bf6f`, `pkg/apis/v1alpha1/ax.proto`: the service is Task, Workspace and Model CRUD plus `SuspendTask` and `ResumeTask`. There is no import, export, snapshot or restore RPC.
- Substrate v0.6.0 `d3f2363`, `pkg/proto/ateapipb/ateapi.proto`: an actor can be seeded only from a Tag (`Actor.source_tag`), and a Tag's required `source_actor` is the suspended actor whose external snapshot the tag captures, which is an actor in the same control plane. Checkpoint and restore appear only in the internal `atelet`, `ateworker` and `objectstore` protos.

Result: no documented cross-cluster import path at the pinned SHAs. MV-PORT is one planned ledger row (16.2) with execution BLOCKED and that reason, citing the read as recorded in `RESEARCH.md`; no bundle, task mode or cluster call. No undocumented route is tried: copying snapshot objects or editing Substrate records would test the lab's copy, not the product. B keeps its bucket and its four bindings exactly as recorded in its run dir.

### 12.2 Eviction mid-run (MV-DRAIN): deferred

MV-DRAIN, S2 on AX with one worker Pod evicted mid-run, is not designed here. A follow-up design, written after steps 1 and 2 have run, must answer what round 3 found:

- Duplicates must be counted from effects outside the sandbox (thread replies, S3 receipt objects, stimuli): the eviction reverts the workspace and its ledger (L-048), so every ticket in a post-eviction ledger export looks new and S2's recovery evidence cannot exist there. The revert itself must be recorded as a fact, not inferred.
- The run flow: commands that pass the context guard, the actor-to-Pod lookup, the collector's phases before and after the eviction merged into one bundle, a completion condition, and an uncordon on every exit.

The follow-up gets its own EGM review. Until then this design has no MV-DRAIN case, key, file, expectation, ledger row or stop rule.

## 13. Timing methodology

Per task, three intervals, each on one clock:

| Key | Clock | From → to |
|---|---|---|
| `server_resume_to_running_ms` (headline) | ax-server log | `msg="resuming actor on Substrate worker" actor=<task>` → `msg="task successfully reconciled and running"` with the same `actor`, from their `time=` fields (slog text handler; `internal/controller/reconciler.go` and `cmd/ax-server/main.go` at `4b7bf6f`), as L-050 recommends; absent with a reason if either line is missing |
| `egress_attach_ms` | operator | start of `ax apply` → egress policy attach returned |
| `submit_to_result_ms` | operator | start of `ax apply` → the collector's `result` exec returns HTTP 200. The exec round trip is measured each round with an empty exec and reported beside it, not subtracted |

Per round, `resume_spread_ms` (ax-server log): the latest minus the earliest `resuming actor` line of the round's c tasks (0 at c = 1).

Headline source: after each round, `kubectl --kubeconfig <run-dir>/kubeconfig -n ax-system logs deployment/ax-server --since-time=<round start>`, saved verbatim in the set dir as `ax-server-<cluster>-c<c>-r<round>.log` (private: its lines hold worker IPs) and read by `serverIntervals()` and `resumeSpread()`. Raw values go only to the set dir's `timing-raw.json`; `aggregate.ts` writes the summary and the raw rows, keyed by run ID and round, to `docs/evidence/<set_id>/timing.json`. Bundles carry no timing.

Summary per configuration (cluster, step, c): n (tasks, n ≥ 30), p50 by nearest rank (n = 30: the 15th value; n = 32: the 16th) and max, for the headline and, as tooling context beside it, for the two operator intervals; p50 and max of `resume_spread_ms`. No other percentile, no interval, and no comparison with C-70, whose result time subtracted a laptop timestamp from a collector Pod timestamp. Per-tenant breakdowns show p50 and max only. Warm-up rounds are listed separately.

## 14. Stop rules

Each rule stops the current step, keeps the evidence, runs teardown for the affected step run dir, and reports what ran. A stop records every planned bundle it leaves unobserved, with its status and reason, in the step run dir's `stopped.json`; `multi.ts report` turns those into BLOCKED or NOT_RUN bundles (11.5).

1. Warm-up preflight failed or vacuous on a cluster (11.2), or the planted-marker control found no marker (9.3): nothing more is applied there; the cluster's rows are BLOCKED.
2. A context mismatch anywhere (runner, `gcloud` or `teardown.sh`): stop the set.
3. Any cross-tenant upstream connection in the gateway log: stop the step. The collector-judged case reports FAIL where it applies; no higher concurrency level runs.
4. An actor probe with G or L outside 0 and 1, a warm-up round not fully scheduled, `ResourceExhausted`, a task unscheduled for 120 s, or an actor count other than the rule of 10.3: stop that level; it and every higher level are reported NOT_RUN with the reason (capacity or actor count); the lower levels stand. A failed actor probe makes all of step 1 NOT_RUN. MT-ISO counts as the level after c = 4: if c = 4 stopped, MT-ISO is NOT_RUN with c = 4's reason; if MT-ISO's own tasks cannot be scheduled, its four rows are NOT_RUN (capacity) and c = 1 to 4 stand.
5. `evaluate_ax.py` and `generateReport()` disagree on a bundle: stop; no export, no ledger row. The agreement rule, `agrees()` in `multi-facts.ts`: evaluate PASS agrees only with report PASS; evaluate FAIL whose every reason is `Missing observation: <key>` agrees with report UNKNOWN; evaluate BLOCKED agrees with report NOT_RUN or BLOCKED; any other pair must be the same status. A pair where exactly one side is PASS is always a real disagreement.
6. An export or aggregate finding (secret rule or private term): quarantine; no ledger row from that run.
7. Teardown not `CLEAN` on a run dir: no later step starts until it is.
8. Any action that would touch something not listed in a run dir (A's router allowlist, another pool, any IAM), a gateway log config that differs from the pinned one (5.4), or a network fact that differs from the baseline (11.4): stop and ask the owner.
9. Step order: 1, then 2.

## 15. Owner approvals

| Action | Where | Status | Recorded in |
|---|---|---|---|
| Private Artifact Registry repo; push AX `4b7bf6f` images and the lab image | project | done 2026-10-29 | A's infrastructure run dir (`ar`, `images`) |
| Redeploy AX `4b7bf6f` on A; collector namespace on A | A | done 2026-10-29 | A's infrastructure run dir |
| Create cluster B, its snapshot bucket and the bucket bindings | project | done 2026-10-29 | B's infrastructure run dir (`gke_cluster`, `gcs_buckets`, `iam`) |
| Install Substrate v0.6.0 and AX on B | B | done 2026-10-29 | B's infrastructure run dir (`versions.json`) |
| Resize B's node pool to 0 until build phase 5 passes, then back to 2 | B | needed | B's infrastructure run dir |
| Collector namespace, Pod, NetworkPolicy and pool on B; pool at R = 3 on both clusters; A's idle infrastructure emulators scaled to 0 | A, B | needed | infrastructure run dirs |
| Per-step tenant namespaces, collector Secret, AX tasks | A, B | needed | step run dirs |
| Delete cluster B, its bucket with its four recorded bindings, and its disks | project | needed; done by `teardown.sh` (16.3) | B's infrastructure run dir |

## 16. Evidence, ledger and teardown

### 16.1 Evidence per bundle

Per bundle: the collector writes `observations.json` and `evidence/` in the collector Pod; `run-step` copies them to `artifacts/runs/<run_id>/` right after `observe`. `multi.ts report` passes these extra limitations to `generateReport()` (11.5): one collector identity per cluster (section 6); one operator identity for the AX API; a tenant here is a namespace, an atespace and an Emulate workspace driven by that one identity, not a separately authenticated AX tenant (L-034); gVisor only; two clusters in one project and one VPC. Per set: the aggregate files from section 11.5.

`report.ts` chooses four strings without regard to profile, and for profile `ax` each says "local": `MODE_LABEL.scripted` "local integration run (scripted driver)" (used in the green banner and the "Mode:" limitation), the non-green banner "NOT A SUCCESS: local core <status>", the `lanes.local` reason "local core: required assertions only" (set in `lanesFrom()`, which gains the `profile` argument), and the markdown line "- Local core: **<status>**". For profile `ax` only they become "AX task (scripted driver)", "NOT A SUCCESS: AX lane <status>", "AX lane: required assertions only" and "- AX lane: **<status>**". One fixed limitation is false for AX: "Grants live in the worker-written ledger; the collector reads them read-only …". The AX collector cannot open the sandbox's ledger, so for profile `ax` it reads "Ledger facts come from an export the in-sandbox coordinator wrote to the task's bucket; the collector reads it with its own credentials but cannot open the sandbox's ledger." The C5 key `lanes.local` stays, and the local lane's wording does not change; `report-wording.test.ts` checks both.

### 16.2 Ledger

A new evidence set **XM** in `CLAIM_LEDGER.md` ("Evidence sets" table): AX `4b7bf6f`, Substrate v0.6.0 `d3f2363`, lab image digest and commit, `set_id`s, per-bundle exports in `docs/evidence/<run_id>/`, aggregates in `docs/evidence/<set_id>/`. A new section "Optional AX lane, many tenants and two clusters (set XM)". IDs start at C-80 (the ledger currently ends at C-70) and are taken in order as results are recorded; no block is reserved. One row per result, added only when its evidence exists. Planned results, in expected order:

- MV-PORT: BLOCKED, "no documented import path at the pinned SHAs", citing `RESEARCH.md` (12.1). Its evidence is the proto read, so it can be recorded first.
- Step 1 on A at c = 1, 2 and 4, one row per configuration, citing every task and tenant export.
- MT-ISO on A, four tenants.
- Timing on A at c = 1, 2 and 4 (EXECUTED, measured; no PASS or FAIL), each with its measured resume spread.
- The network between A and B, labelled "configuration fact, not a test" (11.4).
- MT-W01 of step 2 on A and on B; the all-clusters status for step 2; timing of step 2 on A and on B.

A vendor statement, if one is added, takes the next free ID as DOCUMENTED (doc path at a pinned SHA), is never EXECUTED and is never compared with a lab number.

"Claims that must not be made" gains: no percentile other than p50, and no interval, from an XM configuration with n ≥ 30; no concurrency claim beyond the measured resume spread; not "AX isolates tenants" beyond the probed targets, one sandbox class and one collector identity; not "the clusters cannot reach each other": the network is a configuration fact, not tested; not "work moves between clusters": MV-PORT is BLOCKED; nothing about eviction (12.2); no comparison with C-70 or with vendor scale statements.

### 16.3 Teardown

- **End of each step, per cluster:** `teardown.sh <step-run-dir>` in default mode. In the script's order: the AX tasks and Workspaces per atespace; the listed Substrate objects other than egress policies (leftover golden actors and templates, section 8), then the atespaces; the listed Kubernetes objects by exact name (`collector-env-tenants` included) and the tenant namespaces; then the diff against the step's `pre-snapshot.json`. Egress policies are listed under `substrate` for the record, but `teardown.sh` does not delete them: they go with their actor when the task is deleted.
- **After the last step, B first:** `teardown.sh <B's infrastructure run dir>` in default mode, the first real use of the `gke_cluster` path (until now only `--dry-run`). The script's real order: the AX, Substrate and Kubernetes objects B's run dir lists; B's four recorded bindings, then its bucket; cluster B (Substrate, AX and the collector namespace go with it), with the disks its PersistentVolumes provisioned noted before and deleted after; last, the diff against B's project-level `pre-snapshot.json`. No `--remove-substrate-iam`: B lists no account, and that flag's IAM step would run before the diff. The script runs under `set -e`, so a failed step exits before the diff; the independent check below runs anyway, and the run dir is not `CLEAN` until it passes (stop rule 7).
- **B's expected diff.** B's pre-snapshot was taken after A's Artifact Registry repo existed, and B is torn down before A, so the repo gives no line. Only `compute_disks` lines for A's node boot disks can be expected, if GKE recreated an A node in between; `teardown.sh` reports them as UNEXPECTED, and the runner accepts one only if A's node pool names that disk, recording why. Any other line keeps the run dir from `CLEAN`.
- **Then A:** `teardown.sh <A's infrastructure run dir>` in default mode. It deletes what that run dir lists: its AX task and Workspace, the collector namespace with Floci, Emulate, the pool and the collector, `ax-system` with its cluster-scoped objects, the snapshot prefix and the Artifact Registry repo, then diffs against A's `pre-snapshot.json`. It leaves Substrate v0.6.0 and A's transfer account and grants in place, as today.
- **Independent check, every run dir:** afterwards, as in run 3, read-only queries independent of the script's own report confirm each listed resource is gone.

## 17. Alternatives considered

- **Per-tenant collector identities on B.** B is new, so its allowlist could list one collector SPIFFE ID per tenant, and cross-tenant reads through the router could be tested there. Not chosen: scope. A cross-tenant read test through the router is a new test, not one of the approved steps, and it needs a per-tenant collector setup this design does not build. It remains the obvious follow-up if the owner wants the router boundary tested.
- **Per-tenant WorkerPools.** No isolation gain, since AX sets no `workerSelector` (L-039).
- **Summary keys over all tasks** (`w01_tasks_missing`, `w01_tasks_incomplete`). Dropped: they turned an absent fact into FAIL. One F3-A1 bundle per task keeps absent as UNKNOWN.

## 18. Risks, cost and duration

- **Cost.** B's hourly footprint: one GKE cluster fee and one bucket at all times, plus, while its node pool runs, 2 c3-standard-4 nodes (8 vCPU, 32 GiB) and their boot disks. A's footprint does not grow. B's node pool is resized to 0 now and back to 2 only after build phase 5's gate passes; Substrate and AX on B restart when the nodes return, and the warm-up preflight (11.2) runs after that. This doc quotes no price; the owner checks the current list price.
- **Duration (estimate from run 3, about 20 s per task plus deletion and collection).** Step 1 about 1.5 hours (c = 1 alone is 31 rounds, after the two-round actor probe), step 2 about 45 minutes, plus teardown. B's nodes are billed from the resize back to 2 until B's teardown, including any pause between steps.
- **Network.** Traffic with a node address crosses between the clusters on every port, and both control planes are public. The lab runs no hostNetwork Pod and probes no cross-cluster path; 11.4 is a configuration fact.
- **Capacity and gateway sampling.** c = 4 and MT-ISO may end NOT_RUN (10.3). A probe target that answered 2xx would be forwarded unseen (5.4), so the phase 3 gate checks the 404s.
- **Teardown.** The `gke_cluster` path of `teardown.sh` has only been dry-run; its first real use is B's deletion, followed by the independent read-only check.

## 19. Decisions

1. One collector identity per cluster, one Secret mounted whole, one collector process per call (section 6).
2. A tenant is a namespace, an atespace and an Emulate workspace driven by one operator identity (16.1).
3. The network between the clusters is a configuration fact with a baseline, not a test (11.4).
4. Emulator requests live in `tenant.yaml`; `emulators.yaml` is untouched; idle emulators are scaled to 0 (10.3).
5. The gateway log's attribution is not relied on; probes draw 404s because the log samples 2xx (5.4, 10.4).
6. Rounds run their c tasks together and report the measured overlap (10.3).
7. Timing: headline from the ax-server log, p50 and max only, one location (13).
8. `multi.ts` is the one cluster driver, on run 3's tooling path, reusing the existing helpers (5.1).
9. Reports are built by `generateReport()`; `aggregate.ts` only rolls up (11.5).
10. AX-lane report wording by profile, keeping the `lanes.local` key (16.1).
11. B's zone stays private; only the C-80 start is fixed (16.2).
12. Step 3: MV-PORT BLOCKED by the proto read, MV-DRAIN deferred to its own design and review, no IAM change for B (section 12).

## 20. Review outcome

- **Round 1.** Four reviewers (design critic, implementation readiness, codebase details, zoom-out), 21 issues plus nits, none contested; every PROPOSE FIX accepted; Issue 10 resolved with B's own transfer account, moot since round 3.
- **Round 2.** 6 Blockers and 10 Majors, mostly in round 1's new text; every PROPOSE FIX accepted (R2-1 to R2-16 and nits).
- **Round 3.** 3 Blockers and 17 Majors after deduplication, with churn on R2-3, R2-5, R2-6, R2-12 and R2-14. The reviewers read the pinned protos and found no documented cross-cluster import path (12.1). The owner split step 3 out (resolving R3-1 and R3-7): MV-PORT is one BLOCKED result, and MV-DRAIN moves to a follow-up design with its own review. Removed with step 3: the `mvport` and `S2` modes and their files, B's own transfer account and its IAM edits, `--remove-substrate-iam` for B, the shared Workload Identity principal escalation, and their approvals, risks, decisions and alternatives. Every other round 3 PROPOSE FIX (R3-2 to R3-6, R3-8 to R3-18) and the listed nits are applied in the sections they name. Round 4 is pending.

## Appendix A. File formats

One compact example per file; values are illustrative and private values are placeholders (design rule 6).

| File | Where | Example |
|---|---|---|
| `plan.json` | set dir | `{"set_id": "<uuid>", "step": 1, "clusters": {"a": {"infra_run_dir": "41dc91c3-…", "context": "<context-a>", "step_run_id": "<uuid>"}}, "configurations": [{"cluster": "a", "c": 2, "rounds": 15, "tenant_runs": [{"tenant": "t1", "tenant_run_id": "<uuid>", "tr8": "1a2b3c4d", "tasks": ["apl-1a2b3c4d-00", "apl-1a2b3c4d-01"], "bundles": [{"run_id": "<uuid>", "case": "F3-A1", "task": "apl-1a2b3c4d-01"}, {"run_id": "<uuid>", "case": "MT-W01", "task": null}]}]}]}` |
| `versions.json` | infrastructure run dir | `{"cluster": "<cluster-a>", "gke": {"master": "1.36.4-gke.<n>", "nodes": "1.36.4-gke.<n>"}, "kubectl_client": "v1.36.6", "substrate": {"version": "v0.6.0", "commit": "d3f2363…", "kubectl_ate": "v0.6.0 build"}, "ax": {"commit": "4b7bf6f…", "ax_server": "<registry>/ax-server@sha256:…", "client_pins_substrate": "v0.6.0"}, "lab_image": "<registry>/apl-lab@sha256:…"}` |
| `network-baseline.json`, `network-check.json` | B's infrastructure run dir | `{"taken_at": "<iso>", "clusters": {"a": {"network": "<vpc>", "subnet": "<subnet>", "pod_range": "<cidr>", "service_range": "<cidr>", "dataplane_v2": true, "public_endpoint": true}, "b": {…}}, "firewall": [{"name": "<rule>", "source_ranges": ["<cidr>"], "targets": ["<tag>"], "allowed": ["all"]}]}` |
| `tenant-runs.json` | `private-runs/ax/` | `[{"tenant_run_id": "<uuid>", "tr8": "1a2b3c4d", "cluster": "a", "set_id": "<uuid>", "created_at": "<iso>", "run_ids": ["<uuid>"], "tasks": ["apl-1a2b3c4d-01"], "token_sha256": ["<hex>"]}]` |
| `--foreign-markers-file` | set dir | `{"tenant_run_id": "<uuid>", "foreign": [<every other tenant-runs.json entry>]}` |
| `--targets-file` | set dir | `[{"role": "t2-emulate-clusterip", "host": "emulate.apl-ax-5e6f7a8b.svc.cluster.local", "port": 8080, "addresses": ["<ip>"], "own": false}, {"role": "t1-floci", "host": "floci.apl-ax-1a2b3c4d.svc.cluster.local", "port": 4566, "addresses": ["<clusterip>", "<pod-ip>"], "own": true}]` |
| `--disclosure-file` | set dir | `{"tenant_run_id": "<uuid>", "tasks_checked": 8, "foreign_secret_in_task_count": 0, "method": "operator string search of ax get task; output not stored"}` |
| `--egress-log-file` | set dir | `{"window": {"from": "<iso>", "to": "<iso>"}, "source": "kubectl logs -l app=atenet-egress -c envoy, ate-system", "lines": ["<access-log line, verbatim>"]}` |
| `--run-facts` | set dir | `{"step": 1, "concurrency": 2, "tasks_planned": 15, "tasks_timed": 15}` |
| `stopped.json` | step run dir | `[{"run_id": "<uuid>", "execution": "NOT_RUN", "reason": "stop rule 4: ResourceExhausted at c = 4, round 3"}]` |
| `timing-raw.json` | set dir | `{"tasks": [{"run_id": "<uuid>", "cluster": "a", "c": 2, "round": 3, "task": "apl-1a2b3c4d-03", "server_resume_to_running_ms": 2100, "egress_attach_ms": 9000, "submit_to_result_ms": 19700, "empty_exec_ms": 600, "unobserved": {}}], "rounds": [{"cluster": "a", "c": 2, "round": 3, "resume_spread_ms": 180}]}` |
| `timing.json` | `docs/evidence/<set_id>/` | `{"set_id": "<uuid>", "configurations": [{"cluster": "a", "step": 1, "case": "F3-A1", "c": 2, "n": 30, "server_resume_to_running_ms": {"p50": 2100, "max": 2600}, "resume_spread_ms": {"p50": 180, "max": 400}, "operator": {"submit_to_result_ms": {"p50": 19700, "max": 21000}}, "warmup": [{"task": "apl-1a2b3c4d-00", "server_resume_to_running_ms": 2900}]}], "raw": <timing-raw.json rows>}` |
