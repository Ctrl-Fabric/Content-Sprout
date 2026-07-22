# Getting Started — Total Beginner Guide

This walks you, step-by-step, from a brand-new Mac to a working
Content-Sprout setup that auto-crops, resizes, and watermarks your photos for
Instagram using a local AI model. No prior experience required.

**What you'll have at the end:**

- A local AI model (Gemma 4) running on your Mac — no cloud, no subscriptions
- A folder you drop photos into → finished Instagram-ready images come out
- Four formats per photo: square, portrait, landscape, story
- Your logo placed in the best corner with the right color (dark or white)
  picked automatically

**Estimated time:** 30–60 minutes, of which ~20 minutes is just waiting for
the AI model to download.

---

## Glossary (read this first, 30 seconds)

| Term | What it means |
|------|----------------|
| **Terminal** | The black/white text window where you type commands. Built into macOS. |
| **Command** | A line of text you type and press Enter to run. |
| **Homebrew** (`brew`) | A tool that installs other tools on a Mac. Like an App Store for developers. |
| **Ollama** | The program that runs AI models on your Mac. |
| **Gemma 4** | Google's open AI model — the "brain" we'll use. |
| **Python** | A programming language. Our project is written in it. |
| **uv** | A tool that sets up Python projects. Fast and modern. |
| **CLI** | Command-Line Interface. "Run the CLI" = "type a command and press Enter". |
| **Path** | The address of a file or folder, e.g. `/Users/yourname/Pictures/cat.jpg`. |

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

## Part 3 — Install and start Ollama

Ollama is the program that runs Gemma 4 on your machine.

### 3.1 Install it

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

### 3.3 Download Gemma 4 (the AI model)

```bash
ollama pull gemma4:31b
```

This downloads **about 20 GB**. Depending on your internet speed:

- 1 Gbps fiber: ~5 minutes
- 100 Mbps: ~30 minutes
- 50 Mbps: ~1 hour

You'll see a progress bar. **Don't close Terminal until it finishes.** If
your connection drops, just run the command again — it resumes where it left
off.

When done, you'll see something like:

```
pulling manifest...
success
```

### 3.4 Test the AI works

Find any photo on your Mac and remember its path (right-click in Finder →
"Get Info" shows the location).

Or just use one in Downloads:

```bash
ollama run gemma4:31b "Describe this photo in one sentence" ~/Downloads/your-photo.jpg
```

Replace `your-photo.jpg` with an actual filename. After ~10 seconds, Gemma 4
prints a description. **If this works, your AI is ready.** Press
`Ctrl + D` to exit, or type `/bye` and press Enter.

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

```bash
cd /Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout
```

That's the address of the project. From here, every command runs in the
project folder.

**Verify you're in the right place:**

```bash
ls
```

You should see `README.md`, `pyproject.toml`, `config.yaml`, `input/`,
`output/`, `src/`, and other files.

### 5.2 Install all the project's dependencies

```bash
uv sync
```

This creates a private Python environment for the project and downloads
everything it needs (Pillow, OpenCV, MediaPipe, the Ollama client, etc.).
Takes 2–5 minutes.

When it's done you'll see something like `Resolved N packages` and a return
to the `$` prompt.

### 5.3 Verify the project works

```bash
uv run content-sprout --help
```

You should see a list of commands: `run`, `watch`, `doctor`.

---

## Part 6 — Add your logos

The project needs two logo files: one dark-colored (for light photos) and
one white-colored (for dark photos). Both must be **PNG with transparent
background**.

### 6.1 Where they go

```
Content-Sprout/assets/logo_dark.png    ← black/dark logo
Content-Sprout/assets/logo_white.png   ← white/light logo
```

### 6.2 The easy way to put them there

1. Open Finder.
2. Press `⌘ + Shift + G`, paste this and press Enter:
   `/Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout/assets`
3. Drag your two logo PNG files into that folder.
4. **Rename them exactly** to `logo_dark.png` and `logo_white.png`.

### 6.3 Don't have logos with transparent backgrounds?

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

## Part 7 — Verify everything is connected

This one command checks that Ollama is running, the model is installed,
and your logos are in place.

```bash
uv run content-sprout doctor
```

**Success looks like this:**

```
Config:        config.yaml
  input_dir    input
  output_dir   output
  formats      square, portrait, landscape, story
  ollama.host  http://localhost:11434
  ollama.model gemma4:31b
  ✓ Logos found (logo_dark.png, logo_white.png)
  ✓ Ollama reachable, 'gemma4:31b' available.
```

