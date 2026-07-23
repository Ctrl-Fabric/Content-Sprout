# Content-sprout landing (Angular + Firebase)

Marketing / download site for Content-sprout. **Not** part of the Ctrl-Fabric Website — same pattern as Timeline Generator.

## Preview locally

```bash
cd personal_projects/Content-Sprout/landing
npm install
npm start
```

Open [http://localhost:4202](http://localhost:4202).

## Deploy to Firebase

See [DEPLOY.md](./DEPLOY.md). Short version:

```bash
npm run deploy
```

## Downloads

macOS ZIP/DMG are **not** bundled in the Angular/Firebase build.
The landing page links to [GitHub Releases](https://github.com/Ctrl-Fabric/Content-Sprout/releases).
Publish packages with `../scripts/release-macos.sh <tag>`.

Brand logos:

- `public/assets/brand-logo-light.png` — for dark backgrounds
- `public/assets/brand-logo-dark.png` — for light backgrounds
- `public/assets/favicon.png` — tab / apple-touch icon (`logos/content_sprout_icon_only.png`)

Theme preference is stored as `content-sprout.theme` in localStorage (shared with the desktop app UI).

## Legacy static page

The previous plain HTML/CSS landing is kept under `legacy-static/` for reference.
