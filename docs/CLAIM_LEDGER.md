# Claim Ledger

This ledger lists every outcome claim that the README, the article or a recording might make, bound to its evidence. A sentence that is not here is not a result claim. Fields follow the template in [`RESEARCH.md`](RESEARCH.md#claim-ledger-template).

**Status: unreviewed.** No row has been reviewed by someone other than its author. Nothing here authorizes publication.

## Evidence sets

Three sets of runs back this ledger. Each row says which one it uses.

| Set | What ran | Tree SHA (`HEAD^{tree}`, ADR-9) | Commit | When (2026-10-28, UTC) |
|---|---|---|---|---|
| **H** (harness) | `bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh` and `npm run mutate` on merged `main` | `8e8c3a3b2139d345cac7395a099d8e0509902658` | `4a8f100` | 15:24-15:35 |
| **M** (media) | `lab media capture` runs behind the README screenshots, GIFs and clips (`docs/assets/media-manifest.json`, sanitized exports in `docs/evidence/`) | git tree `60f9f1bfc2ec8a1cca771f2de1e681783bd2c845`; `application_tree_sha256` `ca30f76f48fa4dc0c342018ac67831e3909782e1518cd6a871bf5bdce3e4ae73` | `ea1deca` (`capture_dirty: false`, 0 dirty app files) | capture session `2026-10-28T15-13-18-300Z` |
| **B** (bench) | `npm run bench` | `721110b062ecde0e2941943b6fb685114b07a9a6` | `4935584` | 14:26-14:34 |

Common to all executed rows:

- profile `local`, mode `scripted` (no model was called);
- `mutation: none` in every candidate bundle;
- `dirty: false`;
- cleanup `CLEAN`.

Between B and H, none of these changed: `src/workflows`, `src/worker`, `src/http`, `src/adapters`, `src/ledger`, `src/policy`, `src/config` or `src/collector/probe.ts` (`git diff 4935584 4a8f100` is empty for those paths).

**Harness verdict on H: `LOOP`.** Every gate passes except one assertion. Tasks 1.1-5.1, F1-F5, S1-S4 and F6-A1, F6-A2, F6-A4, F6-A5 all PASS. F6-A3 fails only on `local_render_review_passed: false`, because no independent render review exists yet (`docs/assets/render-review.json` is absent). That makes task 6.1 and F6 FAIL.

**Where the evidence is.** Set H artifacts are in `artifacts/runs/<run_id>/` (gitignored, local). Set M has committed, sanitized exports (`report.json`, `observations.json`, `checksums.sha256`) in `docs/evidence/<run_id>/`. A reader reproduces a row by rerunning its case (see "Reproduce" at the end). A local run ID identifies this author's run, not a file a reader can download, except for set M.

History: an earlier harness run on tree `0f0c432e5c16` (commit `be3bb2d`, before the console existed) had F1-F5 and S1-S3 PASS, with F6 and S4 NOT_RUN. It is superseded by set H.

## Executed claims (local lane, set H)

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-01 | The local profile starts Emulate Slack and Floci and runs all three workflows with no external account. | EXECUTED | F1-A1 `50d7b125-12ef-425d-89b4-330528bc4b5f` | `emulate_running`, `floci_running`, `workflow_count: 3`, `required_external_accounts: 0`, `non_loopback_endpoint_count: 0` | Needs Docker, the pinned Floci image and Node 24 on one macOS arm64 host | unreviewed |
| C-02 | A production endpoint override is rejected before any network request. | EXECUTED | F1-A2 `63829abd-fd0c-4d95-a9a8-22b379a88550` | `rejected_before_network: true`, `outbound_request_count: 0` counted at a collector-owned sinkhole | This case failed on merged `main` before fix `be3bb2d` (L-025) | unreviewed |
| C-03 | A signed mention produces one accepted event and one reply in the original thread; the bot's own message creates no job. | EXECUTED | F2-A1 `2e9503af-085b-4a2f-a989-4c46eb2d7cb6` | `accepted_event_count: 1`, `completion_reply_count: 1`, `reply_in_original_thread: true`, `bot_loop_job_count: 0` | Emulate Slack only; Events API transport, not Socket Mode | unreviewed |
| C-04 | A signed retry of the same event adds no business record and no reply. | EXECUTED | F2-A2 `02730ce2-cd0c-4fe4-a283-66a29bcb44bf` | `additional_business_records: 0`, `additional_completion_replies: 0` | Retries come from Emulate's explicit simulator, not real Slack retry timing | unreviewed |
| C-05 | A W01 service request ends with one ticket, one S3 receipt that matches the request, and one completion reply, all observed independently. | EXECUTED | F3-A1 `e0742bee-abd6-4354-ba6e-b37931050e28` | Four facts from three stores (ledger, S3, Slack thread) | One run of this case; repetition timing is in C-17 | unreviewed |
| C-06 | A requester cannot approve their own purchase request, and a user without approval rights cannot approve it; no write follows either click. | EXECUTED | F3-A2 `a766fa1b-4070-4d88-b98a-3645c2eee896` | `approval_status: awaiting_approval`, `unauthorized_write_count: 0`, `approval_receipt_count: 0` | Fictional grants in a local ledger; no real identity provider | unreviewed |
| C-07 | A CRM update with a stale expected version is a conflict and overwrites nothing. | EXECUTED | F3-A3 `a45bd7b3-945e-4ee9-a205-3fe921982e32` | `result: CONFLICT`, `description_unchanged: true`, `write_count: 0` | Local contract double, not Salesforce | unreviewed |
| C-08 | When the worker reports success but the receipt is missing, the required assertion fails and no success banner appears. | EXECUTED | F4-A1 `8aa9ff48-409a-47b4-80f0-3fc2f83590cf` | `worker_claimed_success: true`, `receipt_present: false`, `required_assertion_failed: true`, `overall_success_banner: false` | The missing receipt is a simulated fault (the coordinator deletes the object) | unreviewed |
| C-09 | With Salesforce unavailable, the lane reports BLOCKED and parity UNKNOWN, separately from the local results. | EXECUTED | F4-A2 `e814c184-d647-438a-954c-acf645ce965b` | `salesforce_status: BLOCKED`, `salesforce_parity: UNKNOWN`, `local_results_separate: true` | Says nothing about Salesforce behavior | unreviewed |
| C-10 | All four optional lanes report BLOCKED with their own prerequisites, and nothing external is created. | EXECUTED | F5-A1 `76461176-44de-4d5e-a5cd-114283398b97` | `blocked_optional_profile_count: 4`, `external_resource_create_count: 0`, `prerequisites_reported: true` | Counting covers provider CLIs via PATH shims plus the sinkhole; proxy routing of Node traffic is unproven (L-023) | unreviewed |
| C-11 | An optional lane that looks configured but is not authorized makes zero external calls and leaves the local result unchanged. | EXECUTED | F5-A2 `07920a06-b5c8-4e95-9ed1-5fe8d45d63f0` | `external_call_count: 0`, `authorization_rejected: true`, `local_result_preserved: true` | Same counting limit as C-10 | unreviewed |
| C-12 | A fresh clone completes W01 with no undeclared account and no reads across runs. | EXECUTED | S1 `89cd9648-15e1-4963-83ed-8e74e9c4bf3c` | `fresh_clone_completed`, `undeclared_account_count: 0`, `cross_run_read_count: 0` | Warm npm cache and pre-pulled image (BUILD_PLAN §8.11); public challenge, not a blind holdout | unreviewed |
| C-13 | After a crash between the ticket commit and the receipt, recovery finishes the job with no duplicate ticket and no false success. | EXECUTED | S2 `fdee44b4-3e4f-4597-b714-fc27cf40c311` | `ticket_count: 1`, `false_success_count: 0`, `recovery_evidence_present: true`, `duplicate_after_restart_count: 0` | Simulated crash (SIGKILL) and stalled PUT; failed on merged `main` until `be3bb2d` (L-026) | unreviewed |
| C-14 | A cross-tenant button copy and a revoked approver produce no write and no disclosure. | EXECUTED | S3 `b3e93133-6051-4d31-a5d6-2f84261a44f3` | `unauthorized_write_count: 0`, `cross_tenant_disclosure_count: 0`, `revoked_approver_denied: true` | Two fictional Emulate workspaces on one host; public challenge | unreviewed |
| C-15 | Each of the four mutation probes (dedupe off, approval bypass, reply before receipt, missing evidence turned into success) was caught. | EXECUTED | `artifacts/mutations/2026-10-28T15-35-03-704Z.json` (committed; tree `8e8c3a3b`) | 4 caught, 0 uncaught, 0 invalid; candidate restored | Counts these four probes only; not a claim that the code has no other defects | unreviewed |
| C-16 | The worker never holds an emulator URL: its Slack proxy forwards only `POST /api/chat.postMessage` and returns 403 for the simulator routes. | EXECUTED | `tests/integration/workflows.test.ts` (W02-R forged-approval checks), run by task 3.1 in set H; L-019 | Proxy and allowlist behavior | Residual: anyone else with an emulator URL and any valid token can still simulate clicks (L-019) | unreviewed |

## Console and README evidence (set H for gates, set M for media)

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-30 | When a required assertion fails, the console shows the failure and no overall success badge. | EXECUTED | F6-A1 `a5a1b5e0-94f8-4ce0-9eea-0e43fb508349` | `failure_visible: true`, `overall_success_banner: false` (browser assertion) | Local console in Playwright Chromium; not a hosted service | unreviewed |
| C-31 | A recording export shows revision, run ID and a synthetic-data notice, with valid evidence references and no secrets or forbidden identities. | EXECUTED | F6-A2 `dd6ea827-d8c1-430d-8bad-a141f367c4f8` | `revision_visible`, `run_id_visible`, `synthetic_notice_visible`, `secret_count: 0`, `forbidden_identity_count: 0`, `evidence_refs_valid` | The scan checks known patterns and the private-terms list; it is not proof that nothing sensitive could exist | unreviewed |
| C-32 | The README has five screenshots, three animated GIFs and three posters that decode, with valid provenance, alt text, captions, static fallbacks and a size within budget. | EXECUTED, **review pending** | F6-A3 `973e516e-30b2-45d6-b53a-060541fbb01f`; `docs/assets/media-manifest.json` (`readme_verification.local_status: PASS`, 12 embeds, desktop 1440 px and narrow 400 px rendered locally) | Every F6-A3 fact matches except `local_render_review_passed: false` | **F6-A3 is not PASS.** It waits for an independent render review (`docs/assets/render-review.json` absent), and every manifest item's manual `visual_review` is PENDING. Local render uses `marked` in Chromium, not GitHub's renderer | unreviewed |
| C-33 | A missing screenshot, a single-frame GIF, a stale capture and a broken embed are each detected, with no false media success. | EXECUTED | F6-A4 `124a8b79-4e0a-4c53-97bd-5a574e3e2c86` | Four detections, `false_media_success_count: 0` | Injected media defects in a scratch copy | unreviewed |
| C-34 | Local media status is PASS while GitHub rendering stays NOT_RUN, and nothing was created or pushed. | EXECUTED | F6-A5 `aad0039f-c96e-4187-822f-8e544b6fb17b` | `local_media_status: PASS`, `github_render_status: NOT_RUN`, 0 repository creates, 0 pushes | GitHub rendering is unchecked until a repository is authorized | unreviewed |
| C-35 | The console never shows a false green, matches the report, shows optional lanes BLOCKED, and rejects a tampered artifact. | EXECUTED | S4 `b38a3f91-4cd2-41a5-b598-4778389e079b` | `false_green_count: 0`, `optional_profile_status: BLOCKED`, `tampered_artifact_rejected: true`, `console_matches_report: true` | Public challenge, not a blind holdout | unreviewed |
| C-40 | The overview screenshot shows a real W02-H approval run: approved once, with one matching receipt. | EXECUTED | M: `d1141e88-6ad1-4ebf-9008-dd8a1a3186df` (`docs/evidence/d1141e88…/`); media `lab-overview` | `approval_status: approved`, `approved_transition_count: 1`, `approval_receipt_count: 1`, `approval_receipt_matches: true` | Manual visual review PENDING | unreviewed |
| C-41 | The service-request screenshot, the evidence-report screenshot, the profile-boundaries screenshot and the service-request GIF come from one passing W01-H run. | EXECUTED | M: `d7b27d50-c6af-4abd-bd03-36b67dfcb967`; media `service-request-success`, `evidence-report`, `profile-boundaries`, `slack-service-request` | `ticket_count: 1`, `receipt_count: 1`, `receipt_matches_request: true`, `completion_reply_count: 1` | The profile-boundaries view shows doctor output for BLOCKED lanes, not lane results; manual review PENDING | unreviewed |
| C-42 | The duplicate-delivery GIF and clip show a signed retry that adds nothing. | EXECUTED | M: `8c577551-a2f9-4968-ac0d-67115ea07c90`; media `duplicate-event-safe`, `clip-duplicate-delivery` | `additional_business_records: 0`, `additional_completion_replies: 0`, `same_request_identity: true` | Manual review PENDING | unreviewed |
| C-43 | The approval-denied screenshot, GIF and permission-boundary clip show both refused clicks with no write. | EXECUTED | M: `493034f5-af80-47da-9994-eb6b5142b363`; media `approval-denied`, `approval-denied-gif`, `clip-permission-boundary` | `approval_status: awaiting_approval`, `unauthorized_write_count: 0`, `approval_receipt_count: 0` | Manual review PENDING | unreviewed |
| C-44 | The mental-model clip contrasts a passing W01-H run with a W01-F run in which the reply looks right but the receipt is missing, and the report FAILs. | EXECUTED | M: `fed9685f-093e-43d3-b630-df61329bc6ab` (W01-H PASS) and `ca8e55fb-ac80-4ea7-8df7-5a2843ea8974` (W01-F FAIL: `receipt_count: 0`, `receipt_matches_request: false`); media `clip-mental-model` | FAIL is the intended outcome of an injected fault | The missing receipt is a simulated fault (object deleted by the coordinator); manual review PENDING | unreviewed |
| C-45 | The emulator-versus-real-org clip shows a W03 stale-version conflict and the Salesforce lane BLOCKED with parity UNKNOWN. | EXECUTED | M: `581e434c-a178-47fe-ae7a-3ff59b4a38b9`; media `clip-emulator-vs-real-org` | `result: CONFLICT`, `description_unchanged: true`, `write_count: 0` | Says nothing about Salesforce; manual review PENDING | unreviewed |

The media runs (set M) were captured on application revision `ea1deca`. Set H later ran on `4a8f100`, which adds recaptured media and docs on top. The manifest's `application_tree_sha256` covers only application files, so a docs-only commit does not invalidate the captures (README_MEDIA_SPEC).

## Measured timings (set B)

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-17 | On one laptop, W01 took 17 to 71 ms (median 18, n=5) from the worker receiving the signed callback to the collector seeing ticket, receipt and reply. | EXECUTED | bench `42bb1f6b-e41b-4de2-b46a-e62631e3eb50`; `artifacts/bench/2026-10-28T14-26-41-782Z.json` | Raw: 71, 19, 17, 17, 18 ms | macOS arm64, 18 cores, load 8 to 22 from other work; n=5; 10 ms poll resolution; no percentiles | unreviewed |
| C-18 | W02 took 20 to 27 ms (median 23, n=5) from the signed approval click being processed to the verified approved state. | EXECUTED | bench `84a91a9a-dadf-4a07-973e-4fb4b88c74f5`; same file | Raw: 27, 23, 22, 23, 20 ms | As C-17 | unreviewed |
| C-19 | W03 took 13 to 41 ms (median 14, n=5) from callback to the verified CRM update and reply. | EXECUTED | bench `5b7acbfe-1b97-4b9a-8564-974a1c64d49f`; same file | Raw: 41, 15, 14, 14, 13 ms | As C-17; local CRM double, not Salesforce | unreviewed |
| C-20 | `npm ci` took 3.8 to 4.1 s with an empty cache and 3.4 to 11.1 s with a warm cache (n=3 each). | EXECUTED | same file | Cold raw 3.8, 4.1, 4.0 s; warm raw 11.1, 3.5, 3.4 s | One network on one day; the image pull was NOT_RUN; measured before the console's dependencies were merged | unreviewed |
| C-21 | One independent observation pass costs 1 to 5 ms; the whole `collect-case` command takes 3.1 to 3.3 s, mostly stack start and teardown. | EXECUTED | same file; collect-case runs `e16abef0-6171-4dbe-8bcd-04fde5275f32`, `95abc1a9-59ad-428c-bfb2-68a5d066c6e3`, `05330766-c388-4726-8f28-1f7bf944d6ec` | observe_ms raw in `docs/BENCHMARKS.md` | Observation timed in the bench process, not the separate collector process | unreviewed |
| C-22 | The supplied harness `run-all.sh` took 260.6 s on the pre-console tree. | EXECUTED | same file | One run; verdict BLOCKED then (F6, S4 and task 6.1 NOT_RUN) | Set H adds console and media cases, so a current run takes longer; it was not timed | unreviewed |

## Not executed: planned, blocked or unknown

| claim_id | What may be said | Label | Source | Why not more | Reviewer |
|---|---|---|---|---|---|
| C-50 | AX could run a lab case on Agent Substrate with the collector deciding the outcome. | DESIGNED; lane BLOCKED | `profiles/ax/README.md`, `docs/diagrams/README.md` (d) | No cluster run approved. Runner contract EXECUTED locally under runc only (`tests/integration/ax-profile.test.ts`), which says nothing about gVisor (L-012) | unreviewed |
| C-51 | The same W03 rules hold on a Salesforce scratch org. | DESIGNED; lane BLOCKED; parity UNKNOWN | `profiles/salesforce/`, C-09 | No Dev Hub or owner approval | unreviewed |
| C-52 | An external reviewer (CodeRabbit) reviewed this code. | BLOCKED | `profiles/coderabbit/` | No hosted repository; `illustrative-defects.json` is a fixture, not review output | unreviewed |
| C-53 | A live model using the same restricted actions passes the same evaluator. | BLOCKED | `profiles/live-model/` | No approved provider, key or budget; no provider client wired | unreviewed |
| C-54 | Blind holdouts written outside the builders' briefs pass. | UNKNOWN | BUILD_PLAN §3.5, §8.8 | No blind-holdout results exist in this tree | unreviewed |
| C-55 | The README renders correctly on GitHub. | NOT_RUN | C-34 | Nothing published; local render only | unreviewed |
| C-56 | Emulate does not support Socket Mode, slash commands or exact rate limiting. | DOCUMENTED | [Emulate Slack docs](https://emulate.dev/docs/slack) @ `v0.12.3` | A product fact, not a lab result | unreviewed |
| C-57 | AX does not read the agent command's exit status back. | DOCUMENTED | [AX runner](https://github.com/google/ax/blob/main/docs/runner.md) @ `4b7bf6f` | A product fact; the lab's design response is L-006 | unreviewed |

## Claims that must not be made

- No speedup, savings, parity or endorsement claim. None was measured.
- No percentile (p95 or similar) from these samples.
- Not "all local gates pass" or "LOCAL_CORE_READY": the current verdict is `LOOP` until the F6-A3 render review exists.
- Not "integration with Salesforce / AX / CodeRabbit works": every optional lane is BLOCKED or DESIGNED.
- Not "the application is secure" or "has no bugs": the mutation count covers four probes, and L-019 and L-023 are open.
- Nothing about Floci credential separation: the worker and collector keys differ, but rejection of a wrong key was not tested.
- Not that the media were visually reviewed: every manual review is PENDING.

## Reproduce

```bash
npm ci
docker pull floci/floci:2.3.0   # once; the run pins it by digest
npm run lab -- doctor
bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh
npm run mutate
npm run bench
```

A reader's run produces new run IDs. Compare the observations and statuses, not the IDs.
