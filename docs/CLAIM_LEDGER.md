# Claim Ledger

This ledger lists every outcome claim that the README, the article or a recording might make, bound to its evidence. A sentence that is not here is not a result claim. Fields follow the template in [`RESEARCH.md`](RESEARCH.md#claim-ledger-template).

**Status: unreviewed.** No row has been reviewed by someone other than its author. Nothing here authorizes publication.

## Evidence sets

Five sets of runs back this ledger. Each row says which one it uses. All dates are 2026-10-28, UTC.

| Set | What ran | Identity | Where the evidence is |
|---|---|---|---|
| **H** (harness) | `bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh` 18:42-18:48 and `npm run mutate` 18:52, on merged `main` | tree `fb59f8f6e2653db1eb16701124a259ca0951a990`, commit `f67cab3`, `dirty: false` | `artifacts/runs/<run_id>/` (local, gitignored); mutation record committed |
| **M** (media) | `lab media capture` runs behind every README screenshot, GIF and clip | `application_revision` `751880e`, `application_tree_sha256` `2371a7ee8a8ec94baa33f41b8ae4143662e8b9d19074c0d7633068ba99e9686c`, git tree `f168658041339b3335b646283132718c89561711`, `capture_dirty: false`, capture session `2026-10-28T18-38-52-461Z` | `docs/assets/media-manifest.json`; sanitized exports `docs/evidence/<run_id>/` (committed) |
| **B** (bench) | `npm run bench`, 14:26-14:34 | tree `721110b062ecde0e2941943b6fb685114b07a9a6`, commit `4935584` | `artifacts/bench/2026-10-28T14-26-41-782Z.json` (committed) |
| **X** (AX run 3) | AX tasks on one GKE cluster running Agent Substrate v0.6.0 (`d3f2363`), gVisor sandboxes, one worker | AX `4b7bf6f`; lab image from commit `d10d3e6`; run `6882d106-…` | `profiles/ax/RESULTS.md` run 3 (committed). Raw evidence names the cluster and stays in gitignored `private-runs/ax/` |
| **BL** (blind) | 15 blind holdout scenarios, expectations timestamped before running | frozen tree `60f9f1bf`, candidate commit `ea1deca` | `docs/LEARNINGS.md` "Blind holdouts" row, L-027, L-028. Scenarios and evaluator copy are outside the repo |

For sets H, M and B: profile `local`, mode `scripted` (no model was called), `mutation: none` in every candidate bundle, cleanup `CLEAN`.

Set B is older than set H. Since B, four files on the workflow path have changed: `src/adapters/slack/emulator.ts`, `src/config/endpoints.ts`, `src/ledger/seed.ts` and `src/collector/probe.ts` (`git diff --stat 4935584 f67cab3`). The BH-07 schema fix (`a7a695c`, L-027) has also landed. The benchmark was not rerun after these changes, so treat C-17 to C-22 as timings of the earlier tree.

**Harness verdict on H: `LOOP`.** Every gate passes except one assertion. Tasks 1.1-5.1, F1-F5, S1-S4 and F6-A1, F6-A2, F6-A4, F6-A5 all PASS. F6-A3 fails only on `local_render_review_passed: false`, because there is no independent render review record (`docs/assets/render-review.json` is absent). That makes task 6.1 and F6 FAIL.

Set H run IDs identify this author's local runs, not files a reader can download. Set M run IDs each have a committed `docs/evidence/<run_id>/` folder. Earlier harness runs (trees `0f0c432e5c16` and `8e8c3a3b`) are superseded by H.

## Executed claims, local lane (set H)

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-01 | The local profile starts Emulate Slack and Floci and runs all three workflows with no external account. | EXECUTED | F1-A1 `96436ec2-3a74-4c5d-9f0e-5981f5c5a66e` | `emulate_running`, `floci_running`, `workflow_count: 3`, `required_external_accounts: 0`, `non_loopback_endpoint_count: 0` | Needs Docker, the pinned Floci image and Node 24 on one macOS arm64 host | unreviewed |
| C-02 | A production endpoint override is rejected before any network request. | EXECUTED | F1-A2 `cb4215d0-d518-4cda-85cd-24dfe5f5d351` | `rejected_before_network: true`, `outbound_request_count: 0` counted at a collector-owned sinkhole | Failed on merged `main` before fix `be3bb2d` (L-025) | unreviewed |
| C-03 | A signed mention produces one accepted event and one reply in the original thread; the bot's own message creates no job. | EXECUTED | F2-A1 `3a1baef4-22ee-47a0-a6d9-7b7572184fe1` | `accepted_event_count: 1`, `completion_reply_count: 1`, `reply_in_original_thread: true`, `bot_loop_job_count: 0` | Emulate Slack only; Events API transport, not Socket Mode | unreviewed |
| C-04 | A signed retry of the same event adds no business record and no reply. | EXECUTED | F2-A2 `0b714c4a-ace7-4f8b-8856-b4809f9789a5` | `additional_business_records: 0`, `additional_completion_replies: 0` | Retries come from Emulate's explicit simulator, not real Slack retry timing | unreviewed |
| C-05 | A W01 service request ends with one ticket, one S3 receipt that matches the request, and one completion reply, all observed independently. | EXECUTED | F3-A1 `906a5619-6123-4cb6-b5a1-d0953820d74c` | Four facts from three stores (ledger, S3, Slack thread) | One run of this case; repetition timing is in C-17 | unreviewed |
| C-06 | A requester cannot approve their own purchase request, and a user without approval rights cannot approve it; no write follows either click. | EXECUTED | F3-A2 `030bae79-21f1-4e06-9afa-1fd776a2dbaa` | `approval_status: awaiting_approval`, `unauthorized_write_count: 0`, `approval_receipt_count: 0` | Fictional grants in a local ledger; no real identity provider | unreviewed |
| C-07 | A CRM update with a stale expected version is a conflict and overwrites nothing. | EXECUTED | F3-A3 `9c9a2c17-cc95-4d09-9e39-7883cc265e40` | `result: CONFLICT`, `description_unchanged: true`, `write_count: 0` | Local contract double, not Salesforce | unreviewed |
| C-08 | When the worker reports success but the receipt is missing, the required assertion fails and no success banner appears. | EXECUTED | F4-A1 `e474699e-2d07-4a88-b674-6ac34fc4f507` | `worker_claimed_success: true`, `receipt_present: false`, `required_assertion_failed: true`, `overall_success_banner: false` | Simulated fault (the coordinator deletes the object) | unreviewed |
| C-09 | With Salesforce unavailable, the lane reports BLOCKED and parity UNKNOWN, separately from the local results. | EXECUTED | F4-A2 `24547ab6-1701-4cb4-864d-9b9c6f96b24d` | `salesforce_status: BLOCKED`, `salesforce_parity: UNKNOWN`, `local_results_separate: true` | Says nothing about Salesforce behavior | unreviewed |
| C-10 | The optional lanes report BLOCKED with their own prerequisites when unconfigured, and nothing external is created. | EXECUTED | F5-A1 `e045eaf8-ee0a-41ae-ba15-92b5fcac89aa` | `blocked_optional_profile_count: 4`, `external_resource_create_count: 0`, `prerequisites_reported: true` | Counting covers provider CLIs via PATH shims plus the sinkhole; proxy routing of Node traffic is unproven (L-023) | unreviewed |
| C-11 | An optional lane that looks configured but is not authorized makes zero external calls and leaves the local result unchanged. | EXECUTED | F5-A2 `99861255-ba57-4559-8c95-8e24140da347` | `external_call_count: 0`, `authorization_rejected: true`, `local_result_preserved: true` | Same counting limit as C-10 | unreviewed |
| C-12 | A fresh clone completes W01 with no undeclared account and no reads across runs. | EXECUTED | S1 `a5c0bbd3-2595-4603-977c-90f5203da755` | `fresh_clone_completed`, `undeclared_account_count: 0`, `cross_run_read_count: 0` | Warm npm cache and pre-pulled image (BUILD_PLAN §8.11); public challenge | unreviewed |
| C-13 | After a crash between the ticket commit and the receipt, recovery finishes the job with no duplicate ticket and no false success. | EXECUTED | S2 `37e1affc-2934-478e-8ece-3425fa84f0d6` | `ticket_count: 1`, `false_success_count: 0`, `recovery_evidence_present: true`, `duplicate_after_restart_count: 0` | Simulated crash (SIGKILL) and stalled PUT; failed on merged `main` until `be3bb2d` (L-026) | unreviewed |
| C-14 | A cross-tenant button copy and a revoked approver produce no write and no disclosure. | EXECUTED | S3 `77c7866a-9949-47f5-95a8-ac6ee21cf8fe` | `unauthorized_write_count: 0`, `cross_tenant_disclosure_count: 0`, `revoked_approver_denied: true` | Two fictional Emulate workspaces on one host. A forged team ID signed with A's secret is accepted into A's inbox before policy denies it (L-028) | unreviewed |
| C-15 | Each of the four mutation probes (dedupe off, approval bypass, reply before receipt, missing evidence turned into success) was caught. | EXECUTED | `artifacts/mutations/2026-10-28T18-52-12-173Z.json` (tree `fb59f8f6`) | 4 caught, 0 uncaught, 0 invalid; candidate restored | Counts these four probes only | unreviewed |
| C-16 | The worker never holds an emulator URL: its Slack proxy forwards only `POST /api/chat.postMessage` and returns 403 for the simulator routes. | EXECUTED | `tests/integration/workflows.test.ts` (W02-R forged-approval checks), run by task 3.1 in set H; L-019 | Proxy and allowlist behavior | Anyone else with an emulator URL and any valid token can still simulate clicks (L-019) | unreviewed |

## Console and README evidence (set H for gates, set M for media)

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-30 | When a required assertion fails, the console shows the failure and no overall success badge. | EXECUTED | F6-A1 `9c8273cc-4382-4236-b0bc-2433fc37ddc2` | `failure_visible: true`, `overall_success_banner: false` (browser assertion) | Local console in Playwright Chromium | unreviewed |
| C-31 | A recording export shows revision, run ID and a synthetic-data notice, with valid evidence references and no secrets or forbidden identities. | EXECUTED | F6-A2 `8c2e12f7-3b9c-4deb-95c9-5217354c4ccc` | `revision_visible`, `run_id_visible`, `synthetic_notice_visible`, `secret_count: 0`, `forbidden_identity_count: 0`, `evidence_refs_valid` | Pattern and private-terms scan; not proof that nothing sensitive could exist | unreviewed |
| C-32 | The README has five screenshots, three animated GIFs and three posters that decode, with valid provenance, alt text, captions, static fallbacks and a size within budget. | EXECUTED, **review pending** | F6-A3 `589891e8-3970-4649-97b1-dfc634327d75`; `docs/assets/media-manifest.json` (`readme_verification.local_status: PASS`, 12 embeds, rendered locally at 1440 px and 400 px) | Every F6-A3 fact matches except `local_render_review_passed: false` | **F6-A3 is not PASS.** It waits for an independent render review record (`docs/assets/render-review.json` absent). Every manifest item's manual `visual_review` is PENDING. The local render uses `marked` in Chromium, not GitHub's renderer | unreviewed |
| C-33 | A missing screenshot, a single-frame GIF, a stale capture and a broken embed are each detected, with no false media success. | EXECUTED | F6-A4 `54853a36-2c09-4eda-a552-62d1290b93c1` | Four detections, `false_media_success_count: 0` | Injected media defects in a scratch copy | unreviewed |
| C-34 | Local media status is PASS while GitHub rendering stays NOT_RUN, and nothing was created or pushed. | EXECUTED | F6-A5 `c7371292-2e57-47a1-afce-694573ff5d04` | `local_media_status: PASS`, `github_render_status: NOT_RUN`, 0 repository creates, 0 pushes | GitHub rendering unchecked until a repository is authorized | unreviewed |
| C-35 | The console never shows a false green, matches the report, shows optional lanes BLOCKED, and rejects a tampered artifact. | EXECUTED | S4 `456c120c-75af-40be-bb46-b488588f5a7d` | `false_green_count: 0`, `optional_profile_status: BLOCKED`, `tampered_artifact_rejected: true`, `console_matches_report: true` | Public challenge | unreviewed |
| C-40 | The overview screenshot shows a real W02-H approval run: approved once, with one matching receipt. | EXECUTED | M: `a440ab5c-4b22-40bf-80d1-d6adb9ec9abe` ([`docs/evidence/a440ab5c-4b22-40bf-80d1-d6adb9ec9abe/`](evidence/a440ab5c-4b22-40bf-80d1-d6adb9ec9abe/report.json)); media `lab-overview` | `approval_status: approved`, `approved_transition_count: 1`, `approval_receipt_count: 1`, `approval_receipt_matches: true` | Manual visual review PENDING | unreviewed |
| C-41 | The service-request, evidence-report and profile-boundaries screenshots and the service-request GIF come from one passing W01-H run. | EXECUTED | M: `61359d45-c5de-4016-b138-7437994c2d7e` ([`docs/evidence/61359d45-c5de-4016-b138-7437994c2d7e/`](evidence/61359d45-c5de-4016-b138-7437994c2d7e/report.json)); media `service-request-success`, `evidence-report`, `profile-boundaries`, `slack-service-request` | `ticket_count: 1`, `receipt_count: 1`, `receipt_matches_request: true`, `completion_reply_count: 1` | The profile-boundaries view shows the local-profile doctor output for optional lanes, not lane results; manual review PENDING | unreviewed |
| C-42 | The duplicate-delivery GIF and clip show a signed retry that adds nothing. | EXECUTED | M: `7d241b93-8399-4894-aa06-a548080a68a7` ([`docs/evidence/7d241b93-8399-4894-aa06-a548080a68a7/`](evidence/7d241b93-8399-4894-aa06-a548080a68a7/report.json)); media `duplicate-event-safe`, `clip-duplicate-delivery` | `additional_business_records: 0`, `additional_completion_replies: 0`, `same_request_identity: true` | Manual review PENDING | unreviewed |
| C-43 | The approval-denied screenshot, GIF and permission-boundary clip show both refused clicks with no write. | EXECUTED | M: `4bdbf285-2d3d-42d8-abc5-93adcad4e057` ([`docs/evidence/4bdbf285-2d3d-42d8-abc5-93adcad4e057/`](evidence/4bdbf285-2d3d-42d8-abc5-93adcad4e057/report.json)); media `approval-denied`, `approval-denied-gif`, `clip-permission-boundary` | `approval_status: awaiting_approval`, `unauthorized_write_count: 0`, `approval_receipt_count: 0` | Manual review PENDING | unreviewed |
| C-44 | The mental-model clip contrasts a passing W01-H run with a W01-F run in which the reply looks right but the receipt is missing, and the report FAILs. | EXECUTED | M: `81c6744f-3164-46e2-abdb-97f16e21260a` (W01-H PASS, [`docs/evidence/81c6744f-3164-46e2-abdb-97f16e21260a/`](evidence/81c6744f-3164-46e2-abdb-97f16e21260a/report.json)) and `7085c56e-5cd2-41e3-9dc8-d5a4e75d863f` (W01-F FAIL: `receipt_count: 0`, `receipt_matches_request: false`, [`docs/evidence/7085c56e-5cd2-41e3-9dc8-d5a4e75d863f/`](evidence/7085c56e-5cd2-41e3-9dc8-d5a4e75d863f/report.json)); media `clip-mental-model` | FAIL is the intended outcome of an injected fault | Simulated fault (object deleted by the coordinator); manual review PENDING | unreviewed |
| C-45 | The emulator-versus-real-org clip shows a W03 stale-version conflict and the Salesforce lane BLOCKED with parity UNKNOWN. | EXECUTED | M: `13c84cec-4fbf-4e9b-b412-3f2cf3b0e973` ([`docs/evidence/13c84cec-4fbf-4e9b-b412-3f2cf3b0e973/`](evidence/13c84cec-4fbf-4e9b-b412-3f2cf3b0e973/report.json)); media `clip-emulator-vs-real-org` | `result: CONFLICT`, `description_unchanged: true`, `write_count: 0` | Says nothing about Salesforce; manual review PENDING | unreviewed |

The manifest's `application_tree_sha256` covers only application files (README_MEDIA_SPEC), so the later docs-only commit `f67cab3` does not invalidate the set M captures.

## Optional AX lane (set X: one cluster, gVisor)

Scope for every row: AX `4b7bf6f` on one GKE cluster (2 × c3-standard-4, amd64, GKE 1.36.4) running Agent Substrate v0.6.0, reinstalled for this run. Every task ran in a gVisor sandbox on the run's single worker. AX reports a task's phase but not its command's exit status (L-006), so every PASS or FAIL below comes from the collector or from logs, never from the phase. Runs 1 and 2 were BLOCKED (L-030, L-043) and are not counted here.

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-60 | W01-H ran as an AX task in a gVisor sandbox and passed the same assertions as the local lane, judged by a separate collector. | EXECUTED, PASS | X `6882d106-…`; `profiles/ax/RESULTS.md` §3.3 test (2) | `evaluate_ax.py F3-A1`: `ticket_count: 1`, `receipt_count: 1`, `receipt_matches_request: true`, `completion_reply_count: 1`, `command_exit_code: 0`; `ax_task_phase` recorded, not asserted | One cluster, one worker; the collector Pod reads with its own token and pod certificate | unreviewed |
| C-61 | A failing command exited 3 while AX still reported the task `Running`: phase and outcome disagree. | EXECUTED, PASS | X; RESULTS.md §3.3 test (3); L-006 | `result.json` `exit_code: 3`, phase `Running` | One deliberate failing command | unreviewed |
| C-62 | `ax suspend` does not deliver SIGTERM to the command. | EXECUTED, **FAIL** | X; RESULTS.md §3.3 test (4a); L-048 | Suspend is a 40 ms checkpoint; no signal, no `result.json` | Lab runner at `d10d3e6`; behavior of the default runner not tested | unreviewed |
| C-63 | `ax delete task` does not deliver SIGTERM to the command. | EXECUTED, **FAIL** | X; RESULTS.md §3.3 test (4b); L-048 | Actor log goes from the command's boot line to `Actor terminated` | As C-62 | unreviewed |
| C-64 | Evicting the worker Pod delivers SIGTERM: the trap exited 42 and an ignoring command was killed after 10.0 s (exit 137). | EXECUTED, PASS (logs) | X; RESULTS.md §3.3 test (4c) | Runner logged `stop requested` 0.65 s after deletion | Evidence is the actor log only; no `result.json` survived (see C-66) | unreviewed |
| C-65 | Resume after `ax suspend` keeps the workspace and its prepare-once marker, with a new process. | EXECUTED, PASS | X; RESULTS.md §3.3 test (4d) | Same marker timestamp on both boots; new pid | One resume | unreviewed |
| C-66 | After a worker eviction, then suspend and resume, the workspace and the result survive. | EXECUTED, **FAIL** | X; RESULTS.md §3.3 test (4e); L-048 | The actor counted as crashed; AX reverted it to its last snapshot; next start had a new marker and no `result.json` | Not built: a runner that survives eviction | unreviewed |
| C-67 | From inside the sandbox, metadata, public hosts, the Kubernetes, Substrate and AX APIs, and an unlisted emulator port were all unreachable, while the allowed emulator API was reachable. | EXECUTED, PASS | X; RESULTS.md §3.3 test (5); L-049 | `EHOSTUNREACH` / `ENOTFOUND` / egress-gateway `400` / `403` as listed in RESULTS.md | One egress policy, one sandbox class (gVisor); probes listed there only | unreviewed |
| C-68 | The Substrate v0.6.0 router refuses a client without a certificate and accepts the collector's allowlisted certificate. | EXECUTED, PASS | X; RESULTS.md §3.3 test (5) router; L-045 | TLS alert `certificate required` vs `200` | Router at v0.6.0; the earlier v0.5 install had an open plain-HTTP port (L-035) | unreviewed |
| C-69 | `ax get task` returns the task's worker token, setup token and signing secret in clear to any AX API caller; the collector's credentials were not in it. | EXECUTED (observation) | X; RESULTS.md §3.3 secrets row; L-034 | String search; output not stored | Not a PASS or FAIL claim; a disclosed exposure | unreviewed |
| C-70 | W01-H AX tasks reached `Running` 16.8 to 17.0 s after submit (median 17.0 s) and the result was observed after 19.6 to 19.9 s (median 19.7 s), n=5. | EXECUTED | X; RESULTS.md §3.3 timing table; L-050 | Raw values in RESULTS.md | About 9 s is attaching the egress policy and 4 s resuming, mostly operator tooling; AX's own resume → running is about 2.1 s. One cluster, n=5, no percentiles | unreviewed |

## Blind holdouts (set BL)

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-54 | Of 15 blind holdout scenarios, 13 passed and 2 failed on the frozen candidate. One failure (zero-amount approval, BH-07) was fixed afterwards; the other (a forged team ID accepted at ingress, BH-03b) is disclosed, not changed. | EXECUTED | BL: frozen tree `60f9f1bf`, candidate `ea1deca`; LEARNINGS "Blind holdouts", L-027 (fix `a7a695c`), L-028 | 15 new fixtures and seeds for existing case types, expectations timestamped before running | **Blind to builder agents, not to the orchestrator.** Re-running BH-07 after the fix is a regression check, not a blind result. Scenarios and their evaluator copy are not in the repository | unreviewed |

## Measured timings, local lane (set B)

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-17 | On one laptop, W01 took 17 to 71 ms (median 18, n=5) from the worker receiving the signed callback to the collector seeing ticket, receipt and reply. | EXECUTED | bench `42bb1f6b-e41b-4de2-b46a-e62631e3eb50`; `artifacts/bench/2026-10-28T14-26-41-782Z.json` | Raw: 71, 19, 17, 17, 18 ms | macOS arm64, 18 cores, load 8 to 22 from other work; n=5; 10 ms poll resolution; no percentiles | unreviewed |
| C-18 | W02 took 20 to 27 ms (median 23, n=5) from the signed approval click being processed to the verified approved state. | EXECUTED | bench `84a91a9a-dadf-4a07-973e-4fb4b88c74f5`; same file | Raw: 27, 23, 22, 23, 20 ms | As C-17 | unreviewed |
| C-19 | W03 took 13 to 41 ms (median 14, n=5) from callback to the verified CRM update and reply. | EXECUTED | bench `5b7acbfe-1b97-4b9a-8564-974a1c64d49f`; same file | Raw: 41, 15, 14, 14, 13 ms | As C-17; local CRM double, not Salesforce | unreviewed |
| C-20 | `npm ci` took 3.8 to 4.1 s with an empty cache and 3.4 to 11.1 s with a warm cache (n=3 each). | EXECUTED | same file | Cold raw 3.8, 4.1, 4.0 s; warm raw 11.1, 3.5, 3.4 s | One network on one day; image pull NOT_RUN; measured before the console's dependencies were merged | unreviewed |
| C-21 | One independent observation pass costs 1 to 5 ms; the whole `collect-case` command takes 3.1 to 3.3 s, mostly stack start and teardown. | EXECUTED | same file; collect-case runs `e16abef0-6171-4dbe-8bcd-04fde5275f32`, `95abc1a9-59ad-428c-bfb2-68a5d066c6e3`, `05330766-c388-4726-8f28-1f7bf944d6ec` | observe_ms raw in `docs/BENCHMARKS.md` | Observation timed in the bench process, not the separate collector process | unreviewed |
| C-22 | The supplied harness `run-all.sh` took 260.6 s on the pre-console tree. | EXECUTED | same file | One run; verdict BLOCKED then | The current suite has console and media cases and was not timed | unreviewed |

## Not executed: blocked or documented

| claim_id | What may be said | Label | Source | Why not more | Reviewer |
|---|---|---|---|---|---|
| C-50 | (Retired. AX is now covered by C-60 to C-70.) | - | - | - | - |
| C-51 | The same W03 rules hold on a Salesforce scratch org. | DESIGNED; lane BLOCKED; parity UNKNOWN | `profiles/salesforce/`, C-09 | No Dev Hub or owner approval | unreviewed |
| C-52 | An external reviewer (CodeRabbit) reviewed this code. | BLOCKED | `profiles/coderabbit/` | No hosted repository; `illustrative-defects.json` is a fixture, not review output | unreviewed |
| C-53 | A live model using the same restricted actions passes the same evaluator. | BLOCKED | `profiles/live-model/` | No approved provider, key or budget; no provider client wired | unreviewed |
| C-55 | The README renders correctly on GitHub. | NOT_RUN | C-34 | Nothing published; local render only | unreviewed |
| C-56 | Emulate does not support Socket Mode, slash commands or exact rate limiting. | DOCUMENTED | [Emulate Slack docs](https://emulate.dev/docs/slack) @ `v0.12.3` | A product fact, not a lab result | unreviewed |
| C-57 | AX does not read the agent command's exit status back. | DOCUMENTED, and observed in C-61 | [AX runner](https://github.com/google/ax/blob/main/docs/runner.md) @ `4b7bf6f` | - | unreviewed |

## Claims that must not be made

- No speedup, savings, parity or endorsement claim. None was measured.
- No percentile (p95 or similar) from these samples.
- Not "all local gates pass" or "LOCAL_CORE_READY": the current verdict is `LOOP` until the F6-A3 render review exists.
- Not "AX works" or "AX termination works": three AX assertions FAIL (C-62, C-63, C-66), on one cluster.
- Not "integration with Salesforce / CodeRabbit / a live model works": those lanes are BLOCKED.
- Not "the application is secure" or "has no bugs": the mutation count covers four probes, the blind suite found two defects, and L-019, L-023, L-028 and L-034 are open.
- Not that the collector's own S3 key is a security boundary. Floci does not check credentials (L-037), so the key separation is labelling only.
- Not "blind holdouts" without the qualifier "blind to builders, not to the orchestrator".
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

A reader's run produces new run IDs. Compare the observations and statuses, not the IDs. The AX lane needs an owner-approved cluster and is described in `profiles/ax/README.md` and `RESULTS.md`.
