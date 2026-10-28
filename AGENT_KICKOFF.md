# Coding-Agent Kickoff

Copy the following contract into your coding agent with this folder available. This is a greenfield build grounded in the supplied specification, using a checkpointed contract because it combines executable software, optional external services and public evidence.

```text
Build Agent Proof Lab into a reproducible, local-first educational repository that demonstrates three synthetic Slack-led workflows and proves their outcomes with independent, inspectable tests.

Grounding: This folder is the approved build brief, not an existing application. Read README.md, AGENTS.md, docs/MENTAL_MODEL.md, docs/CASEBOOK.md and docs/spec/active/2026-10-28-agent-proof-lab/{REQUIREMENTS,IMPLEMENTATION_PLAN,DECISIONS}.md. Use docs/RESEARCH.md for primary-source verification. The owner approved cross-industry examples, emulated Slack as a central feature, and optional Salesforce, CodeRabbit and AX profiles. Keep the project personally branded and independent, with fictional organizations and synthetic records only.

Allowed work: Create the local application, emulator adapters, CLI, teaching console, tests, evidence collector, CI, dependency locks, recording automation and documentation in this repository. Use the implementation plan's paths. Commit the spec and supplied evaluators before application code if Git is available. Do not overwrite unrelated work or modify an unrelated repository.

Protected boundaries: Do not create or publish a public repository, push commits, install a provider app, send real Slack messages, access production, provision paid infrastructure or upload recordings without separate scope-specific approval. Do not use ambient cloud credentials. Never put secrets in source, logs, screenshots or model prompts. Do not mount a host Docker socket into an agent sandbox. Do not claim unexecuted profiles passed.

Build in six checkpoints. Start with the environment inventory, endpoint guards and fail-closed profile handling. Implement a deterministic scripted driver before any live-model option. Implement actual emulated Slack Events API callbacks and Web API replies, not a console that fakes them. Implement Floci SQS/S3 integration, then the three workflows. Add independent evidence collection and deliberate fault cases before polishing the console or article. Implement optional profiles as explicit gates; absent credentials must not prevent finishing local work.

Visual README is mandatory: read docs/README_MEDIA_SPEC.md and docs/README_STORYBOARD.md. Capture five real application screenshots, three short animated GIFs and three static posters from executed local integration cases. Implement repeatable media capture, optimization, verification and README build commands. Store optimized assets under docs/assets/, bind them to run evidence and the tested application revision, and embed them in the root README with relative paths, useful captions, alt text and static fallbacks. Do not substitute generated mockups, fake messages or fixture-only playback. Verify local rendered layout and media integrity. Verify the actual GitHub-rendered README only after a repository/ref exists and access is authorized; otherwise mark that specific check NOT_RUN.

Verify exact current upstream package interfaces and licenses before pinning dependencies. Never replace a required integration with an unlabelled in-memory fake. If an upstream method is missing, reproduce the gap, document it and return BLOCKED for that feature. Keep the core useful without Salesforce, CodeRabbit, AX or an LLM key.

Proof: Run package validation, typecheck, unit tests, integration tests, the supplied acceptance evaluator, public challenge scenarios, mutation probes and a fresh-clone run. Verify Slack messages and threads through the emulator API, Floci receipts through S3 and queue effects through SQS, and business state through a separate read-only ledger connection. The application worker must not grade itself. Capture the tested source revision, fixture hashes, image/package versions, commands, results and sanitized artifacts. Run every required case; never delete a failing test or weaken an expected result to pass.

Example of an honest result: Salesforce profile BLOCKED because no approved Dev Hub alias exists; local CRM contract-double tests PASS; scratch-org parity UNKNOWN. Never call that Salesforce integration complete.

Stop successfully when all local required gates pass, the three workflows run from a fresh clone, failures are demonstrated, cleanup is proven, and the recording and article kit reflects actual evidence. The visual README must contain the required real screenshots, animated GIFs and static posters, with a valid media manifest and passing local media/render checks. Missing media is a blocker, not optional polish. Optional provider profiles may remain BLOCKED; GitHub rendering may remain NOT_RUN pending publication authorization. A local-core success does not authorize publishing.

Blocked: Pause only the affected optional lane when credentials or service approval are absent. Stop the whole run for a suspected secret leak, production endpoint, required core capability gap, destructive action, or a contract change that would weaken acceptance. Return the command, sanitized error, affected requirement, attempted remedies and smallest owner decision needed.

Budget: Use local resources by default. Do not enable paid services or live inference without approval and an explicit configured cap. Stop after three failed approaches to the same blocker; do not keep changing the architecture to avoid the test.

Checkpoints: At the end of each task report completed requirements, files changed, proof run, observed failures and next action. Keep public challenge cases separate from implementation tests; do not call repository-visible scenarios secret holdouts. For a genuine blind evaluation, request a separately controlled evaluator environment.

Final handoff: Report the tested commit, changed files, all commands and results, per-profile status, failed/blocked/unknown items, mutation results, fresh-clone evidence, recording files, screenshot/GIF/poster inventory, README embed checks, media sizes and provenance, local versus GitHub render status, article claims awaiting results, cleanup status and the exact approvals needed before publication. Do not finish with only a plan or a fabricated green dashboard.
```
