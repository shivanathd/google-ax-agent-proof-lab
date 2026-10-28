# Implementation Plan

Implement in six checkpoints. The first four deliver the local core; optional service access cannot block that core. Verification commands below are target repository interfaces to be implemented, not commands already provided by a working application.

## Foundation

### Task 1.1: Bootstrap and safe profiles

**Requirement:** F1-R1 through F1-R6; C1 and contract schemas.
**Classification:** Security.
**Files:** `package.json`, `package-lock.json`, `compose.yaml`, `src/cli/`, `src/config/`, `src/contracts/`, `tests/unit/config.test.ts`, `docs/ENVIRONMENT.md`, `DEPENDENCIES.lock.json`.

1. Inventory the host, verify current upstream API versions and licenses, pin the tested dependency set.
2. Implement doctor/start/seed/stop, explicit endpoint selection, fake credentials and owned-resource manifests.
3. Implement isolated parallel run configuration and profile status handling.
4. Record cold install and warm startup separately; label tested OS/architecture and any platform blocker.

**Verify:** `npm run verify:task -- 1.1`
**Eval script:** `evals/tasks/task-1.1-verify.sh`
**Proof required:** typecheck, configuration unit tests, forbidden-endpoint zero-write test, two-run isolation and cleanup test. A file-existence check is insufficient.
**Commit:** `feat(lab): add safe local profiles and lifecycle`

## Slack integration

### Task 2.1: Stateful Slack and signed events

**Requirement:** F2-R1 through F2-R6; C2.
**Classification:** Security.
**Files:** `src/adapters/slack/`, `src/http/slack.ts`, `fixtures/slack/`, `tests/integration/slack.test.ts`.

1. Start Emulate through its pinned documented interface and seed two fictional installations.
2. Verify raw-body signatures and timestamp freshness, persist events, deduplicate retries and ignore bot loops.
3. Build thread replies and supported approval-button interactions.
4. Implement the signed retry, missing-scope, revocation and tenant-denial cases in the casebook.

**Verify:** `npm run verify:task -- 2.1`
**Eval script:** `evals/tasks/task-2.1-verify.sh`
**Proof required:** F2-A1/A2 plus Slack API state inspection; no screenshots as sole proof.
**Commit:** `feat(slack): add signed emulated interactions and replay protection`

## Business workflows

### Task 3.1: Service, approval and CRM journeys

**Requirement:** F3-R1 through F3-R6; C3.
**Classification:** Functional.
**Files:** `src/workflows/`, `src/policy/`, `src/adapters/floci/`, `src/adapters/crm-local/`, `src/ledger/`, `fixtures/cases/`, `tests/integration/workflows.test.ts`.

1. Implement the ledger, transaction boundaries, inbox/outbox and explicit state machine.
2. Implement W01 with actual SQS/S3 calls; do not substitute in-process arrays or files for those integrations.
3. Implement W02 with separate requester/approver and expiry/replay checks.
4. Implement W03 with a narrowly scoped CRM contract double and optimistic concurrency.
5. Add recovery from known-safe transient errors and ambiguity handling without false success.

**Verify:** `npm run verify:task -- 3.1`
**Eval script:** `evals/tasks/task-3.1-verify.sh`
**Proof required:** F3-A1/A2/A3; every local case in CASEBOOK.md; five repetitions of each happy workflow with all outcomes retained.
**Commit:** `feat(workflows): add synthetic business journeys and guarded actions`

## Evidence and challenge tests

### Task 4.1: Independent collection and report integrity

**Requirement:** F4-R1 through F4-R6; C4/C5.
**Classification:** Operational.
**Files:** `src/evaluator/`, `src/collector/`, `src/reports/`, `tests/integration/evidence.test.ts`, `tests/mutations/`, `.github/workflows/ci.yml`.

1. Implement independent collector clients and read-only DB observations.
2. Implement `collect-case` to satisfy the pre-existing evaluator expectations.
3. Add mutation probes: disable deduplication, bypass approval checks, reply before receipt commit, substitute success for missing evidence. All four must be caught.
4. Record artifacts, hashes and statuses; implement a sanitized export path.
5. Test fresh clone and public challenge cases; retain failed runs alongside successful ones.

