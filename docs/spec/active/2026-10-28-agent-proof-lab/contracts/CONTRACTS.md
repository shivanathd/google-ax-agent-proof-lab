# Boundary Contracts

All contracts use `schema_version: 1`. Unknown enum values and additional security-sensitive fields MUST fail validation. Required identity and authorization fields are never inferred from a natural-language message.

## C1: RunConfig

Required: `run_id` UUID; `profile` in `local|salesforce|coderabbit|ax|live-model`; `mode` in `scripted|fixture-replay|live-model`; `seed` nonnegative integer; `fixture_sha256`; `candidate_revision`; `dirty` boolean; `tenant_id`; `endpoint_allowlist` array of scheme/host/port tuples; `owned_resources` array; `limits` containing `wall_clock_seconds`, `max_actions`, `max_retries`.

Optional: `connection_ref`, `model_ref`, `cost_cap`, `patch_sha256`. Null connection is BLOCKED for a selected external lane, not permission to use a default account. Cost is unknown unless measured; live inference cannot start without an approved positive cap. `patch_sha256` is required when `dirty=true`. Credentials live in a local secret store or process environment, referenced by opaque handle only.

Recommended initial limits are design choices: 120 seconds per scripted case, 20 actions, two retries for known-safe transient reads; no blind write retry after an ambiguous result. These limits are not performance claims.

## C2: WorkflowEvent

Required: `run_id`, `tenant_id`, `installation_id`, `event_id`, `actor_id`, `channel_id`, `message_ts`, `event_type`, `received_at`, `raw_body_sha256`, `verified_signature` boolean and `text`.

Optional: `thread_ts`, `retry_num`. Missing thread means reply to the root `message_ts`, not a new top-level message. Retry number is informational; idempotency is keyed by installation/team/event ID. Accept only the supported event types. Limit and reject oversize payloads before parsing; the chosen bound must be documented and tested.

## C3: ActionEnvelope

Required: `run_id`, `action_id`, `tenant_id`, `actor_id`, `connection_ref`, `operation`, `idempotency_key`, `input`, `authorization_decision`, `policy_version`, `requested_at`.

Optional: `expected_version`, `approval_ref`. A write requiring either field is rejected when absent. `authorization_decision` MUST originate from deterministic policy and current trusted identity, not agent output. Allowed operations: `ticket.create`, `receipt.put`, `approval.request`, `approval.resolve`, `crm.description.update`, `slack.reply`. Operation-specific schemas reject unknown fields.

Authorization binds tenant, principal, connection, operation and target resource. Approvals bind request digest, approver and expiry; changing the request invalidates the approval. State transitions use compare-and-set or a transaction, never a read followed by an unguarded write.

## C4: ObservationBundle

Required: `schema_version`, `case_id`, `run_id`, `profile`, `mode`, `candidate_revision`, `fixture_sha256`, `collector`, `observed_at`, `execution` and `observations`.

`execution` is `EXECUTED|BLOCKED|NOT_RUN`. `collector` names the evaluator process and methods used. `observations` maps stable keys to typed facts, not pass/fail opinions. Examples: `ticket_count: 1`, `completion_reply_count: 1`, `receipt_matches_request: true`, `unauthorized_write_count: 0`. An observation not collected MUST be absent with a reason, not `0`.

`evidence` is an array of `{path, sha256, source}` with paths relative to the bundle's artifact directory. Reject absolute paths, path traversal and symlink escape. Sources describe actual collector methods: Slack API, S3 GET, SQS receive, read-only DB query, direct provider query or browser assertion. Hashes establish binding/integrity, not authenticity of a dishonest collector.

Optional: `reason`, required for BLOCKED/NOT_RUN. Local scripted and replay results MUST not contain a live-model result label. Live-profile bundles also include provider identity stripped of secrets and explicit authorization reference.

## C5: RunReport

Required: identity fields from C4; `status`; `assertions`; `counts`; `limitations`; `artifacts`; `cleanup_status`; `started_at`; `ended_at`. Optional durations and costs remain null with explanatory reasons when unmeasured.

Assertion: `{id, required, expected, observed, status, evidence_refs, reason}`. Status enum: `PASS|FAIL|BLOCKED|SKIPPED|NOT_RUN|UNKNOWN`. An assertion needs direct evidence to pass; skipped optional assertions are excluded from required-pass denominators.

Aggregation: any required FAIL makes the selected lane FAIL; otherwise required UNKNOWN makes it UNKNOWN; otherwise required BLOCKED makes it BLOCKED; otherwise required NOT_RUN makes it NOT_RUN; only all required PASS makes it PASS. Do not let an unselected optional lane change local-core status. Report the all-lanes status separately rather than inventing an overall green result.

`cleanup_status` is `CLEAN|RETAINED_BY_REQUEST|INCOMPLETE|NOT_RUN`; INCOMPLETE names resources requiring action. The publication gate requires clean candidate identity, complete selected evidence, approved redactions and owner approval.

## External protocol and evaluator interface

The implementing CLI MUST provide:

```text
npm run lab -- collect-case --case F2-A2 --output ABSOLUTE_BUNDLE_PATH
```

The command sets up the case, executes it through the real selected local stack, and collects facts through independent clients. It emits a C4 bundle and exits 0 only for a completed collection, 2 for a genuine prerequisite blocker and nonzero for other execution errors. Collection exit 0 is not a test pass; the supplied evaluator compares facts to fixed expectations.

The collector must run outside the worker's permissions. Test setup may mutate emulator state; the worker cannot access collector credentials or expected observations. Public repository readers can inspect the tests, so this arrangement is process separation, not secret holdout security.

## Filesystem and network boundaries

The worker writes only application-owned run state and an outbox. The collector writes evidence. The report publisher reads sanitized evidence. The test coordinator provisions and resets emulators. Optional provider adapters do not inherit authority from the local profile.

A source-level allowlist alone cannot contain arbitrary code. The base lane runs trusted scripted application code; any claim of untrusted-code containment requires an independently tested sandbox boundary, such as the optional AX lane.
