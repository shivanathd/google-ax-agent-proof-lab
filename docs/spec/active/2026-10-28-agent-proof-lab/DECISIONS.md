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
