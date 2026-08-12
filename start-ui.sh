#!/usr/bin/env bash
# Launch watcher + FastAPI API + Angular UI.
# Ctrl+C stops all three.
#
# API:  http://127.0.0.1:${CONTENT_SPROUT_PORT:-17829}
# UI:   http://127.0.0.1:${CONTENT_SPROUT_NG_PORT:-4210}

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CONTENT_SPROUT_PORT:-17829}"
NG_PORT="${CONTENT_SPROUT_NG_PORT:-4210}"
API_URL="http://127.0.0.1:${PORT}"
NG_URL="http://127.0.0.1:${NG_PORT}"

cd "$PROJECT_DIR" || exit 1

cleanup() {
  pkill -f "content-sprout (watch|serve)" 2>/dev/null || true
  pkill -f "content-sprout-angular:serve" 2>/dev/null || true
  pkill -f "${PROJECT_DIR}/ui/node_modules/@angular/cli" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

if [[ ! -d ui/node_modules ]]; then
  echo "Installing Angular UI dependencies (ui/)…"
  (cd ui && npm install)
fi

uv run content-sprout watch &
uv run content-sprout serve --host 127.0.0.1 --port "$PORT" &

(
  cd ui
  # Keep proxy target in sync when CONTENT_SPROUT_PORT is overridden.
  if [[ "$PORT" != "17829" ]]; then
    export NG_PROXY_TARGET="http://127.0.0.1:${PORT}"
  fi
  npm start -- --port "$NG_PORT" --host 127.0.0.1
) &

printf "Waiting for API at %s " "$API_URL"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 "$API_URL/api/config" >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  printf "."
  sleep 0.25
done

printf "Waiting for UI at %s " "$NG_URL"
for _ in $(seq 1 120); do
  if curl -fsS --max-time 1 "$NG_URL" >/dev/null 2>&1; then
    echo " ready."
    open "$NG_URL" 2>/dev/null || true
    break
  fi
  printf "."
  sleep 0.5
done

echo ""
echo "  API: $API_URL"
echo "  UI:  $NG_URL"
echo ""

wait
