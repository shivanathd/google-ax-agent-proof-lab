# Sanitized run evidence

Each run directory is the allowlisted `lab export` projection of one executed local run: `report.json` (C5 run report),
`observations.json` (C4 facts) and `checksums.sha256`. Exports pass the tamper check, the secret scan and the private-terms scan first.
Raw evidence files (ledger rows, Slack payloads) stay in the gitignored `artifacts/runs/<run_id>/`.

Runs used by the README media:

- [`1326a187-7058-4c59-978d-151e893f64fa`](1326a187-7058-4c59-978d-151e893f64fa/report.json): W01-H, local core PASS
- [`5b9cb5d9-c56f-42e1-bc2e-576b84f7f0f7`](5b9cb5d9-c56f-42e1-bc2e-576b84f7f0f7/report.json): W01-D, local core PASS
- [`0baf0bf7-abe3-43aa-b9ee-a176d8482708`](0baf0bf7-abe3-43aa-b9ee-a176d8482708/report.json): W02-U, local core PASS
- [`73f489dd-3a38-4733-a292-2a37f08c16ac`](73f489dd-3a38-4733-a292-2a37f08c16ac/report.json): W02-H, local core PASS
- [`4f002b0a-4daf-4ad5-a118-8d4239dc343e`](4f002b0a-4daf-4ad5-a118-8d4239dc343e/report.json): W01-H, local core PASS
- [`67f7db3e-ca7c-4fd5-8f75-708532efe802`](67f7db3e-ca7c-4fd5-8f75-708532efe802/report.json): W01-F, local core FAIL
- [`a914ea56-a732-4878-a801-cea2df304a8b`](a914ea56-a732-4878-a801-cea2df304a8b/report.json): W03-V, local core PASS

Other directories here are written by other steps and are not media evidence: harness runs cited by `docs/CLAIM_LEDGER.md` and `blind-holdouts/`.
