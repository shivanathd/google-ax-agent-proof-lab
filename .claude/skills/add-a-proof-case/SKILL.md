---
name: add-a-proof-case
description: Add a new proof case to Agent Proof Lab end to end - casebook row, synthetic fixture, workflow or policy change, collector case with observation keys, spec-amended expectation, a test that fails first, a mutation probe, collected evidence and a claim-ledger row. Use when someone asks to add, extend or prove a new scenario, adversarial case or acceptance case in this repository.
---

# Add a proof case

A proof case is finished when an independent collector observes the outcome, the supplied evaluator compares it with a fixed expectation, a deliberate defect makes it fail, and a claim cites the run. Writing the feature is the smallest part.

Read first: `AGENTS.md`, `docs/CASEBOOK.md`, `docs/spec/active/2026-10-28-agent-proof-lab/contracts/CONTRACTS.md` (C3 actions, C4 bundle, C5 report) and `docs/diagrams/README.md` (who holds which credential).

Never edit `docs/spec/active/2026-10-28-agent-proof-lab/evals/` or `tools/` from a build task. Use fictional organizations, users and data only.

## Steps

1. **Casebook row.** Add the row to `docs/CASEBOOK.md` under its workflow (W01 to W03) or the shared table: one stimulus, one expected observation in plain words. If you cannot state the observation as a fact someone else could check, stop and sharpen it.

2. **Expected outcome, written before running.** Add a row to the pre-registered table in `docs/LEARNINGS.md` with the expectation and `pending`. Commit it before any run, so the expectation cannot be edited after the fact.

3. **Fixture.** Add the synthetic stimulus to `fixtures/cases/cases.json` (or a seed under `fixtures/`). Any fixture change changes `fixture_sha256` in every bundle; that is intended.

4. **Expectation through a spec amendment.** The evaluator's expectations live in `evals/cases.json`, which builders do not edit. Write the amendment: the acceptance scenario in `REQUIREMENTS.md`, an ADR in `DECISIONS.md` if it changes a rule, and the proposed `cases.json` entry with typed expected facts. Get owner approval, and commit the spec separately from the code. Until then the case is a local test, not a supplied-harness case.

5. **Test that fails first.** Add the integration test (`tests/integration/<area>.test.ts`) against the real local stack (`startRun` from `src/config/lifecycle.ts`). Run it and watch it fail for the reason you expect. A test that passes before the change can't tell you the change works (see LEARNINGS L-020).

6. **Workflow or policy change.** Change `src/workflows/wNN.ts` or `src/policy/index.ts`. Keep the rules that the existing cases depend on:
   - decide authorization from policy and current grants, never from message text;
   - write business state and the outbox in one transaction;
   - treat an ambiguous remote result as UNKNOWN and never blindly retry it;
   - bind tenant to the installation, never to `team_id` (L-013).

7. **Collector case.** Add a `CaseDef` in `src/collector/cases/<family>.ts` and register it in `src/collector/cases/index.ts`.
   - `execute` is the coordinator half. Drive the stimulus with the helpers in `src/collector/drive.ts`, record stimulus identity with `ref()` and label injected faults with `fault()`. Never pass expectations to the collector.
   - `observe` (and optional `phases` for before/after snapshots) runs in the separate collector process. Read state only through `Probe`: `p.capture(name, source, fn)` for each store, then `p.fact(key, [captures], fn)` for each observation key.
   - A fact must be a typed scalar. If a capture it depends on fails, the key is absent with a reason, which the report turns into UNKNOWN. Never default to `0` or `false` (L-021).
   - The collector holds a reader Slack token, its own Floci key and a read-only ledger handle. If your case needs more, that is a design change: draw it in `docs/diagrams/` first.

8. **Mutation probe.** Write the smallest patch that reintroduces the defect the case guards against, as `tests/mutations/NN-<name>.patch`. Register its checks (tests plus evaluator cases) in `CHECKS` in `scripts/mutations/run.ts`. Run `npm run mutate`: the mutant must be `caught`. An `invalid` mutant (does not apply or does not typecheck) proves nothing, so fix it.

9. **Evidence.** From a clean tree (commit first; untracked files mark bundles dirty, L-024):

   ```bash
   npm run lab -- collect-case --case <ID> --output "$PWD/private-runs/<ID>.json"
   python3 docs/spec/active/2026-10-28-agent-proof-lab/evals/evaluate.py <ID>
   npm run lab -- report --run-id <run_id>
   npm run lab -- export --run-id <run_id>
   ```

   `collect-case` exit 0 means the collection completed, not that the case passed. The evaluator decides. `export` quarantines the run on any secret-shaped match; fix the capture rather than the scanner. Then run `bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh` on the merged tree. Branch-local gates have missed composition failures before (L-025, L-026).

10. **Record and claim.** Fill the LEARNINGS row's Observed column with the run ID and a verdict (met, missed or surprising, and why). Add a row to `docs/CLAIM_LEDGER.md` with the wording, evidence label, run ID, tree SHA, profile, scope, limitations and reviewer status `unreviewed`. Claim no more than the observation keys show.

## Done when

- [ ] The casebook row and the pre-registered expectation were committed before the first run.
- [ ] The test failed before the change and passes after it.
- [ ] The mutant is `caught` by `npm run mutate`.
- [ ] The supplied evaluator reports PASS on a clean tree, with a run ID.
- [ ] LEARNINGS and CLAIM_LEDGER cite that run ID and tree SHA.
- [ ] No fixture, capture or export contains a real name, token or private term.
