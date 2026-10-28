# Sanitized run evidence

Each run directory is the allowlisted `lab export` projection of one executed local run: `report.json` (C5 run report),
`observations.json` (C4 facts) and `checksums.sha256`. Exports pass the tamper check, the secret scan and the private-terms scan first.
Raw evidence files (ledger rows, Slack payloads) stay in the gitignored `artifacts/runs/<run_id>/`.

Runs used by the README media:

- [`61359d45-c5de-4016-b138-7437994c2d7e`](61359d45-c5de-4016-b138-7437994c2d7e/report.json): W01-H, local core PASS
- [`7d241b93-8399-4894-aa06-a548080a68a7`](7d241b93-8399-4894-aa06-a548080a68a7/report.json): W01-D, local core PASS
- [`4bdbf285-2d3d-42d8-abc5-93adcad4e057`](4bdbf285-2d3d-42d8-abc5-93adcad4e057/report.json): W02-U, local core PASS
- [`a440ab5c-4b22-40bf-80d1-d6adb9ec9abe`](a440ab5c-4b22-40bf-80d1-d6adb9ec9abe/report.json): W02-H, local core PASS
- [`81c6744f-3164-46e2-abdb-97f16e21260a`](81c6744f-3164-46e2-abdb-97f16e21260a/report.json): W01-H, local core PASS
- [`7085c56e-5cd2-41e3-9dc8-d5a4e75d863f`](7085c56e-5cd2-41e3-9dc8-d5a4e75d863f/report.json): W01-F, local core FAIL
- [`13c84cec-4fbf-4e9b-b412-3f2cf3b0e973`](13c84cec-4fbf-4e9b-b412-3f2cf3b0e973/report.json): W03-V, local core PASS

Other directories here are written by other steps and are not media evidence: harness runs cited by `docs/CLAIM_LEDGER.md` and `blind-holdouts/`.
