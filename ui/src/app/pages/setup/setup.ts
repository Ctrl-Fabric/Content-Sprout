import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page cs-setup-page">
      <div class="cs-bar">
        <div>
          <h2 style="margin: 0">Setup guide</h2>
          <p class="page-intro" style="margin: 0.35rem 0 0">
            Hardware and software requirements for Content-Sprout. Core editing works on modest
            machines; local AI generation needs much more memory.
          </p>
        </div>
        <div class="page-actions-inline">
          <a routerLink="/settings" class="btn-link">Open Settings</a>
        </div>
      </div>

      <nav class="cs-setup-toc surface-card" aria-label="Setup sections">
        <a href="#hardware">Hardware</a>
        <a href="#basic">Basic software</a>
        <a href="#ai">AI stack</a>
      </nav>

      <section class="surface-card cs-settings-section" id="hardware">
        <h3 class="cs-section-title">1. Minimum hardware</h3>
        <p class="page-intro" style="margin-top: 0">
          Requirements depend on whether you only edit media, or also run local AI generation.
        </p>

        <div class="cs-setup-grid">
          <article class="cs-setup-card">
            <h4>Core studio (no local AI generation)</h4>
            <p class="meta" style="margin: 0 0 0.5rem">Timeline, scripts, assets, TTS, export, publish</p>
            <ul>
              <li><strong>Mac:</strong> macOS 13 Ventura or newer</li>
              <li><strong>Chip:</strong> Apple Silicon recommended; Intel Macs work for core editing</li>
              <li><strong>Memory:</strong> 8&nbsp;GB RAM minimum; <strong>16&nbsp;GB+</strong> recommended for comfortable multi-clip timelines</li>
              <li><strong>Disk:</strong> several GB free for projects, exports, and caches</li>
            </ul>
            <p class="meta" style="margin: 0.5rem 0 0">
              Heuristics, ffmpeg export, and macOS <code>say</code> TTS do not need a GPU or large
              unified memory.
            </p>
          </article>

          <article class="cs-setup-card cs-setup-card--emphasis">
            <h4>With local AI generation</h4>
            <p class="meta" style="margin: 0 0 0.5rem">
              Ollama vision/chat models and ComfyUI image/video workflows
            </p>
            <ul>
              <li>
                <strong>Unified memory:</strong> plan for about
                <strong>48&nbsp;GB</strong> on Apple Silicon when running text/vision LLMs and
                ComfyUI video models on the same machine
              </li>
              <li>
                Smaller machines can still use the studio; point LLM / media gen at
                <strong>cloud</strong> providers (Gemini, Higgsfield, proxies) instead of local models
              </li>
              <li>
                Local AI jobs are serialized (one Ollama or ComfyUI task at a time) to reduce memory
                spikes
              </li>
            </ul>
            <p class="meta" style="margin: 0.5rem 0 0">
              If you only need script/layout assists, a mid-size vision model via Ollama can work on
              less than 48&nbsp;GB — but <strong>local image/video generation</strong> (especially Wan-class
              video) is what drives the high memory bar.
            </p>
          </article>
        </div>
      </section>

      <section class="surface-card cs-settings-section" id="basic">
        <h3 class="cs-section-title">2. Basic software requirements</h3>
        <p class="page-intro" style="margin-top: 0">
          Needed for running the app from source or supporting video export. The packaged macOS app
          bundles the Python runtime; you still need ffmpeg on the system.
        </p>
        <ul class="cs-setup-list">
          <li>
            <strong>Python 3.11+</strong> — required for development / <code>uv sync</code> installs
            (packaged app includes its own runtime)
          </li>
          <li>
            <strong><a href="https://github.com/astral-sh/uv" target="_blank" rel="noopener">uv</a></strong>
            (recommended) or pip + venv — installs Python dependencies
          </li>
          <li>
            <strong>ffmpeg</strong> and <strong>ffprobe</strong> on <code>PATH</code> — video export,
            thumbnails, and audio duration
            <pre class="cs-setup-code"><code>brew install ffmpeg</code></pre>
          </li>
          <li>
            <strong>Homebrew</strong> (macOS) — convenient way to install ffmpeg and optional tools
          </li>
          <li>
            <strong>Node.js 20+</strong> — only if you build or run the Angular UI from source
          </li>
        </ul>
        <p class="meta" style="margin: 0.75rem 0 0">
          After install, run <code>uv run content-sprout doctor</code> (dev) to check config, logos,
          and optional AI reachability.
        </p>
      </section>

      <section class="surface-card cs-settings-section" id="ai">
        <h3 class="cs-section-title">3. AI-related requirements</h3>
        <p class="page-intro" style="margin-top: 0">
          AI is optional. Configure providers under Settings. You can mix local and cloud backends.
        </p>

        <div class="cs-setup-grid">
          <article class="cs-setup-card">
            <h4>Ollama — text + vision</h4>
            <p>
              Used for scripts, layout/logo assists, photo helpers, and other chat/vision tasks when
              the LLM provider is set to local.
            </p>
            <ul>
              <li>Install from <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a> or Homebrew</li>
              <li>
                Pull a <strong>vision-capable</strong> model (text-only models are not enough for
                image-aware features)
              </li>
              <li>Example:
                <pre class="cs-setup-code"><code>brew install ollama