**Verify:** `npm run verify:task -- 4.1`
**Eval script:** `evals/tasks/task-4.1-verify.sh`
**Proof required:** F4-A1/A2, S1–S4, mutation results and honest blocked-profile reporting.
**Commit:** `feat(evidence): add independent collection and fail-closed reporting`

## Optional integrations

### Task 5.1: Profile adapters and prerequisite gates

**Requirement:** F5-R1 through F5-R6.
**Classification:** Operational.
**Files:** `profiles/salesforce/`, `profiles/coderabbit/`, `profiles/ax/`, `profiles/live-model/`, `tests/integration/profiles.test.ts`, `docs/PROFILES.md`.

1. Implement provider-free doctor and denied-by-default behavior for every optional lane.
2. Prepare a minimal Salesforce metadata package, persona permissions, synthetic seed and ownership-safe lifecycle scripts.
3. Prepare CodeRabbit configuration and illustrative seeded defects; do not install an app or open a PR without approval.
4. Prepare AX custom-runner adapter and version-compatibility checklist, without starting a cluster.
5. Document live-model tool schema and capped execution; leave its connection blocked without explicit provider approval.

**Verify:** `npm run verify:task -- 5.1`
**Eval script:** `evals/tasks/task-5.1-verify.sh`
**Proof required:** F5-A1/A2 for local-core completion. Live profile tests are additional and cannot be fabricated or replaced with offline fixtures.
**Commit:** `feat(profiles): add explicit optional integration gates`

## Teaching and publication preparation

### Task 6.1: Console, recordings and article evidence

**Requirement:** F6-R1 through F6-R9.
**Classification:** Documentation.
**Files:** `web/`, `tests/browser/`, `scripts/record/`, `scripts/media/`, `docs/assets/screenshots/`, `docs/assets/gifs/`, `docs/assets/posters/`, `docs/assets/media-manifest.json`, `README.md`, `docs/REPRODUCING.md`, `docs/CLAIM_LEDGER.md`, `writing/ARTICLE_DRAFT.md`, `recordings/README.md`.

1. Implement the console's transcript, state, layer-map and assertion views.
2. Record a good run, a blocked action and a detected mutation, with revision/run overlays.
3. Update the claim ledger from evidence; preserve caveats and label planned optional lanes.
4. Implement the six media/README commands in `docs/README_MEDIA_SPEC.md`; capture the five required screenshots, three animated GIFs and three static posters from real local integration runs.
5. Optimize and decode-check assets, verify manifest hashes/provenance and build the root README using `docs/README_STORYBOARD.md`, preserving manual text outside generated slots.
6. Verify every relative embed, caption, alt text and static fallback, plus local rendered layout at desktop/narrow widths. Check actual GitHub rendering only after an authorized repository/ref exists; otherwise record NOT_RUN for that check.
7. Run the publication checklist, but do not publish. Missing required media blocks local completion.

**Verify:** `npm run verify:task -- 6.1`
**Eval script:** `evals/tasks/task-6.1-verify.sh`
**Proof required:** F6-A1 through F6-A5, actual image/GIF decoding and animation checks, media provenance and size checks, README browser checks, artifact redaction, recording transcript and manual readability review. Include screenshots of the rendered README as verification evidence, not substitutes for application captures.
**Commit:** `docs(lab): add reproducible teaching and recording kit`

## Convergence and handoff

Run `python3 tools/validate_package.py`, then `bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh`. All local task, acceptance and public challenge gates must pass for `LOCAL_CORE_READY`. Optional live results stay individually labeled.

The supplied harness starts BLOCKED in the spec-only package. The implementing agent must not interpret that baseline as a passed application test. After three failed attempts at the same blocker, return an evidence-backed blocker report instead of weakening a test.

## Post-Ship Observability

Once publication is approved, keep a tested-version matrix, reproducibility issues, known emulator gaps and recorded-run manifest. Re-run conformance and affected cases after upstream upgrades; do not silently retain old green badges against a new dependency lock.
