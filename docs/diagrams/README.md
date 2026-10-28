# Architecture diagrams

**These are architecture, not execution evidence.** A box or an arrow here says how the code is built, not that a case passed. Run results live in `artifacts/runs/<run_id>/` and are cited by run ID in [`../CLAIM_LEDGER.md`](../CLAIM_LEDGER.md). The one exception in kind is the AX lane, whose diagrams show what was deployed for run 3; its results are in [`../../profiles/ax/RESULTS.md`](../../profiles/ax/RESULTS.md), not in the drawing.

## Index

Each diagram exists twice: a Mermaid block below, which GitHub renders inline, and an interactive HTML view generated with Archify from the JSON in [`src/`](src/). GitHub shows the HTML as source, so download it and open it locally.

| HTML view | Archify type | What it answers |
|---|---|---|
| [`mental-model.html`](mental-model.html) | architecture | The four layers (execution, emulation, authorization, evidence) kept apart, and the fifth question: what can honestly be claimed. |
| [`system-map.html`](system-map.html) | architecture | Every runtime part of the local lab and what talks to what. |
| [`infra-layers.html`](infra-layers.html) | architecture | Where it runs: the local host, and the optional GKE lane as deployed in run 3, with what teardown removed and what remains. |
| [`request-flow.html`](request-flow.html) | sequence | How one W01 service request travels from a Slack mention to a C5 report, with its failure branches. |
| [`trust-boundaries.html`](trust-boundaries.html) | architecture | Which process holds which credential, and what enforces each boundary. |
| [`evidence-flow.html`](evidence-flow.html) | dataflow | How a stimulus becomes a fact, a report and a published claim. |
| [`ax-lane.html`](ax-lane.html) | architecture | The optional AX lane on Agent Substrate as executed in run 3, with its per-assertion results. |

Automated Archify checks (schema, layout, provenance and a real-browser check) passed for all seven. An agent inspected light-theme captures of the five redrawn on 2026-10-29; no person has reviewed any of them.

Drawn from the tree at commit `872e83a` (2026-10-29). If the code changes, these change with it: every box names the file that implements it, here or in the HTML cards.

## (a) Mental model: four layers and the fifth question

```mermaid
flowchart BT
  subgraph EXE["1. Execution: where does it run?"]
    ax["AX runner on Substrate v0.6.0, gVisor<br/>optional; ran in run 3"]
    worker["Scripted worker<br/>W01-W03, no model"]
  end
  subgraph AUTH["3. Authorization: is the action allowed?"]
    identity["Verified identity<br/>HMAC + installation binding<br/><i>src/http/slack.ts</i>"]
    policy["Deterministic policy<br/>current grants, re-checked at job time<br/><i>src/policy/index.ts</i>"]
    envelope["C3 ActionEnvelope<br/>unknown fields rejected"]
    approval["Approval binding<br/>request digest + expiry (W02)"]
  end
  subgraph EMU["2. Emulation: what does it touch?"]
    slack["Emulate Slack x2"]
    floci["Floci S3 + SQS"]
    ledger[("SQLite ledger")]
    crm["CRM contract double<br/>not Salesforce"]
    sf["Salesforce scratch org<br/>optional, BLOCKED"]
  end
  subgraph EVI["4. Evidence: did it meet the requirement?"]
    collector["Independent collector<br/>own process + credentials"]
    bundle[("C4 bundle")]
    evaluator["Supplied evaluator<br/>fixed cases.json"]
    report[("C5 RunReport")]
  end
  subgraph CLAIM["5. What can honestly be claimed?"]
    status["Assertion status<br/>PASS, FAIL, BLOCKED, SKIPPED, NOT_RUN, UNKNOWN"]
    labels["Claim labels<br/>DOCUMENTED, DESIGNED, EXECUTED, UNKNOWN"]
    claims[("Claim ledger<br/>run ID + tree SHA + limits")]
  end

  slack -- "signed callback" --> identity
  identity -- "tenant" --> policy
  worker -- "every action" --> policy
  ax -. "runs task" .-> worker
  policy -- "decides" --> envelope
  approval -- "digest" --> envelope
  envelope -- "S3 PUT, SQS" --> floci
  envelope -- "transaction" --> ledger
  envelope -- "CAS write" --> crm
  crm -. "BLOCKED" .-> sf
  slack -. "reader token" .-> collector
  floci -. "own client" .-> collector
  ledger -. "read-only" .-> collector
  collector -- "facts" --> bundle
  bundle -- "C4" --> evaluator
  evaluator -- "C5" --> report
  evaluator -- "assigns" --> status
  report -- "cited by run ID" --> claims
  labels -- "labels" --> claims
```

