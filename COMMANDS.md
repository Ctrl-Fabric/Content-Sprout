# Handy commands — Content-Sprout

Copy-paste recipes for day-to-day work. Run all commands from the **repo root**
unless a block `cd`s into `landing/`.

Repo: https://github.com/Ctrl-Fabric/Content-Sprout  
Landing: https://content-sprout.ctrlfabric.com  
Firebase project: `content-sprout`

---

## 1. Run the project locally

### One-shot (watcher + web UI)

```bash
./start-ui.sh
# → http://127.0.0.1:17829
```

Override port:

```bash
CONTENT_SPROUT_PORT=20000 ./start-ui.sh
```

### Web UI only

```bash
uv sync
uv run content-sprout serve --host 127.0.0.1 --port 17829
```

### Batch watch only

```bash
./start.sh
# or: uv run content-sprout watch
```

### Landing page (Angular) locally

```bash
cd landing
npm install
npm start
# → http://127.0.0.1:4202
```

### Sanity check

```bash
uv run content-sprout doctor
```

---

## 2. Generate a DMG and publish to GitHub Releases

Requires: macOS, [`uv`](https://github.com/astral-sh/uv), [`gh`](https://cli.github.com/) logged in (`gh auth login`).

### Automated (recommended)

```bash
# Tag version is required — use SemVer matching the release you want
./scripts/release-macos.sh v0.1.0
```

That script:

1. Runs `packaging/macos/build.sh` → `Content-sprout.app`, ZIP, and DMG  
2. Creates (or updates) a GitHub Release for the tag  
3. Uploads `content-sprout-macos.dmg` and `content-sprout-macos.zip`

### Manual steps

```bash
# Build
chmod +x packaging/macos/build.sh
./packaging/macos/build.sh

# Artifacts
ls -lh dist/macos/content-sprout-macos.dmg dist/macos/content-sprout-macos.zip

# Create release + upload (example tag)
gh release create v0.1.0 \
  dist/macos/content-sprout-macos.dmg \
  dist/macos/content-sprout-macos.zip \
  --repo Ctrl-Fabric/Content-Sprout \
  --title "Content-Sprout v0.1.0" \
  --notes "macOS desktop build."
```

If the tag/release already exists and you only need to replace assets:

```bash
gh release upload v0.1.0 \
  dist/macos/content-sprout-macos.dmg \
  dist/macos/content-sprout-macos.zip \
  --repo Ctrl-Fabric/Content-Sprout \
  --clobber
```

Stable download URLs after publish:

- https://github.com/Ctrl-Fabric/Content-Sprout/releases/latest/download/content-sprout-macos.dmg
- https://github.com/Ctrl-Fabric/Content-Sprout/releases/latest/download/content-sprout-macos.zip

> Build on the Mac architecture you ship (Apple Silicon vs Intel). First open of an unsigned app: right-click → **Open**.

---

## 3. Deploy the landing page to Firebase

Firebase Hosting project: **`content-sprout`** (see `landing/.firebaserc`).  
Web SDK + Analytics config lives in `landing/src/app/firebase/firebase.config.ts`.

### One-time (per machine)

```bash
cd landing
npm install
npx firebase login
npx firebase use content-sprout
```

Enable **Hosting** in the [Firebase Console](https://console.firebase.google.com/project/content-sprout/hosting) if you have not already.

### Deploy (build + Hosting)

```bash
cd landing
npm run deploy
```

`npm run deploy` runs `ng build` then `firebase deploy --only hosting`.

Downloads on the site link to [GitHub Releases](https://github.com/Ctrl-Fabric/Content-Sprout/releases) — no ZIP/DMG in the Firebase deploy. Publish packages separately with `./scripts/release-macos.sh <tag>`.

### Deploy only (already built)

```bash
cd landing
npm run build
npx firebase deploy --only hosting
```

### After deploy

- https://content-sprout.web.app  
- https://content-sprout.firebaseapp.com  
- Custom domain (when DNS is set): https://content-sprout.ctrlfabric.com  

More detail: [`landing/DEPLOY.md`](landing/DEPLOY.md).

---

## Quick reference

| Goal | Command |
|------|---------|
| Run app locally | `./start-ui.sh` |
| Landing locally | `cd landing && npm start` |
| Build DMG + GitHub release | `./scripts/release-macos.sh vX.Y.Z` |
| Deploy landing | `cd landing && npm run deploy` |


Examples 
# 1. App locally
./start-ui.sh
# 2. DMG → GitHub Release
./scripts/release-macos.sh v0.1.0
# 3. Landing → Firebase
cd landing && npm run deploy