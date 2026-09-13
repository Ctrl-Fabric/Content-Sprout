# Content-Sprout

**Ctrl-Fabric** product: desktop studio for social content, plus marketing site.

| Folder | Contents |
|--------|----------|
| [`../Services/content-sprout-service/`](../Services/content-sprout-service/) | Application (Python API, Angular UI, macOS packaging) |
| [`../UI/content-sprout-ui/`](../UI/content-sprout-ui/) | Marketing / download site (Angular + Firebase) |

## Quick links

- App docs: [`../Services/content-sprout-service/README.md`](../Services/content-sprout-service/README.md)
- Daily commands: [`../Services/content-sprout-service/COMMANDS.md`](../Services/content-sprout-service/COMMANDS.md)
- Landing preview / deploy: [`../UI/content-sprout-ui/README.md`](../UI/content-sprout-ui/README.md)

## Layout

```text
ctrl-fabric/
  Services/content-sprout-service/  # studio + local API
  UI/content-sprout-ui/             # public site
```

## Git

Filesystem layout is under Ctrl-Fabric branding. A dedicated git repository for this umbrella (or consolidated service + landing) will be created separately; do not assume a single remote at this folder root yet. The existing service history remains in `Services/content-sprout-service/.git` until that consolidation happens.

## License

Proprietary — [Ctrlfabric Guardlabs Private Limited](https://ctrlfabric.com). See [`../Services/content-sprout-service/LICENSE`](../Services/content-sprout-service/LICENSE).