Each layer answers one question; a green result in one says nothing about another. Every effect, `slack.reply` included, is a C3 envelope that deterministic policy decided (`src/workflows/context.ts`). A worker's "done" reply is one observation for the collector, not the verdict. Sources: [`../MENTAL_MODEL.md`](../MENTAL_MODEL.md), [`CONTRACTS.md`](../spec/active/2026-10-28-agent-proof-lab/contracts/CONTRACTS.md) (C2 to C5), the README section "Understand the layers".

## (b) System map

```mermaid
flowchart LR
  subgraph CLI["lab CLI process: stack + stimulus"]
    profiles["Optional profile adapters<br/>doctor reads config, 0 calls<br/>AX ran in run 3; rest BLOCKED<br/><i>src/config/profiles.ts, profiles/*</i>"]
    coord["lab CLI + coordinator<br/>per-run ports, DB, compose project<br/>down --orphans sweep<br/><i>src/config/lifecycle.ts, src/evaluator/collect-case.ts</i>"]
    slack["Emulate Slack x2, in-process<br/>T_LAB_A, T_LAB_B, strict scopes<br/><i>src/adapters/slack/emulator.ts</i>"]
    proxy["Worker Slack proxy<br/>only POST chat.postMessage<br/><i>src/adapters/slack/worker-proxy.ts</i>"]
  end
  worker["Worker process<br/>signed ingress, policy, W01-W03<br/>run-owned HOME, allowlisted env<br/><i>src/http/slack.ts, src/worker/worker.ts</i>"]
  floci["Floci 2.3.0 container (by digest)<br/>S3 receipts, SQS jobs, loopback only<br/><i>compose.yaml, src/adapters/floci/</i>"]
  ledger[("SQLite ledger<br/>inbox, outbox, tickets, approvals, CRM double<br/><i>src/ledger/db.ts, src/adapters/crm-local/</i>")]
  collector["Independent collector<br/>separate process, own credentials, run-owned HOME<br/><i>src/collector/main.ts, probe.ts</i>"]
  evaluator["Supplied evaluator<br/><i>evals/evaluate.py</i>; <i>src/reports/report.ts</i> applies the same rule"]
  reports[("Run artifacts + export<br/>C5 report, checksums, contained evidence paths<br/><i>src/reports/artifacts.ts, export.ts</i>")]
  console["Teaching console<br/>loopback, one collect-case run per scenario<br/><i>src/console/, web/</i>"]
  media["Media pipeline<br/>capture, optimize, verify<br/><i>src/media/</i>"]

  coord -. "doctor, 0 calls" .-> profiles
  coord -- "user posts" --> slack
  slack -- "signed event" --> worker
  worker -- "slack.reply envelope, re-validated" --> proxy
  proxy -- "POST only" --> slack
  worker -- "S3 PUT, SQS" --> floci
  worker -- "transactions" --> ledger
  ledger -. "read-only" .-> collector
  slack -. "reader token" .-> collector
  floci -. "own S3/SQS client" .-> collector
  collector -- "C4 bundle" --> evaluator
  evaluator -- "C5 report" --> reports
  reports -- "reads" --> console
  console -- "run scenario" --> coord
  media -- "drives UI" --> console
  media -- "export + scan" --> reports
```

The coordinator starts the stack (`startRun` in `src/config/lifecycle.ts`), spawns the worker and the collector as separate Node processes with run-owned HOME directories (`src/worker/config.ts`, `collectorEnv` in `src/evaluator/collect-case.ts`), drives the scripted stimulus and asks the collector to observe. The worker never talks to the collector, and the collector never writes business state. Changed since the first map: replies are C3 `slack.reply` envelopes stored in the outbox and re-validated before the proxy send (`publish` in `src/worker/worker.ts`); evidence paths must resolve inside the run's artifact directory, so a symlink cannot escape (`containedPath` in `src/reports/report.ts`); `lab down --orphans` removes only containers of runs that are no longer active (`removeOrphans`). Not drawn: the fault-injecting loopback proxy (`src/adapters/faults/proxy.ts`) used by W01-S and W01-T.

## (c) Infrastructure layers

