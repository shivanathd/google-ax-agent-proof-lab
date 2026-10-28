#!/usr/bin/env python3
"""Evaluate an AX-lane C4 bundle with the supplied evaluator's own inspect_bundle(), against cases.ax.json.

    python3 profiles/ax/evaluate_ax.py CASE_ID BUNDLE_DIR      # BUNDLE_DIR holds observations.json + evidence/

Only the expectations table differs from the local lane; type-strict comparison, evidence hashing and path
checks are the supplied code's. Keys listed in recorded_not_asserted must never appear in an expectation.
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVAL = HERE.parents[1] / "docs/spec/active/2026-10-28-agent-proof-lab/evals/evaluate.py"
spec = importlib.util.spec_from_file_location("apl_evaluate", EVAL)
evaluate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluate)

table = json.loads((HERE / "cases.ax.json").read_text())
for case_id, case in table.items():
    if isinstance(case, dict) and "expected" in case:
        assert not set(case["expected"]) & set(table["recorded_not_asserted"]), f"{case_id} asserts a recorded-only key"
evaluate.CASES = {k: v for k, v in table.items() if isinstance(v, dict) and "expected" in v}

case_id, directory = sys.argv[1], Path(sys.argv[2])
bundle = json.loads((directory / "observations.json").read_text())
status, reasons = evaluate.inspect_bundle(bundle, case_id, directory)
recorded = {k: bundle.get("observations", {}).get(k) for k in table["recorded_not_asserted"]}
print(json.dumps({"case": case_id, "profile": "ax", "status": status, "reasons": reasons, "recorded_not_asserted": recorded}))
sys.exit(0 if status == "PASS" else 1)
