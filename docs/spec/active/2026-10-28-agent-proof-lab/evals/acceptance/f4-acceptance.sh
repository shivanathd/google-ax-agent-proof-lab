#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/../evaluate.py" F4-A1 F4-A2
