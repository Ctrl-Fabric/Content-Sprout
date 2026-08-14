# macOS desktop packaging

Build a double-clickable **Content-sprout.app**, plus ZIP and DMG
artifacts for **GitHub Releases** (the landing page links there; binaries
are not copied into the Angular/Firebase build).

## Prerequisites (build machine)

- macOS (Apple Silicon or Intel — build on the arch you ship)
- [`uv`](https://github.com/astral-sh/uv)
- Project deps already syncable (`uv sync`)

## Build

```bash
cd Content-Sprout   # repo root
chmod +x packaging/macos/build.sh
./packaging/macos/build.sh
```

Outputs:

- `dist/macos/Content-sprout.app`
- `dist/macos/content-sprout-macos.zip`
- `dist/macos/content-sprout-macos.dmg`

## Publish on GitHub Releases

```bash
./scripts/release-macos.sh v0.1.0
```

Or attach `content-sprout-macos.dmg` and `content-sprout-macos.zip` manually to a
[GitHub Release](https://github.com/sridhar8303/content-sprout/releases)
(do not commit the binaries). See the main README
[Build instructions](../../README.md#build-instructions-macos-app--dmg).

## Runtime notes

- User data lives in `~/Library/Application Support/Content-Sprout/SocialMediaPostGenerator/`
- **ffmpeg** must be installed on the Mac for video export (`brew install ffmpeg`)
- LLM is optional; default packaged config uses built-in placement (no AI service)
- First open may require right-click → **Open** (unsigned app)

## Signing (optional)

```bash
codesign --deep --force --options runtime \
  --sign "Developer ID Application: YOUR NAME" \
  "dist/macos/Content-sprout.app"
```
