#!/usr/bin/env bash
# Content-Sprout daily startup script.
#
# Brings up everything needed to process photos:
#   1. Ensures Ollama is running (starts the brew service if not).
#   2. Waits for the Ollama HTTP API to respond.
#   3. Runs `content-sprout doctor` so any missing piece is reported up-front.
#   4. Launches `content-sprout watch` so you can drop photos into input/.
#
# Usage:
#   ./start.sh            # default — launches watch mode
#   ./start.sh run        # one-shot batch instead of watch mode
#   ./start.sh check      # just run doctor and exit
#
# Press Ctrl+C to stop watch mode.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLLAMA_URL="http://localhost:11434"
MODE="${1:-watch}"

cd "$PROJECT_DIR"

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }

bold "→ Content-Sprout daily startup"
echo  "  Project: $PROJECT_DIR"
echo  "  Mode:    $MODE"
echo

# 1. Make sure Ollama is reachable. If not, try to start it via brew services.
if curl -fsS --max-time 2 "$OLLAMA_URL" >/dev/null 2>&1; then
    green "✓ Ollama is already running"
else
    yellow "! Ollama not reachable, starting brew service..."
    if ! command -v brew >/dev/null 2>&1; then
        red "✗ Homebrew not found. See GETTING_STARTED.md → Part 2."
        exit 1
    fi
    brew services start ollama >/dev/null

    # 2. Wait up to ~30s for Ollama to come online.
    printf "  Waiting for Ollama"
    for _ in $(seq 1 30); do
        if curl -fsS --max-time 1 "$OLLAMA_URL" >/dev/null 2>&1; then
            echo
            green "✓ Ollama is up"
            break
        fi
        printf "."
        sleep 1
    done
    if ! curl -fsS --max-time 1 "$OLLAMA_URL" >/dev/null 2>&1; then
        echo
        red "✗ Ollama did not come up. Try: brew services restart ollama"
        exit 1
    fi
fi

# 3. Verify project health before launching anything heavy.
echo
bold "→ Running content-sprout doctor"
if ! uv run content-sprout doctor; then
    red "✗ doctor reported a problem. Fix it, then re-run ./start.sh"
    exit 1
fi

# 4. Launch the requested mode.
echo
case "$MODE" in
    watch)
        bold "→ Starting watch mode (Ctrl+C to stop)"
        echo  "  Drop photos into:  $PROJECT_DIR/input"
        echo  "  Find results in:   $PROJECT_DIR/output"
        echo
        exec uv run content-sprout watch
        ;;
    run)
        bold "→ Running one-shot batch"
        exec uv run content-sprout run
        ;;
    check)
        green "✓ All checks passed."
        ;;
    *)
        red "Unknown mode '$MODE'. Use: watch | run | check"
        exit 1
        ;;
esac
