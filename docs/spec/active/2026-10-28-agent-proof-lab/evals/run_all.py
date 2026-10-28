#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "eval-manifest.json").read_text())
results = []
for layer in ("task_verifications", "acceptance_tests", "holdout_evals"):
    for entry in manifest[layer]:
        result = subprocess.run(["bash", str(HERE / entry["script"])], capture_output=True, text=True)
        status = "PASS" if result.returncode == 0 else "BLOCKED" if result.returncode == 2 else "FAIL"
        results.append({"layer": layer, "id": entry["id"], "status": status})
        print(f"{entry['id']}: {status}")
statuses = {r["status"] for r in results}
verdict = "LOOP" if "FAIL" in statuses else "BLOCKED" if "BLOCKED" in statuses else "LOCAL_CORE_READY"
report = {"schema_version": 1, "verdict": verdict, "results": results,
          "scope": "local required gates; not authorization to publish",
          "holdout_visibility": "public-challenge"}
(HERE / "results").mkdir(exist_ok=True)
(HERE / "results" / "convergence-report.json").write_text(json.dumps(report, indent=2) + "\n")
print(verdict)
sys.exit(1 if verdict == "LOOP" else 2 if verdict == "BLOCKED" else 0)
