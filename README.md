# Content-Sprout

**Free and open-source** tools for creating Instagram-ready images and short-form videos — locally on your machine.

Drop photos into a folder for batch processing, or use the project-based web editor to build multi-scene video posts with layers, timing, text-to-speech, reusable clips, and exports. Optional local AI (via [Ollama](https://ollama.com)) helps with logo placement and layout; cloud LLMs are optional and never required.

| | |
|---|---|
| **License** | [MIT](LICENSE) — free to use, modify, and share |
| **Python** | 3.11+ |
| **Platform** | macOS (primary; Apple Silicon recommended), Linux with caveats |
| **Cost to run** | $0 core features (local TTS on macOS, local heuristics). Optional Ollama models use your disk/RAM only. |
| **macOS app** | [Download DMG](https://github.com/Ctrl-Fabric/Content-Sprout/releases/latest/download/content-sprout-macos.dmg) · [All releases](https://github.com/Ctrl-Fabric/Content-Sprout/releases) |

> **New to this project?** Start with [`GETTING_STARTED.md`](GETTING_STARTED.md) (beginner setup) and [`DAILY.md`](DAILY.md) (everyday commands).  
> **Handy copy-paste recipes?** See [`COMMANDS.md`](COMMANDS.md) (run locally · DMG + GitHub Release · deploy landing).  
> **Publishing to Instagram?** See [`INSTAGRAM_SETUP.md`](INSTAGRAM_SETUP.md).

---

## Table of contents

1. [Why this exists](#why-this-exists)
2. [Features](#features)
3. [Screenshots / mental model](#screenshots--mental-model)
4. [Requirements](#requirements)
5. [Download (macOS)](#download-macos)
6. [Quick start](#quick-start)
7. [Web UI (projects & editor)](#web-ui-projects--editor)
8. [Batch pipeline (`run` / `watch`)](#batch-pipeline-run--watch)
9. [Configuration](#configuration)
10. [CLI reference](#cli-reference)
11. [Project layout](#project-layout)
12. [Development](#development)
13. [Build instructions (macOS app / DMG)](#build-instructions-macos-app--dmg)
14. [Roadmap & status](#roadmap--status)
15. [Contributing](#contributing)
16. [License](#license)
17. [Support the developer (donations)](#support-the-developer-donations)
18. [Disclaimer](#disclaimer)

---

## Why this exists

Creators often need the same photo in several Instagram sizes, a sensible logo watermark, and — for reels — a timeline of scenes, voiceover, and shared intros. Most tools are SaaS, watermarked, or push media to the cloud.

Content-Sprout is built to:

- Run **entirely on your computer** by default
- Stay **free forever** under a permissive open-source license
- Scale from “drop a folder of JPEGs” to “edit a multi-scene reel in the browser”
- Keep optional AI **local-first** (Ollama), with heuristics that work even when no LLM is available

---

## Features

### Batch image pipeline

- Smart crop (faces via MediaPipe + saliency / center fallback)
- Export to Instagram formats: **square**, **portrait**, **landscape**, **story**
- Story mode with **blur-pad** (full subject over blurred background) or hard crop
- Automatic **dark / light logo** selection and corner placement
- Optional **Gemma / Ollama** fallback when the heuristic is unsure
- Watch folder: drop files → process → triage into `.done` / `.failed`
- Per-image `manifest.json` (placement, hashes, metadata)

### Project-based web editor

- **Projects** with shared and post-private **assets** (images, video, audio)
- **Image posts** and **video posts** (multi-scene timelines)
- Layers: text, images, audio beds, **text-to-speech** (macOS `say` voices)
- Scene gaps, layer timing, fade transitions, preview playhead / gantt timeline
- **Reusable posts** — mark a video (e.g. intro) as reusable and insert it into other posts as a live timeline block
- Project / post logos and branding assets
- Export image (JPEG) and video (MP4 via `ffmpeg`)
- Optional AI assists for photo ops / layout (when an LLM is configured)
- Optional Instagram Graph API publishing (see Instagram setup doc)

### Text to speech

- Uses built-in macOS Speech (`say`) when available — no paid API
- Voices filtered by **country / region** in the UI
- Remembers the **last voice used on a post** for new TTS layers

---

## Screenshots / mental model

**Batch mode**

```
input/photo.jpg
       │
       ▼
┌─────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│  Smart Crop     │ →  │  Heuristic Placer  │ →  │   Logo Composite   │
│ (per format)    │    │  (+ optional LLM)  │    │  (dark/light mark) │
└─────────────────┘    └────────────────────┘    └────────────────────┘
       │
       ▼
output/<name>/{square,portrait,landscape,story}.jpg + manifest.json
```

**Editor mode**

```
Project
 ├── Assets (project-shared or post-private)
 └── Posts
      ├── Image post → layers on a canvas → Export JPG
      └── Video post → scenes (+ optional reusable post refs)
           ├── layers (text / image / audio / TTS)
           └── Export MP4 (ffmpeg concat + audio mix)
```

---

## Requirements

### Required

- **Python 3.11+**
- **[uv](https://github.com/astral-sh/uv)** (recommended) or pip + venv
- **ffmpeg** / **ffprobe** on `PATH` for video export and TTS duration probing  
  (`brew install ffmpeg` on macOS)

### Strongly recommended (macOS)

- Apple Silicon Mac for comfortable local LLM use
- Built-in Speech (`say`) for free TTS

### Optional

- **[Ollama](https://ollama.com)** + a vision-capable model (e.g. `gemma4:31b` or a smaller variant) for smarter logo placement / AI assists
- Instagram Meta app credentials if you want in-app publishing

---

## Download (macOS)

Prefer a double-clickable app? Grab the latest packaged build from **GitHub Releases** (recommended over committing binaries into git):

| Artifact | Link |
|----------|------|
| **DMG** (drag to Applications) | [content-sprout-macos.dmg](https://github.com/Ctrl-Fabric/Content-Sprout/releases/latest/download/content-sprout-macos.dmg) |
| **ZIP** (`.app` inside) | [content-sprout-macos.zip](https://github.com/Ctrl-Fabric/Content-Sprout/releases/latest/download/content-sprout-macos.zip) |
| All versions | [github.com/Ctrl-Fabric/Content-Sprout/releases](https://github.com/Ctrl-Fabric/Content-Sprout/releases) |

The marketing site ([content-sprout.ctrlfabric.com](https://content-sprout.ctrlfabric.com)) links to the same GitHub Releases page (binaries are not hosted on Firebase).

> First open of an unsigned build: right-click the app → **Open**. Install `ffmpeg` (`brew install ffmpeg`) for video export.

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/Ctrl-Fabric/Content-Sprout.git
cd Content-Sprout

# 2. Install dependencies into a local virtualenv
uv sync

# 3. (Optional) Install ffmpeg for video + audio tooling
brew install ffmpeg

# 4. (Optional) Logos for the batch watermark pipeline
#    Place PNGs with transparency at:
#      assets/logo_dark.png
#      assets/logo_white.png

# 5. Sanity check
uv run content-sprout doctor
uv run content-sprout --help

# 6. Open the web UI (default port 8000; use --port to change)
uv run content-sprout serve --port 17829
# → http://127.0.0.1:17829
```

Convenience scripts (if present):

```bash
./start-ui.sh    # web UI
./start.sh       # daily batch / watch helper (see DAILY.md)
```

---

## Web UI (projects & editor)

```bash
uv run content-sprout serve --host 127.0.0.1 --port 17829
```

Typical workflow:

1. Create a **project**
2. Upload **assets** (or generate project-level TTS audio)
3. Create an **image** or **video** post
4. For video: add **scenes**, layers, timing; optionally **+ Reusable** to insert a shared intro
5. Mark intro / bumper posts as **Reusable clip** so other posts can embed them
6. **Export** image or video; files land under `projects/<id>/posts/<post_id>/exports/`

Local data lives under `projects/` (and `cache/`). Do not commit personal media to public forks.

---

## Batch pipeline (`run` / `watch`)

```bash
# Process everything currently in input/
uv run content-sprout run

# Or process a specific folder
uv run content-sprout run /path/to/pictures

# Auto-process new drops
uv run content-sprout watch
```

Watch triage:

| Result | Destination |
|--------|-------------|
| Success | `input/.done/<relative-path>` |
| Failure | `input/.failed/<relative-path>` + `.error.txt` |

LLM placement decisions (when used) are cached in `cache/decisions.jsonl` keyed by file hash so re-runs stay fast.

Example output layout:

```
output/
├── beach/
│   ├── square.jpg
│   ├── portrait.jpg
│   ├── landscape.jpg
│   ├── story.jpg
│   └── manifest.json
└── Vacation/
    └── sunset/
        ├── square.jpg
        └── …
```

---

## Configuration

Primary file: [`config.yaml`](config.yaml). Paths are resolved relative to the config file unless absolute.

| Key | Purpose |
|-----|---------|
| `input_dir` / `output_dir` | Batch pipeline folders |
| `projects_dir` / `cache_dir` | Web projects + caches |
| `formats` | Which Instagram sizes to produce |
| `jpeg_quality` | Export quality (default `92`) |
| `story.fit_mode` | `blur_pad` or `smart_crop` |
| `logo_*` / `logo.*` | Watermark paths and composition |
| `router.*` | When to call the LLM vs trust heuristics |
| `llm` / `ollama` / `llm_proxy` | Local or proxy LLM settings |
| `watch.*` | Debounce / settle for folder watching |
| `instagram.*` | Optional Graph API publishing |

Change settings in the UI (**Settings**) or edit `config.yaml` and restart `serve`.

---

## CLI reference

| Command | Description |
|---------|-------------|
| `content-sprout run [DIR]` | Process images once |
| `content-sprout watch` | Watch `input_dir` and process new files |
| `content-sprout serve` | Local FastAPI web UI |
| `content-sprout doctor` | Check config, logos, Ollama reachability |

Useful `serve` flags: `--host`, `--port`, `--config`, `--reload` (dev).

---

## Project layout

```
Content-Sprout/
├── LICENSE                 # MIT
├── README.md               # You are here
├── GETTING_STARTED.md      # Beginner install guide
├── DAILY.md                # Day-to-day usage
├── INSTAGRAM_SETUP.md      # Optional publishing
├── pyproject.toml
├── config.yaml
├── assets/                 # Default logos (optional)
├── input/ · output/        # Batch pipeline I/O (gitignored contents)
├── projects/               # Web UI projects (local data)
├── cache/                  # Decisions / processing cache
├── packaging/              # e.g. macOS launcher notes
├── landing/                # Angular marketing site (Firebase Hosting; see landing/DEPLOY.md)
├── logos/                  # Brand artwork (source)
├── src/content_sprout/
│   ├── cli.py              # Typer entrypoint
│   ├── web.py              # FastAPI app + static UI
│   ├── projects.py         # Project / post / asset storage
│   ├── render.py           # Compose, preview, video export
│   ├── tts.py              # Local text-to-speech
│   ├── pipeline.py         # Batch processing
│   ├── static/             # Browser UI (HTML/JS/CSS)
│   ├── crop/ · placement/  # Smart crop & logo placement
│   ├── llm/                # Ollama / proxy clients
│   └── instagram/          # Optional publish helpers
└── tests/
```

Package name on PyPI-style installs: **`content-sprout`** (`uv run content-sprout …`).

---

## Development

```bash
uv sync --group dev

# Tests
uv run pytest

# Lint / format
uv run ruff check .
uv run ruff format .
```

Contributions that keep the stack **local-first**, **dependency-light**, and **well-tested** are especially welcome.

---

## Build instructions (macOS app / DMG)

Package a desktop **Content-sprout.app**, ZIP, and DMG on a Mac (build on the architecture you intend to ship — Apple Silicon or Intel).

### Prerequisites

- macOS
- [`uv`](https://github.com/astral-sh/uv)
- Project dependencies syncable (`uv sync`)

### Build

```bash
chmod +x packaging/macos/build.sh
./packaging/macos/build.sh
```

Outputs:

| File | Path |
|------|------|
| App bundle | `dist/macos/Content-sprout.app` |
| ZIP | `dist/macos/content-sprout-macos.zip` |
| DMG | `dist/macos/content-sprout-macos.dmg` |

The script writes artifacts under `dist/macos/` only. Publish them with `./scripts/release-macos.sh <tag>` — the landing page links to GitHub Releases and does **not** bundle ZIP/DMG.

More detail: [`packaging/macos/README.md`](packaging/macos/README.md).

### Publish the DMG on GitHub Releases

Yes — **store the DMG as a GitHub Release asset**, not in the git tree. A ~100–150 MB DMG is well within GitHub’s release asset limits; keeping binaries out of git avoids bloating the repo.

1. Build locally with `./packaging/macos/build.sh`
2. Create a release (UI or CLI), attach both artifacts:

```bash
# Example with GitHub CLI (tag + upload)
gh release create v0.1.0 \
  dist/macos/content-sprout-macos.dmg \
  dist/macos/content-sprout-macos.zip \
  --title "Content-Sprout v0.1.0" \
  --notes "macOS desktop build."
```

Stable download URLs (after the files are attached to a release named with those asset filenames):

- `https://github.com/Ctrl-Fabric/Content-Sprout/releases/latest/download/content-sprout-macos.dmg`
- `https://github.com/Ctrl-Fabric/Content-Sprout/releases/latest/download/content-sprout-macos.zip`

### Optional code signing

```bash
codesign --deep --force --options runtime \
  --sign "Developer ID Application: YOUR NAME" \
  "dist/macos/Content-sprout.app"
```

Then re-run the ZIP/DMG steps (or the full build script after signing the `.app`).

---

## Roadmap & status

Core batch pipeline phases (crop → place → watch → LLM router → story blur-pad) are **done**. The project-based editor continues to evolve (timeline, TTS, reusable posts, asset scopes, exports).

Ideas / welcome PRs:

- Cross-platform TTS beyond macOS `say` (e.g. Piper models fully wired)
- Linux packaging polish
- More export presets and accessibility improvements in the editor
- Broader automated coverage for render / export edge cases

---

## Contributing

1. Fork / branch from the latest `main` (or the branch your remote uses)
2. Keep changes focused; match existing code style (`ruff`)
3. Add or update tests when behavior changes
4. Open a PR with a short **why** and how you verified it

By contributing, you agree that your contributions are licensed under the same **MIT License**.

---

## License

This project is released under the **[MIT License](LICENSE)**.

You may use it commercially or personally, modify it, and redistribute it, provided you keep the copyright and license notice. The software is provided **as is**, without warranty.

Third-party tools you may install separately (Ollama models, Meta APIs, ffmpeg builds, system voices) have their own terms; this license covers the Content-Sprout source in this repository.

---

## Support the developer (donations)

Content-Sprout is **free and open source**. There is no paid tier, no forced watermark, and no telemetry baked into the core app for monetization.

If it saves you time and you want to say thanks, **voluntary donations are welcome**. They help cover coffee, machines, and nights spent on features like the timeline editor and TTS — they are **never required** to use the software.

### UPI (India)

Scan or pay to:

| | |
|---|---|
| **UPI ID** | `REPLACE_WITH_YOUR_UPI@upi` |

> Maintainer: replace the placeholder above with your real UPI VPA (e.g. `name@oksbi`, `name@paytm`) before publishing.

Any amount helps. Please only send what you are comfortable with. Donations do not purchase priority support or a commercial license — the MIT license already covers use.

### Other ways to help

- Star the repository and share it with creators who need a local workflow
- File clear bug reports and pull requests
- Improve docs (especially for non-macOS users)

Thank you for supporting independent open-source work.

---

## Disclaimer

- This tool helps you prepare media; **you** are responsible for rights to photos, logos, music, and for complying with Instagram / Meta policies.
- Local AI quality depends on your hardware and model choice.
- Video export requires a working `ffmpeg` install.
- The server binds to localhost by default; do not expose it to the public internet without authentication and hardening.

---

**Made for creators who want control of their pipeline — free, local, and open.**
