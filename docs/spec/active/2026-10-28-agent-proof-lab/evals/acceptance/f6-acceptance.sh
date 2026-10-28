#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/../evaluate.py" F6-A1 F6-A2 F6-A3 F6-A4 F6-A5
