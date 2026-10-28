#!/usr/bin/env python3
# Checks docs/CLAIM_LEDGER.md: every full run ID it cites is found in committed evidence (docs/evidence/,
# docs/assets/media-manifest.json, artifacts/bench/, artifacts/mutations/) or, for local harness runs, in the
# gitignored artifacts/runs/; every repository path it cites exists; every short ID prefix appears in a cited
# committed doc. Exit 1 on any miss. Run from the repository root: python3 scripts/check-claim-ledger.py
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ledger = (ROOT / "docs/CLAIM_LEDGER.md").read_text()
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
committed = (ROOT / "docs/assets/media-manifest.json").read_text()
committed += "".join(p.read_text() for p in (ROOT / "artifacts/bench").glob("*.json"))
evidence = {p.name for p in (ROOT / "docs/evidence").iterdir() if p.is_dir()}
local_runs = {p.name for p in (ROOT / "artifacts/runs").glob("*")} if (ROOT / "artifacts/runs").exists() else set()
problems, counts = [], {"evidence": 0, "committed": 0, "local": 0}

for rid in sorted(set(UUID.findall(ledger))):
    if rid in evidence:
        counts["evidence"] += 1
        for f in ("report.json", "observations.json", "checksums.sha256"):
            if not (ROOT / "docs/evidence" / rid / f).exists():
                problems.append(f"docs/evidence/{rid}/{f} missing")
    elif rid in committed:
        counts["committed"] += 1
    elif rid in local_runs:
        counts["local"] += 1
    else:
        problems.append(f"run id {rid} not found in docs/evidence, media manifest, bench record or artifacts/runs")

# Media runs must be the ones the manifest names, and each must have its evidence folder.
manifest = json.loads((ROOT / "docs/assets/media-manifest.json").read_text())
items = manifest.get("items") or manifest.get("media") or manifest.get("assets") or []
for item in items:
    if item["run_id"] not in ledger:
        problems.append(f"media {item['id']} run {item['run_id']} not cited in the ledger")
    for ref in item.get("evidence_refs", []):
        if not (ROOT / ref).exists():
            problems.append(f"manifest evidence ref {ref} missing")
if manifest.get("application_tree_sha256", "") not in ledger:
    problems.append("ledger does not cite the manifest's application_tree_sha256")

# Backticked or linked repository paths.
paths = set(re.findall(r"`((?:docs|src|profiles|tests|artifacts|scripts)/[^`*<>\s]+?)`", ledger))
paths |= {"docs/" + p for p in re.findall(r"\]\((evidence/[^)]+)\)", ledger)}
# Cited as absent on purpose (F6-A3 review pending); if it appears, the ledger is stale.
EXPECTED_ABSENT = {"docs/assets/render-review.json"}
for p in sorted(paths):
    if "<" in p or p.startswith("artifacts/runs/"):
        continue
    if p in EXPECTED_ABSENT:
        if (ROOT / p).exists():
            problems.append(f"{p} now exists: update C-32 (F6-A3 review)")
        continue
    if not (ROOT / p.rstrip("/")).exists():
        problems.append(f"path {p} does not exist")

# Short prefixes such as `6882d106-…` must appear in a committed doc.
docs_text = "".join((ROOT / p).read_text() for p in ("profiles/ax/RESULTS.md", "docs/LEARNINGS.md"))
for short in set(re.findall(r"`([0-9a-f]{8})-…`", ledger)):
    if short not in docs_text:
        problems.append(f"short id {short} not found in RESULTS.md or LEARNINGS.md")

print(json.dumps({"run_ids": counts, "paths_checked": len(paths), "problems": problems}, indent=2))
sys.exit(1 if problems else 0)
