#!/usr/bin/env bash
# Build Content-sprout for macOS (.app + .zip + .dmg).
# Usage: ./packaging/macos/build.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_DIR="$PROJECT_DIR/packaging/macos"
DIST_DIR="$PROJECT_DIR/dist/macos"
STAGING="$DIST_DIR/staging"
APP_NAME="Content-sprout"
APP_BUNDLE="$DIST_DIR/${APP_NAME}.app"
ZIP_NAME="content-sprout-macos.zip"
DMG_NAME="content-sprout-macos.dmg"

echo "==> Cleaning $DIST_DIR"
rm -rf "$DIST_DIR"
mkdir -p "$STAGING/app" "$DIST_DIR"

echo "==> Syncing production dependencies into staging venv"
cd "$PROJECT_DIR"
uv sync --no-dev --frozen

echo "==> Building Angular UI for packaged serve"
if [[ ! -d ui/node_modules ]]; then
  (cd ui && npm install)
fi
(cd ui && npm run build)
rm -rf src/content_sprout/ui_dist
mkdir -p src/content_sprout/ui_dist
rsync -a ui/dist/content-sprout-angular/browser/ src/content_sprout/ui_dist/

# Copy runtime payload
echo "==> Copying application files"
rsync -a \
  --exclude='.venv' \
  --exclude='.pytest_cache' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='cache/' \
  --exclude='input/' \
  --exclude='output/' \
  --exclude='projects/' \
  --exclude='dist/' \
  --exclude='.git' \
  --exclude='tests/' \
  --exclude='node_modules/' \
  --exclude='ui/node_modules/' \
  --exclude='ui/.angular/' \
  "$PROJECT_DIR/" "$STAGING/app/"

# Keep a clean default config for first launch (heuristic-only, no secrets)
cat > "$STAGING/app/config.yaml" <<'YAML'
input_dir: input
output_dir: output
projects_dir: projects
cache_dir: cache
scripts_dir: scripts
logo_dark: assets/logo_dark.png
logo_white: assets/logo_white.png
formats:
  - square
  - portrait
  - landscape
  - story
jpeg_quality: 92
story:
  fit_mode: blur_pad
  blur_radius: 60
write_manifest: true
router:
  heuristic_confidence_min: 0.85
  heuristic_gap_min: 0.20
  llm_on_failure: use_heuristic
llm:
  provider: heuristic_only
ollama:
  host: http://localhost:11434
  model: gemma4:31b
  timeout_s: 60
  num_ctx: 4096
llm_proxy:
  base_url: https://api.portkey.ai/v1
  api_key: ""
  model: gpt-4o
  timeout_s: 60
  portkey_provider: ""
  portkey_virtual_key: ""
watch:
  debounce_s: 1.5
  settle_checks: 2
  settle_interval_s: 0.5
logo:
  padding_pct: 4.0
  width_pct: 12.0
  opacity: 0.95
  shadow: false
instagram:
  enabled: false
YAML

mkdir -p "$STAGING/app/input" "$STAGING/app/output" "$STAGING/app/projects" "$STAGING/app/cache" "$STAGING/app/assets"
touch "$STAGING/app/input/.gitkeep" "$STAGING/app/output/.gitkeep"

# Copy the project's uv-managed venv into the bundle (portable enough for same-arch Macs)
echo "==> Bundling Python virtualenv (this may take a minute)"
rsync -a --delete \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache' \
  "$PROJECT_DIR/.venv/" "$STAGING/venv/"

# Rewrite venv shebangs / pyvenv.cfg to use relative paths via launcher
VENV_PY="$STAGING/venv/bin/python"

echo "==> Assembling .app bundle"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

cp "$PKG_DIR/Info.plist" "$APP_BUNDLE/Contents/Info.plist"
cp "$PKG_DIR/launcher.py" "$APP_BUNDLE/Contents/Resources/launcher.py"

# Move payload into Resources
mv "$STAGING/app" "$APP_BUNDLE/Contents/Resources/app"
mv "$STAGING/venv" "$APP_BUNDLE/Contents/Resources/venv"

# Launcher shell script — uses bundled venv python
cat > "$APP_BUNDLE/Contents/MacOS/SocialMediaPostGenerator" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES="$ROOT/Resources"
export PYTHONPATH="$RESOURCES/app/src${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1

# Prefer bundled venv python
PY="$RESOURCES/venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "Bundled Python missing at $PY" >&2
  exit 1
fi

# Ensure venv points at a usable interpreter (homebrew/uv may have absolute paths)
exec "$PY" "$RESOURCES/launcher.py"
LAUNCH
chmod +x "$APP_BUNDLE/Contents/MacOS/SocialMediaPostGenerator"

# Fix venv pyvenv.cfg home if needed — leave as-is; python binary is in venv

# Minimal app icon placeholder (optional)
if [[ -f "$PKG_DIR/AppIcon.icns" ]]; then
  cp "$PKG_DIR/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
fi

echo "==> Creating ZIP"
cd "$DIST_DIR"
rm -f "$ZIP_NAME"
ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" "$ZIP_NAME"

echo "==> Creating DMG"
DMG_STAGING="$DIST_DIR/dmg-root"
rm -rf "$DMG_STAGING" "$DIST_DIR/$DMG_NAME"
mkdir -p "$DMG_STAGING"
cp -R "$APP_BUNDLE" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"

hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$DMG_STAGING" \
  -ov -format UDZO \
  "$DIST_DIR/$DMG_NAME"

rm -rf "$DMG_STAGING" "$STAGING"

echo ""
echo "Done."
echo "  App:  $APP_BUNDLE"
echo "  ZIP:  $DIST_DIR/$ZIP_NAME"
echo "  DMG:  $DIST_DIR/$DMG_NAME"
echo "  Publish with: ./scripts/release-macos.sh <tag>"
ls -lh "$DIST_DIR/$ZIP_NAME" "$DIST_DIR/$DMG_NAME"
