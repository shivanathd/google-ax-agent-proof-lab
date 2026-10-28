# Sanitized run evidence

Each directory is the allowlisted `lab export` projection of one executed local run used by the README media: `report.json` (C5 run report),
`observations.json` (C4 facts) and `checksums.sha256`. Exports pass the tamper check, the secret scan and the private-terms scan first.
Raw evidence files (ledger rows, Slack payloads) stay in the gitignored `artifacts/runs/<run_id>/`.

- [`d7b27d50-c6af-4abd-bd03-36b67dfcb967`](d7b27d50-c6af-4abd-bd03-36b67dfcb967/report.json): W01-H, local core PASS
- [`8c577551-a2f9-4968-ac0d-67115ea07c90`](8c577551-a2f9-4968-ac0d-67115ea07c90/report.json): W01-D, local core PASS
- [`493034f5-af80-47da-9994-eb6b5142b363`](493034f5-af80-47da-9994-eb6b5142b363/report.json): W02-U, local core PASS
- [`d1141e88-6ad1-4ebf-9008-dd8a1a3186df`](d1141e88-6ad1-4ebf-9008-dd8a1a3186df/report.json): W02-H, local core PASS
- [`fed9685f-093e-43d3-b630-df61329bc6ab`](fed9685f-093e-43d3-b630-df61329bc6ab/report.json): W01-H, local core PASS
- [`ca8e55fb-ac80-4ea7-8df7-5a2843ea8974`](ca8e55fb-ac80-4ea7-8df7-5a2843ea8974/report.json): W01-F, local core FAIL
- [`581e434c-a178-47fe-ae7a-3ff59b4a38b9`](581e434c-a178-47fe-ae7a-3ff59b4a38b9/report.json): W03-V, local core PASS
