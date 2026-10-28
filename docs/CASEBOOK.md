# Synthetic Use-Case Casebook

All organizations, users and business rules here are fictional teaching fixtures. These are planned cases, not measured results or descriptions of a real customer's system.

## W01: Service desk request

A facilities coordinator mentions LabBot in an emulated Slack channel: “Create a service request for the printer on floor two.” The worker accepts the event, queues the job through Floci SQS, creates a ticket in its ledger, stores a receipt in Floci S3 and replies in the original thread.

**Lesson:** A correct reply is only one part of completion. The ticket, receipt and thread must agree, and duplicate delivery must not create another ticket.

| Case | Stimulus | Expected observation |
|---|---|---|
| W01-H | Valid request | One ticket, one receipt, one completion reply |
| W01-D | Signed retry of same event | No additional business effect or reply |
| W01-B | Bot receives its own message | No new job |
| W01-S | Receipt storage fails | Ticket retained, completion withheld, retry/recovery explicit |
| W01-Q | Queue redelivery | Existing action recognized, no duplicate ticket |
| W01-T | Reply accepted, response times out | Reconcile or UNKNOWN; never blindly duplicate |

## W02: Operations approval

A team member requests a fictional equipment purchase of 12,500 cents. The app posts an approval button; a different authorized user may approve before expiry, with a request-bound receipt and no payment execution.

**Lesson:** An interaction arriving through Slack does not make it authorized. The policy boundary must verify the current actor, request digest, tenant and state when the action is attempted.

| Case | Stimulus | Expected observation |
|---|---|---|
| W02-H | Authorized second person approves | One approved transition and matching receipt |
| W02-U | Requester clicks own approval | Denied, no terminal transition |
| W02-X | Approval expires before click | Expired, no approval receipt |
| W02-R | Same approval replayed | No second transition or receipt |
| W02-C | Request edited after approval generated | Old approval rejected |
| W02-P | Approver permission revoked before click | Denied using current policy |
| W02-F | Copied interaction from other workspace | No cross-tenant action or disclosure |

## W03: CRM follow-up update

A sales coordinator asks LabBot to change a synthetic account's description to “Workshop follow-up requested.” The local lane uses a small contract double; the optional Salesforce lane applies the same semantic test to an explicitly configured scratch org.

**Lesson:** An API-shaped test double and a real platform environment provide different evidence. The same workflow can keep its policy while changing the dependency used to validate it.

| Case | Stimulus | Expected observation |
|---|---|---|
| W03-H | Authorized update, version matches | Allowed field changes, version advances |
| W03-V | Expected version stale | Conflict, no overwrite |
| W03-U | Actor lacks write authority | No change |
| W03-W | Prompt asks for another tenant | Bound tenant unchanged; request denied |
| W03-N | Missing target or expected version | Invalid input; no write |
| W03-SF | Authorized scratch-org profile | Actual platform observations, independently labeled |

## Shared adversarial and reporting cases

| Case | Test | Required result |
|---|---|---|
| G-SIG | Forged Slack signature | Rejected before queueing |
| G-OLD | Valid signature with stale timestamp | Rejected |
| G-SCOPE | Token without chat scope | No escalation to broader credentials |
| G-REVOKE | Uninstalled/revoked app token | No further successful provider action |
| G-NET | Production endpoint override | Zero outbound requests |
| G-SEED | Two concurrent runs | No shared business state |
| G-EVIDENCE | Worker says success, receipt absent | Required assertion fails |
| G-UNKNOWN | Collector cannot read state | UNKNOWN, never inferred zero or pass |
| G-EXPORT | Secret-shaped canary in capture | Export blocked and quarantined |
| G-CLEAN | Cleanup with unrelated container present | Only owned resources removed |

Mutation probes MUST deliberately disable deduplication, bypass approval, reply before commit and convert missing evidence into success, one at a time. The tests must catch each mutation; record caught/uncaught/invalid-mutant counts, not a broad claim that the application has no bugs.

## Art of the possible

These extensions are design hypotheses, not v1 commitments or tested features:

- **Order exceptions:** Slack request, emulated order API, queue-based reconciliation and explicit approval before a write.
- **Document processing:** Object storage plus extraction jobs, with an independent field-level oracle and synthetic documents.
- **Incident investigation:** Read-only cloud diagnostics and an evidence-backed Slack report, with remediation outside the default authority.
- **Employee onboarding:** Synthetic access requests, role-policy checks and provider-specific test environments before real account creation.
- **CRM maintenance:** Scratch-org tests across personas and configuration, with a sandbox lane for customer-specific behavior.

WireMock may cover an API absent from the selected emulator; Testcontainers may provide a real database or broker; Playwright may exercise a UI. Those are alternative or additional roles, not mandatory components in every use case ([WireMock](https://wiremock.org/docs/overview/), [Testcontainers](https://testcontainers.com/getting-started/), [Playwright](https://playwright.dev/docs/intro)).
