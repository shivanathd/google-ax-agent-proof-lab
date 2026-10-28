# Sanitized run evidence

Each directory is the allowlisted `lab export` projection of one executed local run used by the README media: `report.json` (C5 run report),
`observations.json` (C4 facts) and `checksums.sha256`. Exports pass the tamper check, the secret scan and the private-terms scan first.
Raw evidence files (ledger rows, Slack payloads) stay in the gitignored `artifacts/runs/<run_id>/`.

- [`0fe7285f-531e-4eb3-8d92-54b7a55a84c8`](0fe7285f-531e-4eb3-8d92-54b7a55a84c8/report.json): W01-H, local core PASS
- [`de624d93-0e32-4071-a85f-981b8a2e1073`](de624d93-0e32-4071-a85f-981b8a2e1073/report.json): W01-D, local core PASS
- [`0bdf37f3-0667-462c-8143-4c6aa63e0fd4`](0bdf37f3-0667-462c-8143-4c6aa63e0fd4/report.json): W02-U, local core PASS
- [`d717040a-4532-49a8-9a67-881cfa382dd4`](d717040a-4532-49a8-9a67-881cfa382dd4/report.json): W02-H, local core PASS
- [`2cd3a116-982b-4562-8c37-36acae6ebe78`](2cd3a116-982b-4562-8c37-36acae6ebe78/report.json): W01-H, local core PASS
- [`5f03f95b-6ea4-4d08-aef6-7c6ba8c6c49d`](5f03f95b-6ea4-4d08-aef6-7c6ba8c6c49d/report.json): W01-F, local core FAIL
- [`bbfafa8f-3aa4-4d17-bd3b-68146e4fb232`](bbfafa8f-3aa4-4d17-bd3b-68146e4fb232/report.json): W03-V, local core PASS
