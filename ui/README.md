# Content-Sprout Angular UI

Primary browser UI for Content-Sprout (Media Studio).

## Dev

From the Content-Sprout repo root (recommended):

```bash
./start-ui.sh
```

That starts:

| Process | URL |
|---|---|
| FastAPI API (+ watcher) | http://127.0.0.1:17829 |
| **Angular** UI (this app) | http://127.0.0.1:4210 |

Angular proxies `/api` to the FastAPI server. Open the Angular URL, not the API port.

Angular only (API already running on `:17829`):

```bash
cd ui
npm install
npm start
```

## Shared UI (required)

**`ui-shared` is a required dependency.** This Angular app will not build or
start without it.

It is consumed as source via the `shared/ui` TypeScript path alias (plus
`link-shared-ui-deps`). A convenience symlink `../ui-shared` →
`../../../UI/ui-shared` should be present. Confirm with `ls ../ui-shared`.

## Production bundle

```bash
cd ui && npm run build
```

Output: `ui/dist/content-sprout-angular/browser/`. Packaged macOS builds copy this into
`src/content_sprout/ui_dist/` so FastAPI can serve the UI on the API port.

## Routes

- `/media-studio` — Media Studio
- `/personal-media` — Personal Media
- `/global-resources` — Global Resources
- `/settings` — Settings
