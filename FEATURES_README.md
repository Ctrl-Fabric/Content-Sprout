# Content-Sprout — Features

**Content-Sprout** is an Open-Source, local-first creative studio for macOS—think iMovie, with AI workflows woven through the same workspace. One place to gather media, write and refine scripts, build multi-scene timelines, brand and edit assets, generate voiceover, and export finished work. Core editing runs on your machine with no subscription; optional AI (via Ollama, Gemini, or an OpenAI-compatible endpoint) assists without being required.

## What you can do

- **Media Studio** — Project-based editor for images and multi-scene videos: layers (text, image, video, audio, TTS), timing, fades, reusable clips (intros, bumpers, shared blocks), preview, and JPEG/MP4 export.
- **Media library** — Personal Media and global resources so your library lives beside the editor; import from disk or stock sources when you need more footage.
- **Batch branding** — Drop photos into a folder for smart crop (face-aware), multi-format exports, and logo placement when you need volume processing without opening the full editor.
- **Video prep** — Trim, mute, and speed-adjust clips (copy-on-write) before they land on the timeline.

## Creative workflow

Content-Sprout is built as a central creative desk: idea → media → structure → edit → export, with AI available at each step.

1. **Brief / notes** — Capture the concept and references in the project post.
2. **Script** — Generate a production script from a brief, refine it in chat, then activate it so scene markers drive the timeline.
3. **Assets** — Upload, import from disk or stock, generate TTS, optionally describe or photo-edit with AI, or pull in generative stills/video when configured.
4. **Timeline / canvas** — Build scenes and layers; regenerate structure from the script; nest reusable clips; preview the cut.
5. **Export** — Render JPG or MP4 locally when the piece is ready.

Batch mode remains the fast lane for stills (drop → crop → logo → done). The editor is the full production path for everything else.

## AI features

AI is assistive and local-first. Heuristics, ffmpeg, and macOS TTS keep the product usable with no LLM at all; turn AI on when you want help writing, structuring, branding, or generating.

| Feature | Role in the workflow |
|---|---|
| **Script Generator** | Brief → draft with scene/duration/visual markers → chat refine → activate on the post |
| **Script → timeline** | Turns markers into a scene scaffold (optionally assigning assets and TTS) |
| **AI layout edit** | Natural-language edits to layers and scenes |
| **AI photo edit** | Plans local ops (crop, grade, logo…) and/or generative edits as new assets |
| **Asset describe** | Vision captions so assets are searchable and reusable across projects |
| **AI suggest** | Reach, legal, accessibility, and design tips before you ship |
| **Logo placement** | Heuristic first; vision LLM only when confidence is low |
| **Image / video gen** | Optional ComfyUI, Gemini (Nano Banana), Higgsfield, or OpenAI-compatible image APIs |

## Tech stack

| Layer | Stack |
|---|---|
| **Backend** | Python 3.11+, FastAPI, Uvicorn, Typer CLI, Pydantic |
| **Frontend** | Angular 22 (Media Studio UI), RxJS |
| **Media / vision** | Pillow, OpenCV, NumPy, MediaPipe, smartcrop, ffmpeg / ffprobe |
| **AI (optional)** | Ollama, Gemini, OpenAI-compatible proxies; ComfyUI / Higgsfield / Gemini for media gen |
| **TTS** | macOS Speech (`say`) |
| **Packaging / tooling** | uv, Hatchling; macOS DMG/ZIP app builds |
| **License** | MIT |

## Dependencies

### Required (runtime)

- **Python 3.11+** with project deps via `uv sync` (or pip)
- **ffmpeg** / **ffprobe** on `PATH` (video export, thumbs, audio duration)

**Python packages** (from `pyproject.toml`): Pillow, Pydantic / pydantic-settings, Typer, Rich, PyYAML, OpenCV, NumPy, smartcrop, MediaPipe, Watchdog, Ollama client, FastAPI, Uvicorn, python-multipart, httpx, cryptography.

**UI packages** (Angular app in `ui/`): Angular core / animations / forms / router, RxJS, TypeScript.

### Strongly recommended (macOS)

- Apple Silicon for comfortable local LLM use
- Built-in Speech (`say`) for voiceover without a paid TTS API

### Optional

- **Ollama** + a vision-capable model (e.g. Gemma) for script, layout, photo, and logo assists
- **Gemini** or an OpenAI-compatible cloud LLM / image API
- **ComfyUI** / **Higgsfield** for generative image & video
- Stock / publish integrations as configured (e.g. Pixabay, Instagram Graph API)

### Dev

- pytest, ruff (Python); Angular CLI / `@angular/build`

## Recent updates

- **Reusable timeline clips** — Add scenes that reference another post (intro/outro/snippets) and reuse them across timelines without duplicating assets.
- **Scene navigation controls** — Previous/next scene buttons in Timeline for quicker script-driven edits and reviews.
- **Clearer AI error reporting** — Better Ollama/Gemini/proxy connection and model errors surfaced in Settings and AI flows.
- **ComfyUI workflow-first setup** — Upload API-format workflow JSONs, assign per operation (text→image, text→video, image→video, upscale), and keep model selections inside the workflow itself. Text→video is only enabled when a workflow is explicitly assigned (no built-in fallback).
- **Workflow storage is self-contained** — Uploaded ComfyUI workflows are copied into Content-Sprout-managed storage, so generation does not depend on the original file location.
- **Generation-time video sizing** — Video/image sizes stay restricted to small presets and are selected during generate/upscale actions (not in config).
- **Ollama memory release** — Local Ollama chat calls send `keep_alive: 0` so models unload after each request, reducing VRAM pressure for ComfyUI.
- **Exclusive local AI execution** — Only one local AI task runs at a time across Ollama and ComfyUI; overlapping requests are rejected until the current task completes.

## Bottom line

Content-Sprout is a privacy-friendly creative hub—timeline editing and media management in one local workspace, with AI workflows that help you write, structure, brand, generate, and polish without scattering work across a dozen SaaS tools.
