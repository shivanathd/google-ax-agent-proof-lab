# Agent Proof Lab

A local-first lab for testing Slack-led agent workflows against emulated Slack, local S3/SQS and a small ledger. It keeps four questions apart that a single green checkmark tends to blur: where the work runs (execution), what it talks to (emulation), what it is allowed to do (authorization) and what an independent collector can prove happened (evidence).

Everything below runs on one laptop with fictional workspaces, people and records. No Slack workspace, cloud account, CRM org or model key is needed for the local core.

<!-- BEGIN LAB MEDIA: overview -->
<!-- END LAB MEDIA: overview -->

> **Synthetic data only.** Every workspace, person, company and record in the screenshots is fictional and lives in local emulators. The console labels its transcript "Emulated Slack (local Emulate instance)": it is not the Slack client and has no Slack branding.

## See a workflow

A Slack mention reaches the scripted worker as a signed Events API callback. The worker queues a job in SQS, writes one ticket, stores a receipt object in S3 and replies in the original thread. A separate collector process then reads the emulator (reader token), S3 (its own credentials) and the ledger (read-only handle) and writes the C5 report that the console displays.

<!-- BEGIN LAB MEDIA: workflow -->
<!-- END LAB MEDIA: workflow -->

## Understand the layers

This table and diagram describe the architecture; they are not execution evidence.

| Layer | Local core (always on) | Opt-in lane (blocked until separately authorized) |
|---|---|---|
| Execution | Deterministic scripted worker process | AX runner on Agent Substrate; live-model planner with a spend cap |
| Emulation | Emulate Slack (signed callbacks, Web API, button simulations), Floci S3 + SQS, SQLite ledger, a narrow local CRM double | A real Salesforce scratch org |
| Authorization | Trusted identity from the event, deterministic policy, current grants, approval digest + expiry | Provider-side permissions in the real org |
| Evidence | Independent collector: reader token, own S3/SQS credentials, read-only SQLite; C5 report with hashes | CodeRabbit review lane (code review, not an outcome oracle) |

```text
What business outcome do we want?
  +-- Where does the work run?            local scripted worker (optional AX later)
  +-- What systems does it interact with?  Emulate Slack; Floci S3/SQS; local CRM double
  +-- Is the action allowed?              trusted identity + deterministic policy + current approval
  +-- Did it meet the requirement?        independent state assertions + public challenge cases
  +-- What can we honestly claim?         run-bound evidence + limitations
```

The longer explanation is in [the mental model](docs/MENTAL_MODEL.md).

## Try it

Tested on macOS 27 (arm64) with Node.js 24.22, npm 11.19 and Docker Desktop 29.9; other platforms are untested ([environment](docs/ENVIRONMENT.md)). Media capture additionally needs FFmpeg 6 and Playwright's Chromium.

```bash
npm ci                                   # also applies the pinned Emulate patch
docker pull floci/floci:2.3.0@sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9
npm run lab -- doctor                    # local prerequisites; optional lanes show BLOCKED
npm run lab -- up --profile local        # prints run_id and console_url (loopback only)
```

Open the printed `console_url`, pick a scenario and run it: each console run starts its own isolated stack and is judged by the independent collector. From another terminal you can also post a scripted stimulus into the `up` stack and then remove only that run's resources:

```bash
npm run lab -- run --run-id <run_id> --case W01-H
npm run lab -- down --run-id <run_id>    # cleanup_status CLEAN
```

To collect one supplied evaluator case end to end, or run all local gates:

```bash
npm run lab -- collect-case --case F3-A1 --output "$PWD/private-runs/manual/F3-A1.json"
bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh
```

Salesforce, CodeRabbit, AX and live-model lanes are optional and stay BLOCKED until their prerequisites and the owner's approval exist ([profiles](docs/PROFILES.md)).

## Watch the boundaries hold

Two challenges, each checked by the collector rather than by the worker's own reply. The duplicate case covers one bounded idempotency case (a signed retry of the same event), not "exactly once everywhere".

<!-- BEGIN LAB MEDIA: boundaries -->
<!-- END LAB MEDIA: boundaries -->

## Inspect the evidence

The console's evidence view is the C5 `report.json` as written: expected and observed values, status and the evidence file behind every assertion, plus the run's limitations. Sanitized exports of every run used on this page are committed in [docs/evidence](docs/evidence/README.md).

<!-- BEGIN LAB MEDIA: evidence -->
<!-- END LAB MEDIA: evidence -->

## Understand what remains unverified

<!-- BEGIN LAB MEDIA: profiles -->
<!-- END LAB MEDIA: profiles -->

A local CRM double cannot show Salesforce behaviour, and a passing local run is not evidence of real Slack transport, cloud IAM or an unexecuted code review. Those lanes report BLOCKED with their missing prerequisites, and Salesforce parity stays UNKNOWN. The GitHub-rendered view of this README has not been checked (NOT_RUN) because nothing has been published.

## Short clips

<!-- BEGIN LAB MEDIA: videos -->
<!-- END LAB MEDIA: videos -->

## Explore and reproduce

- [Use-case casebook](docs/CASEBOOK.md) and [public challenge scenarios](docs/spec/active/2026-10-28-agent-proof-lab/SCENARIOS.md)
- [Reproducing the media and evidence](docs/REPRODUCING.md) and [recordings](recordings/README.md)
- [Recording runbook](docs/RECORDING_RUNBOOK.md), [README media contract](docs/README_MEDIA_SPEC.md), [storyboard](docs/README_STORYBOARD.md)
- [Learnings: expected vs observed](docs/LEARNINGS.md) and [research register](docs/RESEARCH.md)
- [Article draft (pre-results)](writing/ARTICLE_DRAFT.md)
- [Build specification](docs/spec/active/2026-10-28-agent-proof-lab/REQUIREMENTS.md), [implementation plan](docs/spec/active/2026-10-28-agent-proof-lab/IMPLEMENTATION_PLAN.md), [decisions](docs/spec/active/2026-10-28-agent-proof-lab/DECISIONS.md) and the [supplied evaluator](docs/spec/active/2026-10-28-agent-proof-lab/evals/README.md)
- [Publication checklist](docs/PUBLICATION_CHECKLIST.md)

This is a personal educational project. The license and contribution terms are pending the owner's review; repository publication, provider-app installation and any upload need separate approval.
