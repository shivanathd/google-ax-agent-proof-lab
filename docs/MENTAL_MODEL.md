# Five Questions Before You Trust an Agent Demo

An agent can run successfully and still do the wrong thing. This lab separates the questions that are often collapsed into one green checkmark.

## The mental map

```text
What business outcome do we want?
  |
  +-- Where does the work run?
  |     Local process now; optional AX execution later
  |
  +-- What systems does it interact with?
  |     Emulate Slack; Floci S3/SQS; narrow local CRM double
  |     Optional actual Salesforce scratch org
  |
  +-- Is the action allowed?
  |     Trusted identity + deterministic policy + current approval
  |
  +-- Did the code and behavior meet the requirement?
  |     Code review + independent state assertions + challenge cases
  |
  +-- What can we honestly claim?
        Run-bound evidence + limitations + reproducible instructions
```

This map describes the proposed lab, not a deployed system. The interactive architecture view is a second way to explore the same responsibilities.

## Execution is one layer

AX supplies infrastructure for agent-task execution on Agent Substrate; its custom runner has a defined lifecycle contract ([AX](https://github.com/google/ax/blob/main/docs/runner.md)). In this lab, AX is an optional place to run an existing task, not the authority that decides whether its business result is correct.

The base lane runs a deterministic scripted worker. That lets the reader learn about integration, authorization and evidence without confusing those behaviors with model quality.

## An emulator gives the workflow something to interact with

Emulate supplies stateful Slack behavior, including messages, threads, signed callbacks and selected interactions ([Emulate Slack](https://emulate.dev/docs/slack)). Floci supplies local cloud-shaped services; this lab deliberately uses only S3 and SQS in its baseline ([Floci](https://floci.io/)).

A useful emulator test asks whether the application handles a specific supported interaction. It does not establish complete provider fidelity, real-world quota behavior or every production permission boundary.

## A real test environment answers different questions

A Salesforce scratch org is an actual source-driven Salesforce deployment, not a local response stub ([Salesforce DX](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs.html)). The local CRM double in this lab exists only to exercise its small action contract; the scratch-org lane is where platform-specific claims become testable.

Use the same business assertion in both lanes, but disclose what differs. “The account description changed under this test persona” is a narrower and more useful claim than “Salesforce integration works.”

## Review and runtime evidence are complementary

CodeRabbit reviews code changes and can support a review lane; that does not make it the business-outcome oracle ([CodeRabbit](https://docs.coderabbit.ai/guides/code-review-overview)). The lab's evaluator separately asks whether the ticket exists, whether the receipt matches, whether the right thread received the reply and whether a forbidden action left state unchanged.

Keep both kinds of evidence. A reviewer may identify a bug the current tests miss, while a test may expose behavior a reviewer did not predict.

## Known, failed and unknown are different

The console should show what was attempted, what was observed and what could not be established. A blocked Salesforce profile is not a failed local demo, but it is also not evidence of Salesforce parity.

The same discipline applies to recordings. A clean clip can explain a test; only the associated run record can show the input, revision, assertions and limitations behind it.
