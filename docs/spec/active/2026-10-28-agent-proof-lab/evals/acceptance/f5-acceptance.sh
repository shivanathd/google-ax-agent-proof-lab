#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/../evaluate.py" F5-A1 F5-A2
