# Content-sprout landing page

Standalone marketing / download page for Content-sprout. **Not** part of the Ctrl-Fabric Website.

## Preview locally

```bash
cd landing
python3 -m http.server 8765
```

Open [http://localhost:8765](http://localhost:8765).

## Downloads

macOS ZIP/DMG builds from `packaging/macos/build.sh` are copied into `downloads/`.
Those binaries are gitignored — rebuild or copy them locally when needed.

Brand logos (source of truth in `../logos/`):
- `brand-logo-light.png` — for dark backgrounds
- `brand-logo-dark.png` — for light backgrounds

Theme preference is stored as `content-sprout.theme` in localStorage (shared with the app UI).
