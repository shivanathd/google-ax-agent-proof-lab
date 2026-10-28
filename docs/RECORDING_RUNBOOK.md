# Recording Runbook

This is the plan for recording the implemented lab. No video or actual workflow run is included in this specification package.

## Prepare a clean recording

Use a dedicated browser profile and synthetic workspaces. Disable notifications, close credential tabs, choose a clean candidate revision and record the environment inventory before starting.

Run the local suite first. Save its report and artifact hashes, then record the exact same candidate with fresh seeded run IDs. Screen overlays must show profile, scripted/live mode, revision and synthetic-data notice.

Do not screen-record provider login, OAuth consent details, access tokens or emulator auth inspectors. Redaction is a second safeguard, not permission to record secrets.

## Main recording: proposed 10–12 minute sequence

| Segment | Screen | Spoken direction | Required proof |
|---|---|---|---|
| Opening | Mental-model view | “I want to separate five questions: where the work runs, what it connects to, what it is allowed to do, what happened, and what we can claim.” | Label proposed architecture |
| Setup | Terminal doctor/up | “The basic lab does not need a Slack workspace, cloud account or model key. The optional profiles are visible rather than hidden prerequisites.” | Real doctor output and selected profile |
| Happy path | Console + Slack inspector | “This is an emulated Slack conversation. The app still sends API requests and receives signed callbacks.” | Actual event, thread and message identity |
| Follow the action | State/evidence view | “The reply alone is not my acceptance test. I also need the ticket and matching storage receipt.” | Ledger + S3 observations |
| Duplicate event | Retry control | “Now I will deliver the same event again. A second delivery must not become a second business action.” | Before/after counts |
| Denied approval | W02 view | “This user can request approval but cannot approve their own request. The action should fail without changing the record.” | Zero unauthorized transitions |
| Detected defect | Mutation run | “This defect is deliberately injected. The point is whether the test notices it.” | Mutant identity and failed assertion |
| Real-org boundary | Profile view | “A local CRM double cannot prove Salesforce behavior. This lane requires a real, independently authorized test org.” | Real status: executed or blocked |
| Close | Run report | “These are the cases this revision passed, the failures the tests caught, and the areas I have not verified.” | All statuses, caveats and cleanup |

Timing is an editorial target, not an execution benchmark. Use only the segments supported by actual results; if an optional lane is blocked, show that state rather than inserting a fabricated success clip.

## Short clips

- **Mental model, 60–90 seconds:** Explain the layers without installation details.
- **Duplicate delivery, 90 seconds:** Show the first result, repeated event and unchanged business count.
- **Permission boundary, 90 seconds:** Show a denied approval and unchanged state.
- **Emulator versus real org, 90 seconds:** Compare what is tested and what remains unknown.

## Capture contract

Each clip must have a sidecar JSON record with run ID, revision, timestamps, profile, mode, scenario IDs, original capture filename, SHA-256 and edits performed. Keep a transcript or captions. Speed changes and cut transitions must not be presented as measured latency.

The implementation MUST supply `lab record --case W01-H` and a browser capture route using Playwright. It MUST also implement the capture/optimization/README commands in [README Media Production Contract](README_MEDIA_SPEC.md). If the host cannot encode video or GIFs, retain source captures and report the affected step BLOCKED; do not claim the required media work is complete.

## Required README media

Capture five screenshots of the built app, three GIFs showing Slack completion, duplicate-event handling and denied approval, plus a static poster for each GIF. Follow [the storyboard](README_STORYBOARD.md) to embed them in the root README with captions, alt text and repository-relative paths.

The README assets must be actual integration captures, bound to run IDs and the tested application revision. Verify file decoding, animation, dimensions, size budget, provenance and local rendered layout; check GitHub's actual rendered page only after repository access and publication are authorized.

## Publication review

Watch the exported recording from beginning to end, inspect captions and scan artifact text for secrets and internal names. Confirm the visible UI agrees with the saved report, the failure is labeled injected, and the closing claim is no broader than the executed cases.
