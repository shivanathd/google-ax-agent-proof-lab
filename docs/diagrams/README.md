# Architecture diagrams

**These are architecture, not execution evidence.** A box or an arrow here says how the code is built, not that a case passed. Run results live in `artifacts/runs/<run_id>/` and are cited by run ID in [`../CLAIM_LEDGER.md`](../CLAIM_LEDGER.md).

Each diagram exists twice:

- a Mermaid block below, which GitHub renders inline;
- an interactive HTML view generated with Archify from the JSON in [`src/`](src/) (`system-map.html`, `trust-boundaries.html`, `evidence-flow.html`, `ax-lane.html`). Download and open it locally; GitHub shows HTML as source. Automated layout and browser checks passed for all four; they have not been visually reviewed by a person.

Drawn from the tree at commit `be3bb2d` (2026-10-28). If the code changes, these change with it: every box names the file that implements it.

## (a) System map

```mermaid
flowchart LR
  coord["Test coordinator<br/><i>src/evaluator/collect-case.ts</i><br/><i>src/collector/drive.ts</i>"]
  slack["Emulate Slack x2<br/>T_LAB_A, T_LAB_B, strict scopes<br/><i>src/adapters/slack/emulator.ts</i>"]
  proxy["Worker Slack proxy<br/>only POST chat.postMessage<br/><i>src/adapters/slack/worker-proxy.ts</i>"]
  worker["Worker process<br/>signed ingress, policy, W01-W03<br/><i>src/http/slack.ts, src/worker/worker.ts,<br/>src/policy/index.ts</i>"]
  floci["Floci 2.3.0 container (by digest)<br/>S3 receipts, SQS jobs<br/><i>compose.yaml, src/adapters/floci/</i>"]
  ledger[("SQLite ledger<br/>inbox, outbox, tickets, approvals,<br/>CRM double<br/><i>src/ledger/db.ts, src/adapters/crm-local/</i>")]
  collector["Independent collector<br/>separate process, own credentials<br/><i>src/collector/main.ts, probe.ts</i>"]
  evaluator["Evaluator<br/><i>src/reports/report.ts</i> + supplied <i>evaluate.py</i>"]
  reports[("Run artifacts + export<br/>C5 report, checksums, quarantine<br/><i>src/reports/artifacts.ts, export.ts</i>")]
  console["Console + README media<br/>reads reports only (Task 6.1, built in parallel)"]
  lanes["Optional lanes: AX, Salesforce,<br/>CodeRabbit, live-model<br/>all BLOCKED<br/><i>src/config/profiles.ts, profiles/*</i>"]

  coord -- "user posts, simulate/*" --> slack
  slack -- "signed callback" --> worker
  worker -- "reply" --> proxy
  proxy -- "forward" --> slack
  worker -- "S3 put, SQS send/receive" --> floci
  worker -- "transactions" --> ledger
  ledger -. "read-only handle" .-> collector
  slack -. "reader token" .-> collector
  floci -. "own S3/SQS client" .-> collector
  collector -- "C4 bundle" --> evaluator
  evaluator -- "C5 report" --> reports
  reports -- "sanitized view" --> console
  coord -. "doctor, 0 external calls" .-> lanes
```

The coordinator starts the stack (`startRun` in `src/config/lifecycle.ts`), spawns the worker and the collector as separate Node processes, drives the scripted stimulus and asks the collector to observe. The worker never talks to the collector, and the collector never writes business state. Not drawn: the fault-injecting loopback proxy (`src/adapters/faults/proxy.ts`) used by W01-S and W01-T.

## (b) Trust boundaries and credential custody

```mermaid
flowchart TB
  subgraph CP["coordinator process"]
    coord["Coordinator<br/>holds setup token, per-user tokens,<br/>signing secrets (generated per run)"]
    proxy["Worker Slack proxy<br/>forwards POST /api/chat.postMessage<br/>403 for /_slack/*, /_emulate/*, other methods"]
  end
  subgraph WP["worker process"]
    worker["Worker<br/>bot token (chat:write, app_mentions:read)<br/>signing secret per installation<br/>fake AWS key; allowlist without emulator ports"]
  end
  subgraph CL["collector process"]
    collector["Collector<br/>reader token (channels:history, channels:read)<br/>collector AWS key, readonly SQLite handle<br/>loopback sinkhole + PATH shims (F5)"]
  end
  emulate["Emulate Slack x2<br/><b>L-019:</b> /_slack/simulate/* accepts any valid token"]
  ledger[("SQLite ledger<br/>worker: read-write")]
  floci["Floci S3 + SQS<br/>credential checks not verified (UNKNOWN)"]
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

**Residual (L-019).** Emulate checks only that a token is valid on its simulator routes. Anyone who knows an emulator URL and holds any valid token for that workspace can simulate clicks and retries. The boundary is process separation (the worker never learns the URL), not emulator authorization. **Unknown.** The worker and collector use different Floci keys, but nobody has checked that Floci rejects a wrong key, so treat the separation as labelling.

## (c) Evidence flow

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
3. `generateReport` refuses to regenerate a report when captured files fail their recorded checksums (`src/reports/artifacts.ts`, L-022).
4. `exportRun` scans the allowlisted projection for secret-shaped strings and private terms and quarantines the run on any match (`src/reports/export.ts`, G-EXPORT).

## (d) Optional AX lane: DESIGNED, not executed

```mermaid
flowchart LR
  operator["Operator laptop<br/>doctor gates; ax apply<br/>APL_AX_AUTHORIZED=1"]
  subgraph K["cluster context $APL_AX_CONTEXT (owner-approved) — DESIGNED"]
    axcp["AX control plane<br/>ax-system; Task + Workspace"]
    substrate["Agent Substrate<br/>ate-system; image by digest"]
    router["atenet-router<br/>ingress, SPIFFE allowlist"]
    egress["atenet-egress<br/>default deny; policy not drafted"]
    subgraph AS["atespace apl-RUN_ID"]
      task["Task sandbox (gVisor)<br/>custom runner PID 1<br/>writes .apl/result.json"]
    end
    subgraph NS["namespace apl-RUN_ID"]
      collector["Collector Job<br/>own identity and credentials"]
      emulators["Emulate + Floci Deployments"]
    end
  end
  operator -. "ax apply (gRPC)" .-> axcp
  axcp -. "ActorTemplate" .-> substrate
  substrate -. "start sandbox" .-> task
  task -. "outbound" .-> egress
  egress -. "two services only" .-> emulators
  collector -. "GET /apl/result" .-> router
  router -.-> task
  collector -. "reads state" .-> emulators
```

Every dashed arrow is a design from `profiles/ax/README.md`, never run. What has run is local only: the doctor and run gates (zero external calls when blocked) and the custom runner image under plain Docker (`runc`, amd64 emulation), in `tests/integration/ax-profile.test.ts`. A local runner pass says nothing about gVisor (L-012). AX does not read the command's exit status back (L-006), so the collector, not the task phase, would decide PASS or FAIL.

## Regenerating the HTML views

```bash
node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/system-map.architecture.json docs/diagrams/system-map.html --quality showcase --json
node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/trust-boundaries.architecture.json docs/diagrams/trust-boundaries.html --quality showcase --json
node <archify>/bin/archify.mjs finalize dataflow docs/diagrams/src/evidence-flow.dataflow.json docs/diagrams/evidence-flow.html --quality showcase --json
node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/ax-lane.architecture.json docs/diagrams/ax-lane.html --quality showcase --json
```

The JSON carries no `meta.repository` source links: Archify requires an `origin` remote to verify them, and this repository has none until publication. File citations are in the node labels above and in the cards.