brew services start ollama
ollama pull gemma3:12b</code></pre>
              </li>
              <li>In Settings → Language &amp; vision AI, choose <strong>Local (Ollama)</strong> and select your model</li>
            </ul>
            <p class="meta" style="margin: 0.5rem 0 0">
              Prefer a model size that fits your memory. Content-Sprout sends
              <code>keep_alive: 0</code> so Ollama can unload after each call and free memory for ComfyUI.
            </p>
          </article>

          <article class="cs-setup-card">
            <h4>ComfyUI — image &amp; video generation</h4>
            <p>
              Powers Create → AI Gen and Assets generate/upscale when the media backend is ComfyUI. Workflows
              are API-format JSON files stored under tools storage or packaged defaults.
            </p>
            <ul>
              <li>Install and run <a href="https://github.com/comfyanonymous/ComfyUI" target="_blank" rel="noopener">ComfyUI</a> locally (default <code>http://127.0.0.1:8188</code>)</li>
              <li>Install the models required by your workflows (UNET / CLIP / VAE / upscalers, etc.)</li>
              <li>
                Export workflows as <strong>API format</strong>, then upload or place them in
                <code>src/content_sprout/workflows/</code> as packaged defaults
              </li>
              <li>
                In Settings → Media generation / ComfyUI, set provider to local, assign workflows per
                operation, and review required models on each flow
              </li>
            </ul>
            <p class="meta" style="margin: 0.5rem 0 0">
              Local video generation is the heaviest path — treat the <strong>48&nbsp;GB unified memory</strong>
              guidance as the practical bar when combining Ollama + ComfyUI on one Mac.
            </p>
          </article>
        </div>

        <div class="cs-setup-note">
          <strong>Cloud alternatives:</strong> Gemini, Higgsfield, or OpenAI-compatible proxies can
          replace local Ollama/ComfyUI when hardware is limited. Configure those in Settings instead
          of (or alongside) local services.
        </div>
      </section>
    </div>
  `,
  styles: [
    `
      .cs-setup-toc {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem 1.25rem;
        padding: 0.85rem 1rem;
        margin-bottom: 1rem;
      }
      .cs-setup-toc a {
        text-decoration: none;
        font-weight: 600;
        color: inherit;
        opacity: 0.85;
      }
      .cs-setup-toc a:hover {
        opacity: 1;
        text-decoration: underline;
      }
      .cs-setup-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
        gap: 0.85rem;
      }
      .cs-setup-card {
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        border-radius: 10px;
        padding: 0.85rem 1rem;
        background: color-mix(in srgb, currentColor 3%, transparent);
      }
      .cs-setup-card--emphasis {
        border-color: color-mix(in srgb, var(--cs-accent, #3b82f6) 45%, transparent);
        background: color-mix(in srgb, var(--cs-accent, #3b82f6) 8%, transparent);
      }
      .cs-setup-card h4 {
        margin: 0 0 0.35rem;
        font-size: 1rem;
      }
      .cs-setup-card ul,
      .cs-setup-list {
        margin: 0.35rem 0 0;
        padding-left: 1.15rem;
      }
      .cs-setup-card li,
      .cs-setup-list li {
        margin: 0.35rem 0;
      }
      .cs-setup-code {
        margin: 0.45rem 0 0;
        padding: 0.55rem 0.7rem;
        border-radius: 8px;
        overflow: auto;
        font-size: 0.85rem;
        background: color-mix(in srgb, currentColor 8%, transparent);
      }
      .cs-setup-note {
        margin-top: 0.85rem;
        padding: 0.75rem 0.9rem;
        border-radius: 8px;
        background: color-mix(in srgb, currentColor 6%, transparent);
      }
      .btn-link {
        display: inline-flex;
        align-items: center;
        padding: 0.35rem 0.7rem;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        text-decoration: none;
        color: inherit;
      }
    `,
  ],
})
export class SetupPage {}