```mermaid
flowchart LR
  subgraph LOCAL["Local host: macOS arm64, Node 24, Docker Desktop"]
    coord["lab CLI + coordinator<br/>Emulate in-process, per-run ports"]
    worker["Worker process<br/>run-owned HOME"]
    collector["Collector process<br/>run-owned HOME"]
    subgraph DOCKER["Docker"]
      floci["Floci container<br/>by digest, 127.0.0.1 only<br/>compose project per run"]
    end
    artifacts[("artifacts/runs/#lt;id#gt;/<br/>C4, C5; gitignored")]
    privateruns[("private-runs/#lt;id#gt;/<br/>manifest, ledger; gitignored")]
    evidence[("docs/evidence/#lt;id#gt;/<br/>sanitized; committed")]
    operator["Operator tools<br/>kubectl, ax CLI, orchestrate.ts"]
  end
  subgraph GCP["GCP project #lt;project#gt; (optional AX lane, run 3)"]
    registry["Artifact Registry #lt;registry#gt;<br/>REMOVED"]
    bucket[("GCS #lt;snapshot-bucket#gt;<br/>run prefixes REMOVED")]
    sa["Transfer SA #lt;transfer-sa#gt;, 3 grants<br/>REMAINS"]
    subgraph GKE["GKE #lt;cluster#gt;: 2 x c3-standard-4, pre-existing"]
      substrate["Agent Substrate v0.6.0<br/>ate-system; REMAINS"]
      sandbox["Task sandbox (gVisor)<br/>run-owned WorkerPool; REMOVED"]
      atenet["atenet router + egress<br/>mTLS SPIFFE; REMAINS"]
      axcp["AX control plane<br/>ax-system + Postgres; REMOVED"]
      podcollector["Collector Pod<br/>own SA + cert; REMOVED"]
      emulators["Emulate + Floci<br/>lab namespace; REMOVED"]
    end
  end

  coord -- "spawns" --> worker
  coord -- "spawns" --> collector
  worker -- "S3, SQS" --> floci
  collector -- "C4 bundle" --> artifacts
  artifacts -- "lab export" --> evidence
  operator -- "run dir" --> privateruns
  operator -- "ax apply" --> axcp
  axcp -- "actors" --> substrate
  substrate -. "snapshots" .-> bucket
  substrate -- "impersonates" --> sa
  sa -- "2 roles" --> bucket
  substrate -- "runs actor" --> sandbox
  sandbox -- "egress" --> atenet
  atenet -- "2 services" --> emulators
  podcollector -- "via router" --> sandbox
  podcollector -- "reads" --> emulators
```

The local lane binds every port to loopback (`compose.yaml`, `src/config/endpoints.ts`) and gives each run its own ports, ledger file and compose project (`src/config/lifecycle.ts`). The GKE lane is drawn as deployed in run 3 ([`profiles/ax/README.md`](../../profiles/ax/README.md), in-cluster placement); identifiers are placeholders. After the owner-approved teardown on 2026-10-29 the lab namespace, `ax-system` with its PersistentVolume and disk, the registry and the run's snapshot prefixes are gone; Substrate v0.6.0 and the transfer service account with its three grants remain on purpose, because the v0.6.0 API server needs them ([`RESULTS.md`](../../profiles/ax/RESULTS.md), Teardown). The cluster and the bucket existed before the run.

## (d) How it works: one W01 request

```mermaid
sequenceDiagram
  participant C as Coordinator
  participant S as Emulate Slack
  participant P as Slack proxy
  participant W as Worker
  participant L as SQLite ledger
  participant F as Floci SQS + S3
  participant K as Collector
  participant E as Evaluator
  C->>S: post as Dana: @LabBot service-request
  S->>W: signed Events API callback
  Note over W: raw-body HMAC, 300 s window. Forged or stale: 401, no inbox row (G-SIG, G-OLD)
  W->>L: durable inbox insert
  Note over L: unique installation + team + event_id. A signed retry adds nothing (W01-D)
  W-->>S: 200 ok
  W->>L: ticket.create envelope + outbox sqs.send (one transaction)
  W->>F: SendMessage job
  F-->>W: ReceiveMessage
  W->>L: grant re-check, INSERT ticket ON CONFLICT DO NOTHING (W01-Q)
  W->>F: PutObject receipt (bounded retries, read-back)
  Note over W,F: all retries fail: no commit, no completion reply (W01-S)
  W->>L: commit receipt + outbox slack.reply
  W->>P: chat.postMessage, envelope re-checked
  Note over W,P: sent but timed out: outbox UNKNOWN, never re-posted (W01-T)
  P->>S: forward to thread
  C->>K: finish
  K->>S: conversations.replies (reader token)
  K->>F: GetObject receipt (own key)
  K->>L: read-only query
  K->>E: C4 ObservationBundle
  Note over K,E: a capture that failed leaves its fact absent with a reason, never 0
  E-->>C: C5 RunReport vs cases.json F3-A1
  Note over E,C: receipt missing after a success reply: FAIL (W01-F, F4-A1). Unobserved: UNKNOWN
```

