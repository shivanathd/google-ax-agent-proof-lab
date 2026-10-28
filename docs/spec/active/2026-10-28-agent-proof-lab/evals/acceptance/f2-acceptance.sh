#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/../evaluate.py" F2-A1 F2-A2
