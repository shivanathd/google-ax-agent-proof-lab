# The Agent Ran. What Did That Prove?

> **Draft status: unreviewed, not authorized for publication.** Every result below is tied to a run ID in [`docs/CLAIM_LEDGER.md`](../docs/CLAIM_LEDGER.md). Anything not in that ledger is marked planned or unknown.

An agent demo usually ends with a green check and a friendly message: "Your request is complete." I wanted to know what that check had actually established. So I built a small lab that splits it into four questions and answers each one separately:

1. **Did it run?** A process started and finished.
2. **Did it run against something realistic?** The systems it called were emulated, and emulated is not the same as real.
3. **Was it allowed?** Authority is a separate decision from whether the code ran.
4. **Did the outcome happen?** Someone other than the agent checked the state.

These are four different claims. A demo that answers the first one is often presented as if it answered all four.

<!-- media: lab-overview (run a440ab5c, W02-H; C-40) -->

## The setup

Everything here is synthetic: fictional companies, fictional users, fake credentials. It all runs on a laptop.

- **Slack** is [Emulate](https://emulate.dev/docs/slack) 0.12.3, two fictional workspaces, with strict scope checks and signed callbacks.
- **Cloud storage and a queue** come from [Floci](https://floci.io/) 2.3.0, pinned by image digest. The lab uses only its S3 and SQS.
- **A ledger** is a SQLite file. It holds the inbox, outbox, tickets, approvals and a narrow CRM stand-in.
- **The worker** is a scripted program, not a model. Each run is labelled `mode: scripted`. A deterministic worker lets the lab test integration, authorization and evidence without mixing in model behavior.

There are three workflows. W01 is a service request: a Slack mention becomes a queued job, a ticket, a receipt in S3 and a reply in the thread. W02 is a purchase approval that a second, authorized person has to click. W03 is a CRM description update with a version check.

## Running is not verifying

The worker can say "done". In this lab that statement is one observation among several, never the verdict.

A separate collector process reads the outcome. It has its own Slack token, which can only read conversations. It has its own S3 client and opens the ledger read-only. (Its separate S3 key turned out to be a label, not a lock: Floci does not check credentials, L-037. What actually keeps the two apart is that they are separate processes.) It never talks to the worker. For W01 it checks three stores: is there exactly one ticket, does the S3 receipt match the request, and is there exactly one completion reply in the original thread? Those facts go into an observation bundle, and an evaluator compares them with expectations fixed in the specification.

The case that matters is the one where they disagree. In one test the receipt is deleted after the worker has committed it, and the worker still claims success. The required assertion fails, and the report shows no success banner (C-08). The console shows the same failure without a success badge (C-30).

<!-- media: service-request-success (run 61359d45, W01-H; C-41) -->
<!-- media: evidence-report (run 61359d45; C-41) -->
<!-- media: clip-mental-model (runs 81c6744f W01-H PASS and 7085c56e W01-F FAIL; C-44) -->

A rule from the specification turned out to be harder to keep than to state: **missing evidence is not zero.** If the collector cannot read the ledger, it does not know which receipt to look for. An early version recorded `receipt_count: 0` anyway, which reads as "no receipt". The test for the unreadable-ledger case caught it. The fact is now absent with a reason, and the report says UNKNOWN (L-021).

## Emulated is not real, in specific ways

An emulator is useful when you can say exactly which question it answers. Emulate answered mine: signed event callbacks, thread replies, button clicks, strict scopes, an explicit retry simulator. It also has documented gaps, including Socket Mode, slash commands and exact rate limiting (C-56). None of the lab's claims depend on those.

The surprises came from where the documentation and the behavior differed:

- Seeding an app with an event subscription through the public API did not deliver any callbacks. The seeder drops the dispatcher that delivers them. The lab carries a small, hash-checked patch for that one file and says so in its dependency lock (L-001).
- Every emulated workspace reports the same `team_id`. Tenancy therefore cannot be keyed on it; the lab binds each tenant to its callback URL and signing secret (L-013).
- The simulator routes that fake a button click accept **any** valid token, including the worker's own bot token. An independent reviewer used exactly that to forge an approval (L-019).

The last finding changed the design. The worker no longer gets an emulator URL at all. It gets a loopback proxy that forwards one Slack method and refuses everything else. That fixes the worker's path, not the emulator. Anyone who knows an emulator URL and holds any valid token can still simulate clicks. The boundary is process separation, and the ledger says so (C-16).

The same discipline applies to the CRM. W03 runs against a local contract double that is good for version conflicts and input validation (C-07). It is not Salesforce. The Salesforce lane is designed and blocked, and parity is reported as UNKNOWN rather than implied (C-09, C-51).

<!-- media: clip-emulator-vs-real-org (run 13c84cec, W03-V; C-45) -->

## Authorized is not the same as delivered through Slack

A button click arriving through a signed Slack callback proves where the click came from. It does not prove the clicker may approve. In W02 the policy checks the current actor, the tenant and a digest of the request at the moment of the click.

The lab's results for the denied paths, all with zero writes:

- the requester clicking their own approval (C-06);
- a user without approval rights (C-06);
- a button copied into the other workspace (C-14);
- an approver whose permission was revoked before the click (C-14).

<!-- media: approval-denied (run 4bdbf285, W02-U; C-43) -->
<!-- media: approval-denied-gif (run 4bdbf285; C-43) -->
<!-- media: clip-permission-boundary (run 4bdbf285; C-43) -->

Duplicate delivery is part of the same question. A signed retry of the same event creates no second ticket and no second reply (C-04). If a reply is sent and the response never comes back, the outcome is recorded as UNKNOWN and never re-posted. With least-privilege scopes the worker cannot read history to check, so the lab trades reconcilability for privilege and says so (L-017).

<!-- media: duplicate-event-safe (run 7d241b93, W01-D; C-42) -->
<!-- media: clip-duplicate-delivery (run 7d241b93; C-42) -->

## Tests that cannot fail

The most useful lessons came from tests that passed for the wrong reason.

The optional lanes (Salesforce, CodeRabbit, AX, a live model) are supposed to report BLOCKED until their owner approves them and configures them. They did. But the profile loader looked for a named export while every adapter used a default export, so each lane reported "adapter not installed". BLOCKED was right and the reason was wrong. The check now refuses that placeholder as evidence (L-020).

Regenerating a report also rewrote its checksum file, which would have quietly re-approved an edited evidence file. Report generation now verifies the old checksums first and refuses on a mismatch (L-022).

Four deliberate mutants target the defects the lab exists to catch: deduplication off, approval bypassed, reply sent before the receipt, missing evidence turned into success. All four were caught on the tested tree (C-15). That is a count for four probes, not a claim that nothing else is wrong.

Two failures appeared only after merging. Each branch had passed its own gates. Together, the new Slack proxy sat in front of a forbidden endpoint and hid it from the worker's guard. Separately, a restarted worker collided with the ports of its crashed predecessor. Only the full harness on the merged tree caught them (L-025, L-026). Both were fixed before the runs this article cites.

A blind suite found what the visible one missed. A separate agent that had never seen the builders' tests wrote 15 extra scenarios and timestamped their expectations before running them against a frozen tree. Thirteen passed and two failed (C-54). A zero-cent purchase request was accepted because the input schema allowed zero; that is fixed now, and re-running it is a regression check, not a blind result (L-027). A payload claiming the other workspace's team, signed with this workspace's secret, was accepted at the door and only denied later by policy, because both emulated workspaces report the same team ID (L-028). That one is disclosed rather than changed. These were blind to the builder agents, not to the orchestrator who set them.

## Running somewhere else: AX on Agent Substrate

The optional AX lane runs the same W01 case as an AX task in a gVisor sandbox on Agent Substrate. It took three attempts. The first stopped because the AX control plane and the installed Substrate disagreed on the wire format (L-030). The second stopped on missing IAM prerequisites for upgrading Substrate (L-043). The third reinstalled Substrate at v0.6.0 with the owner's approval and ran the tests. Everything below comes from that one cluster, one worker and gVisor, and is recorded per assertion in `profiles/ax/RESULTS.md`.

What passed:

- W01 ran as an AX task and passed the same four assertions as the local lane, judged by a collector Pod with its own token and certificate (C-60).
- A command that exited 3 was still reported by AX as `Running`. That is what the AX docs say to expect, and it is why the lane never treats the task phase as an outcome (C-61, C-57).
- From inside the sandbox, metadata, public hosts, the cluster and control-plane APIs and an unlisted emulator port were all unreachable (C-67). The router refused a client without a certificate (C-68).
- Resuming after a suspend kept the workspace (C-65).

What failed:

- Neither `ax suspend` nor `ax delete task` delivered SIGTERM to the command, so the runner never recorded an exit (C-62, C-63). Only evicting the worker Pod did (C-64).
- After an eviction, AX treated the actor as crashed and reverted it to its last snapshot, so the result was gone (C-66).

One observation is neither: `ax get task` returns the task's tokens in clear to any AX API caller (C-69).

Timing, n=5: a task reached `Running` about 17 seconds after submit and its result about 20 seconds after (C-70). Most of that is the operator tooling attaching the egress policy and resuming the task. AX's own logs put resume to running at about 2 seconds.

## What it costs to run

Measured on one laptop (macOS arm64, 18 cores) with other workloads running, n=5 per workflow, on a tree from before the console merge and the later emulator and allowlist changes, raw values in [`docs/BENCHMARKS.md`](../docs/BENCHMARKS.md):

| Workflow | Callback to verified, 5 repetitions | Median |
|---|---|---|
| W01 service request | 71, 19, 17, 17, 18 ms | 18 ms |
| W02 approval | 27, 23, 22, 23, 20 ms | 23 ms |
| W03 CRM update | 41, 15, 14, 14, 13 ms | 14 ms |

The clock starts when the worker records the signed callback and stops when the collector first sees the complete final state (C-17 to C-19). The first repetition was the slowest every time. A cold `npm ci` with an empty cache took about 4 seconds here (C-20). The image pull was not measured. One independent observation pass costs a few milliseconds; the whole `collect-case` command takes about 3 seconds, mostly starting and stopping the stack (C-21). The supplied harness took 260.6 seconds before the console cases were added (C-22); the current, longer run was not timed.

These are descriptive numbers from a small sample on a busy machine. They are not a performance claim about Emulate, Floci or anything else.

## What is not done

- **The README media have not had an independent render review.** The console and media cases now run and pass (C-30, C-31, C-33 to C-35), and the media decode with valid provenance. But F6-A3 waits for a reviewer other than the media builder, so the harness verdict is `LOOP`, not ready (C-32). Every capture's manual visual review is pending, and GitHub rendering is NOT_RUN because nothing is published (C-55).
- **AX termination** fails two of its three signal paths and loses state after an eviction (C-62, C-63, C-66). A runner that survives eviction is not built. All AX results come from one cluster.
- **Salesforce, CodeRabbit and a live model** are blocked on accounts and approvals the owner has not given (C-51 to C-53).
- **Egress counting** for the optional lanes relies on shims for provider command-line tools. Routing Node's own traffic through the counting proxy is unproven (L-023).
- **The blind finding BH-03b** (team ID not checked at ingress) is disclosed, not fixed (L-028). The public challenge cases are reproducible, not secret.

<!-- media: profile-boundaries (run 61359d45; C-41) -->

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

<!-- media: slack-service-request (run 61359d45, W01-H; C-41) -->

The standard I wanted is modest and checkable: someone else can inspect the request, follow the action, challenge the result and rerun the case.
