#!/usr/bin/env bash
# Launch the watcher + the web UI, then open the UI in your browser.
# Ctrl+C in this terminal stops both.
# Port 17829 is chosen to avoid common dev-server clashes.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CONTENT_SPROUT_PORT:-17829}"
URL="http://127.0.0.1:${PORT}"

cd "$PROJECT_DIR" || exit 1

# Backstop: if Ctrl+C doesn't propagate, sweep any leftover content-sprout processes.
trap 'pkill -f "content-sprout (watch|serve)" 2>/dev/null; exit 0' INT TERM EXIT

uv run content-sprout watch &
uv run content-sprout serve --port "$PORT" &

printf "Waiting for UI at %s " "$URL"
for _ in $(seq 1 40); do
    if curl -fsS --max-time 1 "$URL/api/config" >/dev/null 2>&1; then
        echo " ready."
        open "$URL"
        break
    fi
    printf "."
    sleep 0.25
done

wait
