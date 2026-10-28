#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/../evaluate.py" --task 1.1
