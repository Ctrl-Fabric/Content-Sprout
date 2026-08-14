# Getting Started — Total Beginner Guide

This walks you, step-by-step, from a brand-new Mac to a working
Content-Sprout setup. No prior experience required.

Content-Sprout is a **local studio for social content** — not just Instagram
photos. Use it for images, short-form and long-form video, scripts, voiceover,
branding, export, and publish across **YouTube, Instagram, TikTok, LinkedIn,
Facebook, X, Telegram**, and anywhere else you post. Everything runs on your
machine by default.

**What you'll have at the end:**

- The Content-Sprout web studio running locally (projects, assets, timeline, export)
- Optional local AI via Ollama — **any vision-capable model that fits your Mac**
  (it must understand both text and images; no cloud required)
- Optional batch photo pipeline (drop-in folder → sized + watermarked stills)
- Optional logos used for branding across posts

AI is optional. You can create and export content without downloading a model.

**Estimated time:** 20–40 minutes for the studio. If you also install a local
LLM, add however long that model takes to download (small models: a few
minutes; large ones: much longer).

---

## Glossary (read this first, 30 seconds)

| Term | What it means |
|------|----------------|
| **Terminal** | The black/white text window where you type commands. Built into macOS. |
| **Command** | A line of text you type and press Enter to run. |
| **Homebrew** (`brew`) | A tool that installs other tools on a Mac. Like an App Store for developers. |
| **Ollama** | Optional. Runs AI language models on your Mac. |
| **LLM / vision model** | A local AI model that can read **text and images**. Pick any vision-capable Ollama model that runs well on *your* machine (Llama Vision, LLaVA, Qwen-VL, Gemma 3, …). Text-only models are not enough. |
| **Python** | A programming language. Our project is written in it. |
| **uv** | A tool that sets up Python projects. Fast and modern. |
| **CLI** | Command-Line Interface. "Run the CLI" = "type a command and press Enter". |
| **Path** | The address of a file or folder, e.g. `/Users/yourname/Pictures/cat.jpg`. |
| **Studio / web UI** | The browser app where you build posts, timelines, scripts, and exports. |
| **ui-shared** | Vendored shared UI library (shipped under `ui-shared/` in this project). |

---

## Part 1 — Open Terminal

1. Press `⌘ + Space` to open Spotlight.
2. Type `Terminal` and press Enter.
3. A window with a `$` prompt appears. This is where you'll type everything.

**Tip:** Copy commands from this file with `⌘ + C`, paste into Terminal with
`⌘ + V`, then press Enter.

---

## Part 2 — Install Homebrew (skip if you already have it)

Homebrew is the tool we'll use to install everything else.

**Check if you have it:**

```bash
brew --version
```

If you see something like `Homebrew 4.x.x`, skip to Part 3.
If you see `command not found`, install it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

