#!/usr/bin/env bash
# Verify Rico in a REAL, headed Chrome on a virtual screen, driven by OS-level mouse and keyboard
# (xdotool) with screenshots of the actual screen. Playwright/CDP is used only to read geometry/state.
# Linux only. Needs: Xvfb, xdotool, ImageMagick (`import`), google-chrome, and `npm install`.
# Screenshots land in e2e/desktop/out/.   Usage: bash e2e/desktop/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
CHROME="${CHROME:-google-chrome}"
mkdir -p e2e/desktop/out
PIDS=()
cleanup() { kill "${PIDS[@]}" 2>/dev/null || true; pkill -f 'remote-debugging-port=9333' 2>/dev/null || true; }
trap cleanup EXIT

Xvfb :99 -screen 0 1500x950x24 >/dev/null 2>&1 & PIDS+=($!)
sleep 1
if [ -n "${REAL_PR:-}" ]; then
  # LIVE GitHub: uses your GITHUB_TOKEN against brianv0/rico#1 (dry unless RICO_POST=1)
  NODE_USE_ENV_PROXY=1 PORT=4318 node server.js >/tmp/rico-desktop-backend.log 2>&1 & PIDS+=($!)
  URL='http://localhost:4318/#pr=brianv0%2Frico%231&f=docs%2Farchitecture.md'; SCRIPT=real-pr.cjs
else
  node e2e/desktop/backend.mjs >/tmp/rico-desktop-backend.log 2>&1 & PIDS+=($!)
  URL='http://localhost:4318/#pr=acme%2Fdocs%237'; SCRIPT=computer.cjs
fi
sleep 2
rm -rf /tmp/rico-chrome-profile
DISPLAY=:99 "$CHROME" --no-sandbox --kiosk --no-first-run --disable-features=Translate \
  --remote-debugging-port=9333 --user-data-dir=/tmp/rico-chrome-profile \
  "$URL" >/tmp/rico-desktop-chrome.log 2>&1 & PIDS+=($!)
sleep 4
node "e2e/desktop/$SCRIPT"
