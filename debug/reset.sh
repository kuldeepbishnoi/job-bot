#!/usr/bin/env bash
# Clear captured responses so the next run starts clean.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$ROOT/debug/captures"
mkdir -p "$ROOT/debug/captures"
echo "cleared debug/captures/"
