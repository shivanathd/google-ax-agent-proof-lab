# Sanitized run evidence

Each run directory is the allowlisted `lab export` projection of one executed local run: `report.json` (C5 run report),
`observations.json` (C4 facts) and `checksums.sha256`. Exports pass the tamper check, the secret scan and the private-terms scan first.
Raw evidence files (ledger rows, Slack payloads) stay in the gitignored `artifacts/runs/<run_id>/`.

Runs used by the README media:

- [`7e63be51-eb89-4fa6-b40d-3edfa1e6f9e9`](7e63be51-eb89-4fa6-b40d-3edfa1e6f9e9/report.json): W01-H, local core PASS
- [`c56e3668-6014-4178-b2b7-44adf04d67c3`](c56e3668-6014-4178-b2b7-44adf04d67c3/report.json): W01-D, local core PASS
- [`304234f2-1b2c-47fb-8979-2ee7d7590827`](304234f2-1b2c-47fb-8979-2ee7d7590827/report.json): W02-U, local core PASS
- [`28bd1213-321d-422a-a81d-74e2b7ef9d84`](28bd1213-321d-422a-a81d-74e2b7ef9d84/report.json): W02-H, local core PASS
- [`56dbbe65-d864-43ac-a66b-d4c34ac00dfa`](56dbbe65-d864-43ac-a66b-d4c34ac00dfa/report.json): W01-H, local core PASS
- [`25b02c98-2157-4772-a40e-89aae825964d`](25b02c98-2157-4772-a40e-89aae825964d/report.json): W01-F, local core FAIL
- [`2a6647f6-13df-44a5-9fbf-dc7960a5be71`](2a6647f6-13df-44a5-9fbf-dc7960a5be71/report.json): W03-V, local core PASS

Other directories here are written by other steps and are not media evidence: harness runs cited by `docs/CLAIM_LEDGER.md` and `blind-holdouts/`.
