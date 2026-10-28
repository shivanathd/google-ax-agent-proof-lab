#!/usr/bin/env bash
# Run the supplied, unmodified tools/validate_package.py against tracked files only.
# It globs every *.md under its root, so in a working checkout it also scans node_modules/
# and agent worktrees (third-party READMEs), which it was never meant to judge (LEARNINGS L-029).
set -euo pipefail
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
git archive HEAD | tar -x -C "$dir"
python3 "$dir/tools/validate_package.py"
