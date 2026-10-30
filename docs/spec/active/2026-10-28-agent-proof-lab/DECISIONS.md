# Architecture Decisions

All decisions below use single-author trade-off analysis: [No Council: single-author decision]. They are implementation defaults within the approved scope, not claims of measured superiority.

## ADR-1: Local core, optional external lanes

**Context:** Requiring every account would prevent many readers from reproducing the lesson.
**Decision:** Make Slack + Floci + local ledger mandatory; Salesforce, CodeRabbit, AX and live-model execution are opt-in.
**Consequences:** Local completion is achievable independently, but must not be called full-provider validation.
**Alternatives:** Full-stack-only setup; screenshots-only demo. Rejected for access burden and weak evidence respectively.

## ADR-2: Scripted plans before live reasoning

**Context:** A key-free demonstration should not pretend a recorded plan is fresh AI reasoning.
**Decision:** Deterministic scripted driver for baseline, optional live-model planner using the same constrained actions.
**Consequences:** Reproducible integration behavior can be separated from model variability.
**Alternatives:** LLM mandatory or fake model responses labeled live. Neither serves the evidence goal.

## ADR-3: Slack Events API, not Socket Mode

**Context:** Emulate documents signed events and button interactions, while listing Socket Mode and slash commands as unsupported ([Slack documentation](https://emulate.dev/docs/slack)).
**Decision:** Use bot mentions, thread replies and supported button simulations.
**Consequences:** The repo cannot claim transport parity with a Socket-Mode deployment.
**Alternatives:** A custom Socket Mode emulator or a mandatory real Slack workspace; both expand v1 unnecessarily.

## ADR-4: One local cloud role

**Context:** Several tools overlap in cloud emulation.
**Decision:** Use Floci AWS S3/SQS only in the baseline. Discuss LocalStack and other cloud families as alternatives, not mandatory parallel installations.
**Consequences:** Clearer teaching and fewer moving parts; no cross-vendor performance ranking.
**Alternatives:** Install every emulator. Rejected because it confuses roles with a product comparison.

## ADR-5: Real Salesforce as a separate evidence tier

**Context:** A small local API double cannot reproduce Salesforce runtime, permissions and configuration.
**Decision:** Keep the local double narrow and explicitly labeled; use a separately authorized scratch org for platform checks.
**Consequences:** Some claims remain UNKNOWN until that profile runs.
**Alternatives:** Build a full Salesforce clone. Rejected as an unrelated large product.

## ADR-6: Public challenges, not pretend secret holdouts

**Context:** Readers need reproducible test cases, while a public repo cannot keep those cases hidden from an agent.
**Decision:** Publish the tests and state their limits. Genuine blind evaluation requires a separate reviewer environment.
**Consequences:** Honest reproducibility, no unsupported claim of test secrecy.
**Alternatives:** Hidden-looking filenames or instructions not to read them. Rejected as insufficient access control.

## ADR-7: Evidence collector outside the worker

**Context:** A worker's statement of success is not an outcome oracle.
**Decision:** Collect provider and ledger state independently, compare with fixed expectations and bind artifacts to a revision.
**Consequences:** More collector code but a testable separation of duties. Hashes ensure integrity, not honesty.
**Alternatives:** LLM grading or log matching alone. Rejected for the baseline.

## ADR-8: Small stack and provisional license

**Context:** The project is a teaching lab rather than a production platform.
**Decision:** TypeScript/Node, a small console, SQLite and local emulators; proposed MIT code license only after owner and dependency review.
**Consequences:** Keep Kubernetes out of the default bootstrap. Do not bundle vendor source/images or represent third-party services as relicensed.
**Alternatives:** Full multi-service platform, default cluster or premature license attribution. Rejected as unnecessary scope.

## ADR-9: Evidence binds to the git tree SHA

**Context:** The repository will move machines and its author metadata may be rewritten before publication. A rewrite changes commit SHAs.
**Decision:** Every bundle, report and media item records `tree_sha` (`HEAD^{tree}`) as the primary identity. It also records `candidate_revision` (commit), `dirty` and `patch_sha256`.
**Consequences:** Rewriting author identity leaves the evidence valid, because tree hashes depend only on content.
**Alternatives:** Commit-only binding. Rejected: it would break on any history rewrite.

## ADR-10: Pin emulate 0.12.3 despite release age

**Context:** The default policy pins the newest release at least 14 days old. That would be emulate 0.12.2, which has no `/_slack/simulate/event-retry` or `/_slack/simulate/block-actions`. F2-A2 and F2-R5 need both.
**Decision:** Pin 0.12.3 (published 2026-10-22). Add one hash-checked install-time patch that fixes the missing `slack.event_subscriptions` seed (LEARNINGS L-001).
**Consequences:** The pinned version is newer than the policy allows, and the dependency is patched. Both facts are disclosed in `DEPENDENCIES.lock.json`. The patch refuses to apply to any other file hash.
**Alternatives:** Poll `conversations.history` instead of Events API callbacks. Rejected: F2 requires signed callbacks.

## ADR-11: Short MP4 clips in the README

**Context:** The owner asked for videos alongside GIFs.
**Decision:** Add sanitized MP4 clips under `docs/assets/videos/` that follow RECORDING_RUNBOOK. Include them in the manifest, in `media verify` and in the 25 MiB budget (≤ 8 MiB of MP4 in total). The README links them through poster images.
**Consequences:** Full-length raw recordings stay gitignored. Inline playback on GitHub needs a post-publication upload, which is recorded as NOT_RUN.

## ADR-12: AX lane expectations in `profiles/ax/cases.ax.json`

**Context:** F5-R4 asks the AX lane to repeat an existing case's outcome assertions. AX reports a task phase but does not read the command's exit status (L-006), and the collector cannot open the ledger inside the sandbox.
**Decision:** `profiles/ax/cases.ax.json` holds the AX expectations. F3-A1 keeps the local keys and values (`ticket_count`, `receipt_count`, `receipt_matches_request`, `completion_reply_count`) and adds `command_exit_code` from the runner's `result.json`. `ax_task_phase` goes into every bundle under `recorded_not_asserted` and may never be an expectation. `profiles/ax/evaluate_ax.py` runs the supplied evaluator's own `inspect_bundle` against this table. The ledger-derived facts come from a ledger export the in-sandbox coordinator writes to Floci, cross-checked against the receipt and the Slack thread.
**Consequences:** The ledger facts in the AX lane are weaker than local ones: a compromised sandbox could forge the export, though not the receipt hash it must match. The supplied `cases.json` and evaluator are unchanged.
**Alternatives:** Treat phase `Running`/`Succeeded` as success. Rejected (L-006). Give the collector debug access to the sandbox. Rejected: `ax ssh` needs `spec.debug`, which also lets anyone with AX API access run code in the task.

## ADR-13: Many tenants and two clusters on the AX lane

**Context:** Run 3 showed one tenant on one cluster with one worker. The owner asked whether AX keeps tenants' evidence and egress apart as concurrency grows, whether the same case gets the same verdict on a second cluster, and whether work can move between clusters. The design went through five EGM review rounds (`docs/MULTI_CLUSTER.md`) and was accepted at the cap with every finding applied.
**Decision:**
- Steps 1 and 2 only. Tenants share one WorkerPool per cluster and one collector identity (the router allowlist already admits it). The worker each task actor ran on is recorded, so "shared a worker" is claimed only for pairs observed on the same worker.
- New cases MT-W01 (evidence separation) and MT-ISO (egress isolation, probed one tenant at a time by (address, Host, port), with a planted positive control) go into `profiles/ax/cases.ax.json` beside F3-A1; no second table.
- Moving work between clusters (MV-PORT) is DOCUMENTED as having no path: AX `4b7bf6f` has no import, export or restore RPC, and a Substrate v0.6.0 actor can be seeded only from a Tag of a suspended actor in the same control plane. Eviction mid-run (MV-DRAIN) moves to its own follow-up design.
- The design and the build plan are separate documents: the design is reviewed; the build plan (`docs/MULTI_CLUSTER_BUILD.md`) is verified by its phase gates and dry run.
- `profiles/ax/multi.ts` is the only cluster driver; `index.ts run()` returns BLOCKED and names it. Every cluster call passes one context guard; every object is recorded in the run dir before it is created.
- Step 2 reuses A's step 1 c = 1 result only if A's recorded versions are unchanged; otherwise A is re-run first, in the same session. In the run the reuse check refused (a recorded name-format change with the same `ax-server` digest, L-064), and A's half was re-run rather than the guard overridden.
- Cluster A's node pool went from 2 to 3 nodes for the run (owner approval, 2026-10-30): Substrate and GKE system pods left room for only two of the three 1-CPU workers (L-059). Cluster B's node pool went from 0 to 3 nodes, not the design's 2, to match A. After the runs A was restored to 2 nodes and its WorkerPool to 1, and B scaled back to 0.
**Consequences:** Isolation claims are limited to the probed (address, Host, port) triples, one tenant at a time, on the workers recorded. MT-W01 mainly tests the lab's own evidence path. The two clusters share a project, a VPC and the `ate-api-server` Workload Identity principal, so they are not independent failure or security domains. Timing is recorded, never asserted, with no trend claim across concurrency levels. Results: `profiles/ax/RESULTS.md` run 4, claims C-80 to C-90.
**Alternatives:** A WorkerPool and collector identity per tenant (rejected: scope, and step 2 would compare unlike setups). A cross-cluster probe (rejected: the network is a recorded configuration fact). Two workers on two nodes (rejected by the owner: c = 4 and MT-ISO would most likely end NOT_RUN). Cluster B in another project (out of scope; the only option that would separate the identities).
