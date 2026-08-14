# shared/ui — vendored UI library (Content-Sprout)

Framework-only Angular standalone components used by the Content-Sprout studio.
This copy lives **inside** the Content-Sprout project (`ui-shared/`) so the app
builds without depending on the monorepo `UI/ui-shared` tree.

There is **no published package and no separate build step**. The Angular app
imports the source via the `shared/ui` TypeScript path alias and compiles it
into its own bundle. Hosts supply company/legal contact at runtime with
`provideCompanyContact`.

## Consumed by

`ui/` (Media Studio). Path alias:

```json
"paths": {
  "shared/ui": ["../ui-shared/src/index.ts"]
}
```

Peer Angular / RxJS packages are linked from `ui/node_modules` into
`ui-shared/node_modules` by `ui/scripts/link-shared-ui-deps.mjs` (runs on
`postinstall` / `prestart` / `prebuild`).

## Styles (required in `ui/src/styles.scss`)

```scss
@use '../../ui-shared/src/styles/identity-console' as console;
@use '../../ui-shared/src/styles/components/service-layout';
```

## Product chrome

| Export | Role |
|--------|------|
| `ServiceSideRailComponent` | 68px icon rail + glass flyouts |
| `ServiceConsoleHeaderComponent` | Console header (title, tenant chip, user menu) |
| `FooterComponent` | 32px footer |
| `PageWrapperComponent` | Page content wrapper |
| `Modal` / `ModalWrapperComponent` / dialogs | Overlays |
| `SnackbarService` | Toasts |

See `src/index.ts` for the full public surface.
