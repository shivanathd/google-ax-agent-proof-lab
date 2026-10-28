#!/usr/bin/env python3
"""Validate spec structure and traceability, not application behavior."""
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/spec/active/2026-10-28-agent-proof-lab"
errors = []
req = (SPEC / "REQUIREMENTS.md").read_text()
features = re.findall(r"^## (F\d+):.*?(?=^## |\Z)", req, re.M | re.S)
blocks = re.split(r"^## F\d+:.*$", req, flags=re.M)[1:]
required_sections = ["Metadata", "Problem Statement", "Evidence", "Impact Analysis",
                     "Functional Requirements", "Technical Specification", "Acceptance Scenarios",
                     "Edge Cases", "Test Strategy", "What This Is NOT", "Anti-Patterns", "AI Development Guidance"]
for index, block in enumerate(blocks, 1):
    block = re.split(r"^## ", block, maxsplit=1, flags=re.M)[0]
    for section in required_sections:
        if f"### {section}" not in block:
            errors.append(f"F{index} missing {section}")
    if len(re.findall(r"GIVEN", block)) < 2:
        errors.append(f"F{index} needs two acceptance cases")
    if "**Classification:** Security" in block:
        for section in ("Standards Alignment", "Failure Behavior", "Threats Addressed"):
            if f"### {section}" not in block:
                errors.append(f"F{index} missing {section}")
    if "**Classification:** Operational" in block and "### Failure Behavior" not in block:
        errors.append(f"F{index} missing Failure Behavior")
    for line in block.splitlines():
        if re.match(r"\| F\d+-R\d+", line) and not re.search(r"\b(MUST|SHALL|SHOULD|MAY)\b", line):
            errors.append(f"Non-normative requirement: {line}")
manifest = json.loads((SPEC / "evals/eval-manifest.json").read_text())
cases = json.loads((SPEC / "evals/cases.json").read_text())
covered = set()
for layer in ("task_verifications", "acceptance_tests", "holdout_evals"):
    for item in manifest[layer]:
        if not (SPEC / "evals" / item["script"]).is_file():
            errors.append(f"Missing script {item['script']}")
        covered.update(item.get("cases", []))
expected_cases = set(re.findall(r"\*\*(F\d+-A\d+):", req))
expected_cases.update(re.findall(r"^### (S\d+):", (SPEC / "SCENARIOS.md").read_text(), re.M))
if covered != expected_cases or set(cases) != expected_cases:
    errors.append("Case manifest, scenarios and expectations differ")
plan = (SPEC / "IMPLEMENTATION_PLAN.md").read_text()
tasks = re.findall(r"^### Task (\d+\.\d+):", plan, re.M)
if set(tasks) != {x["id"] for x in manifest["task_verifications"]}:
    errors.append("Task manifest mismatch")
if plan.count("**Verify:**") != len(tasks):
    errors.append("Missing task verification")
if not (SPEC / "evals/run-all.sh").stat().st_mode & 0o111:
    errors.append("run-all.sh not executable")
for path in ROOT.rglob("*.md"):
    text = path.read_text()
    if "\u2014" in text:
        errors.append(f"Em dash in {path.relative_to(ROOT)}")
    private_terms = [term.strip() for term in os.environ.get("PRIVATE_TERMS", "").split(",") if term.strip()]
    if any(term.casefold() in text.casefold() for term in private_terms):
        errors.append(f"Private identity in {path.relative_to(ROOT)}")
    prose = re.sub(r"```.*?```", "", text, flags=re.S)
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", prose):
        if not target.startswith(("http://", "https://", "#")) and not (path.parent / target.split("#")[0]).exists():
            errors.append(f"Broken local link {path.relative_to(ROOT)}: {target}")
print(json.dumps({"status": "FAIL" if errors else "PASS", "features": len(features),
                  "tasks": len(tasks), "cases": len(cases), "errors": errors,
                  "scope": "specification consistency only"}, indent=2))
sys.exit(bool(errors))
