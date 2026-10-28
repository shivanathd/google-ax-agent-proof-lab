#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/../evaluate.py" F3-A1 F3-A2 F3-A3
