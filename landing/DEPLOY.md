# Deploy Content-sprout landing to Firebase Hosting

This app is a static Angular SPA. Firebase Hosting serves the production build from `dist/content-sprout/browser/`. No Cloud Functions or backend are required.

## Prerequisites

1. A [Firebase](https://console.firebase.google.com/) project (create one named e.g. `content-sprout`)
2. Node.js 20+ and npm
3. Firebase CLI access (installed locally via this repo’s `firebase-tools` dependency)

## One-time setup

### 1. Install dependencies

```bash
cd personal_projects/Content-Sprout/landing
npm install
```

### 2. Log in to Firebase

```bash
npx firebase login
```

### 3. Create / link Firebase project

`.firebaserc` defaults to project id **`content-sprout`**. Create that project in the Firebase Console (or pick another id), then:

```bash
npx firebase use --add
```

Register a **Web app** in Project settings and paste the SDK config into:

`src/app/firebase/firebase.config.ts`

Until real credentials are set, Hosting still deploys; Analytics is skipped.

### 4. Enable Hosting

In the Firebase Console → your project → **Hosting** → get started (if Hosting is not already enabled).

When using `npx firebase init hosting` (skip if `firebase.json` already exists):

| Prompt | Value |
| --- | --- |
| Public directory | `dist/content-sprout/browser` |
| Single-page app | Yes |
| Overwrite `index.html` | No |

## Deploy

Build and deploy in one step:

```bash
npm run deploy
```

This runs `npm run build` then `firebase deploy --only hosting`.

Copy macOS ZIP/DMG into `public/downloads/` first (via `../packaging/macos/build.sh`) so download links work on the live site.

### Deploy only (if you already built)

```bash
npm run build
npx firebase deploy --only hosting
```

## After deploy

Default Hosting URLs (once the Firebase project exists):

- https://content-sprout.web.app
- https://content-sprout.firebaseapp.com

### Custom domain: `content-sprout.ctrlfabric.com` (GoDaddy)

1. Deploy the site first (`npm run deploy`).
2. In Firebase Console → **Hosting** → **Add custom domain** → `content-sprout.ctrlfabric.com`.
3. Add the DNS records Firebase shows in GoDaddy for `ctrlfabric.com`.
4. Wait until status is **Connected**, then open https://content-sprout.ctrlfabric.com.

Canonical URL / SEO copy lives in `src/app/app.properties.ts`. Keep `src/index.html`, `public/sitemap.xml`, and `public/robots.txt` aligned.

## Local preview

```bash
npm start
# → http://localhost:4202
```

Production build locally:

```bash
npm run build
npx firebase emulators:start --only hosting
```

## AdSense

1. Add the live Hosting / custom domain in AdSense.
2. `adsEnabled` and publisher id live in `src/app/app.properties.ts` / `src/app/ads/ads.config.ts`.
3. Optionally create Display units and put slot IDs in `ads.config.ts`.
4. Redeploy with `npm run deploy`.

## Troubleshooting

| Issue | Fix |
| --- | --- |
| `Firebase project not found` | Create the project or run `npx firebase use --add` |
| Empty / 404 site | Confirm `dist/content-sprout/browser/` has files after `npm run build` |
| Download 404 | Run packaging build so ZIP/DMG land in `public/downloads/` |
| Auth errors | `npx firebase login` again |
