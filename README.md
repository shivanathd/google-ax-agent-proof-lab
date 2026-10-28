# Agent Proof Lab

A build specification and publishing kit for a personal, open-source lab. The lab teaches how agent execution, emulated dependencies, real test environments, code review and independent verification fit together.

**Status: specification package v1.1.0, not a working application.** Local-first scope and cross-industry examples are approved. Emulated Slack is central; Salesforce, CodeRabbit, live-model execution and AX are opt-in profiles. Real screenshots, animated GIFs and a populated visual GitHub README are required build deliverables; no integrations or business-workflow captures have been run by preparing this package.

## Start here

Give your coding agent this entire folder and paste the prompt in [AGENT_KICKOFF.md](AGENT_KICKOFF.md). The agent should commit the specification first, implement the local core in a separate commit, and return proof rather than publish anything automatically.

| Read | Purpose |
|---|---|
| [Build specification](docs/spec/active/2026-10-28-agent-proof-lab/REQUIREMENTS.md) | Requirements, safety boundaries, acceptance criteria and null contracts |
| [Implementation plan](docs/spec/active/2026-10-28-agent-proof-lab/IMPLEMENTATION_PLAN.md) | Six bounded implementation tasks with verification commands |
| [Scenario validation](docs/spec/active/2026-10-28-agent-proof-lab/SCENARIOS.md) | End-to-end challenge scenarios and the honest limits of public holdouts |
| [Architecture decisions](docs/spec/active/2026-10-28-agent-proof-lab/DECISIONS.md) | Defaults, alternatives and reasons |
| [Mental model](docs/MENTAL_MODEL.md) | What each layer proves, and what it does not |
| [Use-case casebook](docs/CASEBOOK.md) | Synthetic workflows, test inventory and extensions |
| [Recording runbook](docs/RECORDING_RUNBOOK.md) | Capture sequence, narration and evidence binding |
| [README media contract](docs/README_MEDIA_SPEC.md) | Required screenshots, GIFs, static posters, capture commands and render gates |
| [README storyboard](docs/README_STORYBOARD.md) | Placement, captions, relative embeds and generated-section ownership |
| [Article draft](writing/ARTICLE_DRAFT.md) | Publishable-in-principle explanation, explicitly pre-results |
| [Research register](docs/RESEARCH.md) | First-party evidence, limitations and implementation checks |
| [Publication checklist](docs/PUBLICATION_CHECKLIST.md) | Personal branding, licensing, disclosure and publish approval |
| [Verification guide](docs/spec/active/2026-10-28-agent-proof-lab/evals/README.md) | What the supplied executable evaluators do and do not prove |

## What the future repository should demonstrate

- **Service desk:** A Slack mention produces a queued service request, durable record, object-storage receipt and correct thread reply.
- **Operations approval:** A Slack request waits for an authorized second person; a forged or stale approval cannot change its state.
- **CRM update:** A Slack request changes a synthetic account description through a small local contract double, then the same semantic checks run against an explicitly authorized scratch org when available.

Floci supplies the core's S3/SQS-shaped dependencies. Emulate supplies Slack. SQLite supplies the application ledger. Other tools are added only when their role is needed, not to inflate the stack.

## Reproducibility lanes

**Fixture replay** teaches the workflow without claiming AI reasoning. **Local integration execution** runs actual emulator processes and verifies their observed state. **Opt-in live profiles** exercise specific external integrations and report missing prerequisites honestly.

The future repository MUST show `PASS`, `FAIL`, `BLOCKED`, `SKIPPED`, `NOT_RUN` and `UNKNOWN` separately. A successful local run is not evidence of real Slack transport, production cloud IAM, Salesforce customer configuration or an unexecuted CodeRabbit review.

## Package checks

Run `python3 tools/validate_package.py` to validate the specification bundle. Run `bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh` to attempt the future application gates; on this spec-only package, they must report blocked rather than success.

The working name is provisional. Repository creation, final license selection, public upload, provider-app authorization and any paid resources require the owner's separate approval.
