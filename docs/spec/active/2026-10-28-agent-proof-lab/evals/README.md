# Verification Harness

This executable harness ships with the specification before the application. It is intentionally fail-closed: without the target CLI it reports BLOCKED and returns exit code 2.

`run-all.sh` executes task verifications, feature acceptance and public challenge cases. `evaluate.py` asks the future independent `collect-case` CLI for observed facts, verifies evidence file hashes, and compares them to `cases.json`. It does not accept a worker's pass/fail judgment.

The harness itself cannot prove a dishonest collector ran a real integration. The implementation must provide direct independent clients, restricted worker permissions, integration tests and reviewable capture evidence, as required by F4. Hash validation establishes artifact binding, not provenance authenticity.

The `holdout/` cases are public challenge scenarios, not secret holdouts. A genuinely blind evaluation must run additional cases in a separate reviewer-controlled environment.

## Commands

```bash
python3 tools/validate_package.py
bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh
```

Set `PROJECT_ROOT` only when the implementation resides outside the package root. `EVAL_CASE_TIMEOUT_SECONDS` defaults to 180; changing it must not hide an unbounded action loop.

Results are written beneath `evals/results/` and should remain gitignored after the initial package validation record. Aggregate verdicts are `LOCAL_CORE_READY`, `LOOP` and `BLOCKED`; none authorizes publication.
