#!/usr/bin/env bash
# Stop the scratch Chrome + mitmweb started by debug/launch.sh.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/debug/logs"

pkill -f "mitm-capture.py" >/dev/null 2>&1 || true
pkill -f "chrome-jobbot-mitm" >/dev/null 2>&1 || true
rm -f "$LOG_DIR/mitm.pid" "$LOG_DIR/chrome.pid"
echo "stopped."
