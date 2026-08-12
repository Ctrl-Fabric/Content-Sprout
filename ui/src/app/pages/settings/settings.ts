import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SnackbarService } from '@ctrlfabric/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import type {
  ComfyWorkflowEntry,
  LlmSettings,
  LlmSettingsUpdate,
  SettingsTestResult,
  StockSettings,
  StorageSettings,
} from '../../models/content-sprout.models';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="page cs-settings">
      <div class="cs-bar">
        <div>
          <h2 style="margin: 0">Settings</h2>
          <p class="page-intro" style="margin: 0.35rem 0 0">
            Preferences are saved to <code>config.yaml</code> and reused on every start.
          </p>
        </div>
        <div class="page-actions-inline">
          <button type="button" (click)="reload()" [disabled]="busy()">Reload</button>
          <button type="button" class="primary" (click)="save()" [disabled]="busy()">
            {{ busy() ? 'Saving…' : 'Save settings' }}
          </button>
        </div>
      </div>

      @if (loadError()) {
        <p class="status-msg error">{{ loadError() }}</p>
      }

      <!-- Config / storage -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Config &amp; storage</h3>
        <p class="page-intro" style="margin-top: 0">
          Active config:
          <code class="cs-mono">{{ storage.config_path || 'config.yaml' }}</code>
        </p>
        <div class="cs-form-stack">
          <label>
            <span>Projects folder</span>
            <input [(ngModel)]="storage.projects_dir" placeholder="projects" />
            @if (storage.projects_dir_resolved) {
              <span class="meta">Resolved: {{ storage.projects_dir_resolved }}</span>
            }
          </label>
          <label>
            <span>Scripts folder</span>
            <input [(ngModel)]="storage.scripts_dir" placeholder="scripts" />
            @if (storage.scripts_dir_resolved) {
              <span class="meta">Resolved: {{ storage.scripts_dir_resolved }}</span>
            }
          </label>
          <label>
            <span>Cache folder</span>
            <input [(ngModel)]="storage.cache_dir" placeholder="cache" />
            @if (storage.cache_dir_resolved) {
              <span class="meta">Resolved: {{ storage.cache_dir_resolved }}</span>
            }
          </label>
        </div>
      </section>

      <!-- LLM -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Language &amp; vision AI</h3>
        <p class="page-intro" style="margin-top: 0">
          Layout edits, scripts, asset descriptions, captions, and suggestions.
        </p>
        <div class="cs-form-stack">
          <label>
            <span>Provider</span>
            <select [(ngModel)]="llmProvider">
              <option value="heuristic_only">Off (built-in heuristics only)</option>
              <option value="ollama">Local (Ollama)</option>
              <option value="gemini">Gemini (Google cloud)</option>
              <option value="proxy">Cloud / gateway (OpenAI, OpenRouter, Portkey, …)</option>
            </select>
          </label>

          @if (llmProvider === 'ollama') {
            <div class="surface-inset cs-form-stack">
              <p class="meta" style="margin: 0">Talks to a local Ollama server. No API key required.</p>
              <label>
                <span>Ollama host</span>
                <input [(ngModel)]="ollamaHost" placeholder="http://localhost:11434" />
              </label>
              <label>
                <span>Model</span>
                <input [(ngModel)]="ollamaModel" placeholder="gemma4:31b" />
              </label>
              <label>
                <span>Timeout (seconds)</span>
                <input type="number" min="1" max="600" [(ngModel)]="ollamaTimeout" />
              </label>
            </div>
          }

          @if (llmProvider === 'gemini') {
            <div class="surface-inset cs-form-stack">
              <p class="meta" style="margin: 0">
                Direct Google Gemini API for scripts, layout, and vision. Same API key is used for Nano
                Banana image generation below.
              </p>
              <label>
                <span>Gemini API key</span>
                <input
                  type="password"
                  [(ngModel)]="geminiApiKey"
                  placeholder="Leave blank to keep existing key"
                  autocomplete="off"
                />
                <span class="meta">{{ geminiApiKeyHint }}</span>
              </label>
              <label>
                <span>Text / vision model</span>
                <input [(ngModel)]="geminiModel" placeholder="gemini-2.5-flash" />
              </label>
              <label>
                <span>Vision model override (optional)</span>
                <input [(ngModel)]="geminiVisionModel" placeholder="Blank = use text model" />
              </label>
              <label>
                <span>Timeout (seconds)</span>
                <input type="number" min="1" max="600" [(ngModel)]="geminiTimeout" />
              </label>
            </div>
          }

          @if (llmProvider === 'proxy') {
            <div class="surface-inset cs-form-stack">
              <p class="meta" style="margin: 0">
                OpenAI-compatible <code>/chat/completions</code>. Use a preset for direct OpenAI or a
                gateway.
              </p>
              <div class="page-actions-inline" style="flex-wrap: wrap">
                <button type="button" (click)="applyProxyPreset('openai')">OpenAI</button>
                <button type="button" (click)="applyProxyPreset('openrouter')">OpenRouter</button>
                <button type="button" (click)="applyProxyPreset('portkey')">Portkey</button>
                <button type="button" (click)="applyProxyPreset('custom')">Custom</button>
              </div>
              <label>
                <span>Base URL</span>
                <input [(ngModel)]="proxyBaseUrl" placeholder="https://api.openai.com/v1" />
              </label>
              <label>
                <span>API key</span>
                <input
                  type="password"
                  [(ngModel)]="proxyApiKey"
                  placeholder="Leave blank to keep existing key"
                  autocomplete="off"
                />
                <span class="meta">{{ proxyApiKeyHint }}</span>
              </label>
              <label>
                <span>Model</span>
                <input [(ngModel)]="proxyModel" placeholder="gpt-4o" />
              </label>
              <div class="cs-form-row" style="margin: 0">
                <label>
                  <span>Portkey provider</span>
                  <input [(ngModel)]="proxyPortkeyProvider" placeholder="openai" />
                </label>
                <label>
                  <span>Portkey virtual key</span>
                  <input
                    type="password"
                    [(ngModel)]="proxyPortkeyVirtualKey"
                    placeholder="Leave blank to keep"
                    autocomplete="off"
                  />
                  <span class="meta">{{ proxyVirtualKeyHint }}</span>
                </label>
              </div>
              <label>
                <span>Timeout (seconds)</span>
                <input type="number" min="1" max="600" [(ngModel)]="proxyTimeout" />
              </label>
            </div>
          }

          <div class="page-actions-inline">
            <button type="button" (click)="testLlm()" [disabled]="busy() || testingLlm()">
              {{ testingLlm() ? 'Testing…' : 'Test connection' }}
            </button>
            @if (llmTest()) {
              <span class="meta" [class.cs-ok]="llmTest()!.ok" [class.cs-bad]="!llmTest()!.ok">
                {{ llmTest()!.ok ? 'OK' : 'Failed' }}
              </span>
            }
          </div>
          @if (llmTestText()) {
            <pre class="cs-test-result" [class.is-bad]="llmTest() && !llmTest()!.ok">{{ llmTestText() }}</pre>
          }
          @if (api.llmError() && !llmTestText()) {
            <pre class="cs-test-result is-bad">{{ api.llmError() }}</pre>
          }
        </div>
      </section>

      <!-- Image gen -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Image generation</h3>
        <p class="page-intro" style="margin-top: 0">
          Generative photo edits via OpenAI-compatible <code>/images</code> APIs. Local Pillow ops
          work without this.
          @if (imageGenReady) {
            <span class="cs-ok"> · Ready</span>
          }
        </p>
        <div class="cs-form-stack">
          <label>
            <span>Provider</span>
            <select [(ngModel)]="imageGenProvider">
              <option value="off">Off</option>
              <option value="local">Local OpenAI-compatible API</option>
              <option value="proxy">Cloud / gateway</option>
            </select>
          </label>
          @if (imageGenProvider !== 'off') {
            <div class="surface-inset cs-form-stack">
              <label>
                <span>Base URL</span>
                <input [(ngModel)]="imageGenBaseUrl" placeholder="https://api.portkey.ai/v1" />
              </label>
              <label>
                <span>API key</span>
                <input
                  type="password"
                  [(ngModel)]="imageGenApiKey"
                  placeholder="Optional for local · leave blank to keep"
                  autocomplete="off"
                />
                <span class="meta">{{ imageGenApiKeyHint }}</span>
              </label>
              <label>
                <span>Model</span>
                <input [(ngModel)]="imageGenModel" placeholder="gpt-image-1" />
              </label>
              @if (imageGenProvider === 'proxy') {
                <div class="cs-form-row" style="margin: 0">
                  <label>
                    <span>Portkey provider</span>
                    <input [(ngModel)]="imageGenPortkeyProvider" placeholder="openai" />
                  </label>
                  <label>
                    <span>Portkey virtual key</span>
                    <input
                      type="password"
                      [(ngModel)]="imageGenPortkeyVirtualKey"
                      placeholder="Leave blank to keep"
                      autocomplete="off"
                    />
                  </label>
                </div>
              }
              <label>
                <span>Timeout (seconds)</span>
                <input type="number" min="1" max="600" [(ngModel)]="imageGenTimeout" />
              </label>
            </div>
          }
        </div>
      </section>

      <!-- Media generation tools -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Media generation tools</h3>
        <p class="page-intro" style="margin-top: 0">
          Select which tool to use for each supported media generation use case.
          @if (mediaGenReadyHint) {
            <span class="cs-ok"> · {{ mediaGenReadyHint }}</span>
          }
        </p>

        <div class="cs-form-stack">
          <div class="surface-inset cs-form-stack">
            <label>
              <span>1) Generate image from text prompt</span>
              <select [(ngModel)]="mediaOpTextToImage">
                <option value="comfyui">ComfyUI</option>
                <option value="gemini">Gemini</option>
                <option value="higgsfield">Higgsfield</option>
              </select>
            </label>

            <label>
              <span>2) Generate video from text prompt</span>
              <select [(ngModel)]="mediaOpTextToVideo">
                <option value="comfyui">ComfyUI</option>
                <option value="higgsfield">Higgsfield</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>

            <label>
              <span>3) Generate video from text prompt + reference image</span>
              <select [(ngModel)]="mediaOpImageToVideo">
                <option value="comfyui">ComfyUI</option>
                <option value="higgsfield">Higgsfield</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>

            <label>
              <span>4) Scale a video</span>
              <select [(ngModel)]="mediaOpUpscaleVideo">
                <option value="comfyui">ComfyUI</option>
                <option value="higgsfield">Higgsfield</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>
          </div>

          @if (anyGeminiSelected()) {
            <div class="surface-inset cs-form-stack">
              <p class="meta" style="margin: 0">
                Gemini (Nano Banana) — shared with Language &amp; vision when provider is Gemini
              </p>
              <label>
                <span>Gemini API key</span>
                <input
                  type="password"
                  [(ngModel)]="geminiApiKey"
                  placeholder="Leave blank to keep existing key"
                  autocomplete="off"
                />
                <span class="meta">{{ geminiApiKeyHint }}</span>
              </label>
              <label>
                <span>Image model</span>
                <input [(ngModel)]="geminiImageModel" placeholder="gemini-2.5-flash-image" />
              </label>
              <label>
                <span>Image timeout (seconds)</span>
                <input type="number" min="1" max="900" [(ngModel)]="geminiImageTimeout" />
              </label>
            </div>
          }

          @if (anyHiggsfieldSelected()) {
            <div class="surface-inset cs-form-stack">
              <p class="meta" style="margin: 0">Higgsfield cloud</p>
              <label>
                <span>API key ID</span>
                <input
                  type="password"
                  [(ngModel)]="higgsfieldApiKeyId"
                  placeholder="Leave blank to keep"
                  autocomplete="off"
                />
                <span class="meta">{{ higgsfieldKeyIdHint }}</span>
              </label>
              <label>
                <span>API key secret</span>
                <input
                  type="password"
                  [(ngModel)]="higgsfieldApiKeySecret"
                  placeholder="Leave blank to keep"
                  autocomplete="off"
                />
                <span class="meta">{{ higgsfieldSecretHint }}</span>
              </label>
              <label>
                <span>Base URL</span>
                <input [(ngModel)]="higgsfieldBaseUrl" placeholder="https://platform.higgsfield.ai" />
              </label>
              <label>
                <span>Endpoint · text → image</span>
                <input [(ngModel)]="higgsfieldEndpointT2I" placeholder="higgsfield-ai/soul/standard" />
              </label>
              <label>
                <span>Endpoint · text → video</span>
                <input [(ngModel)]="higgsfieldEndpointT2V" placeholder="Model path from Higgsfield Cloud" />
              </label>
              <label>
                <span>Endpoint · image → video</span>
                <input [(ngModel)]="higgsfieldEndpointI2V" placeholder="higgsfield-ai/dop/standard" />
              </label>
              <label>
                <span>Endpoint · upscale video (optional)</span>
                <input [(ngModel)]="higgsfieldEndpointUpscaleVideo" />
              </label>
              <label>
                <span>Timeout (seconds)</span>
                <input type="number" min="30" max="3600" [(ngModel)]="higgsfieldTimeout" />
              </label>
            </div>
          }
        </div>
      </section>

      <!-- ComfyUI media generation (only when at least one use case uses ComfyUI) -->
      @if (anyComfyuiSelected()) {
        <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">ComfyUI media generation</h3>
        <p class="page-intro" style="margin-top: 0">
          Local/remote ComfyUI workflows for image &amp; video generation and upscale, or an
          OpenAI-compatible video gateway for text→video.
          @if (comfyReady) {
            <span class="cs-ok"> · Ready</span>
          }
        </p>
        <div class="cs-form-stack">
          <label>
            <span>Provider</span>
            <select [(ngModel)]="comfyProvider">
              <option value="off">Off</option>
              <option value="local">Local ComfyUI</option>
              <option value="proxy">Cloud / gateway</option>
            </select>
          </label>
          @if (comfyProvider !== 'off') {
            <div class="surface-inset cs-form-stack">
              <label>
                <span>ComfyUI URL</span>
                <input [(ngModel)]="comfyBaseUrl" placeholder="http://127.0.0.1:8188" />
              </label>
              <label>
                <span>ComfyUI API key</span>
                <input
                  type="password"
                  [(ngModel)]="comfyApiKey"
                  placeholder="Optional · leave blank to keep"
                  autocomplete="off"
                />
                <span class="meta">{{ comfyApiKeyHint }}</span>
              </label>

              <div class="surface-inset cs-form-stack">
                <p class="meta" style="margin: 0">
                  Upload ComfyUI <strong>API format</strong> workflows (flat JSON keyed by node id).
                  Files are <strong>copied</strong> into ContentSprout storage — you can move or delete
                  the original. Models and loaders stay as configured in the workflow.
                  Editor format (top-level <code>nodes</code> / <code>links</code>) must be exported
                  as API format from ComfyUI first.
                </p>
                @if (comfyWorkflowsDirResolved) {
                  <span class="meta">Stored in: <code class="cs-mono">{{ comfyWorkflowsDirResolved }}</code></span>
                }
                <div class="page-actions-inline" style="flex-wrap: wrap">
                  <input
                    #workflowFileInput
                    type="file"
                    accept=".json,application/json"
                    style="display: none"
                    (change)="onWorkflowFileSelected($event)"
                  />
                  <button type="button" (click)="workflowFileInput.click()" [disabled]="busy() || uploadingWorkflow()">
                    Choose workflow JSON…
                  </button>
                  <label style="margin: 0">
                    <span>Assign after upload</span>
                    <select [(ngModel)]="workflowUploadAssignOp" [disabled]="busy() || uploadingWorkflow()">
                      <option value="">Do not assign</option>
                      <option value="text_to_image">Text → image</option>
                      <option value="text_to_video">Text → video</option>
                      <option value="image_to_video">Image → video</option>
                      <option value="upscale_video">Upscale video</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    (click)="uploadWorkflow()"
                    [disabled]="busy() || uploadingWorkflow() || !workflowUploadFile"
                  >
                    {{ uploadingWorkflow() ? 'Uploading…' : 'Upload workflow' }}
                  </button>
                </div>
                @if (workflowUploadFile) {
                  <span class="meta">Selected: {{ workflowUploadFile.name }}</span>
                }
                @if (comfyWorkflows.length) {
                  <ul class="cs-workflow-list" style="margin: 0; padding-left: 1.1rem">
                    @for (wf of comfyWorkflows; track wf.stem) {
                      <li>
                        <code>{{ wf.stem }}</code>
                        <span class="meta"> · {{ wf.source === 'package' ? 'built-in' : 'uploaded' }}</span>
                        @if (wf.source === 'user') {
                          <button
                            type="button"
                            class="cs-inline-btn"
                            (click)="deleteWorkflow(wf.filename)"
                            [disabled]="busy() || uploadingWorkflow()"
                          >
                            Delete
                          </button>
                        }
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="meta" style="margin: 0">No workflows found yet.</p>
                }
              </div>

              <div class="cs-form-stack" style="gap: 0.55rem">
                <p class="meta" style="margin: 0">Assign a workflow per operation</p>
                @if (mediaOpTextToImage === 'comfyui') {
                  <label>
                    <span>Text → image</span>
                    <select [(ngModel)]="comfyWorkflowTextToImage">
                      <option value="">Not configured</option>
                      @for (wf of comfyWorkflows; track wf.stem) {
                        <option [value]="wf.stem">{{ wf.stem }} ({{ wf.source }})</option>
                      }
                    </select>
                  </label>
                }
                @if (mediaOpTextToVideo === 'comfyui') {
                  <label>
                    <span>Text → video</span>
                    <select [(ngModel)]="comfyWorkflowTextToVideo">
                      <option value="">Not configured</option>
                      @for (wf of comfyWorkflows; track wf.stem) {
                        <option [value]="wf.stem">{{ wf.stem }} ({{ wf.source }})</option>
                      }
                    </select>
                  </label>
                }
                @if (mediaOpImageToVideo === 'comfyui') {
                  <label>
                    <span>Image + text → video</span>
                    <select [(ngModel)]="comfyWorkflowImageToVideo">
                      <option value="">Not configured</option>
                      @for (wf of comfyWorkflows; track wf.stem) {
                        <option [value]="wf.stem">{{ wf.stem }} ({{ wf.source }})</option>
                      }
                    </select>
                  </label>
                }
                @if (mediaOpUpscaleVideo === 'comfyui') {
                  <label>
                    <span>Upscale video</span>
                    <select [(ngModel)]="comfyWorkflowUpscaleVideo">
                      <option value="">Not configured</option>
                      @for (wf of comfyWorkflows; track wf.stem) {
                        <option [value]="wf.stem">{{ wf.stem }} ({{ wf.source }})</option>
                      }
                    </select>
                  </label>
                }
              </div>

              <div class="cs-form-row" style="margin: 0">
                <label>
                  <span>Frames</span>
                  <input type="number" [(ngModel)]="comfyFrames" />
                </label>
                <label>
                  <span>FPS</span>
                  <input type="number" [(ngModel)]="comfyFps" />
                </label>
                <label>
                  <span>Steps</span>
                  <input type="number" [(ngModel)]="comfySteps" />
                </label>
                <label>
                  <span>CFG</span>
                  <input type="number" step="0.5" [(ngModel)]="comfyCfg" />
                </label>
                <label>
                  <span>Timeout (s)</span>
                  <input type="number" [(ngModel)]="comfyTimeout" />
                </label>
              </div>
              <p class="meta" style="margin: 0">
                Prompt and video size presets are chosen on the Assets page when generating (not here).
                Video upscale is capped at 2×.
              </p>

              @if (comfyProvider === 'proxy') {
                <div class="cs-form-stack">
                  <p class="meta" style="margin: 0">
                    Optional OpenAI-compatible video gateway (when set, used for text→video instead
                    of a ComfyUI workflow).
                  </p>
                  <label>
                    <span>Gateway base URL</span>
                    <input [(ngModel)]="comfyGatewayBaseUrl" placeholder="https://…" />
                  </label>
                  <label>
                    <span>Gateway API key</span>
                    <input
                      type="password"
                      [(ngModel)]="comfyGatewayApiKey"
                      placeholder="Leave blank to keep"
                      autocomplete="off"
                    />
                    <span class="meta">{{ comfyGatewayApiKeyHint }}</span>
                  </label>
                  <label>
                    <span>Gateway model</span>
                    <input [(ngModel)]="comfyGatewayModel" />
                  </label>
                  <label>
                    <span>Portkey provider</span>
                    <input [(ngModel)]="comfyPortkeyProvider" />
                  </label>
                  <label>
                    <span>Gateway timeout (s)</span>
                    <input type="number" [(ngModel)]="comfyGatewayTimeout" />
                  </label>
                </div>
              }

              <label>
                <span>Negative prompt</span>
                <textarea rows="3" [(ngModel)]="comfyNegativePrompt"></textarea>
              </label>

              <div class="page-actions-inline">
                <button type="button" (click)="testComfy()" [disabled]="busy() || testingComfy()">
                  {{ testingComfy() ? 'Testing…' : 'Test ComfyUI' }}
                </button>
                @if (comfyTest()) {
                  <span
                    class="meta"
                    [class.cs-ok]="comfyTest()!.ok"
                    [class.cs-bad]="!comfyTest()!.ok"
                  >
                    {{ comfyTest()!.ok ? 'OK' : comfyTest()!.detail || 'Failed' }}
                  </span>
                }
              </div>
              @if (comfyTestText()) {
                <pre class="cs-test-result">{{ comfyTestText() }}</pre>
              }
            </div>
          }
        </div>
        </section>
      }

      <!-- Stock -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Free stock</h3>
        <p class="page-intro" style="margin-top: 0">
          Pixabay key for free-stock search and the daily import quota.
        </p>
        <div class="cs-form-stack">
          <label>
            <span>Pixabay API key</span>
            <input
              type="password"
              [(ngModel)]="pixabayApiKey"
              placeholder="Leave blank to keep existing key"
              autocomplete="off"
            />
            <span class="meta">{{ pixabayHint }}</span>
          </label>
          <label>
            <span>Daily download limit</span>
            <input type="number" min="0" [(ngModel)]="dailyDownloadLimit" />
            <span class="meta">{{ dailyLimitHint }} · 0 = unlimited</span>
          </label>
        </div>
      </section>

      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">About</h3>
        <p class="page-intro" style="margin: 0">
          API base <code>{{ apiBase }}</code>
        </p>
      </section>

      <div class="cs-settings-footer">
        <button type="button" class="primary" (click)="save()" [disabled]="busy()">
          {{ busy() ? 'Saving…' : 'Save settings' }}
        </button>
      </div>
    </div>
  `,
})
export class SettingsPage implements OnInit {
  readonly apiBase = environment.apiBase;
  readonly busy = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly testingLlm = signal(false);
  readonly testingComfy = signal(false);
  readonly uploadingWorkflow = signal(false);
  readonly llmTest = signal<SettingsTestResult | null>(null);
  readonly comfyTest = signal<SettingsTestResult | null>(null);
  readonly llmTestText = signal('');
  readonly comfyTestText = signal('');

  storage: StorageSettings = {};

  llmProvider: string = 'ollama';
  ollamaHost = 'http://localhost:11434';
  ollamaModel = 'gemma4:31b';
  ollamaTimeout = 60;
  proxyBaseUrl = 'https://api.portkey.ai/v1';
  proxyApiKey = '';
  proxyModel = 'gpt-4o';
  proxyPortkeyProvider = '';
  proxyPortkeyVirtualKey = '';
  proxyTimeout = 60;
  proxyApiKeyHint = '';
  proxyVirtualKeyHint = '';

  geminiApiKey = '';
  geminiApiKeyHint = '';
  geminiModel = 'gemini-2.5-flash';
  geminiVisionModel = '';
  geminiTimeout = 120;
  geminiImageModel = 'gemini-2.5-flash-image';
  geminiImageTimeout = 180;

  mediaDefaultBackend = 'comfyui';
  mediaOpTextToImage = 'comfyui';
  mediaOpTextToVideo = 'comfyui';
  mediaOpImageToVideo = 'comfyui';
  mediaOpUpscaleImage = 'inherit';
  mediaOpUpscaleVideo = 'comfyui';
  mediaGenReadyHint = '';

  higgsfieldApiKeyId = '';
  higgsfieldApiKeySecret = '';
  higgsfieldKeyIdHint = '';
  higgsfieldSecretHint = '';
  higgsfieldBaseUrl = 'https://platform.higgsfield.ai';
  higgsfieldEndpointT2I = 'higgsfield-ai/soul/standard';
  higgsfieldEndpointT2V = '';
  higgsfieldEndpointI2V = 'higgsfield-ai/dop/standard';
  higgsfieldEndpointUpscaleImage = '';
  higgsfieldEndpointUpscaleVideo = '';
  higgsfieldTimeout = 900;

  imageGenProvider = 'off';
  imageGenBaseUrl = 'https://api.portkey.ai/v1';
  imageGenApiKey = '';
  imageGenModel = 'gpt-image-1';
  imageGenPortkeyProvider = '';
  imageGenPortkeyVirtualKey = '';
  imageGenTimeout = 120;
  imageGenApiKeyHint = '';
  imageGenReady = false;

  comfyProvider = 'off';
  comfyBaseUrl = 'http://127.0.0.1:8188';
  comfyApiKey = '';
  comfyWorkflowsDirResolved = '';
  comfyWorkflows: ComfyWorkflowEntry[] = [];
  workflowUploadFile: File | null = null;
  workflowUploadAssignOp = '';
  comfyWorkflowTextToImage = '';
  comfyWorkflowTextToVideo = '';
  comfyWorkflowImageToVideo = '';
  comfyWorkflowUpscaleImage = '';
  comfyWorkflowUpscaleVideo = '';
  comfyFrames = 33;
  comfyFps = 16;
  comfySteps = 30;
  comfyCfg = 6;
  comfyTimeout = 900;
  comfyNegativePrompt = '';
  comfyGatewayBaseUrl = '';
  comfyGatewayApiKey = '';
  comfyGatewayModel = '';
  comfyPortkeyProvider = '';
  comfyGatewayTimeout = 600;
  comfyApiKeyHint = '';
  comfyGatewayApiKeyHint = '';
  comfyReady = false;

  pixabayApiKey = '';
  pixabayHint = '';
  dailyDownloadLimit = 20;
  dailyLimitHint = '';

  anyGeminiSelected(): boolean {
    return (
      this.mediaOpTextToImage === 'gemini' ||
      this.mediaOpTextToVideo === 'gemini' ||
      this.mediaOpImageToVideo === 'gemini' ||
      this.mediaOpUpscaleVideo === 'gemini'
    );
  }

  anyHiggsfieldSelected(): boolean {
    return (
      this.mediaOpTextToImage === 'higgsfield' ||
      this.mediaOpTextToVideo === 'higgsfield' ||
      this.mediaOpImageToVideo === 'higgsfield' ||
      this.mediaOpUpscaleVideo === 'higgsfield'
    );
  }

  anyComfyuiSelected(): boolean {
    return (
      this.mediaOpTextToImage === 'comfyui' ||
      this.mediaOpTextToVideo === 'comfyui' ||
      this.mediaOpImageToVideo === 'comfyui' ||
      this.mediaOpUpscaleVideo === 'comfyui'
    );
  }

  constructor(
    public api: ContentSproutApiService,
    private snackbar: SnackbarService,
  ) {}

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.busy.set(true);
    this.loadError.set(null);
    this.llmTest.set(null);
    this.comfyTest.set(null);
    this.llmTestText.set('');
    this.comfyTestText.set('');
    try {
      const [storage, llm, stock] = await Promise.all([
        this.api.getStorageSettings(),
        this.api.getLlmSettings(),
        this.api.getStockSettings(),
      ]);
      if (!storage || !llm) {
        this.loadError.set('Could not load settings from the API.');
        return;
      }
      this.applyStorage(storage);
      this.applyLlm(llm);
      if (stock) this.applyStock(stock);
      if (this.comfyProvider !== 'off') {
        await this.loadWorkflows();
      } else {
        this.comfyWorkflows = [];
        this.comfyWorkflowsDirResolved = '';
      }
    } finally {
      this.busy.set(false);
    }
  }

  private applyStorage(s: StorageSettings): void {
    this.storage = { ...s };
  }

  private applyLlm(data: LlmSettings): void {
    this.llmProvider = data.provider || 'ollama';
    const ollama = data.ollama || {};
    this.ollamaHost = ollama.host || 'http://localhost:11434';
    this.ollamaModel = ollama.model || 'gemma4:31b';
    this.ollamaTimeout = ollama.timeout_s ?? 60;

    const proxy = data.proxy || {};
    this.proxyBaseUrl = proxy.base_url || 'https://api.portkey.ai/v1';
    this.proxyApiKey = '';
    this.proxyModel = proxy.model || 'gpt-4o';
    this.proxyPortkeyProvider = proxy.portkey_provider || '';
    this.proxyPortkeyVirtualKey = '';
    this.proxyTimeout = proxy.timeout_s ?? 60;
    this.proxyApiKeyHint = proxy.api_key_set
      ? `Current key: ${proxy.api_key_masked || 'configured'}`
      : 'No API key saved yet.';
    this.proxyVirtualKeyHint = proxy.portkey_virtual_key_set
      ? `Current virtual key: ${proxy.portkey_virtual_key_masked || 'configured'}`
      : '';

    const gem = data.gemini || {};
    this.geminiApiKey = '';
    this.geminiModel = gem.model || 'gemini-2.5-flash';
    this.geminiVisionModel = gem.vision_model || '';
    this.geminiTimeout = gem.timeout_s ?? 120;
    this.geminiImageModel = gem.image_model || 'gemini-2.5-flash-image';
    this.geminiImageTimeout = gem.image_timeout_s ?? 180;
    this.geminiApiKeyHint = gem.api_key_set
      ? `Current key: ${gem.api_key_masked || 'configured'}`
      : 'No Gemini API key saved yet.';

    const mg = data.media_gen || {};
    const defaultBackend = mg.default_backend || 'comfyui';
    this.mediaDefaultBackend = defaultBackend;
    this.mediaOpTextToImage =
      mg.text_to_image && mg.text_to_image !== 'inherit' ? mg.text_to_image : defaultBackend;
    this.mediaOpTextToVideo =
      mg.text_to_video && mg.text_to_video !== 'inherit' ? mg.text_to_video : defaultBackend;
    this.mediaOpImageToVideo =
      mg.image_to_video && mg.image_to_video !== 'inherit' ? mg.image_to_video : defaultBackend;
    this.mediaOpUpscaleImage =
      mg.upscale_image && mg.upscale_image !== 'inherit' ? mg.upscale_image : defaultBackend;
    this.mediaOpUpscaleVideo =
      mg.upscale_video && mg.upscale_video !== 'inherit' ? mg.upscale_video : defaultBackend;
    const ops = mg.ops || {};
    const readyOps = Object.entries(ops)
      .filter(([, ok]) => !!ok)
      .map(([name]) => name);
    this.mediaGenReadyHint = readyOps.length ? `${readyOps.length} ops ready` : '';

    const hf = data.higgsfield || {};
    this.higgsfieldApiKeyId = '';
    this.higgsfieldApiKeySecret = '';
    this.higgsfieldBaseUrl = hf.base_url || 'https://platform.higgsfield.ai';
    this.higgsfieldEndpointT2I = hf.endpoint_text_to_image || 'higgsfield-ai/soul/standard';
    this.higgsfieldEndpointT2V = hf.endpoint_text_to_video || '';
    this.higgsfieldEndpointI2V = hf.endpoint_image_to_video || 'higgsfield-ai/dop/standard';
    this.higgsfieldEndpointUpscaleImage = hf.endpoint_upscale_image || '';
    this.higgsfieldEndpointUpscaleVideo = hf.endpoint_upscale_video || '';
    this.higgsfieldTimeout = hf.timeout_s ?? 900;
    this.higgsfieldKeyIdHint = hf.api_key_id_set
      ? `Current id: ${hf.api_key_id_masked || 'configured'}`
      : 'No key id saved yet.';
    this.higgsfieldSecretHint = hf.api_key_secret_set
      ? `Current secret: ${hf.api_key_secret_masked || 'configured'}`
      : 'No secret saved yet.';

    const ig = data.image_gen || {};
    this.imageGenProvider = ig.provider || (ig.enabled ? 'proxy' : 'off');
    this.imageGenBaseUrl =
      ig.base_url ||
      (this.imageGenProvider === 'local' ? 'http://127.0.0.1:8080/v1' : 'https://api.portkey.ai/v1');
    this.imageGenApiKey = '';
    this.imageGenModel = ig.model || 'gpt-image-1';
    this.imageGenPortkeyProvider = ig.portkey_provider || '';
    this.imageGenPortkeyVirtualKey = '';
    this.imageGenTimeout = ig.timeout_s ?? 120;
    this.imageGenReady = !!ig.ready;
    this.imageGenApiKeyHint = ig.api_key_set
      ? `Current key: ${ig.api_key_masked || 'configured'}`
      : this.imageGenProvider === 'local'
        ? 'API key optional for local servers.'
        : 'No API key saved yet.';

    const cu = data.comfyui || {};
    this.comfyProvider = cu.provider || (cu.enabled ? 'local' : 'off');
    this.comfyBaseUrl = cu.base_url || 'http://127.0.0.1:8188';
    this.comfyApiKey = '';
    this.comfyWorkflowTextToImage = cu.workflow_text_to_image || '';
    this.comfyWorkflowTextToVideo = cu.workflow_text_to_video || '';
    this.comfyWorkflowImageToVideo = cu.workflow_image_to_video || '';
    this.comfyWorkflowUpscaleImage = cu.workflow_upscale_image || '';
    this.comfyWorkflowUpscaleVideo = cu.workflow_upscale_video || '';
    this.comfyFrames = cu.frames ?? 33;
    this.comfyFps = cu.fps ?? 16;
    this.comfySteps = cu.steps ?? 30;
    this.comfyCfg = cu.cfg ?? 6;
    this.comfyTimeout = cu.timeout_s ?? 900;
    this.comfyNegativePrompt = cu.negative_prompt || '';
    this.comfyGatewayBaseUrl = cu.gateway_base_url || '';
    this.comfyGatewayApiKey = '';
    this.comfyGatewayModel = cu.gateway_model || '';
    this.comfyPortkeyProvider = cu.portkey_provider || '';
    this.comfyGatewayTimeout = cu.gateway_timeout_s ?? 600;
    this.comfyReady = !!cu.ready;
    this.comfyApiKeyHint = cu.api_key_set
      ? `Current key: ${cu.api_key_masked || 'configured'}`
      : '';
    this.comfyGatewayApiKeyHint = cu.gateway_api_key_set
      ? `Current key: ${cu.gateway_api_key_masked || 'configured'}`
      : '';
  }

  private applyStock(stock: StockSettings): void {
    this.pixabayApiKey = '';
    this.pixabayHint = stock.pixabay_api_key_set
      ? `Current key: ${stock.pixabay_api_key_masked || 'configured'}`
      : 'No Pixabay key saved — free stock videos may be unavailable.';
    this.dailyDownloadLimit = stock.daily_download_limit ?? 20;
    const used = stock.downloads_used_today ?? 0;
    const lim = this.dailyDownloadLimit;
    if (lim <= 0) {
      this.dailyLimitHint = `Unlimited. Used today: ${used}.`;
    } else {
      const rem = stock.downloads_remaining_today;
      this.dailyLimitHint =
        rem == null ? `Used today: ${used}/${lim}.` : `Used today: ${used}/${lim} · ${rem} remaining.`;
    }
  }

  async save(): Promise<void> {
    this.busy.set(true);
    try {
      const storageOk = await this.api.saveStorageSettings({
        projects_dir: this.storage.projects_dir?.trim() || undefined,
        scripts_dir: this.storage.scripts_dir?.trim() || undefined,
        cache_dir: this.storage.cache_dir?.trim() || undefined,
      });
      if (!storageOk) return;

      const llmOk = await this.api.saveLlmSettings(this.buildLlmPayload());
      if (!llmOk) return;

      const stockPayload: Record<string, unknown> = {
        daily_download_limit: Number(this.dailyDownloadLimit) || 0,
      };
      if (this.pixabayApiKey.trim()) {
        stockPayload['pixabay_api_key'] = this.pixabayApiKey.trim();
      }
      const stockOk = await this.api.saveStockSettings(stockPayload);
      if (!stockOk) return;

      this.snackbar.show('Settings saved', 'success');
      await this.reload();
    } finally {
      this.busy.set(false);
    }
  }

  private buildLlmPayload(): LlmSettingsUpdate {
    const payload: LlmSettingsUpdate = {
      provider: this.llmProvider,
      gemini_model: this.geminiModel.trim() || 'gemini-2.5-flash',
      gemini_vision_model: this.geminiVisionModel.trim(),
      gemini_timeout_s: Number(this.geminiTimeout) || 120,
      gemini_image_model: this.geminiImageModel.trim() || 'gemini-2.5-flash-image',
      gemini_image_timeout_s: Number(this.geminiImageTimeout) || 180,
      media_gen_default_backend: this.mediaDefaultBackend,
      media_gen_text_to_image: this.mediaOpTextToImage,
      media_gen_text_to_video: this.mediaOpTextToVideo,
      media_gen_image_to_video: this.mediaOpImageToVideo,
      media_gen_upscale_image: this.mediaOpUpscaleImage,
      media_gen_upscale_video: this.mediaOpUpscaleVideo,
      higgsfield_base_url: this.higgsfieldBaseUrl.trim() || 'https://platform.higgsfield.ai',
      higgsfield_endpoint_text_to_image: this.higgsfieldEndpointT2I.trim(),
      higgsfield_endpoint_text_to_video: this.higgsfieldEndpointT2V.trim(),
      higgsfield_endpoint_image_to_video: this.higgsfieldEndpointI2V.trim(),
      higgsfield_endpoint_upscale_image: this.higgsfieldEndpointUpscaleImage.trim(),
      higgsfield_endpoint_upscale_video: this.higgsfieldEndpointUpscaleVideo.trim(),
      higgsfield_timeout_s: Number(this.higgsfieldTimeout) || 900,
      image_gen_provider: this.imageGenProvider,
      image_gen_base_url:
        this.imageGenBaseUrl.trim() ||
        (this.imageGenProvider === 'local'
          ? 'http://127.0.0.1:8080/v1'
          : 'https://api.portkey.ai/v1'),
      image_gen_model: this.imageGenModel.trim() || 'gpt-image-1',
      image_gen_portkey_provider: this.imageGenPortkeyProvider.trim(),
      image_gen_timeout_s: Number(this.imageGenTimeout) || 120,
      comfyui_provider: this.comfyProvider,
      comfyui_base_url: this.comfyBaseUrl.trim() || 'http://127.0.0.1:8188',
      comfyui_workflow_text_to_image: this.comfyWorkflowTextToImage.trim(),
      comfyui_workflow_text_to_video: this.comfyWorkflowTextToVideo.trim(),
      comfyui_workflow_image_to_video: this.comfyWorkflowImageToVideo.trim(),
      comfyui_workflow_upscale_image: this.comfyWorkflowUpscaleImage.trim(),
      comfyui_workflow_upscale_video: this.comfyWorkflowUpscaleVideo.trim(),
      comfyui_gateway_base_url: this.comfyGatewayBaseUrl.trim(),
      comfyui_gateway_model: this.comfyGatewayModel.trim(),
      comfyui_portkey_provider: this.comfyPortkeyProvider.trim(),
      comfyui_gateway_timeout_s: Number(this.comfyGatewayTimeout) || 600,
      comfyui_frames: Number(this.comfyFrames) || 33,
      comfyui_fps: Number(this.comfyFps) || 16,
      comfyui_steps: Number(this.comfySteps) || 30,
      comfyui_cfg: Number(this.comfyCfg) || 6,
      comfyui_timeout_s: Number(this.comfyTimeout) || 900,
      comfyui_negative_prompt: this.comfyNegativePrompt,
    };

    if (this.llmProvider === 'ollama') {
      payload['ollama_host'] = this.ollamaHost.trim() || 'http://localhost:11434';
      payload['ollama_model'] = this.ollamaModel.trim() || 'gemma4:31b';
      payload['ollama_timeout_s'] = Number(this.ollamaTimeout) || 60;
    }
    if (this.llmProvider === 'proxy') {
      payload['proxy_base_url'] = this.proxyBaseUrl.trim() || 'https://api.portkey.ai/v1';
      payload['proxy_model'] = this.proxyModel.trim() || 'gpt-4o';
      payload['proxy_portkey_provider'] = this.proxyPortkeyProvider.trim();
      payload['proxy_timeout_s'] = Number(this.proxyTimeout) || 60;
      if (this.proxyApiKey.trim()) payload['proxy_api_key'] = this.proxyApiKey.trim();
      if (this.proxyPortkeyVirtualKey.trim()) {
        payload['proxy_portkey_virtual_key'] = this.proxyPortkeyVirtualKey.trim();
      }
    }
    if (this.geminiApiKey.trim()) payload['gemini_api_key'] = this.geminiApiKey.trim();
    if (this.higgsfieldApiKeyId.trim()) {
      payload['higgsfield_api_key_id'] = this.higgsfieldApiKeyId.trim();
    }
    if (this.higgsfieldApiKeySecret.trim()) {
      payload['higgsfield_api_key_secret'] = this.higgsfieldApiKeySecret.trim();
    }
    if (this.imageGenApiKey.trim()) payload['image_gen_api_key'] = this.imageGenApiKey.trim();
    if (this.imageGenPortkeyVirtualKey.trim()) {
      payload['image_gen_portkey_virtual_key'] = this.imageGenPortkeyVirtualKey.trim();
    }
    if (this.comfyApiKey.trim()) payload['comfyui_api_key'] = this.comfyApiKey.trim();
    if (this.comfyGatewayApiKey.trim()) {
      payload['comfyui_gateway_api_key'] = this.comfyGatewayApiKey.trim();
    }
    return payload;
  }

  applyProxyPreset(kind: 'openai' | 'openrouter' | 'portkey' | 'custom'): void {
    if (kind === 'openai') {
      this.proxyBaseUrl = 'https://api.openai.com/v1';
      this.proxyModel = this.proxyModel.trim() || 'gpt-4o';
      this.proxyPortkeyProvider = '';
    } else if (kind === 'openrouter') {
      this.proxyBaseUrl = 'https://openrouter.ai/api/v1';
      this.proxyModel = this.proxyModel.trim() || 'openai/gpt-4o';
      this.proxyPortkeyProvider = '';
    } else if (kind === 'portkey') {
      this.proxyBaseUrl = 'https://api.portkey.ai/v1';
      this.proxyModel = this.proxyModel.trim() || 'gpt-4o';
      this.proxyPortkeyProvider = this.proxyPortkeyProvider.trim() || 'openai';
    } else {
      // Keep current URL; just clarify it's custom.
      if (!this.proxyBaseUrl.trim()) {
        this.proxyBaseUrl = 'https://api.openai.com/v1';
      }
    }
  }

  async testLlm(): Promise<void> {
    this.testingLlm.set(true);
    this.llmTest.set(null);
    this.llmTestText.set('');
    try {
      // Save first so test uses current form values
      const ok = await this.api.saveLlmSettings(this.buildLlmPayload());
      if (!ok) return;
      const result = await this.api.testLlmSettings();
      if (!result) {
        this.llmTest.set({ ok: false });
        this.llmTestText.set(this.api.llmError() || 'LLM connection test failed');
        return;
      }
      this.llmTest.set(result);
      this.llmTestText.set(this.formatTest(result));
    } finally {
      this.testingLlm.set(false);
    }
  }

  async testComfy(): Promise<void> {
    this.testingComfy.set(true);
    this.comfyTest.set(null);
    this.comfyTestText.set('');
    try {
      const ok = await this.api.saveLlmSettings(this.buildLlmPayload());
      if (!ok) return;
      const result = await this.api.testComfyuiSettings();
      if (!result) return;
      this.comfyTest.set(result);
      this.comfyTestText.set(this.formatTest(result));
    } finally {
      this.testingComfy.set(false);
    }
  }

  private async loadWorkflows(): Promise<void> {
    const data = await this.api.listComfyuiWorkflows();
    if (!data) return;
    this.comfyWorkflows = data.workflows || [];
    this.comfyWorkflowsDirResolved = data.workflows_dir || '';
  }

  onWorkflowFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.workflowUploadFile = input.files?.[0] ?? null;
  }

  async uploadWorkflow(): Promise<void> {
    if (!this.workflowUploadFile) return;
    this.uploadingWorkflow.set(true);
    try {
      const ok = await this.api.saveLlmSettings(this.buildLlmPayload());
      if (!ok) return;
      const data = await this.api.uploadComfyuiWorkflow(
        this.workflowUploadFile,
        this.workflowUploadAssignOp,
      );
      if (!data) return;
      this.comfyWorkflows = data.workflows || [];
      if (this.workflowUploadAssignOp === 'text_to_image') {
        this.comfyWorkflowTextToImage = this.workflowUploadFile.name.replace(/\.json$/i, '');
      } else if (this.workflowUploadAssignOp === 'text_to_video') {
        this.comfyWorkflowTextToVideo = this.workflowUploadFile.name.replace(/\.json$/i, '');
      } else if (this.workflowUploadAssignOp === 'image_to_video') {
        this.comfyWorkflowImageToVideo = this.workflowUploadFile.name.replace(/\.json$/i, '');
      } else if (this.workflowUploadAssignOp === 'upscale_image') {
        this.comfyWorkflowUpscaleImage = this.workflowUploadFile.name.replace(/\.json$/i, '');
      } else if (this.workflowUploadAssignOp === 'upscale_video') {
        this.comfyWorkflowUpscaleVideo = this.workflowUploadFile.name.replace(/\.json$/i, '');
      }
      this.workflowUploadFile = null;
      this.workflowUploadAssignOp = '';
      this.snackbar.show('Workflow uploaded', 'success');
      await this.loadWorkflows();
    } finally {
      this.uploadingWorkflow.set(false);
    }
  }

  async deleteWorkflow(filename: string): Promise<void> {
    if (!confirm(`Delete workflow ${filename}?`)) return;
    this.uploadingWorkflow.set(true);
    try {
      const workflows = await this.api.deleteComfyuiWorkflow(filename);
      if (!workflows) return;
      this.comfyWorkflows = workflows;
      const stem = filename.replace(/\.json$/i, '');
      if (this.comfyWorkflowTextToImage === stem) this.comfyWorkflowTextToImage = '';
      if (this.comfyWorkflowTextToVideo === stem) this.comfyWorkflowTextToVideo = '';
      if (this.comfyWorkflowImageToVideo === stem) this.comfyWorkflowImageToVideo = '';
      if (this.comfyWorkflowUpscaleImage === stem) this.comfyWorkflowUpscaleImage = '';
      if (this.comfyWorkflowUpscaleVideo === stem) this.comfyWorkflowUpscaleVideo = '';
      this.snackbar.show('Workflow deleted', 'success');
    } finally {
      this.uploadingWorkflow.set(false);
    }
  }

  private formatTest(result: SettingsTestResult): string {
    const lines: string[] = [];
    if (result.detail) lines.push(result.detail);
    if (result.base_url) lines.push(`URL: ${result.base_url}`);
    if (result.workflow) lines.push(`Workflow: ${result.workflow}`);
    for (const check of result.checks || []) {
      lines.push(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail || ''}`);
    }
    return lines.join('\n') || (result.ok ? 'Connection OK' : 'Test failed');
  }
}
