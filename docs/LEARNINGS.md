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
