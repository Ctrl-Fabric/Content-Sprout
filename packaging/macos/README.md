# macOS desktop packaging

Build a double-clickable **Content-sprout.app**, plus ZIP and DMG
artifacts for the landing page downloads.

## Prerequisites (build machine)

- macOS (Apple Silicon or Intel — build on the arch you ship)
- [`uv`](https://github.com/astral-sh/uv)
- Project deps already syncable (`uv sync`)

## Build

```bash
cd personal_projects/Content-Sprout
chmod +x packaging/macos/build.sh
./packaging/macos/build.sh
```

Outputs:

- `dist/macos/Content-sprout.app`
- `dist/macos/content-sprout-macos.zip`
- `dist/macos/content-sprout-macos.dmg`

Copies are also written to:

- `landing/public/downloads/` (Content-sprout Angular landing → Firebase Hosting; not part of Ctrl-Fabric Website)

## Runtime notes

- User data lives in `~/Library/Application Support/CtrlFabric/SocialMediaPostGenerator/`
- **ffmpeg** must be installed on the Mac for video export (`brew install ffmpeg`)
- LLM is optional; default packaged config uses built-in placement (no AI service)
- First open may require right-click → **Open** (unsigned app)

## Signing (optional)

```bash
codesign --deep --force --options runtime \
  --sign "Developer ID Application: YOUR NAME" \
  "dist/macos/Content-sprout.app"
```