**If you see a red `✗` or yellow `!`** — read what it says. It tells you the
exact fix (e.g. "Run: ollama pull gemma4:31b" or "Missing: assets/logo_dark.png").
Fix the issue, then re-run `uv run content-sprout doctor`.

---

## Part 8 — Process your first photos!

### 8.1 Put photos in the input folder

In Finder, navigate to:

```
/Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout/input
```

Drag some JPEG, PNG, or HEIC photos into it. You can also drag whole folders —
the structure is preserved on output.

### 8.2 Run the pipeline

```bash
uv run content-sprout run
```

A progress bar appears. Each photo takes about 2–5 seconds without the AI
fallback, or 10–15 seconds when Gemma 4 is consulted (which only happens for
photos where the simple corner-picker is uncertain).

### 8.3 Check the results

```
/Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout/output
```

You'll see one folder per input photo. Each folder contains:

- `square.jpg` (1080 × 1080) — feed
- `portrait.jpg` (1080 × 1350) — feed (highest engagement)
- `landscape.jpg` (1080 × 566) — feed
- `story.jpg` (1080 × 1920) — Stories / Reels
- `manifest.json` — a record of what the AI decided (corner, logo color, etc.)

Open them in Finder — they're ready to post.

---

## Part 9 — Watch mode (the fun way)

Instead of running `content-sprout run` every time, you can leave the project in
"watch mode" and it will process photos automatically as you drop them in.

### 9.1 Start the watcher

```bash
uv run content-sprout watch
```

You'll see:

```
Watching /Users/sridhar/.../input (debounce 1.5s, Ctrl+C to stop)
  Processed → .done/   Failed → .failed/
```

Leave this terminal open.

### 9.2 Drop a photo

Open Finder, drag a photo into `input/`. Within ~2 seconds the watcher
processes it. The original photo is then moved into `input/.done/` so it
doesn't get reprocessed.

### 9.3 To stop the watcher

In the terminal running it, press `Ctrl + C`.

---

## Common problems and fixes

### "command not found: uv" / "command not found: brew"

You probably need to close and reopen Terminal. New tools are only available
in new Terminal windows.

### "Cannot reach Ollama at http://localhost:11434"

Ollama isn't running. Fix:

```bash
brew services restart ollama
```

Wait 5 seconds, then re-run `uv run content-sprout doctor`.

### "gemma4:31b not pulled yet"

You skipped Part 3.3. Fix:

```bash
ollama pull gemma4:31b
```

### "Logo PNGs missing"

You skipped Part 6. Either add the PNGs, or run anyway — outputs will just
have no watermark.

### The 31B model is too slow / runs out of memory

Edit `config.yaml`, find:

```yaml
ollama:
  model: gemma4:31b
```

Change to:

```yaml
ollama:
  model: gemma4:e4b
```

Then pull the smaller model:

```bash
ollama pull gemma4:e4b
```

It's about 4× faster and uses much less RAM. Quality is still excellent for
this task.

### "I dragged a photo into input/ but nothing happened in watch mode"

- Check it has a supported extension: `.jpg`, `.jpeg`, `.png`, `.webp`,
  `.heic`, `.tiff`.
- Wait 2 seconds — there's a debounce.
- Look in `input/.failed/` for a `.error.txt` file explaining what went wrong.

### "An image came out cropped weirdly"

The pipeline tries to keep the subject (face or salient region) in frame. If
it picked badly, look at `manifest.json` for the source photo — it tells you
whether the heuristic or the AI made the call. You can also change story
behavior in `config.yaml`:

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

Once everything is set up, your daily workflow is:

1. **Open Terminal**
2. ```bash
   cd /Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout
   ./start.sh
   ```
3. Drag photos into the `input/` folder via Finder.
4. Find processed images in `output/`.
5. Press `Ctrl + C` in Terminal when you're done for the day.

That's the entire flow. For more detail on day-to-day operations (batch mode,
troubleshooting, quick reference), see [`DAILY.md`](DAILY.md).

---

## What's next?

- Day-to-day playbook (no setup, just running) → [`DAILY.md`](DAILY.md).
- The technical reference (config, architecture, all phases) is in
  [`README.md`](README.md).
- To tweak logo size, padding, or opacity, edit `config.yaml`. The defaults
  are sensible but you can experiment.
- To change which Instagram formats are produced, edit the `formats:` list in
  `config.yaml`.