Sources: `src/http/slack.ts`, `src/adapters/slack/signature.ts`, `src/ledger/db.ts` (`acceptEvent`), `src/workflows/w01.ts`, `src/workflows/context.ts`, `src/worker/worker.ts`, `src/collector/probe.ts` (`captureTicket`), `src/evaluator/collect-case.ts`, `src/reports/report.ts`, [`../CASEBOOK.md`](../CASEBOOK.md) W01. The branches are exercised by `tests/integration/slack.test.ts` and `tests/integration/workflows.test.ts`; which runs passed is in the claim ledger (C-03 to C-05, C-08).

## (e) Trust boundaries and credential custody

```mermaid
flowchart TB
  subgraph CP["coordinator process (Emulate runs in-process)"]
    coord["Coordinator<br/>holds setup token, per-user tokens,<br/>signing secrets (generated per run)"]
    proxy["Worker Slack proxy<br/>forwards POST /api/chat.postMessage<br/>403 for /_slack/*, /_emulate/*, other methods"]
    emulate["Emulate Slack x2<br/><b>L-019:</b> /_slack/simulate/* accepts any valid token"]
  end
  subgraph WP["worker process"]
    worker["Worker<br/>bot token (chat:write, app_mentions:read)<br/>signing secret per installation<br/>fake AWS key; allowlist without emulator ports"]
  end
  subgraph CL["collector process"]
    collector["Collector<br/>reader token (channels:history, channels:read)<br/>collector AWS key, readonly SQLite handle<br/>loopback sinkhole + PATH shims (F5)"]
  end
  ledger[("SQLite ledger<br/>worker: read-write")]
  floci["Floci S3 + SQS<br/>does not check credentials (L-037)"]
  evaluator["Evaluator<br/>no provider credentials"]

  coord -- "setup token: seed, invite, simulate" --> emulate
  worker -- "chat.postMessage + bot token" --> proxy
  proxy -- "forward only" --> emulate
  emulate -- "HMAC-signed callback" --> worker
  worker -- "transaction" --> ledger
  worker -- "fake AWS key" --> floci
  emulate -. "conversations.* only" .-> collector
  floci -. "own S3/SQS client" .-> collector
  ledger -. "readonly: true" .-> collector
  collector -- "C4 bundle" --> evaluator
```

What enforces each boundary, with the file that does it:

| Boundary | Enforced by | Source |
|---|---|---|
| Worker receives only its bot token and signing secret | `workerConfig` builds the worker's whole env from one JSON value; ambient credential variables are stripped | `src/worker/config.ts`, `src/config/env.ts` |
| Worker cannot reach `/_slack/simulate/*` | The worker is given the proxy URL, never an emulator URL, and emulator ports are removed from its allowlist | `src/config/lifecycle.ts` (`startWorker`), `src/adapters/slack/worker-proxy.ts` |
| Collector cannot write Slack | Its token carries only `channels:history`, `channels:read` under `strict_scopes` | `src/adapters/slack/emulator.ts` (`SCOPES.reader`) |
| Collector cannot write the ledger | `better-sqlite3` opened with `{ readonly: true }` (L-015) | `src/ledger/read.ts` |
| Evaluator cannot see stimulus internals | It reads only the bundle and the spec's `cases.json` | `src/reports/artifacts.ts` |

**Residual (L-019).** Emulate checks only that a token is valid on its simulator routes. Anyone who knows an emulator URL and holds any valid token for that workspace can simulate clicks and retries. The boundary is process separation (the worker never learns the URL), not emulator authorization. **Also labelling only (L-037).** The worker and collector use different Floci keys, but Floci served the worker's receipts to the collector's never-provisioned key: it does not check credentials. The boundary is process separation here too.

**Corrected on 2026-10-29.** Earlier versions drew Emulate outside the coordinator process. It runs inside it: `startWorkspace` calls `createEmulator` in the process that runs `startRun` (`src/adapters/slack/emulator.ts`, `src/config/lifecycle.ts`). The HTML view and the block above now place it there.

## (f) Evidence flow

```mermaid
flowchart LR
  stim["Coordinator<br/>user post or click<br/><i>drive.ts</i>"] -- "signed event" --> worker["Worker<br/>verify, policy, act"]
  worker -- "transaction" --> ledger[("SQLite ledger")]
  worker -- "receipt PUT" --> s3["Floci S3"]
  worker -- "reply via proxy" --> thread["Slack thread"]
  ledger -. "readonly query" .-> collector["Collector<br/>own credentials<br/><i>probe.ts</i>"]
  s3 -. "GetObject" .-> collector
  thread -. "conversations.replies" .-> collector
  collector -- "typed facts + sha256" --> bundle[("C4 bundle<br/>observations.json")]
  bundle --> evaluator["Evaluator<br/>compares with cases.json"]
  evaluator --> report[("C5 report.json, report.md,<br/>checksums.sha256")]
  report -- "sanitized export" --> console["Console, README media,<br/>claim ledger"]
```

