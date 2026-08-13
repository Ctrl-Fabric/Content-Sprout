#!/usr/bin/env bash
# Build macOS DMG/ZIP and publish them to a GitHub Release.
# Usage: ./scripts/release-macos.sh v0.1.0 ["Optional release notes"]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-}"
NOTES="${2:-macOS desktop build (Content-sprout.app, ZIP, DMG).}"
REPO="sridhar8303/content-sprout"
DMG="$ROOT/dist/macos/content-sprout-macos.dmg"
ZIP="$ROOT/dist/macos/content-sprout-macos.zip"

if [[ -z "$TAG" ]]; then
  echo "Usage: $0 <tag> [release notes]" >&2
  echo "Example: $0 v0.1.0" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS packaging must run on a Mac." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required. Install: brew install gh && gh auth login" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install: https://github.com/astral-sh/uv" >&2
  exit 1
fi

echo "==> Building macOS packages"
chmod +x "$ROOT/packaging/macos/build.sh"
"$ROOT/packaging/macos/build.sh"

if [[ ! -f "$DMG" || ! -f "$ZIP" ]]; then
  echo "Expected artifacts missing:" >&2
  echo "  $DMG" >&2
  echo "  $ZIP" >&2
  exit 1
fi

echo "==> Publishing GitHub release $TAG"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists — uploading assets (clobber)."
  gh release upload "$TAG" "$DMG" "$ZIP" --repo "$REPO" --clobber
else
  gh release create "$TAG" "$DMG" "$ZIP" \
    --repo "$REPO" \
    --title "Content-Sprout ${TAG#v}" \
    --notes "$NOTES"
fi

echo ""
echo "Done."
echo "  DMG: https://github.com/${REPO}/releases/download/${TAG}/content-sprout-macos.dmg"
echo "  Latest: https://github.com/${REPO}/releases/latest/download/content-sprout-macos.dmg"
