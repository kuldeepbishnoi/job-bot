#!/usr/bin/env bash
# Launch mitmweb (with our capture addon) + Chrome routed through it, with the built
# extension pre-loaded. Everything relevant lands in debug/captures/.
#
# Two modes:
#   debug/launch.sh <url>                # SCRATCH profile at /tmp/chrome-jobbot-mitm
#                                        # — clean sandbox, no Google login, best for
#                                        #   pure form capture. Can run alongside your
#                                        #   normal Chrome (different --user-data-dir).
#   USE_MY_PROFILE=1 debug/launch.sh <url>
#                                        # Uses ~/Library/Application Support/Google/Chrome.
#                                        # You must QUIT your normal Chrome first —
#                                        # Chrome refuses to open the same profile twice.
#                                        # Gives you your Gmail login, cookies, everything.
#
# Stop everything:  debug/stop.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAP_DIR="$ROOT/debug/captures"
LOG_DIR="$ROOT/debug/logs"
EXT_DIR="$ROOT/.output/chrome-mv3"

if [[ "${USE_MY_PROFILE:-0}" == "1" ]]; then
  CHROME_PROFILE="$HOME/Library/Application Support/Google/Chrome"
  # If Chrome's already running against this profile, refuse to launch — Chrome will
  # silently open a tab in the running instance and ignore all our flags (proxy,
  # extension). That's the real footgun.
  if pgrep -f 'Google Chrome' | grep -vq "$(pgrep -f 'chrome-jobbot-mitm' || echo NONE)"; then
    echo "Your normal Chrome is running. Quit it first (⌘Q), then re-run." >&2
    exit 1
  fi
else
  CHROME_PROFILE="/tmp/chrome-jobbot-mitm"
fi

MITM_HOST=127.0.0.1
MITM_PORT=8080
MITM_UI_PORT=8081

mkdir -p "$CAP_DIR" "$LOG_DIR"

if [[ ! -d "$EXT_DIR" ]]; then
  echo "extension not built at $EXT_DIR — running: npm run build" >&2
  (cd "$ROOT" && npm run build >/dev/null)
fi

# Ensure the mitmproxy CA cert exists (generated on first mitmproxy run).
if [[ ! -f "$HOME/.mitmproxy/mitmproxy-ca-cert.pem" ]]; then
  echo "generating mitmproxy CA cert (first run)..."
  mitmdump -q >/dev/null 2>&1 &
  CA_PID=$!
  sleep 3
  kill "$CA_PID" >/dev/null 2>&1 || true
fi

# Kill anything from a previous run so we don't stack instances.
pkill -f "mitm-capture.py" >/dev/null 2>&1 || true
pkill -f "chrome-jobbot-mitm" >/dev/null 2>&1 || true

# Start mitmweb in background — with our capture addon loaded.
mitmweb \
  --set web_open_browser=false \
  --set web_host="$MITM_HOST" \
  --set web_port="$MITM_UI_PORT" \
  --set listen_host="$MITM_HOST" \
  --set listen_port="$MITM_PORT" \
  -s "$ROOT/debug/mitm-capture.py" \
  > "$LOG_DIR/mitm.log" 2>&1 &
MITM_PID=$!
echo "$MITM_PID" > "$LOG_DIR/mitm.pid"

# Wait until the proxy port is actually accepting connections.
for _ in $(seq 1 20); do
  if nc -z "$MITM_HOST" "$MITM_PORT" 2>/dev/null; then break; fi
  sleep 0.25
done

URL="${1:-chrome://newtab}"

# Launch a scratch Chrome. --ignore-certificate-errors + --test-type bypasses the
# HTTPS interception cert prompt (the profile is disposable, at $CHROME_PROFILE).
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$CHROME_PROFILE" \
  --proxy-server="http://$MITM_HOST:$MITM_PORT" \
  --ignore-certificate-errors \
  --test-type \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=AutofillAddressProfileImport,AutofillCreditCardImport,AutofillServerCommunication \
  --load-extension="$EXT_DIR" \
  --disable-extensions-except="$EXT_DIR" \
  "$URL" \
  > "$LOG_DIR/chrome.log" 2>&1 &
CHROME_PID=$!
echo "$CHROME_PID" > "$LOG_DIR/chrome.pid"

cat <<EOF
mode:       $([[ "${USE_MY_PROFILE:-0}" == "1" ]] && echo "REAL profile ($CHROME_PROFILE)" || echo "scratch profile ($CHROME_PROFILE)")
mitmweb UI: http://$MITM_HOST:$MITM_UI_PORT
captures:   $CAP_DIR
tail logs:  tail -f $LOG_DIR/mitm.log
stop:       debug/stop.sh
EOF
