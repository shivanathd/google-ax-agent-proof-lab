# Research and Assumption Register

Reviewed 28 October 2026. This is documentation-level evidence with targeted prior AX source review, not a compatibility test of this proposed lab. The coding agent must verify and pin the exact dependencies before implementing adapters.

| Topic | Supported fact | Implementation check / limit |
|---|---|---|
| Emulate lifecycle | Programmatic creation, reset and close are documented ([API](https://emulate.dev/docs/programmatic-api)). | Verify installed package export/types and reset behavior; no assumed version compatibility. |
| Slack | Threads, signed events, button interactions, strict-scope option and explicit retry simulator are documented ([Slack](https://emulate.dev/docs/slack)). | Use strict mode; verify exact seed shape and independent state queries. |
| Slack gaps | Socket Mode, slash commands, exact rate limiting and several enterprise surfaces are listed as unsupported ([limits](https://emulate.dev/docs/slack)). | No claim of full Slack fidelity or transport parity. |
| Signature verification | Slack specifies raw request bytes, HMAC-SHA256 and timestamp freshness checks ([Slack verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)). | Use constant-time comparison; reject stale requests before queueing. |
| Floci | Local cloud emulators and S3/SQS use cases are documented; container runtime required ([Floci](https://floci.io/)). | Pin image digest, verify needed calls; do not repeat unmeasured performance or parity claims. |
| Salesforce | Scratch orgs are disposable code/metadata deployments with expiry and allocation limits ([DX](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs.html)). | Test actual features/personas; do not assume customer configuration. |
| Org fidelity | Scratch orgs and sandboxes serve different uses ([Salesforce org guide](https://developer.salesforce.com/blogs/2024/05/choose-the-right-salesforce-org-for-the-right-job)). | Separate application contract, platform behavior and customer configuration evidence. |
| CodeRabbit | PR review and local IDE/CLI review workflows are documented ([review](https://docs.coderabbit.ai/guides/code-review-overview), [local review](https://docs.coderabbit.ai/overview/ide-cli-review)). | Requires actual approved access for a live claim; offline examples are fixtures only. |
| AX | Custom images must implement a runner contract; running readiness is not equivalent to agent exit success ([runner](https://github.com/google/ax/blob/main/docs/runner.md)). | Verify AX/Substrate version pair, command status, termination and resume behavior. |
| AX maturity | Heavy development and likely breaking changes are disclosed ([README](https://github.com/google/ax)). | Optional research profile, not dependency of basic teaching experience. |
| LocalStack | AWS local emulation and Kubernetes-specific limitations are documented ([AWS](https://docs.localstack.cloud/aws/getting-started/), [Kubernetes](https://docs.localstack.cloud/aws/customization/kubernetes/)). | Comparison candidate only; no need to run beside Floci by default. |
| WireMock | Stateful stubs and fault injection are documented ([overview](https://wiremock.org/docs/overview/)). | Useful for controlled faults, not provider parity proof. |
| Testcontainers | Disposable real dependencies are documented ([getting started](https://testcontainers.com/getting-started/)). | Add only if the case needs an actual database/broker beyond SQLite. |
| Playwright | Browser testing, assertions and isolation are documented ([intro](https://playwright.dev/docs/intro)). | Browser-visible state remains supplementary to backend assertions. |
| Security mapping | NIST provides a control catalog, not certification of this lab ([NIST](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)). | Design alignment only. |

## Evidence labels

Use DOCUMENTED for a sourced product capability, DESIGNED for a proposed mechanism, EXECUTED for an actual test with artifacts, and UNKNOWN for missing proof. A source citation cannot turn a planned integration into an executed one.

## Claim ledger template

Each future public claim must contain `claim_id`, wording, evidence label, source URL or run ID, tested revision, profile, scope, limitations and reviewer status. Do not auto-fill result claims from the expected values in the tests.
