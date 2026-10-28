#!/usr/bin/env python3
"""Preimplementation verification contract; no application success is synthesized."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("PROJECT_ROOT", HERE.parents[4])).resolve()
CASES = json.loads((HERE / "cases.json").read_text())


def same(actual, expected):
    """Do not let Python equate False with zero or True with one."""
    return type(actual) is type(expected) and actual == expected


def inspect_bundle(bundle, case_id, directory):
    case = CASES[case_id]
    errors = []
    if bundle.get("execution") in ("BLOCKED", "NOT_RUN"):
        return "BLOCKED", [bundle.get("reason") or "No execution evidence"]
    for key, expected in (
        ("schema_version", 1), ("case_id", case_id), ("profile", case["profile"]),
        ("execution", "EXECUTED"),
    ):
        if not same(bundle.get(key), expected):
            errors.append(f"Invalid {key}")
    for key in ("run_id", "candidate_revision", "fixture_sha256", "collector", "observed_at"):
        if not isinstance(bundle.get(key), str) or not bundle[key].strip():
            errors.append(f"Missing {key}")
    if bundle.get("mode") not in ("scripted", "fixture-replay", "live-model"):
        errors.append("Invalid mode")
    if bundle.get("mode") == "fixture-replay":
        errors.append("Replay does not satisfy local integration acceptance")
    evidence = bundle.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        errors.append("Missing evidence files")
    else:
        for item in evidence:
            if not isinstance(item, dict):
                errors.append("Invalid evidence record")
                continue
            raw = item.get("path", "")
            if not isinstance(raw, str) or not raw or Path(raw).is_absolute():
                errors.append("Invalid evidence path")
                continue
            path = (directory / raw).resolve()
            if not path.is_relative_to(directory.resolve()) or not path.is_file():
                errors.append("Evidence missing or escapes directory")
                continue
            if hashlib.sha256(path.read_bytes()).hexdigest() != item.get("sha256"):
                errors.append("Evidence hash mismatch")
            if not item.get("source"):
                errors.append("Missing evidence source")
    observations = bundle.get("observations", {})
    if not isinstance(observations, dict):
        observations = {}
        errors.append("Invalid observations")
    for key, expected in case["expected"].items():
        if key not in observations:
            errors.append(f"Missing observation: {key}")
        elif not same(observations[key], expected):
            errors.append(f"Unexpected observation: {key}")
    return ("FAIL", errors) if errors else ("PASS", [])


def run_case(case_id):
    if case_id not in CASES:
        return {"case": case_id, "status": "FAIL", "reasons": ["Unknown case"]}
    if not (ROOT / "package.json").exists():
        return {"case": case_id, "status": "BLOCKED", "reasons": ["Application not implemented"]}
    target = HERE / "results" / "collected" / f"{case_id}-{uuid.uuid4().hex}"
    target.mkdir(parents=True)
    output = target / "observations.json"
    command = ["npm", "run", "lab", "--", "collect-case", "--case", case_id, "--output", str(output)]
    try:
        completed = subprocess.run(command, cwd=ROOT, timeout=int(os.environ.get("EVAL_CASE_TIMEOUT_SECONDS", "180")),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if completed.returncode == 2:
            return {"case": case_id, "status": "BLOCKED", "reasons": ["Collector prerequisite blocked; inspect sanitized CLI report"]}
        if completed.returncode != 0 or not output.is_file():
            return {"case": case_id, "status": "FAIL", "reasons": ["Collector failed or evidence absent"]}
        bundle = json.loads(output.read_text())
        if not isinstance(bundle, dict):
            raise ValueError("Bundle must be an object")
        status, errors = inspect_bundle(bundle, case_id, target)
        return {"case": case_id, "status": status, "reasons": errors}
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {"case": case_id, "status": "FAIL", "reasons": [type(error).__name__]}


def run_task(task):
    package = ROOT / "package.json"
    if not package.exists():
        return {"task": task, "status": "BLOCKED", "reasons": ["Application not implemented"]}
    try:
        scripts = json.loads(package.read_text()).get("scripts", {})
        if "verify:task" not in scripts:
            return {"task": task, "status": "FAIL", "reasons": ["Missing verify:task interface"]}
        result = subprocess.run(["npm", "run", "verify:task", "--", task], cwd=ROOT,
                                timeout=600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        status = "PASS" if result.returncode == 0 else "BLOCKED" if result.returncode == 2 else "FAIL"
        return {"task": task, "status": status, "reasons": [] if status == "PASS" else ["Task verification did not pass"]}
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {"task": task, "status": "FAIL", "reasons": [type(error).__name__]}


def main():
    args = sys.argv[1:]
    results = [run_task(args[1])] if args[:1] == ["--task"] and len(args) == 2 else [run_case(c) for c in args]
    if not results:
        print("Specify one or more case IDs")
        return 1
    print(json.dumps(results, indent=2))
    statuses = {r["status"] for r in results}
    return 1 if "FAIL" in statuses else 2 if "BLOCKED" in statuses else 0


if __name__ == "__main__":
    sys.exit(main())
