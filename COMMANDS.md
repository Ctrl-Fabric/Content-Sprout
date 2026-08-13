# Handy commands — Content-Sprout

Copy-paste recipes for day-to-day work. Run all commands from the **app repo root**
(`utility_apps/ContentSprout`) unless a block `cd`s elsewhere.

Repo: https://github.com/sridhar8303/content-sprout  
Landing site: https://content-sprout.ctrlfabric.com  
Landing project: `../ContentSproutLanding`  
Firebase project: `content-sprout`

---

## 1. Run the project locally

### One-shot (watcher + API + Angular UI)

```bash
./start-ui.sh
# → API: http://127.0.0.1:17829
# → UI:  http://127.0.0.1:4210
```

Override ports:

```bash
CONTENT_SPROUT_PORT=20000 CONTENT_SPROUT_NG_PORT=4211 ./start-ui.sh
```

Note: the Angular `environment.mediaBase` defaults to API port **17829**.
If you change `CONTENT_SPROUT_PORT`, update `ui/src/environments/environment.ts`
(or keep 17829). `ui/proxy.conf.js` follows `NG_PROXY_TARGET` / `CONTENT_SPROUT_PORT`
via `start-ui.sh`.

### Angular UI only

```bash
# Terminal A — API
uv run content-sprout serve --host 127.0.0.1 --port 17829

# Terminal B — Angular (proxies /api → :17829)
cd ui && npm install && npm start
# → http://127.0.0.1:4210
```

### Batch watch only

```bash
./start.sh
# or: uv run content-sprout watch
```

### Landing page (Angular) locally

```bash
cd ../ContentSproutLanding
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
  --repo sridhar8303/content-sprout \
  --title "Content-Sprout v0.1.0" \
  --notes "macOS desktop build."
```

If the tag/release already exists and you only need to replace assets:

```bash
gh release upload v0.1.0 \
  dist/macos/content-sprout-macos.dmg \
  dist/macos/content-sprout-macos.zip \
  --repo sridhar8303/content-sprout \
  --clobber
```

Stable download URLs after publish:

- https://github.com/sridhar8303/content-sprout/releases/latest/download/content-sprout-macos.dmg
- https://github.com/sridhar8303/content-sprout/releases/latest/download/content-sprout-macos.zip

> Build on the Mac architecture you ship (Apple Silicon vs Intel). First open of an unsigned app: right-click → **Open**.

---

## 3. Deploy the landing page to Firebase

The marketing site lives in **`../ContentSproutLanding`** (sibling of this app).

Firebase Hosting project: **`content-sprout`** (see `../ContentSproutLanding/.firebaserc`).  
Web SDK + Analytics config: `../ContentSproutLanding/src/app/firebase/firebase.config.ts`.

### One-time (per machine)

```bash
cd ../ContentSproutLanding
npm install
npx firebase login
npx firebase use content-sprout
```

Enable **Hosting** in the [Firebase Console](https://console.firebase.google.com/project/content-sprout/hosting) if you have not already.

### Deploy (build + Hosting)

```bash
cd ../ContentSproutLanding
npm run deploy
```

`npm run deploy` runs `ng build` then `firebase deploy --only hosting`.

Downloads on the site link to [GitHub Releases](https://github.com/sridhar8303/content-sprout/releases) — no ZIP/DMG in the Firebase deploy. Publish packages separately with `./scripts/release-macos.sh <tag>`.

### Deploy only (already built)

```bash
cd ../ContentSproutLanding
npm run build
npx firebase deploy --only hosting
```

### After deploy

- https://content-sprout.web.app  
- https://content-sprout.firebaseapp.com  
- Custom domain (when DNS is set): https://content-sprout.ctrlfabric.com  

More detail: [`../ContentSproutLanding/DEPLOY.md`](../ContentSproutLanding/DEPLOY.md).

---

## Quick reference

| Goal | Command |
|------|---------|
| Run app locally | `./start-ui.sh` |
| Landing locally | `cd ../ContentSproutLanding && npm start` |
| Build DMG + GitHub release | `./scripts/release-macos.sh vX.Y.Z` |
| Deploy landing | `cd ../ContentSproutLanding && npm run deploy` |


Examples 
# 1. App locally
./start-ui.sh
# 2. DMG → GitHub Release
./scripts/release-macos.sh v0.1.0
# 3. Landing → Firebase
cd ../ContentSproutLanding && npm run deploy