Rules the flow depends on, each in code:

1. A fact exists only if every capture it depends on succeeded (`Probe.fact` in `src/collector/probe.ts`). A failed capture leaves the key absent with a reason, so the evaluator reports UNKNOWN, not 0 (G-UNKNOWN).
2. The bundle binds to `tree_sha`, `candidate_revision`, `dirty` and `patch_sha256` (ADR-9). Untracked files make `dirty` true but are not in `patch_sha256` (L-024).
3. `generateReport` refuses to regenerate a report when captured files fail their recorded checksums, or when an evidence path resolves outside the artifact directory (`src/reports/artifacts.ts`, L-022).
4. `exportRun` scans the allowlisted projection for secret-shaped strings and private terms and quarantines the run on any match (`src/reports/export.ts`, G-EXPORT).

## (g) Optional AX lane, as executed in run 3

```mermaid
flowchart LR
  operator["Operator laptop<br/>orchestrate.ts, ax apply<br/>owner-approved run 3"]
  subgraph K["GKE #lt;cluster#gt; (owner-approved), run 3"]
    axcp["AX control plane<br/>ax-system @ 4b7bf6f<br/>phase recorded, not asserted"]
    substrate["Agent Substrate v0.6.0<br/>ate-system; images by digest"]
    router["atenet-router<br/>mTLS, SPIFFE allowlist"]
    egress["atenet-egress<br/>default deny; policy per task"]
    subgraph AS["atespace apl-ax-#lt;short-id#gt;"]
      task["Task sandbox (gVisor)<br/>custom runner PID 1<br/>writes .apl/result.json"]
    end
    subgraph NS["namespace apl-ax-#lt;short-id#gt;"]
      collector["Collector Pod<br/>own identity, tokens, pod cert"]
      emulators["Emulate + Floci Services"]
    end
  end
  operator -- "ax apply" --> axcp
  axcp -- "template" --> substrate
  substrate -- "starts actor" --> task
  task -- "egress" --> egress
  egress -- "two services only" --> emulators
  collector -- "mTLS, own cert" --> router
  router -- "/apl/result" --> task
  collector -- "reads state" --> emulators
```

Run 3 (2026-10-28) ran every test on the cluster under gVisor. Per assertion ([`RESULTS.md`](../../profiles/ax/RESULTS.md) section 3.3):

- **PASS (6):** F3-A1 (W01-H) as an AX Task with the local lane's assertions; AX-R1 failing command; SIGTERM on worker eviction (logs only); resume after `ax suspend` keeps the prepare-once marker and the workspace; isolation from inside the sandbox; router identity.
- **FAIL (3):** `ax suspend` delivers no SIGTERM; `ax delete task` delivers no SIGTERM; after eviction, then suspend and resume, the result and the marker are lost (L-048).
- **Neither:** secrets in `ax get task` observed (L-034); timing expectation met.

The task phase is not the outcome (L-006): AX reported `Running` while the failing command had exited 3, and `cases.ax.json` records `ax_task_phase` without asserting it. The collector, not the task phase, decides PASS or FAIL. The lane was torn down on 2026-10-29; diagram (c) shows what remains.

## Regenerating the HTML views

```bash
node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/mental-model.architecture.json docs/diagrams/mental-model.html --repo-root . --quality showcase --json
node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/system-map.architecture.json docs/diagrams/system-map.html --repo-root . --quality showcase --json
node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/infra-layers.architecture.json docs/diagrams/infra-layers.html --repo-root . --quality showcase --json
node <archify>/bin/archify.mjs finalize sequence docs/diagrams/src/request-flow.sequence.json docs/diagrams/request-flow.html --repo-root . --quality showcase --json
node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/trust-boundaries.architecture.json docs/diagrams/trust-boundaries.html --repo-root . --quality showcase --json
node <archify>/bin/archify.mjs finalize dataflow docs/diagrams/src/evidence-flow.dataflow.json docs/diagrams/evidence-flow.html --quality showcase --json
node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/ax-lane.architecture.json docs/diagrams/ax-lane.html --repo-root . --quality showcase --json
```

`finalize` also writes receipt JSON files next to each HTML; they are not committed. The JSON carries no `meta.repository` source links: Archify requires an `origin` remote to verify them, and this repository has none until publication. File citations are in the node labels above and in the HTML cards.
