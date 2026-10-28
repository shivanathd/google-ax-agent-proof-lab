# Agent Proof Lab: Build Specification

Version 1.1.0, 28 October 2026. Status: ready for local-core implementation, with opt-in integrations gated by prerequisites. Classification: Functional, Security, Operational and Documentation. Data classification: public synthetic fixtures; local secrets remain confidential and excluded from artifacts.

## Executive Summary

Build a personal open-source teaching lab that lets developers observe the difference between an agent running, a dependency being emulated, an action being authorized and a result being verified. Three Slack-led synthetic business workflows supply the common thread: service requests, operations approvals and CRM updates.

The default profile MUST run without provider accounts or an LLM key. It MUST use actual Emulate Slack and Floci S3/SQS processes, not pictures of integrations. Salesforce scratch orgs, CodeRabbit, live-model execution and AX MUST be independently gated options. The repository MUST teach what each result establishes and what remains unknown.

## Discovery Summary

The owner approved local-first execution and a cross-industry suite, explicitly asked for emulated Slack, and required a standalone personal project without corporate branding. Intended readers are developers, architects and technical audiences learning through a repo, recordings and an article.

Success means a fresh clone runs the local suite, shows both correct behavior and controlled failures, produces inspectable evidence, and can be recorded without exposing secrets. This is not a production worker fleet, an emulator benchmark leaderboard, a complete Salesforce clone, a compliance certification or an authorization to publish.

## Open Questions

### Critical (blocks spec)

- [x] Local-first core with separate opt-in profiles.
- [x] Cross-industry synthetic use cases.
- [x] Emulated Slack is a primary demo surface.
- [x] Standalone personal branding, with no internal project references.

### High (blocks only its named lane)

- Dependency versions, container digests and architecture support: resolve in Task 1.1 before runtime installation.
- Salesforce org availability and disposable-org authorization: blocks the Salesforce lane only.
- CodeRabbit account, permitted repository and data-disclosure consent: blocks live review only.
- AX/Substrate version pair, cluster and resource authorization: blocks AX only.
- Live-model provider and spending cap: blocks live reasoning only.

### Deferred (before publication)

Final repository name, license approval and publication destination. Proposed name: `agent-proof-lab`; proposed code license: MIT, subject to owner approval and third-party license inventory.

## System Context & Impact Analysis

This is greenfield. It changes no existing deployed system. Nine components are proposed: CLI/coordinator, teaching console, workflow worker, Emulate Slack, Floci, SQLite ledger/local CRM double, evaluator, evidence publisher, optional-provider adapters.

| Contract | Producers → consumers | Impact |
|---|---|---|
| C1 RunConfig | CLI → coordinator, worker, evaluator | New; enforces profile, endpoint, identity and resource boundaries |
| C2 WorkflowEvent | Slack receiver → ledger/worker | New; signed transport, deduplication and tenant identity |
| C3 ActionEnvelope | policy boundary → dependency adapters | New; scoped intent and optimistic preconditions |
| C4 ObservationBundle | independent collector → evaluator | New; facts, artifact references and unknowns |
| C5 RunReport | evaluator → CLI, console, article/recordings | New; status aggregation and evidence identity |

All five contracts are versioned at `1`. Their fields and validation rules are in `contracts/CONTRACTS.md`; JSON Schemas MUST be implemented in Task 1.1 and Task 4.1. The blast radius is limited to the new repository, local processes and explicitly approved optional test resources.

## F1: Reproducible profiles and safety boundaries

### Metadata

- **ID:** REQ-LAB-001
- **Classification:** Security
- **Priority:** Critical
- **Status:** Approved scope
- **Author / Last Updated / Version:** Specification author / 2026-10-28 / 1.0.0

### Problem Statement

A runnable lab is unsafe and misleading if local tests can fall back to real services or optional accounts are silently required. Installation and cleanup must be bounded and visible.

### Evidence

