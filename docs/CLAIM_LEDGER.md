# Claim Ledger

Every outcome claim that the README, the article or a recording might make, bound to its evidence. If a sentence is not here, it is not a result claim. Fields follow the template in [`RESEARCH.md`](RESEARCH.md#claim-ledger-template).

**Status: unreviewed.** No row has been reviewed by someone other than its author. Nothing here authorizes publication.

## Shared identity for executed rows

Unless a row says otherwise, executed rows come from one run of the supplied harness (`bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh`) on 2026-10-28 between 14:17 and 14:24 UTC.

| Field | Value |
|---|---|
| Tree SHA (`HEAD^{tree}`, ADR-9) | `0f0c432e5c16c4daa066587ac9ce5d7a6b7bba2a` |
| Commit at run time | `be3bb2d` (`dirty: false` in every bundle) |
| Profile / mode | `local` / `scripted` (no model was called) |
| Mutation | `none` in every candidate bundle |
| Cleanup | `CLEAN` for every executed run |
| Harness verdict | `BLOCKED`: tasks 1.1-5.1, F1-F5 and S1-S3 PASS; task 6.1, F6 and S4 BLOCKED because the console and media are not in this tree (NOT_RUN bundles) |
| Where the evidence is | `artifacts/runs/<run_id>/` (gitignored, local): `manifest.json`, `events.ndjson`, `observations.json`, `evidence/`, `report.json`, `report.md`, `checksums.sha256` |

Run artifacts are local and gitignored. A reader reproduces a row by rerunning its case (see "Reproduce" at the end); the run ID identifies this author's run, not a file a reader can download.

## Executed claims (local lane)

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-01 | The local profile starts Emulate Slack and Floci and runs all three workflows with no external account. | EXECUTED | F1-A1 `1f68651b-bddc-42b9-8f78-8854b5c2ec34` | `emulate_running`, `floci_running`, `workflow_count: 3`, `required_external_accounts: 0`, `non_loopback_endpoint_count: 0` | Needs Docker, the pinned Floci image and Node 24 on one macOS arm64 host | unreviewed |
| C-02 | A production endpoint override is rejected before any network request. | EXECUTED | F1-A2 `11835685-6d3a-402d-b3c4-116aa9c3219a` | `rejected_before_network: true`, `outbound_request_count: 0` counted at a collector-owned sinkhole | The first run of this case on merged `main` failed (L-025) and was fixed in `be3bb2d` before this run | unreviewed |
| C-03 | A signed mention produces one accepted event and one reply in the original thread; the bot's own message creates no job. | EXECUTED | F2-A1 `99faa345-da82-4ff5-aee4-6077ba62d57b` | `accepted_event_count: 1`, `completion_reply_count: 1`, `reply_in_original_thread: true`, `bot_loop_job_count: 0` | Emulate Slack only; Events API transport, not Socket Mode | unreviewed |
| C-04 | A signed retry of the same event adds no business record and no reply. | EXECUTED | F2-A2 `02a1dea3-802c-4f68-bd19-fd46e0e67158` | `additional_business_records: 0`, `additional_completion_replies: 0` | Retries come from Emulate's explicit simulator, not real Slack retry timing | unreviewed |
| C-05 | A W01 service request ends with one ticket, one S3 receipt that matches the request, and one completion reply, all observed independently. | EXECUTED | F3-A1 `5bfdd4b7-f5f3-47c5-9343-94c737c5cdf4` | Four facts from three stores (ledger, S3, Slack thread) | One run of this case; repetition timing is in C-17 | unreviewed |
| C-06 | A requester cannot approve their own purchase request, and a user without approval rights cannot approve it; no write follows either click. | EXECUTED | F3-A2 `1deef3e2-66fe-4401-b32e-93c255140bda` | `approval_status: awaiting_approval`, `unauthorized_write_count: 0`, `approval_receipt_count: 0` | Fictional grants in a local ledger; no real identity provider | unreviewed |
| C-07 | A CRM update with a stale expected version is a conflict and overwrites nothing. | EXECUTED | F3-A3 `f59286f4-95c3-4291-9608-506811789d44` | `result: CONFLICT`, `description_unchanged: true`, `write_count: 0` | Local contract double, not Salesforce | unreviewed |
| C-08 | When the worker reports success but the receipt is missing, the required assertion fails and no success banner appears. | EXECUTED | F4-A1 `1f4274fd-784a-427a-b573-e85d41da0846` | `worker_claimed_success: true`, `receipt_present: false`, `required_assertion_failed: true`, `overall_success_banner: false` | The missing receipt is a simulated fault (the coordinator deletes the object) | unreviewed |
| C-09 | With Salesforce unavailable, the lane reports BLOCKED and parity UNKNOWN, separately from the local results. | EXECUTED | F4-A2 `5ae88a67-2bab-4470-ad49-af2798fd02f4` | `salesforce_status: BLOCKED`, `salesforce_parity: UNKNOWN`, `local_results_separate: true` | Says nothing about Salesforce behavior | unreviewed |
| C-10 | All four optional lanes report BLOCKED with their own prerequisites, and nothing external is created. | EXECUTED | F5-A1 `e1e138c0-78a9-4619-9da7-69ef4fd50334` | `blocked_optional_profile_count: 4`, `external_resource_create_count: 0`, `prerequisites_reported: true` | Counting covers provider CLIs via PATH shims plus the sinkhole; proxy routing of Node traffic is unproven (L-023) | unreviewed |
| C-11 | An optional lane that looks configured but is not authorized makes zero external calls and leaves the local result unchanged. | EXECUTED | F5-A2 `713a010c-330d-47b4-819e-887b63733566` | `external_call_count: 0`, `authorization_rejected: true`, `local_result_preserved: true` | Same counting limit as C-10 | unreviewed |
| C-12 | A fresh clone completes W01 with no undeclared account and no reads across runs. | EXECUTED | S1 `0a6611d0-c518-435d-a4ae-13ba9f532b74` | `fresh_clone_completed`, `undeclared_account_count: 0`, `cross_run_read_count: 0` | Warm npm cache and pre-pulled image (BUILD_PLAN §8.11); public challenge, not a blind holdout | unreviewed |
| C-13 | After a crash between the ticket commit and the receipt, recovery finishes the job with no duplicate ticket and no false success. | EXECUTED | S2 `99fde0da-472f-4d16-ba38-905f411cb0bd` | `ticket_count: 1`, `false_success_count: 0`, `recovery_evidence_present: true`, `duplicate_after_restart_count: 0` | Simulated crash (SIGKILL) and stalled PUT; failed on merged `main` until `be3bb2d` (L-026) | unreviewed |
| C-14 | A cross-tenant button copy and a revoked approver produce no write and no disclosure. | EXECUTED | S3 `5ca5619e-ec46-49df-a568-875fc2ac8a95` | `unauthorized_write_count: 0`, `cross_tenant_disclosure_count: 0`, `revoked_approver_denied: true` | Two fictional Emulate workspaces on one host; public challenge | unreviewed |
| C-15 | Each of the four mutation probes (dedupe off, approval bypass, reply before receipt, missing evidence turned into success) was caught. | EXECUTED | `artifacts/mutations/2026-10-28T14-25-24-558Z.json` (committed) | 4 caught, 0 uncaught, 0 invalid; candidate restored | Counts these four probes only; not a claim that the code has no other defects | unreviewed |
| C-16 | The worker never holds an emulator URL: its Slack proxy forwards only `POST /api/chat.postMessage` and returns 403 for the simulator routes. | EXECUTED | `tests/integration/workflows.test.ts` (W02-R forged-approval checks); L-019 | Proxy and allowlist behavior | Residual: anyone else with an emulator URL and any valid token can still simulate clicks (L-019) | unreviewed |

## Measured timings

| claim_id | Wording that may be used | Label | Run ID / source | Scope | Limitations | Reviewer |
|---|---|---|---|---|---|---|
| C-17 | On one laptop, W01 took 17 to 71 ms (median 18, n=5) from the worker receiving the signed callback to the collector seeing ticket, receipt and reply. | EXECUTED | bench `42bb1f6b-e41b-4de2-b46a-e62631e3eb50`; `artifacts/bench/2026-10-28T14-26-41-782Z.json`; tree `721110b062ecde0e2941943b6fb685114b07a9a6` | Raw: 71, 19, 17, 17, 18 ms | macOS arm64, 18 cores, load 8 to 22 from other work; n=5; 10 ms poll resolution; no percentiles | unreviewed |
| C-18 | W02 took 20 to 27 ms (median 23, n=5) from the signed approval click being processed to the verified approved state. | EXECUTED | bench `84a91a9a-dadf-4a07-973e-4fb4b88c74f5`; same file and tree | Raw: 27, 23, 22, 23, 20 ms | As C-17 | unreviewed |
| C-19 | W03 took 13 to 41 ms (median 14, n=5) from callback to the verified CRM update and reply. | EXECUTED | bench `5b7acbfe-1b97-4b9a-8564-974a1c64d49f`; same file and tree | Raw: 41, 15, 14, 14, 13 ms | As C-17; local CRM double, not Salesforce | unreviewed |
| C-20 | `npm ci` took 3.8 to 4.1 s with an empty cache and 3.4 to 11.1 s with a warm cache (n=3 each). | EXECUTED | same file and tree | Cold raw 3.8, 4.1, 4.0 s; warm raw 11.1, 3.5, 3.4 s | One network on one day; the image pull was NOT_RUN | unreviewed |
| C-21 | One independent observation pass costs 1 to 5 ms; the whole `collect-case` command takes 3.1 to 3.3 s, mostly stack start and teardown. | EXECUTED | same file and tree; collect-case runs `e16abef0-6171-4dbe-8bcd-04fde5275f32`, `95abc1a9-59ad-428c-bfb2-68a5d066c6e3`, `05330766-c388-4726-8f28-1f7bf944d6ec` | observe_ms raw in `docs/BENCHMARKS.md` | Observation timed in the bench process, not the separate collector process | unreviewed |
| C-22 | The supplied harness `run-all.sh` took 260.6 s and returned `BLOCKED`. | EXECUTED | same file and tree | One run | Verdict BLOCKED because F6, S4 and task 6.1 were NOT_RUN | unreviewed |

## Not executed: planned, blocked or unknown

| claim_id | What may be said | Label | Source | Why not more | Reviewer |
|---|---|---|---|---|---|
| C-30 | The console, screenshots and GIFs show failures without a success badge. | UNKNOWN (NOT_RUN here) | F6-A1..A5 and S4 bundles in this run are NOT_RUN: `1fb4a04d…`, `0f7fe996…`, `0f9dbfb5…`, `a55724eb…`, `01d811b8…`, S4 `f4c34541…` | Task 6.1 is built in parallel and was not in this tree | unreviewed |
| C-31 | AX could run a lab case on Agent Substrate with the collector deciding the outcome. | DESIGNED; lane BLOCKED | `profiles/ax/README.md`, `docs/diagrams/README.md` (d) | No cluster run approved. Runner contract EXECUTED locally under runc only (`tests/integration/ax-profile.test.ts`), which says nothing about gVisor (L-012) | unreviewed |
| C-32 | The same W03 rules hold on a Salesforce scratch org. | DESIGNED; lane BLOCKED; parity UNKNOWN | `profiles/salesforce/`, C-09 | No Dev Hub or owner approval | unreviewed |
| C-33 | An external reviewer (CodeRabbit) reviewed this code. | BLOCKED | `profiles/coderabbit/` | No hosted repository; `illustrative-defects.json` is a fixture, not review output | unreviewed |
| C-34 | A live model using the same restricted actions passes the same evaluator. | BLOCKED | `profiles/live-model/` | No approved provider, key or budget; no provider client wired | unreviewed |
| C-35 | Blind holdouts written outside the builders' briefs pass. | UNKNOWN | BUILD_PLAN §3.5, §8.8 | No blind-holdout results exist in this tree | unreviewed |
| C-36 | Emulate does not support Socket Mode, slash commands or exact rate limiting. | DOCUMENTED | [Emulate Slack docs](https://emulate.dev/docs/slack) @ `v0.12.3` | A product fact, not a lab result | unreviewed |
| C-37 | AX does not read the agent command's exit status back. | DOCUMENTED | [AX runner](https://github.com/google/ax/blob/main/docs/runner.md) @ `4b7bf6f` | A product fact; the lab's design response is L-006 | unreviewed |

## Claims that must not be made

- No speedup, savings, parity or endorsement claim. None was measured.
- No percentile (p95 or similar) from these samples.
- "Integration with Salesforce / AX / CodeRabbit works": every optional lane is BLOCKED or DESIGNED.
- "The application is secure" or "has no bugs": the mutation count covers four probes, and L-019 and L-023 are open.
- Floci credential separation: the worker and collector keys differ, but rejection of a wrong key was not tested.

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