- Press Enter when it asks.
- It will ask for your Mac login password — type it (you won't see characters
  appear, that's normal) and press Enter.
- This takes 3–5 minutes.

**At the very end**, Homebrew prints two `==> Next steps` lines that look like:

```
echo >> /Users/yourname/.zprofile
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> /Users/yourname/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

**Copy those exact lines from your terminal** (not from this README — yours
will have your username) and paste them. This makes the `brew` command
available.

**Verify:**

```bash
brew --version
```

You should now see `Homebrew 4.x.x`. If you don't, close Terminal, reopen it,
and try again.

---

## Part 3 — Optional: local AI with Ollama

Skip this entire part if you just want the studio. You can add AI later.

Ollama runs an AI model on your Mac. Content-Sprout **reads images** (photos,
frames, layout, logo placement) as well as text (scripts, hashtags), so the
model must be **vision-capable** (multimodal) — not text-only.

Any vision model that Ollama supports and that **fits your RAM/CPU** will
work: Llama Vision, LLaVA, Qwen-VL, Gemma 3, MiniCPM-V, and similar. Pick a
smaller vision model on 8–16 GB machines; larger ones only if you have the
memory.

### 3.1 Install Ollama

```bash
brew install ollama
```

This downloads and installs Ollama (1–2 minutes).

### 3.2 Start it as a background service

```bash
brew services start ollama
```

You should see `Successfully started ollama`. This means Ollama is now
running in the background and will start automatically every time you reboot
your Mac.

**Verify it's running:**

```bash
curl http://localhost:11434
```

Expected output: `Ollama is running`

If it says `Connection refused`, run `brew services restart ollama` and try
again.

### 3.3 Download a vision model that fits your machine

List what you already have:

```bash
ollama list
```

Pull **one vision-capable** model. Examples (choose what your Mac can handle
— these are illustrative, not required):

```bash
# Smaller / faster vision models (good starting point on most laptops)
ollama pull llama3.2-vision
# ollama pull llava
# ollama pull moondream

# Larger vision models if you have the RAM
# ollama pull qwen2.5vl
# ollama pull gemma3:12b
```

Use a model whose Ollama page or tag says it can **see / understand images**.
Plain text models (for example `llama3.2` without `-vision`, `mistral`,
`phi3`) will not work well for Content-Sprout.

Download size depends on the model. A few GB is typical for small vision
models; 20 GB+ models are optional and only worth it if your machine can run
them.

You'll see a progress bar. **Don't close Terminal until it finishes.** If
your connection drops, just run the command again — it resumes where it left
off.

When done, you'll see something like:

```
pulling manifest...
success
```

Remember the model name you pulled (for example `llama3.2-vision`). You'll
put that name in `config.yaml` (or Settings in the UI).

### 3.4 Test the model (including an image)

Find any photo on your Mac (right-click in Finder → **Get Info** shows the
path), or use one in Downloads:

```bash
ollama run llama3.2-vision "Describe this photo in one sentence" ~/Downloads/your-photo.jpg
```

Replace `llama3.2-vision` with **your** vision model name, and
`your-photo.jpg` with a real file. After a few seconds it should describe
the picture. **If this works, your local AI is ready.** Press `Ctrl + D` to
exit, or type `/bye` and press Enter.

### 3.5 Point Content-Sprout at that model

Edit `config.yaml` in the project folder:

```yaml
llm:
  provider: ollama
ollama:
  host: http://localhost:11434
  model: llama3.2-vision    # ← use the exact vision model you pulled
```

You can also set the model later in the studio **Settings** page.

---

## Part 4 — Install Python and `uv`

### 4.1 Check Python

```bash
python3 --version
```

You need **Python 3.11 or newer**. If you see `3.11.x`, `3.12.x`, or higher,
you're good.

If you see something older or `command not found`:

```bash
brew install python@3.12
```

Then re-run `python3 --version` to confirm.

### 4.2 Install `uv`

`uv` is what sets up the project's Python environment.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

When done, **close Terminal entirely** (`⌘ + Q`) and reopen it. This makes the
`uv` command available.

**Verify:**

```bash
uv --version
```

You should see `uv 0.x.x`.

---

## Part 5 — Install the Content-Sprout project

### 5.1 Go to the project folder

In Terminal, `cd` into the folder that contains `README.md` and
`pyproject.toml` (the Content-Sprout repo root).

**Verify you're in the right place:**

```bash
ls
```

You should see `README.md`, `pyproject.toml`, `config.yaml`, `input/`,
`output/`, `src/`, `ui/`, and other files.

### 5.2 Confirm `ui-shared` is present

The studio ships with a vendored **`ui-shared/`** folder (shared Angular
components). From the Content-Sprout folder:

```bash
ls ui-shared/src
```

You should see `index.ts`, `components/`, `styles/`, etc. This is part of the
project — no monorepo symlink is required.

### 5.3 Install all the project's dependencies

```bash
uv sync
```

This creates a private Python environment for the project and downloads
everything it needs (Pillow, OpenCV, MediaPipe, the Ollama client, etc.).
Takes 2–5 minutes.

When it's done you'll see something like `Resolved N packages` and a return
to the `$` prompt.

### 5.4 Verify the project works

```bash
uv run content-sprout --help
```

You should see a list of commands: `run`, `watch`, `doctor`.

### 5.5 (Recommended) ffmpeg for video export

```bash
brew install ffmpeg
```

Needed to export MP4 (YouTube, Reels, TikTok, etc.). Image-only work can skip
this.

---

## Part 6 — Open the studio (the main app)

This is the primary way to use Content-Sprout: projects, assets, scripts,
timelines, export, and social upload.

From the project folder:

```bash
./start-ui.sh
```

When it's ready, open the URL it prints (typically
`http://127.0.0.1:4210`).

From here you can:

- Create a **project** and add photos, video, audio, and logos
- Build **image or video posts** (including multi-scene timelines)
- Write / refine **scripts**, attach **TTS** voiceover (macOS voices)
- **Export** JPEG or MP4 locally
- Connect **social accounts** (YouTube, Instagram, TikTok, LinkedIn, …) and upload

Leave that Terminal window open while you work. Press `Ctrl + C` to stop.

More day-to-day commands: [`DAILY.md`](DAILY.md).

---

## Part 7 — Optional: add your logos

Logos are used for branding on posts and for the optional batch photo
pipeline. You need two PNG files with **transparent backgrounds**: one dark
(for light images) and one white (for dark images).

### 7.1 Where they go

```
Content-Sprout/assets/logo_dark.png    ← black/dark logo
Content-Sprout/assets/logo_white.png   ← white/light logo
```

### 7.2 The easy way to put them there

1. Open Finder.
2. Press `⌘ + Shift + G`, paste the path to this repo's `assets/` folder,
   and press Enter.
3. Drag your two logo PNG files into that folder.
4. **Rename them exactly** to `logo_dark.png` and `logo_white.png`.

### 7.3 Don't have logos with transparent backgrounds?

Easiest options:

- **Free, online:** [remove.bg](https://www.remove.bg) — upload, download as PNG
- **Free, offline:** Open the image in **Preview** on your Mac → click the
  toolbox icon → click the "Instant Alpha" wand → click the background → press
  Delete → File → Export as PNG.
- **Already a logo creator:** Canva, Figma, Photoshop, Illustrator all export
  PNG with transparency. Make sure to **delete the background layer** before
  exporting.

You'll want the dark version to be **solid black or near-black**, and the
white version to be **pure white**. The transparent background is what
matters most.

---

## Part 8 — Verify everything is connected

This one command checks config, optional Ollama, and logos.

```bash
uv run content-sprout doctor
```

**Success looks like this** (model name will match whatever you configured):

```
Config:        config.yaml
  input_dir    input
  output_dir   output
  formats      square, portrait, landscape, story
  ollama.host  http://localhost:11434
  ollama.model llama3.2-vision
  ✓ Logos found (logo_dark.png, logo_white.png)
  ✓ Ollama reachable, 'llama3.2-vision' available.
```

If you skipped Ollama, doctor may warn that no model is configured. That's
fine — the studio still works.

**If you see a red `✗` or yellow `!`** — read what it says. It tells you the
exact fix (e.g. pull your model, or add `assets/logo_dark.png`).
Fix the issue, then re-run `uv run content-sprout doctor`.

---

## Part 9 — Optional: batch stills (folder drop-in)

The studio in Part 6 is the main product. This part is a **bonus pipeline**
for bulk stills: drop photos in a folder, get several sizes with optional
logo placement. Useful for feeds/stories; it is not the only way to create
content.

### 9.1 Put photos in the input folder

In Finder, open this repo's `input/` folder. Drag some JPEG, PNG, or HEIC
photos into it. You can also drag whole folders — the structure is preserved
on output.

### 9.2 Run the pipeline

```bash
uv run content-sprout run
```

A progress bar appears. Each photo takes a few seconds with heuristics, or
longer if a local model is asked for a second opinion.

### 9.3 Check the results

Look in this repo's `output/` folder. You'll see one folder per input photo.
Each folder typically contains several sizes (square, portrait, landscape,
story) plus `manifest.json`.

Open them in Finder — they're ready to use on any platform that wants those
aspect ratios.

---

## Part 10 — Optional: watch mode for batch stills

Instead of running `content-sprout run` every time, you can leave the batch
pipeline in "watch mode" and it will process photos as you drop them in.

### 10.1 Start the watcher

```bash
uv run content-sprout watch
```

You'll see:

```
Watching …/input (debounce 1.5s, Ctrl+C to stop)
  Processed → .done/   Failed → .failed/
```

Leave this terminal open.

### 10.2 Drop a photo

Open Finder, drag a photo into `input/`. Within ~2 seconds the watcher
processes it. The original photo is then moved into `input/.done/` so it
doesn't get reprocessed.

### 10.3 To stop the watcher

In the terminal running it, press `Ctrl + C`.

For everyday studio use (video, YouTube, scripts), prefer `./start-ui.sh`
instead of watch mode.

---

## Common problems and fixes

### "command not found: uv" / "command not found: brew"

You probably need to close and reopen Terminal. New tools are only available
in new Terminal windows.

### `./start-ui.sh` / `npm start` fails (cannot find `shared/ui` or `ui-shared`)

Confirm the vendored library is present: `ls ui-shared/src/index.ts`. Then from
`ui/` run `npm install` (this also links peer deps via
`scripts/link-shared-ui-deps.mjs`) and try again.

### "Cannot reach Ollama at http://localhost:11434"

Ollama isn't running. Fix:

```bash
brew services restart ollama
```

Wait 5 seconds, then re-run `uv run content-sprout doctor`.

### Model not pulled / doctor says the model is missing

You skipped Part 3.3, or `config.yaml` names a model you never downloaded.
Pull the same **vision** model you set in config:

```bash
ollama pull llama3.2-vision
```

Use **your** model name, not necessarily `llama3.2-vision`.

### The model is too slow / runs out of memory

Use a **smaller vision model** (still one that can read images). Edit
`config.yaml`:

```yaml
ollama:
  model: llama3.2-vision    # or llava, moondream, gemma3:4b, … whatever fits
```

Then:

```bash
ollama pull llama3.2-vision
```

Any **vision-capable** Ollama model is valid. Pick the largest one that
stays smooth on your Mac. Text-only models are not a substitute.

### "Logo PNGs missing"

You skipped Part 7. Either add the PNGs, or run anyway — batch stills will
just have no watermark, and posts can still use other branding later.

### "I dragged a photo into input/ but nothing happened in watch mode"

- Check it has a supported extension: `.jpg`, `.jpeg`, `.png`, `.webp`,
  `.heic`, `.tiff`.
- Wait 2 seconds — there's a debounce.
- Look in `input/.failed/` for a `.error.txt` file explaining what went wrong.

### "An image came out cropped weirdly"

The batch pipeline tries to keep the subject (face or salient region) in
frame. If it picked badly, look at `manifest.json` for the source photo — it
tells you whether the heuristic or the AI made the call. You can also change
story behavior in `config.yaml`:

```yaml
story:
  fit_mode: blur_pad     # full photo with blurred sides — best for landscape sources
  # or
  fit_mode: smart_crop   # hard 9:16 crop
```

### "Where does my photo go after watch mode processes it?"

To `input/.done/<same-relative-path>`. If you want it back in `input/`, just
drag it from `.done/`. To re-process it, you also need to delete the cached
decision: `rm cache/decisions.jsonl` (or just specific lines).

---

## Daily use, the short version

Once everything is set up:

1. **Open Terminal** and `cd` to the Content-Sprout project folder.
2. ```bash
   ./start-ui.sh
   ```
3. Create or open a project in the browser. Build image or video posts,
   export, and optionally upload to YouTube or other platforms.
4. Press `Ctrl + C` in Terminal when you're done for the day.

Optional batch stills: drop files into `input/` and run `./start.sh` or
`uv run content-sprout watch`.

That's the flow. For more detail (troubleshooting, quick reference), see
[`DAILY.md`](DAILY.md).

---

## What's next?

- Day-to-day playbook (no setup, just running) → [`DAILY.md`](DAILY.md).
- Full feature list, config, and architecture → [`README.md`](README.md).
- Social publishing (YouTube, Instagram, …) → the **Social accounts** panel
  in the studio.
- To tweak logo size, padding, or opacity, edit `config.yaml`.
- To change which still sizes the **batch** pipeline produces, edit the
  `formats:` list in `config.yaml`. Video/image posts in the studio pick
  their own target format per post.