The owner approved a provider-account-free local core. Floci documents local endpoint overrides and Docker/Podman prerequisites; Emulate supports local service selection and programmatic lifecycle management ([Floci](https://floci.io/), [Emulate](https://emulate.dev/docs/programmatic-api)).

### Impact Analysis

C1 is consumed by worker and evaluator; C5 is consumed by CLI/console. Changes to profile status or endpoint selection MUST update all four consumers and their tests.

### Standards Alignment

Design mapping, not certification: least privilege and access enforcement align with NIST SP 800-53 AC-6 and AC-3; audit handling aligns with AU controls ([NIST publication](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)). Treat mappings as engineering guidance, not a compliance claim.

### Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| F1-R1 | The local profile MUST require only a supported Node toolchain, container runtime and local dependencies; it MUST NOT require provider accounts or an LLM key. | Critical |
| F1-R2 | Every local outbound adapter MUST validate scheme, resolved host, port and redirects against the run allowlist before network use; production endpoints MUST be rejected. | Critical |
| F1-R3 | The coordinator MUST strip ambient provider credentials, disable cloud metadata credential lookup, and inject fake credentials with explicit local endpoints. | Critical |
| F1-R4 | Setup MUST pin packages and images, record versions/licenses, bind exposed ports to loopback and label all owned resources with run ID. | High |
| F1-R5 | Cleanup MUST remove only resources created by this run and MUST preserve evidence until explicit purge. | High |
| F1-R6 | Optional profiles MUST report BLOCKED with prerequisites when selected but unavailable; unselected profiles MUST report SKIPPED, not PASS. | Critical |

### Technical Specification

Use Node 24, TypeScript, npm with committed lockfile, Fastify, Vitest and Playwright as design defaults. Use `better-sqlite3` for the local ledger; verify its toolchain support before committing the lockfile. Use a containerized Floci AWS service for S3/SQS only, and a separate host Emulate process for Slack. Keep the app and test runner separate processes. No cloud IaC deployment is required.

Implement commands in `src/cli/`: `doctor`, `up`, `seed`, `run`, `test`, `report`, `record`, `down`, `profile`, `verify`, `collect-case`. Commands run through `npm run lab -- COMMAND`. `up --profile local` prints a loopback console URL. `down --run-id ID` is scoped; destructive global cleanup is forbidden.

Local run IDs are UUIDs. Resource names use a validated shortened ID. Two concurrent runs MUST use isolated ports, DB files, service instances or exclusive leases, and non-overlapping storage/queue namespaces. A shared unpartitioned emulator process is not acceptable.

### Acceptance Scenarios

- **F1-A1:** GIVEN no provider keys and installed prerequisites, WHEN local setup runs, THEN both emulators start, three workflows are available, and all required endpoints are loopback.
- **F1-A2:** GIVEN a local profile with a production endpoint override, WHEN the workflow is requested, THEN it is rejected before any outbound request and a zero-write audit record is produced.

### Failure Behavior

On Invalid Input: reject configuration with a nonzero exit and sanitized reason. On System Error: fail closed; tear down invocation-owned resources, preserve partial evidence. Alerting: CLI error and console banner, no external notification.

### Threats Addressed

Ambient credential leakage, accidental production access, cross-run state contamination, SSRF through configurable URLs and overbroad cleanup.

### Edge Cases

| Case | Expected |
|---|---|
| Docker absent | BLOCKED with installation prerequisite, no fake “running” status |
| Port already used | Allocate owned port or fail; do not kill the other process |
| Setup interrupted | Recover using owned-resource manifest |
| Redirect to external host | Reject before following redirect |

### Test Strategy

Unit-test URL/identity validation; integration-test local startup and two-run isolation; inject a forbidden endpoint and observe zero network writes. Security assumptions MUST be stated: application allowlists are not a general OS sandbox; the optional AX lane tests a separate containment boundary.

### What This Is NOT

Production multi-tenancy or a universal secure execution platform.

### Anti-Patterns

MUST NOT use unpinned `latest`, remote install scripts piped into a shell, automatic provider login, shared host Docker sockets inside untrusted workers, or default cloud credential chains.

### AI Development Guidance

Read `AGENTS.md`, C1 and Task 1.1. Changes to endpoint policy require matching denial tests; do not enable an optional profile to work around a local failure.

## F2: Stateful Slack entry and interaction surface

### Metadata

- **ID:** REQ-LAB-002
- **Classification:** Security
- **Priority:** Critical
- **Status:** Approved scope
- **Author / Last Updated / Version:** Specification author / 2026-10-28 / 1.0.0

### Problem Statement

A Slack-looking UI does not establish Slack integration behavior. The lab needs real emulated Web API calls, signed Events API callbacks and explicit interaction tests.

### Evidence

The owner explicitly requested Slack emulation. Emulate documents message/thread state, signed callbacks, button simulations and explicit event retry, but not Socket Mode, slash commands or exact rate limits ([Slack emulator](https://emulate.dev/docs/slack)).

### Impact Analysis

C2 feeds the worker and ledger; C3 gates responses/actions; C4 records message and callback evidence. Changes MUST preserve tenant binding, thread identity and event deduplication.

### Standards Alignment

Use least privilege and access enforcement as design guidance, with no certification claim ([NIST SP 800-53](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)). Implement Slack request verification against raw bytes and a timestamp window as specified by Slack ([Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)).

### Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| F2-R1 | The lab MUST start actual Emulate Slack, seed fictional users/channels/apps and enable `slack.strict_scopes: true`. | Critical |
| F2-R2 | The receiver MUST verify signatures over raw bytes, reject stale/forged requests, and ignore its own bot messages. | Critical |
| F2-R3 | Event processing MUST deduplicate by installation/team/event ID and preserve the original thread for replies. | Critical |
| F2-R4 | The UI MUST distinguish its own lab console from the emulator inspector and MUST NOT imply it is the official Slack client. | High |
| F2-R5 | Approval tests MUST invoke supported emulator button interactions and re-check current approver authority at action time. | Critical |
| F2-R6 | The lab MUST test revoked credentials, missing scopes, explicit retry and cross-tenant attempts; unsupported transport features MUST be disclosed. | High |

### Technical Specification

Use an ordinary bot mention such as `@LabBot service-request printer offline`, not a slash command. Store the ingress body hash, verified installation, event ID, actor, channel and thread. Events must be durably accepted before async business processing. A retry with a new valid signature but the same event ID must not produce another business action.

Use two fictional workspaces, `T_LAB_A` and `T_LAB_B`, with separate installation bindings. Prefer separate emulator instances if cross-workspace visibility cannot be faithfully isolated. Do not infer full tenant isolation from an emulator's seed format.

Use `/_slack/simulate/event-retry` and `/_slack/simulate/block-actions` only from the test coordinator. Workers MUST NOT receive simulator/admin credentials. For ambiguous reply timeout after a write, reconcile recorded message identity; if certainty is unavailable, record UNKNOWN and do not blindly retry or announce success.

### Acceptance Scenarios

- **F2-A1:** GIVEN a valid user mention, WHEN the callback and reply complete, THEN one accepted event and one correct-thread bot reply exist; the bot's own reply produces no new job.
- **F2-A2:** GIVEN a previously processed event, WHEN its signed retry is delivered, THEN the same request is returned with zero additional business records and zero additional completion replies.

### Failure Behavior

On Invalid Input: reject forged/stale identity with no queued work. On System Error: record the failed delivery and reconcile idempotently; do not claim successful business execution. Alerting: run-local evidence and visible failure/unknown banner.

### Threats Addressed

Request forgery, replay, bot loops, scope bypass, stale approval, actor spoofing and cross-workspace disclosure.

### Edge Cases

| Case | Expected |
|---|---|
| Bot-authored message | Ignore, record reason |
| Missing scope | No retry escalation to a broader token |
| Unknown actor/team | Deny before dependency action |
| Revocation during job | Stop further provider actions; preserve committed-state evidence |

### Test Strategy

Verify actual state using `conversations.history` and `conversations.replies`, not the worker's success text. Inject signed and forged callbacks; inspect raw request capture and external state independently.

### What This Is NOT

Full Slack fidelity, an official Slack UI clone or proof of Socket Mode readiness.

### Anti-Patterns

MUST NOT disable signature checks for demos, spoof replies only in the console, silently enable permissive scopes, or let message text choose tenant credentials.

### AI Development Guidance

Read Slack source documentation linked in `docs/RESEARCH.md`, C2/C3 and Task 2.1. Preserve unsupported-feature disclosures in the console and recording overlay.

## F3: Three synthetic business workflows

### Metadata

- **ID:** REQ-LAB-003
- **Classification:** Functional
- **Priority:** High
- **Status:** Approved scope
- **Author / Last Updated / Version:** Specification author / 2026-10-28 / 1.0.0

### Problem Statement

Tool tours do not show why a dependency matters. Each workflow must express a business rule, an observable result and at least one meaningful failure.

### Evidence

The owner approved cross-industry examples. Floci documents S3 and SQS-shaped local services, while scratch orgs are actual disposable Salesforce environments rather than API doubles ([Floci](https://floci.io/), [Salesforce](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs.html)).

### Impact Analysis

C3 is consumed by S3/SQS, ledger and CRM adapters; C4 carries their observed state. The same business assertions MUST apply when replacing a local CRM double with an authorized scratch org, with provider-specific behavior reported separately.

### Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| F3-R1 | W01 MUST accept a service request through Slack, enqueue via Floci SQS, create one durable ticket and write a Floci S3 receipt before confirming completion. | High |
| F3-R2 | W02 MUST require an authorized second person to approve a synthetic purchase request before changing it to approved; it MUST NOT execute payments. | High |
| F3-R3 | W03 MUST update only an allowlisted synthetic account-description field, check expected version, and refuse stale or unauthorized writes. | High |
| F3-R4 | All workflows MUST use deterministic scripted plans in the base lane, clearly labeled as fixtures rather than live reasoning. | Critical |
| F3-R5 | All workflows MUST have deduplication, explicit state transitions, bounded retries and independently observable outcomes. | High |
| F3-R6 | The local CRM adapter MUST be labeled a narrow contract double, never a Salesforce emulator or proof of platform parity. | Critical |

### Technical Specification

Use `tickets`, `approval_requests`, `crm_accounts`, `inbox`, `outbox`, `actions` and `run_audit` tables. Enforce a unique key on `(run_id, tenant_id, action_key)`. Use a transactional inbox/outbox for application-local atomicity; remote systems remain at-least-once and require reconciliation.

Approval states: `requested → awaiting_approval → approved|rejected|expired`; only one terminal transition is allowed. Requester cannot approve their own request. Amounts are integer cents and illustrative; no real financial decision is made.

CRM default fixture: fictional Northstar Demo account, description “Trial account”, version 1. Allowed update: “Workshop follow-up requested”, expected version 1. A version conflict leaves all fields unchanged and returns CONFLICT, not silent overwrite. Authorization binds principal, tenant, connection and operation; none can be supplied by untrusted natural-language output.

### Acceptance Scenarios

- **F3-A1:** GIVEN W01's fresh synthetic fixture, WHEN the job completes, THEN exactly one ticket, matching S3 receipt and one completion reply exist.
- **F3-A2:** GIVEN W02 awaiting approval, WHEN its requester or an unauthorized user attempts approval, THEN status remains awaiting approval and no approval receipt is emitted.
- **F3-A3:** GIVEN W03 with expected version 1, WHEN the stored version is 2, THEN the update fails as a conflict and the stored description remains unchanged.

### Edge Cases

| Case | Expected |
|---|---|
| S3 write fails after ticket creation | Mark incomplete, retain ticket, retry receipt safely; no success reply |
| Queue redelivery | Deduplicate business effect |
| Approval expires | No action, clear expiry feedback |
| Customer name mentioned in prompt | Does not change tenant binding |

### Test Strategy

Run happy paths and fault variants against live local emulators. Compare ledger state, queue observations, S3 contents and Slack thread state; the receipt hash must bind the same action and input.

### What This Is NOT

A procurement system, service desk product, hiring decision engine or complete Salesforce implementation.

### Anti-Patterns

MUST NOT use optimistic success messages before commit, route decisions through hardcoded expected-output strings, or omit remote uncertainty.

### AI Development Guidance

Read `docs/CASEBOOK.md`, C3 and Task 3.1. Keep business policy deterministic and outside any optional LLM planner.

## F4: Independent evidence and truthful reporting

### Metadata

- **ID:** REQ-LAB-004
- **Classification:** Operational
- **Priority:** Critical
- **Status:** Approved scope
- **Author / Last Updated / Version:** Specification author / 2026-10-28 / 1.0.0

### Problem Statement

A test demo can appear successful when only a log line or model answer is correct. The lab must bind claims to observed state and preserve incomplete evidence.

### Evidence

The owner requested public test cases and recordings. AX documentation distinguishes a running runner from the exit status of the agent command, showing why infrastructure readiness must not be used as task success ([AX runner contract](https://github.com/google/ax/blob/main/docs/runner.md)).

### Impact Analysis

C4 feeds the evaluator; C5 feeds all teaching and publishing surfaces. A schema or aggregation change MUST update the Python acceptance verifier, console, report generator and recording overlay.

### Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| F4-R1 | The evaluator MUST inspect dependencies through independent clients and a separate read-only ledger connection, not accept worker self-grading. | Critical |
| F4-R2 | Every run MUST bind candidate revision, dirty-worktree state, seed, fixture hashes, dependency versions and profile to its artifacts. | High |
| F4-R3 | PASS MUST require all selected required assertions to pass with evidence; missing or partial evidence MUST NOT become a pass or numeric zero. | Critical |
| F4-R4 | Report generation MUST distinguish actual integration runs, fixture replay, simulated faults and optional-provider validation. | Critical |
| F4-R5 | Public challenge tests MUST NOT be described as secret holdouts; a genuinely blind evaluation MAY use a separate reviewer-controlled environment. | High |
| F4-R6 | Deliberately introduced faults MUST be caught by relevant tests, and the lab MUST restore the known-good candidate before final evidence capture. | High |

### Technical Specification

Write sanitized artifacts to `artifacts/runs/{run_id}/`: `manifest.json`, `events.ndjson`, `observations.json`, `report.json`, `report.md`, `checksums.sha256`, and optional recordings. Keep unpublished raw captures in gitignored `private-runs/`. Publish only an allowlisted export after a secret scan and manual review.

Report each assertion as expected/observed/status/evidence_refs. Record counts for required, passed, failed, blocked, skipped, not-run and unknown. Do not use a single blended “trust score”. Statistical summaries require sample count and environment; do not report p95 from tiny demonstration samples.

### Acceptance Scenarios

- **F4-A1:** GIVEN the worker claims success but S3 lacks its receipt, WHEN the evaluator collects state, THEN the run fails and cannot render a green completion banner.
- **F4-A2:** GIVEN a selected Salesforce profile without credentials, WHEN reporting runs, THEN its status is BLOCKED, parity is UNKNOWN, and local-core results remain separately visible.

### Failure Behavior

On Invalid Input: reject malformed evidence and unknown schema versions. On System Error: preserve partial evidence and mark UNKNOWN or BLOCKED with reason. Alerting: fail the affected verification command and render a clear incomplete-result banner.

### Edge Cases

| Case | Expected |
|---|---|
| Collector disconnected | UNKNOWN, never inferred PASS |
| Dirty candidate | Record patch digest and disallow final published “clean revision” claim |
| Secret in artifact | Quarantine export and fail publication gate |
| Mutant remains enabled | Block final demonstration capture |

### Test Strategy

Inject missing evidence, forged worker success, missing profile and deliberate mutations. The supplied spec evaluator checks report consistency; implementation MUST also supply the independent collectors and direct integration tests.

### What This Is NOT

Cryptographic proof of an honest test runner or a certification of production readiness.

### Anti-Patterns

MUST NOT aggregate blocked work into success, hide failing cases, describe fixture transcripts as fresh model output, or call repository-visible tests secret.

### AI Development Guidance

Read C4/C5, the supplied `evals/` and Task 4.1. Keep evidence-check logic outside the worker process and prevent the worker from writing evaluator outputs.

## F5: Optional real-provider and execution profiles

### Metadata

- **ID:** REQ-LAB-005
- **Classification:** Operational
- **Priority:** Medium
- **Status:** Approved as gated extensions
- **Author / Last Updated / Version:** Specification author / 2026-10-28 / 1.0.0

### Problem Statement

Readers should see how the layers connect without being forced to obtain every service account. An absent integration must be obvious rather than silently mocked.

### Evidence

Scratch orgs are temporary Salesforce deployments; CodeRabbit supports code review; AX requires a compatible execution environment and runner contract ([Salesforce](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs.html), [CodeRabbit](https://docs.coderabbit.ai/guides/code-review-overview), [AX](https://github.com/google/ax/blob/main/docs/runner.md)).

### Impact Analysis

C1 selects the profile; C3 binds external connection identity; C4/C5 carry provider-specific observations. Implementing an optional adapter MUST NOT alter the local workflow's policy or success criteria.

### Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| F5-R1 | Salesforce MUST use an explicitly approved Dev Hub/scratch-org path, synthetic data, known permission sets and separately bound connection identity. | High |
| F5-R2 | Salesforce tests MUST cover one permitted update, one denied update and one stale-version conflict; successful local-double tests MUST NOT substitute. | High |
| F5-R3 | CodeRabbit MUST be a review lane, with revision-bound findings and adjudication, not the execution oracle. | High |
| F5-R4 | AX MUST be optional; when enabled it MUST run a selected existing case through the runner contract and repeat the same outcome assertions. | Medium |
| F5-R5 | Live-model mode MUST use the same restricted tool actions and deterministic evaluator, with explicit provider approval, budgets and model identity. | Medium |
| F5-R6 | Missing prerequisites MUST block only their optional lane; live-provider actions MUST require explicit operator opt-in. | Critical |

### Technical Specification

Implement `lab profile doctor NAME` and `lab profile run NAME --case ID`. Salesforce setup verifies the target is the intended disposable org before deployment; org lifecycle manifests track ownership and expiry. Do not reuse the developer's default org implicitly.

Use a small Apex REST operation with account-level sharing and explicit CRUD/FLS enforcement if atomic compare-and-write cannot be proven through the selected REST path. The specification requires semantic optimistic concurrency, not a fictitious native version column. Test lower-privilege personas and a separate observer identity.

CodeRabbit offline examples MUST be clearly labeled illustrative fixtures. A live review requires approved repository access and an actual review artifact tied to the commit. AX setup records the AX/Substrate revisions and tests termination, isolation and command-result reporting. No cluster creation in the default bootstrap.

### Acceptance Scenarios

- **F5-A1:** GIVEN no external accounts, WHEN all optional profile doctors run, THEN they provide actionable BLOCKED statuses and no external resource is created.
- **F5-A2:** GIVEN a configured optional lane, WHEN it is requested without explicit authorization, THEN no remote call is performed and the report preserves the local result.

### Failure Behavior

On Invalid Input: refuse unknown profile or connection. On System Error: stop the lane, retain local evidence and list cleanup required. Alerting: status banner with prerequisite or remedy; do not silently switch adapters.

### Edge Cases

| Case | Expected |
|---|---|
| Scratch-org quota exhausted | BLOCKED, no fallback to production |
| CodeRabbit app absent | No fake review score |
| AX provisioning failure | Preserve host-run evidence; AX result not executed |
| Live-model budget exhausted | Stop new requests, no unbounded retry |

### Test Strategy

Provider-free doctor/denial tests are required locally. Live parity and runtime checks are required only when the selected profile is authorized; record their results independently.

### What This Is NOT

Guaranteed access to hosted services, permission to install apps or an automatic public GitHub launch.

### Anti-Patterns

MUST NOT provision services to turn a blocked optional test green, silently use a production org, or claim CodeRabbit approved code from an offline sample.

### AI Development Guidance

Read `docs/RESEARCH.md`, C1/C3 and Task 5.1. Ask only for the prerequisite needed by the selected lane and use secure credential entry, never chat-pasted secrets.

## F6: Teaching console, recordings and article

### Metadata

- **ID:** REQ-LAB-006
- **Classification:** Documentation
- **Priority:** High
- **Status:** Approved scope
- **Author / Last Updated / Version:** Specification author / 2026-10-28 / 1.0.0

### Problem Statement

The repository should teach a transferable mental model, not require readers to infer it from infrastructure logs. Public materials must remain personal, synthetic and honest about the state of the experiment.

### Evidence

The owner asked for an open-source repo, visible test cases, recordings, mental models and article-style material, then explicitly excluded corporate branding.

### Impact Analysis

C5 feeds the console, report, recording overlays and article claims. Every public outcome claim MUST trace to a run ID or remain labeled as planned/illustrative.

### Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| F6-R1 | The console MUST show request, selected layers, observed state, assertions and limitations without impersonating an official vendor interface. | High |
| F6-R2 | The repository MUST include a mental model, casebook, setup guide, claim ledger, recording runbook and article. | High |
| F6-R3 | Recording automation MUST capture a happy path and a meaningful failure, bind them to the same tested revision, and exclude secrets. | High |
| F6-R4 | Article and recordings MUST distinguish sourced product facts, design assumptions, measured results and unknowns. | Critical |
| F6-R5 | Public assets MUST use neutral personal-project identity and synthetic examples only; publication MUST remain separately approved. | Critical |
| F6-R6 | The implementation MUST produce five actual application screenshots, three animated GIFs and three static posters, as specified in `docs/README_MEDIA_SPEC.md`. | High |
| F6-R7 | The root README MUST embed the captures using relative paths, meaningful alt text, captions and static GIF fallbacks; capture and rebuild commands MUST be reproducible. | High |
| F6-R8 | A media manifest MUST bind every asset to executed run evidence, tested application revision, source capture and encoding details; mockups and fabricated outcomes MUST NOT substitute. | Critical |
| F6-R9 | Local media integrity and rendered README checks MUST pass before local completion; actual GitHub rendering MUST be checked only with authorized repository access, and MUST remain NOT_RUN until then. | Critical |

### Technical Specification

Use a small Vite vanilla-TypeScript frontend served by the local app. Provide a scenario picker, Slack transcript view, layer map, before/after state, assertion table and run details. Read-only evidence views MUST not expose auth records or simulator secrets.

Playwright captures the teaching console; terminal capture may use a pinned recorder or a plain timestamped transcript. Video format depends on the available renderer, but source recording, captions/transcript and artifact hashes must be retained. Generated speech is optional, not required.

`docs/README_MEDIA_SPEC.md` is the normative capture contract: five PNG screenshots, three animated GIFs, three poster PNGs, `docs/assets/media-manifest.json` and reproducible `lab media` / `lab readme` commands. `docs/README_STORYBOARD.md` defines placement in the actual root README. Local media verification is required; GitHub-hosted rendering is a separate authorization-dependent check, not permission to push.

### Acceptance Scenarios

- **F6-A1:** GIVEN a failed required assertion, WHEN the console renders the run, THEN the failure remains visible and no overall success badge appears.
- **F6-A2:** GIVEN a recording export, WHEN the publication scan runs, THEN it contains a revision, run ID, synthetic-data notice and evidence references, with no secret or corporate/customer material.
- **F6-A3:** GIVEN executed local cases, WHEN the media pipeline and README build complete, THEN five screenshots, three animated GIFs and three static posters decode, all eleven required assets have valid provenance, and relative embeds, captions, alt text and local rendered layout pass.
- **F6-A4:** GIVEN a missing screenshot, single-frame GIF, stale capture or broken README path, WHEN media verification runs, THEN the affected gate fails and completion remains blocked without deleting or weakening the requirement.
- **F6-A5:** GIVEN complete local media but no authorized published repository, WHEN README verification runs, THEN local status remains separately reported, GitHub rendering is NOT_RUN, and no repository is created or pushed.

### Edge Cases

| Case | Expected |
|---|---|
| No screen recorder or GIF encoder | Provide approved local capture/encoding path or BLOCKED; required media remains incomplete |
| No audio | Silent demo plus captions is acceptable |
| Optional service unavailable | Show BLOCKED clearly; do not splice in a passing fixture |

### Test Strategy

Browser assertions verify visible status and accessibility; artifact checks verify run binding; manual review verifies readability, voice and redaction. Do not label unreviewed output “publication ready”.

F6-A3/A4 must inspect actual decoded media, manifest hashes and rendered image nodes rather than accepting file extensions or a self-reported success. F6-A5 must distinguish local preview from GitHub-hosted verification and assert zero unauthorized publication actions.

### What This Is NOT

A vendor endorsement, an official product client, a hosted multi-user service or a fabricated experiment retrospective.

### Anti-Patterns

MUST NOT invent measurements, show a staged failure as a vendor defect, include corporate branding, or publish during implementation.

### AI Development Guidance

Read `writing/ARTICLE_DRAFT.md`, `docs/README_MEDIA_SPEC.md`, `docs/README_STORYBOARD.md`, recording/publication guides and Task 6.1. Keep the article in pre-results form until measured evidence exists; do not stop at a bare README without the required real captures.

## Non-Functional Requirements

### Performance

The lab SHOULD be practical on an ordinary developer laptop. Task 1.1 MUST record tested OS/architecture, CPU/RAM and cold versus warm setup; no unmeasured hardware or latency promise is made. Run each happy workflow five times for repeatability, report all outcomes, and avoid inferential benchmark claims from that sample.

### Security

Endpoint/identity denial cases MUST have zero unauthorized side effects. Secrets MUST be excluded from exported artifacts. Generated test secrets are local-only and MUST not be presented as production credentials.

### Observability

Every transition MUST carry run ID, tenant, request/action ID and source revision. Logs MUST distinguish receipt creation, request completion, remote uncertainty and cleanup.

### Backward Compatibility

No existing external consumers are changed. Future incompatible contract changes require a schema-version increment and updates to all C1–C5 consumers.

## Null Handling Contract

| Field | Missing / null / empty | Zero | Unknown / out-of-range |
|---|---|---|---|
| run_id, profile, tenant_id, actor_id, event_id | Reject; never infer identity | Invalid type | Reject unsupported value |
| thread_ts | Use root message timestamp if independently known; otherwise reject reply action | Invalid timestamp | Reject |
| expected_version | Reject write; read-only inspection remains allowed | Valid only if fixture defines initial version 0 | Conflict or invalid input, no write |
| amount_cents | Reject approval request | Explicitly allowed zero-value demonstration if fixture declares it | Negative/over configured maximum rejected, not clamped into approval |
| optional connection | BLOCKED when selected; SKIPPED when not selected | Invalid type | Reject |
| measured duration/cost | Null plus reason; exclude from numerical summaries | Valid if actually measured | Invalid/nonfinite value rejected |
| assertion observed value | UNKNOWN if evidence missing; never impute success or zero | Valid observation | Preserve typed observation or schema error |
| evidence_refs | Empty only for NOT_RUN/BLOCKED with reason | Invalid type | Missing file invalidates claimed PASS |

No scoring neutrality rule may grant authorization or convert absent evidence into proof.
