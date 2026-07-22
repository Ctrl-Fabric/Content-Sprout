# Daily Operations

This is the day-to-day playbook for Content-Sprout. It assumes you have
already finished the one-time setup in
[`GETTING_STARTED.md`](GETTING_STARTED.md) (Homebrew, Ollama, Gemma 4, `uv`,
`uv sync`, and your two logo PNGs are in place).

If you have **not** done those steps yet, start with `GETTING_STARTED.md` —
this document will not work without them.

---

## TL;DR — the one command to remember

```bash
cd /Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout
./start.sh
```

That single script:

1. Confirms Ollama is running (and starts it via `brew services` if not).
2. Waits for the Ollama API to respond.
3. Runs `content-sprout doctor` so any missing piece is surfaced before processing.
4. Launches `content-sprout watch` so you can just drop photos into `input/`.

Drop photos into `input/`, grab the finished images from `output/`, and press
`Ctrl + C` in the terminal when you're done for the day.

---

## Web UI (recommended day-to-day)

`./start-ui.sh` is the one command to remember when you want the UI. It
starts the watcher and the UI together, then opens the UI in your browser:

```bash
./start-ui.sh                      # → http://127.0.0.1:17829
CONTENT_SPROUT_PORT=20000 ./start-ui.sh # override port
```

`Ctrl+C` in that terminal stops both processes.

What the UI gives you:

- **Drop files into `input/`** via a drag-and-drop zone (whole folders work
  too — relative paths are preserved).
- **Live processing state** — a spinner + indigo pulse highlights any file
  currently being worked on (the watcher processes them one at a time).
- **Browse `output/`** by group, with thumbnails, a per-group `.zip`
  download, per-file downloads, and the rendered `manifest.json`.
- **Clear all** buttons to wipe `input/` or `output/` (preserves `.gitkeep`).

> A safety net: `content-sprout watch` refuses to start if another live watcher
> holds `cache/watcher.pid`, so running `./start-ui.sh` while `./start.sh`
> is already running just prints a clear error instead of double-processing.

Just the UI, no watcher (rare):

```bash
uv run content-sprout serve --port 17829
```

Options on `serve`: `--port 17829`, `--host 0.0.0.0` (LAN-accessible),
`--reload` (dev).

---

## The startup script

Location: `start.sh` in the project root.

| Command | What it does |
|---------|--------------|
| `./start.sh` | (default) Health checks + watch mode. |
| `./start.sh watch` | Same as default — explicit. |
| `./start.sh run` | Health checks + one-shot batch over `input/`. |
| `./start.sh check` | Health checks only — exits after `doctor` passes. |

The script is idempotent. Running it when Ollama is already up is a no-op for
the service, so feel free to run it whenever.

---

## Daily workflow — watch mode (recommended)

Watch mode is the fastest way to work: leave one terminal open, drag photos
into Finder, finished posts appear in `output/` within seconds.

### Start the day

```bash
cd /Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout
./start.sh
```

You should see:

```
→ Content-Sprout daily startup
  Project: /Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout
  Mode:    watch

✓ Ollama is already running

→ Running content-sprout doctor
  ✓ Logos found (logo_dark.png, logo_white.png)
  ✓ Ollama reachable, 'gemma4:31b' available.

→ Starting watch mode (Ctrl+C to stop)
  Drop photos into:  .../input
  Find results in:   .../output
Watching .../input (debounce 1.5s, Ctrl+C to stop)
  Processed → .done/   Failed → .failed/
```

### Process photos

In Finder, drag photos (or whole folders) into:

```
input/
```

Within ~2 seconds the watcher picks each one up. When the bar settles, the
finished assets are at:

```
output/<photo-name>/
├── square.jpg       (1080 × 1080)
├── portrait.jpg     (1080 × 1350)
├── landscape.jpg    (1080 × 566)
├── story.jpg        (1080 × 1920)
└── manifest.json
```

Originals are moved to `input/.done/<same-relative-path>` so they don't get
reprocessed.

### Stop the day

Press `Ctrl + C` in the terminal running `start.sh`. Ollama keeps running as
a background service — that's fine; it idles at near-zero CPU until next time.

---

## Daily workflow — one-shot batch mode

Use this when you want to dump a folder of photos and walk away.

```bash
cd /Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout

# Drop photos into input/ first, then:
./start.sh run
```

Or point at any folder explicitly (no need to copy anything into `input/`):

```bash
uv run content-sprout run /path/to/some/pictures
```

The script exits when the batch finishes. Each photo takes ~2–5 seconds
(15s if Gemma 4 has to look at it).

---

## Quick reference

| Task | Command |
|------|---------|
| Start everything (watch mode) | `./start.sh` |
| One-shot batch over `input/` | `./start.sh run` |
| Just verify health | `./start.sh check` |
| Watch a custom folder | `uv run content-sprout watch /path/to/folder` |
| Process a custom folder once | `uv run content-sprout run /path/to/folder` |
| Re-run a photo (forget cached decision) | Delete its line from `cache/decisions.jsonl`, drop it back into `input/` |
| Restart Ollama | `brew services restart ollama` |
| Stop Ollama (rare) | `brew services stop ollama` |

---

## Troubleshooting on a normal day

### `start.sh` says "Ollama did not come up"

```bash
brew services restart ollama
sleep 5
./start.sh
```

If it still fails, check Ollama is installed: `which ollama`. If missing,
return to `GETTING_STARTED.md` Part 3.

### `doctor` reports the model is missing

Gemma updates rarely, but if you see `'gemma4:31b' not pulled yet`:

```bash
ollama pull gemma4:31b
./start.sh
```

### A photo isn't being picked up by watch mode

- Confirm the file extension: `.jpg`, `.jpeg`, `.png`, `.webp`, `.heic`, `.tiff`.
- Wait 2 seconds — there's a debounce.
- Check `input/.failed/` for a `.error.txt` sidecar explaining the problem.

### Output looks wrong

Open the photo's `manifest.json` in `output/<photo-name>/`. It records which
corner the logo went into, whether the heuristic or Gemma 4 decided, and the
story fit mode used. Tweak `config.yaml` if you want different defaults; see
`README.md` for the full list of knobs.

### "It's slow" / "memory pressure is high"

Switch to the smaller model:

```yaml
# config.yaml
ollama:
  model: gemma4:e4b
```

```bash
ollama pull gemma4:e4b
./start.sh
```

About 4× faster, much lower RAM. Quality is still strong for this task.

---

## What's next?

- Full setup walkthrough → [`GETTING_STARTED.md`](GETTING_STARTED.md)
- Architecture, config knobs, and CLI reference → [`README.md`](README.md)
