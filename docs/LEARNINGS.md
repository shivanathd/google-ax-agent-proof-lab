# Learnings: expected vs observed

Each entry records what we expected *before* running something, what we actually observed, why, and what changed as a result. The expectations in the second table were committed before the W5 verification runs so they cannot be rewritten with hindsight. Observed values reference run IDs in `artifacts/` or the spike output.

## Upstream and environment findings

| ID | Area | Expected | Observed | Why / evidence | What we changed |
|---|---|---|---|---|---|
| L-001 | Emulate Slack events | Seeding an app plus an event subscription through `createEmulator({service:"slack", seed})` would deliver `app_mention` callbacks | `emulate@0.12.3`'s Slack `seedFromConfig(store, baseUrl, config)` drops the webhook dispatcher the loader passes as a 4th argument (Stripe's seeder uses it). The public API cannot register a subscription, so no callback ever fires. Upstream tests call an internal helper instead. | `spikes/w0-spike.ts`; `node_modules/emulate/dist/dist-B5YXZCS3.js` | Added `scripts/patch-emulate.mjs`: a hash-checked, version-pinned patch that adds `slack.event_subscriptions`. ADR-10. Candidate upstream PR. |
| L-002 | Emulate seed identity | Seeded `users[].user_id` would be honoured | User IDs are generated (`U` + random). `bot_user_id` on an OAuth app *is* honoured. | spike check "seeded user_id is not honoured" | Code resolves user IDs through `users.list` and never hardcodes seeded IDs |
| L-003 | Emulate strict scopes | `strict_scopes: true` would enforce method scopes | Confirmed. A bot token without `channels:history` gets `missing_scope` with `needed`. | spike | Worker, collector and setup tokens get disjoint minimal scopes |
| L-004 | Emulate version | The newest release older than 14 days would cover the spec | 0.12.2 has no `/_slack/simulate/*` routes, which 0.12.3 added | `npm view emulate time`; grep of the 0.12.2 dist | Pinned 0.12.3 (ADR-10) |
| L-005 | Floci SQS | `QueueUrl` would reflect the mapped host port | `QueueUrl` is always `http://localhost:4566/...`. AWS SDK v3 used the configured endpoint, so calls reached the right instance. | spike, with nothing listening on 4566 | The collector asserts which endpoint each client actually used, so a stray 4566 listener cannot cause silent cross-run reads |
| L-006 | AX | A running AX task would report the agent command's exit status | AX runner docs say the control plane "does not currently read the command's exit status back from the container" | `google/ax` `docs/runner.md` | The AX lane writes a result file in `/workspace`, and only the independent collector judges the outcome |
| L-008 | AX resource model | AX Task/Workspace would be Kubernetes objects applied with kubectl and labelled | They go through `ax apply` over gRPC. Metadata is name + atespace only, so there are no labels. | AX `docs/manifests.md` @ `4b7bf6f` | Run ID goes into the atespace, names and `spec.config`; Kubernetes objects keep the `apl-run` label; the `ax` CLI is a doctor prerequisite |
| L-009 | Substrate images | Tagged image references would work | Substrate rejects tag references and requires a digest | Substrate docs @ `6d7b3f4` | AX doctor requires `APL_AX_IMAGE` by digest |
| L-010 | Substrate networking | An in-cluster emulator would be reachable from a task | Task egress is default-deny; reaching emulators needs an explicit egress policy | Substrate README | Egress policy is a W6 prerequisite, scoped to the lab namespace |
| L-011 | Substrate versions | GKE 1.36 would be enough | 1.37 serves the PodCertificate APIs by default; 1.36 needs beta APIs and replaced node pools | Substrate setup-gcp README | The existing cluster's version is checked at W6 before applying anything |
| L-012 | Local runner proof | `docker run` passes would show runner behaviour under AX | Substrate runs only gVisor/microVM sandboxes, so local runc passes say nothing about gVisor behaviour | Substrate README | Local results are labelled "runner contract, runc"; gVisor behaviour stays UNKNOWN until W6 |
| L-013 | Emulate tenancy | Each seeded workspace would carry its own `team_id` | Every instance reports `team_id` `T000000001`, and the seed cannot change it | core builder, Task 2.1 | Tenant is bound by a per-installation callback URL plus a per-workspace signing secret, never by `team_id` or message text |
| L-014 | Emulate URL | `createEmulator` would report the bound address `127.0.0.1` | It reports `localhost` while listening on 127.0.0.1 | Task 1.1 | Each owned port is allowlisted under both names; other hosts are rejected |
| L-015 | better-sqlite3 | A `file:…?mode=ro` URI would open read-only | URIs aren't accepted; `{ readonly: true }` is the supported option | Task 3.1 | The collector uses `readonly: true` on its own handle |
| L-016 | Emulate revocation | After `apps.uninstall`, further mentions would still be delivered and fail later | Delivery of `app_mention` stops; `tokens_revoked`/`app_uninstalled` are sent instead | Task 2.1 | G-REVOKE uses a coordinator-signed late event to test the worker's own refusal |
| L-017 | W01-T ambiguity | A timed-out reply could be reconciled via `conversations.history` | With least-privilege scopes the worker cannot read history, so reconciliation is impossible | Task 3.1 | Outcome recorded UNKNOWN and never re-posted; the trade-off is privilege vs reconcilability |
| L-018 | Happy-path latency (5 runs, author tests) | W01 under 2 s, W02/W03 under 1 s | W01 102/63/62/63/63 ms; W02 120/119/122/122/118 ms; W03 60/60/61/59/59 ms | `private-runs/<run>/happy-reps.json` (local) | Well under the expectations; independent W5 benchmark still pending |
| L-007 | Host hygiene | A dev laptop's Docker host would be empty or lab-only | Many unrelated containers run there, some with private names | `docker ps`, not recorded | Cleanup is label-scoped (`dev.agent-proof-lab.run-id`). `docker ps` output is never written to artifacts. Cold benchmarks remove only lab images, by digest. |

## Expectations committed before verification runs (W5)

| Area | Expected before running | Observed | Run ID |
|---|---|---|---|
| F1–F6, S1–S4 | Every observation equals `cases.json` | pending | pending |
| Mutation probes | 4 of 4 caught (dedup off, approval bypass, reply before commit, missing evidence → success) | pending | pending |
| Blind holdouts | Some blind cases fail first time. A suite built against visible tests usually misses a boundary somewhere; any blind failure is reported, not patched quietly. | pending | pending |
| W01 happy-path wall clock (callback → verified receipt) | Under 2 s on this laptop (emulators in-process plus one container); single digits over 5 runs | pending | pending |
| W02 / W03 happy path | Under 1 s each; no queue or S3 hop on W03 | pending | pending |
| Cold vs warm setup | Cold is dominated by `npm ci` and the image pull (tens of seconds); warm under 10 s | pending | pending |
| collect-case overhead | Under 30% of workflow time | pending | pending |
| Fresh clone (S1) | Within the 180 s case timeout only with a warm npm cache and pre-pulled image | pending | pending |
| AX lane on GKE | Task reaches Running in tens of seconds. The outcome needs the collector because of L-006. | pending | pending |
