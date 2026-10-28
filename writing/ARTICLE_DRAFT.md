# The Agent Ran. What Did That Prove?

> **Draft status: unreviewed, not authorized for publication.** Every result below is tied to a run ID in [`docs/CLAIM_LEDGER.md`](../docs/CLAIM_LEDGER.md). Anything not in that ledger is marked planned or unknown.

An agent demo usually ends with a green check and a friendly message: "Your request is complete." I wanted to know what that check had actually established. So I built a small lab that splits it into four questions and answers each one separately:

1. **Did it run?** A process started and finished.
2. **Did it run against something realistic?** The systems it called were emulated, and emulated is not the same as real.
3. **Was it allowed?** Authority is a separate decision from whether the code ran.
4. **Did the outcome happen?** Someone other than the agent checked the state.

These are four different claims. A demo that answers the first one is often presented as if it answered all four.

<!-- media: lab-overview -->

## The setup

Everything here is synthetic: fictional companies, fictional users, fake credentials. It all runs on a laptop.

- **Slack** is [Emulate](https://emulate.dev/docs/slack) 0.12.3, two fictional workspaces, with strict scope checks and signed callbacks.
- **Cloud storage and a queue** come from [Floci](https://floci.io/) 2.3.0, pinned by image digest. The lab uses only its S3 and SQS.
- **A ledger** is a SQLite file. It holds the inbox, outbox, tickets, approvals and a narrow CRM stand-in.
- **The worker** is a scripted program, not a model. Each run is labelled `mode: scripted`. A deterministic worker lets the lab test integration, authorization and evidence without mixing in model behavior.

There are three workflows. W01 is a service request: a Slack mention becomes a queued job, a ticket, a receipt in S3 and a reply in the thread. W02 is a purchase approval that a second, authorized person has to click. W03 is a CRM description update with a version check.

## Running is not verifying

The worker can say "done". In this lab that statement is one observation among several, never the verdict.

A separate collector process reads the outcome. It has its own Slack token, which can only read conversations. It has its own S3 client and opens the ledger read-only. It never talks to the worker. For W01 it checks three stores: is there exactly one ticket, does the S3 receipt match the request, and is there exactly one completion reply in the original thread? Those facts go into an observation bundle, and an evaluator compares them with expectations fixed in the specification.

The case that matters is the one where they disagree. In one test the receipt is deleted after the worker has committed it, and the worker still claims success. The required assertion fails, and the report shows no success banner (C-08).

<!-- media: service-request-success -->
<!-- media: evidence-report -->

A rule from the specification turned out to be harder to keep than to state: **missing evidence is not zero.** If the collector cannot read the ledger, it does not know which receipt to look for. An early version recorded `receipt_count: 0` anyway, which reads as "no receipt". The test for the unreadable-ledger case caught it. The fact is now absent with a reason, and the report says UNKNOWN (L-021).

## Emulated is not real, in specific ways

An emulator is useful when you can say exactly which question it answers. Emulate answered mine: signed event callbacks, thread replies, button clicks, strict scopes, an explicit retry simulator. It also has documented gaps, including Socket Mode, slash commands and exact rate limiting (C-36). None of the lab's claims depend on those.

The surprises came from where the documentation and the behavior differed:

- Seeding an app with an event subscription through the public API did not deliver any callbacks. The seeder drops the dispatcher that delivers them. The lab carries a small, hash-checked patch for that one file and says so in its dependency lock (L-001).
- Every emulated workspace reports the same `team_id`. Tenancy therefore cannot be keyed on it; the lab binds each tenant to its callback URL and signing secret (L-013).
- The simulator routes that fake a button click accept **any** valid token, including the worker's own bot token. An independent reviewer used exactly that to forge an approval (L-019).

The last finding changed the design. The worker no longer gets an emulator URL at all. It gets a loopback proxy that forwards one Slack method and refuses everything else. That fixes the worker's path, not the emulator. Anyone who knows an emulator URL and holds any valid token can still simulate clicks. The boundary is process separation, and the ledger says so (C-16).

The same discipline applies to the CRM. W03 runs against a local contract double that is good for version conflicts and input validation (C-07). It is not Salesforce. The Salesforce lane is designed and blocked, and parity is reported as UNKNOWN rather than implied (C-09, C-32).

## Authorized is not the same as delivered through Slack

A button click arriving through a signed Slack callback proves where the click came from. It does not prove the clicker may approve. In W02 the policy checks the current actor, the tenant and a digest of the request at the moment of the click.

The lab's results for the denied paths, all with zero writes:

- the requester clicking their own approval (C-06);
- a user without approval rights (C-06);
- a button copied into the other workspace (C-14);
- an approver whose permission was revoked before the click (C-14).

<!-- media: approval-denied -->

Duplicate delivery is part of the same question. A signed retry of the same event creates no second ticket and no second reply (C-04). If a reply is sent and the response never comes back, the outcome is recorded as UNKNOWN and never re-posted. With least-privilege scopes the worker cannot read history to check, so the lab trades reconcilability for privilege and says so (L-017).

<!-- media: duplicate-event-safe -->

## Tests that cannot fail

The most useful lessons came from tests that passed for the wrong reason.

The optional lanes (Salesforce, CodeRabbit, AX, a live model) are supposed to report BLOCKED until their owner approves them. They did. But the profile loader looked for a named export while every adapter used a default export, so each lane reported "adapter not installed". BLOCKED was right and the reason was wrong. The check now refuses that placeholder as evidence (L-020).

Regenerating a report also rewrote its checksum file, which would have quietly re-approved an edited evidence file. Report generation now verifies the old checksums first and refuses on a mismatch (L-022).

Four deliberate mutants target the defects the lab exists to catch: deduplication off, approval bypassed, reply sent before the receipt, missing evidence turned into success. All four were caught on the tested tree (C-15). That is a count for four probes, not a claim that nothing else is wrong.

Two failures appeared only after merging. Each branch had passed its own gates. Together, the new Slack proxy sat in front of a forbidden endpoint and hid it from the worker's guard. Separately, a restarted worker collided with the ports of its crashed predecessor. Only the full harness on the merged tree caught them (L-025, L-026). Both were fixed before the runs this article cites.

## What it costs to run

Measured on one laptop (macOS arm64, 18 cores) with other workloads running, n=5 per workflow, raw values in [`docs/BENCHMARKS.md`](../docs/BENCHMARKS.md):

| Workflow | Callback to verified, 5 repetitions | Median |
|---|---|---|
| W01 service request | 71, 19, 17, 17, 18 ms | 18 ms |
| W02 approval | 27, 23, 22, 23, 20 ms | 23 ms |
| W03 CRM update | 41, 15, 14, 14, 13 ms | 14 ms |

The clock starts when the worker records the signed callback and stops when the collector first sees the complete final state (C-17 to C-19). The first repetition was the slowest every time. A cold `npm ci` with an empty cache took about 4 seconds here (C-20). The image pull was not measured. One independent observation pass costs a few milliseconds; the whole `collect-case` command takes about 3 seconds, mostly starting and stopping the stack (C-21). The full supplied harness took 260.6 seconds (C-22).

These are descriptive numbers from a small sample on a busy machine. They are not a performance claim about Emulate, Floci or anything else.

## What is not done

- **The console and README media** are being built in a parallel task. In the run cited here, their cases were NOT_RUN, so the harness verdict is BLOCKED rather than ready (C-30).
- **AX on Agent Substrate** is designed and blocked. The custom runner passed its contract tests under plain Docker, which says nothing about gVisor. AX does not read the agent command's exit status back, so in the design the collector, not the task phase, decides the outcome (C-31, C-37).
- **Salesforce, CodeRabbit and a live model** are blocked on accounts and approvals the owner has not given (C-32 to C-34).
- **Egress counting** for the optional lanes relies on shims for provider command-line tools. Routing Node's own traffic through the counting proxy is unproven (L-023).
- **Blind holdouts** have not been run. The public challenge cases are reproducible, not secret (C-35).

<!-- media: profile-boundaries -->

## Reproduce it

You need Node 24 and Docker. On the test machine, `npm ci` took about 4 seconds and the full harness about 4 to 6 minutes.

```bash
npm ci
docker pull floci/floci:2.3.0
npm run lab -- doctor
bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh
npm run mutate
npm run bench
```

Your run produces new run IDs. Compare observations and statuses with the claim ledger, not the IDs. If yours differ, that is a finding, and the ledger is where it belongs.

<!-- media: slack-service-request -->

The standard I wanted is modest and checkable: someone else can inspect the request, follow the action, challenge the result and rerun the case.
