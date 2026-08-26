import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SnackbarService, DialogService, ListDetailView, type ListDetailConfig } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import type {
  AiServiceProfile,
  ComfyWorkflowEntry,
  ComfyWorkflowInputField,
  LlmSettings,
  LlmSettingsUpdate,
  PublishPlatform,
  SettingsTestResult,
  StockSettings,
  StorageSettings,
} from '../../models/content-sprout.models';
import {
  WorkflowInputsFormComponent,
  enabledFromWorkflowInputs,
  valuesFromWorkflowInputs,
} from '../../shared/workflow-inputs-form';
import { WorkflowDetailDialogComponent } from '../../shared/workflow-detail-dialog';

interface EditableAiService extends AiServiceProfile {
  api_key?: string;
  api_key_secret?: string;
  portkey_virtual_key?: string;
}
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    WorkflowInputsFormComponent,
    WorkflowDetailDialogComponent,
    ListDetailView,
  ],
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

      <div class="cs-tabs cs-settings-tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          role="tab"
          [class.active]="settingsTab() === 'storage'"
          [attr.aria-selected]="settingsTab() === 'storage'"
          (click)="settingsTab.set('storage')"
        >
          Config and storage
        </button>
        <button
          type="button"
          role="tab"
          [class.active]="settingsTab() === 'stock'"
          [attr.aria-selected]="settingsTab() === 'stock'"
          (click)="settingsTab.set('stock')"
        >
          Stock Assets Settings
        </button>
        <button
          type="button"
          role="tab"
          [class.active]="settingsTab() === 'textVision'"
          [attr.aria-selected]="settingsTab() === 'textVision'"
          (click)="settingsTab.set('textVision')"
        >
          Text &amp; Vision AI config
        </button>
        <button
          type="button"
          role="tab"
          [class.active]="settingsTab() === 'genAi'"
          [attr.aria-selected]="settingsTab() === 'genAi'"
          (click)="settingsTab.set('genAi')"
        >
          Image and Video Gen AI config
        </button>
      </div>

      @if (settingsTab() === 'storage') {
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
      }

      @if (settingsTab() === 'stock') {
      <!-- Stock Assets Settings -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Download stock Assets</h3>
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
        <div class="cs-bar" style="margin-bottom: 0.65rem">
          <div>
            <h3 class="cs-section-title" style="margin: 0">Upload assets to stock platforms</h3>
            <p class="page-intro" style="margin: 0.35rem 0 0">
              Contributor portals used by Shared Library → Publish to stock. Packages prepare
              files + metadata; upload happens on the site.
            </p>
          </div>
          <div class="page-actions-inline">
            <button type="button" (click)="addPublishPlatform()">Add platform</button>
          </div>
        </div>
        <div class="cs-platform-list">
          @for (p of publishPlatforms; track $index; let i = $index) {
            <div class="cs-platform-row surface-inset">
              <div class="cs-platform-top">
                <label class="cs-check">
                  <input type="checkbox" [(ngModel)]="p.enabled" />
                  Enabled
                </label>
                <input [(ngModel)]="p.label" placeholder="Label" />
                <button type="button" class="danger" (click)="removePublishPlatform(i)">
                  Remove
                </button>
              </div>
              <input
                [(ngModel)]="p.contributor_url"
                placeholder="https://… contributor upload URL"
              />
              <input [(ngModel)]="p.notes" placeholder="Notes (optional)" />
            </div>
          } @empty {
            <p class="cs-empty-inline">No platforms yet — add one to get started.</p>
          }
        </div>
      </section>
      }

      @if (settingsTab() === 'textVision') {
      <!-- LLM multi-service -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Language &amp; vision AI</h3>
        <p class="page-intro" style="margin-top: 0">
          Configure one or more text/vision providers (Ollama, Gemini, OpenAI, Claude via OpenAI-compatible
          gateways, …). The Script tab lets you pick which service to use per post.
        </p>
        <div class="page-actions-inline" style="margin-bottom: 0.65rem">
          <button type="button" class="primary" (click)="addAiService('llm')">Add service</button>
        </div>
        <div class="cs-settings-ldv">
          <app-list-detail-view
            [config]="llmListConfig"
            [items]="filteredLlmServices()"
            [selectedItem]="selectedLlm()"
            [searchTerm]="llmSearch()"
            (itemSelected)="selectedLlm.set($event)"
            (searchChanged)="llmSearch.set($event)"
          >
            <ng-template #detail let-svc>
              <div class="cs-form-stack">
                <label>
                  <span>Name</span>
                  <input [(ngModel)]="svc.name" placeholder="My Ollama / OpenAI / Claude" />
                </label>
                <div class="cs-form-row">
                  <label>
                    <span>Protocol</span>
                    <select [(ngModel)]="svc.protocol" (ngModelChange)="onLlmProtocolChange(svc)">
                      <option value="ollama">Local Ollama</option>
                      <option value="gemini">Gemini (Google)</option>
                      <option value="openai_chat">OpenAI-compatible chat</option>
                    </select>
                  </label>
                  @if (svc.protocol !== 'gemini') {
                    <label>
                      <span>Host</span>
                      <select [(ngModel)]="svc.host">
                        <option value="local">Local</option>
                        <option value="remote">Third-party / cloud</option>
                      </select>
                    </label>
                  }
                  <label class="cs-check">
                    <input type="checkbox" [(ngModel)]="svc.enabled" />
                    <span>Enabled</span>
                  </label>
                </div>

                @if (svc.protocol === 'openai_chat') {
                  <div class="page-actions-inline" style="flex-wrap: wrap">
                    <button type="button" (click)="applyLlmPreset(svc, 'openai')">OpenAI</button>
                    <button type="button" (click)="applyLlmPreset(svc, 'openrouter')">OpenRouter</button>
                    <button type="button" (click)="applyLlmPreset(svc, 'portkey')">Portkey</button>
                    <button type="button" (click)="applyLlmPreset(svc, 'claude')">Claude</button>
                  </div>
                }

                @if (svc.protocol === 'ollama' || svc.protocol === 'openai_chat') {
                  <label>
                    <span>{{ svc.protocol === 'ollama' ? 'Ollama host' : 'Base URL' }}</span>
                    <input
                      [(ngModel)]="svc.base_url"
                      [placeholder]="
                        svc.protocol === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'
                      "
                    />
                  </label>
                }

                <label>
                  <span>Model</span>
                  <input
                    [(ngModel)]="svc.model"
                    [placeholder]="
                      svc.protocol === 'ollama'
                        ? 'gemma4:31b'
                        : svc.protocol === 'gemini'
                          ? 'gemini-2.5-flash'
                          : 'gpt-4o'
                    "
                  />
                </label>

                @if (svc.protocol === 'gemini' || svc.protocol === 'openai_chat') {
                  <label>
                    <span>API key</span>
                    <input
                      type="password"
                      [(ngModel)]="svc.api_key"
                      [placeholder]="
                        svc.api_key_set
                          ? 'Leave blank to keep existing'
                          : svc.host === 'local'
                            ? 'Optional for local'
                            : 'Required'
                      "
                      autocomplete="off"
                    />
                    @if (svc.api_key_masked) {
                      <span class="meta">Current: {{ svc.api_key_masked }}</span>
                    }
                  </label>
                }

                @if (svc.protocol === 'openai_chat') {
                  <div class="cs-form-row" style="margin: 0">
                    <label>
                      <span>Portkey provider</span>
                      <input [(ngModel)]="svc.portkey_provider" placeholder="openai (optional)" />
                    </label>
                    <label>
                      <span>Portkey virtual key</span>
                      <input
                        type="password"
                        [(ngModel)]="svc.portkey_virtual_key"
                        [placeholder]="svc.portkey_virtual_key_set ? 'Leave blank to keep' : 'Optional'"
                        autocomplete="off"
                      />
                    </label>
                  </div>
                }

                <label>
                  <span>Timeout (seconds)</span>
                  <input type="number" min="15" max="7200" step="15" [(ngModel)]="svc.timeout_s" />
                  <span class="meta">Large local models often need 300–900s.</span>
                </label>
                <span class="meta" [class.cs-ok]="svc.ready" [class.cs-bad]="!svc.ready">
                  {{ svc.ready ? 'Ready for scripts & vision' : 'Not ready — check URL / key / model' }}
                </span>
                <div class="page-actions-inline" style="margin-top: 0.35rem">
                  <button
                    type="button"
                    (click)="testLlm(svc)"
                    [disabled]="busy() || testingLlm() || !svc.enabled"
                  >
                    {{ testingLlm() ? 'Testing…' : 'Test connection' }}
                  </button>
                  @if (llmTest() && llmTestServiceId() === svc.id) {
                    <span class="meta" [class.cs-ok]="llmTest()!.ok" [class.cs-bad]="!llmTest()!.ok">
                      {{ llmTest()!.ok ? 'OK' : 'Failed' }}
                    </span>
                  }
                </div>
                @if (llmTestText() && llmTestServiceId() === svc.id) {
                  <pre class="cs-test-result" [class.is-bad]="llmTest() && !llmTest()!.ok">{{ llmTestText() }}</pre>
                }
                @if (api.llmError() && !llmTestText() && llmTestServiceId() === svc.id) {
                  <pre class="cs-test-result is-bad">{{ api.llmError() }}</pre>
                }
              </div>
            </ng-template>
          </app-list-detail-view>
        </div>
      </section>
      }

      @if (settingsTab() === 'genAi') {
      <!-- Image AI services (generate & edit) -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Image generation &amp; editing</h3>
        <p class="page-intro" style="margin-top: 0">
          Configure one or more local or third-party image AI services. Photo Magic and other edit
          flows let you pick which service to use when more than one is ready.
        </p>
        <div class="page-actions-inline" style="margin-bottom: 0.65rem">
          <button type="button" class="primary" (click)="addAiService('image')">Add image AI service</button>
        </div>
        <div class="cs-settings-ldv">
          <app-list-detail-view
            [config]="imageListConfig"
            [items]="filteredImageServices()"
            [selectedItem]="selectedImage()"
            [searchTerm]="imageSearch()"
            (itemSelected)="selectedImage.set($event)"
            (searchChanged)="imageSearch.set($event)"
          >
            <ng-template #detail let-svc>
              <div class="cs-form-stack">
                <label>
                  <span>Name</span>
                  <input [(ngModel)]="svc.name" placeholder="My image editor" />
                </label>
                <div class="cs-form-row">
                  <label>
                    <span>Host</span>
                    <select [(ngModel)]="svc.host">
                      <option value="local">Local</option>
                      <option value="remote">Third-party / cloud</option>
                    </select>
                  </label>
                  <label>
                    <span>Protocol</span>
                    <select [(ngModel)]="svc.protocol">
                      <option value="openai_images">OpenAI-compatible /images</option>
                      <option value="gemini">Gemini image</option>
                    </select>
                  </label>
                  <label class="cs-check">
                    <input type="checkbox" [(ngModel)]="svc.enabled" />
                    <span>Enabled</span>
                  </label>
                </div>
                @if (svc.protocol === 'openai_images') {
                  <label>
                    <span>Base URL</span>
                    <input [(ngModel)]="svc.base_url" placeholder="http://127.0.0.1:8080/v1" />
                  </label>
                  <label>
                    <span>Model</span>
                    <input [(ngModel)]="svc.model" placeholder="gpt-image-1" />
                  </label>
                  <label>
                    <span>API key</span>
                    <input
                      type="password"
                      [(ngModel)]="svc.api_key"
                      [placeholder]="svc.api_key_set ? 'Leave blank to keep existing' : 'Optional for local'"
                      autocomplete="off"
                    />
                    @if (svc.api_key_masked) {
                      <span class="meta">Current: {{ svc.api_key_masked }}</span>
                    }
                  </label>
                } @else {
                  <label>
                    <span>Gemini API key</span>
                    <input
                      type="password"
                      [(ngModel)]="svc.api_key"
                      [placeholder]="svc.api_key_set ? 'Leave blank to keep existing' : 'Or use shared Gemini key'"
                      autocomplete="off"
                    />
                  </label>
                  <label>
                    <span>Image model</span>
                    <input [(ngModel)]="svc.model" placeholder="gemini-2.5-flash-image" />
                  </label>
                }
                <label>
                  <span>Timeout (seconds)</span>
                  <input type="number" min="30" max="900" [(ngModel)]="svc.timeout_s" />
                </label>
                <span class="meta" [class.cs-ok]="svc.ready" [class.cs-bad]="!svc.ready">
                  {{ svc.ready ? 'Ready for image edit' : 'Not ready — check URL / key / model' }}
                </span>
              </div>
            </ng-template>
          </app-list-detail-view>
        </div>
      </section>

      <!-- Video AI services -->
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Video generation &amp; editing</h3>
        <p class="page-intro" style="margin-top: 0">
          Named video AI services (local ComfyUI gateway, OpenAI-compatible video, or Higgsfield).
          Local ComfyUI workflow routing is configured below when enabled.
        </p>
        <div class="page-actions-inline" style="margin-bottom: 0.65rem">
          <button type="button" class="primary" (click)="addAiService('video')">Add video AI service</button>
        </div>
        <div class="cs-settings-ldv">
          <app-list-detail-view
            [config]="videoListConfig"
            [items]="filteredVideoServices()"
            [selectedItem]="selectedVideo()"
            [searchTerm]="videoSearch()"
            (itemSelected)="selectedVideo.set($event)"
            (searchChanged)="videoSearch.set($event)"
          >
            <ng-template #detail let-svc>
              <div class="cs-form-stack">
                <label>
                  <span>Name</span>
                  <input [(ngModel)]="svc.name" placeholder="My video service" />
                </label>
                <div class="cs-form-row">
                  <label>
                    <span>Host</span>
                    <select [(ngModel)]="svc.host">
                      <option value="local">Local</option>
                      <option value="remote">Third-party / cloud</option>
                    </select>
                  </label>
                  <label>
                    <span>Protocol</span>
                    <select [(ngModel)]="svc.protocol">
                      <option value="openai_video">OpenAI-compatible video</option>
                      <option value="comfyui">ComfyUI</option>
                      <option value="higgsfield">Higgsfield</option>
                    </select>
                  </label>
                  <label class="cs-check">
                    <input type="checkbox" [(ngModel)]="svc.enabled" />
                    <span>Enabled</span>
                  </label>
                </div>
                <label>
                  <span>Base URL</span>
                  <input
                    [(ngModel)]="svc.base_url"
                    [placeholder]="
                      svc.protocol === 'higgsfield'
                        ? 'https://platform.higgsfield.ai'
                        : 'http://127.0.0.1:8188'
                    "
                  />
                </label>
                @if (svc.protocol === 'openai_video') {
                  <label>
                    <span>Model</span>
                    <input [(ngModel)]="svc.model" placeholder="sora-2" />
                  </label>
                }
                <label>
                  <span>API key{{ svc.protocol === 'higgsfield' ? ' ID' : '' }}</span>
                  <input
                    type="password"
                    [(ngModel)]="svc.api_key"
                    [placeholder]="svc.api_key_set ? 'Leave blank to keep existing' : ''"
                    autocomplete="off"
                  />
                </label>
                @if (svc.protocol === 'higgsfield') {
                  <label>
                    <span>API key secret</span>
                    <input
                      type="password"
                      [(ngModel)]="svc.api_key_secret"
                      [placeholder]="svc.api_key_secret_set ? 'Leave blank to keep existing' : ''"
                      autocomplete="off"
                    />
                  </label>
                }
                <label>
                  <span>Timeout (seconds)</span>
                  <input type="number" min="30" max="3600" [(ngModel)]="svc.timeout_s" />
                </label>
                <span class="meta" [class.cs-ok]="svc.ready" [class.cs-bad]="!svc.ready">
                  {{ svc.ready ? 'Ready' : 'Not ready — check URL / credentials' }}
                </span>
              </div>
            </ng-template>
          </app-list-detail-view>
        </div>
      </section>

      <!-- Local ComfyUI workflow config (gated) -->
      <label class="cs-check cs-settings-comfy-toggle">
        <input
          type="checkbox"
          [ngModel]="allowLocalComfyui"
          (ngModelChange)="onAllowLocalComfyuiChange($event)"
        />
        <span>Allow local content generation using ComfyUI</span>
      </label>

      @if (allowLocalComfyui) {
      <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">Local AI Workflow Config (Comfy UI)</h3>
        <p class="page-intro" style="margin-top: 0">
          Select which tool to use for each supported media generation use case, and configure local
          ComfyUI workflows.
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

      <!-- ComfyUI connection & workflows -->
        <section class="surface-card cs-settings-section">
        <h3 class="cs-section-title">ComfyUI connection &amp; workflows</h3>
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
                  Files are <strong>copied</strong> into ContentSprout tools storage
                  (<code class="cs-mono">tools/comfyui/workflows</code>) — you can move or delete
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
                  <input
                    #workflowBundleInput
                    type="file"
                    accept=".zip,application/zip"
                    style="display: none"
                    (change)="onWorkflowBundleSelected($event)"
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
                <div class="page-actions-inline" style="flex-wrap: wrap">
                  <button
                    type="button"
                    (click)="downloadWorkflowBundle()"
                    [disabled]="busy() || uploadingWorkflow() || bundlingWorkflow()"
                  >
                    {{ bundlingWorkflow() ? 'Preparing…' : 'Download workflow bundle' }}
                  </button>
                  <button
                    type="button"
                    (click)="workflowBundleInput.click()"
                    [disabled]="busy() || uploadingWorkflow() || bundlingWorkflow()"
                  >
                    Import workflow bundle…
                  </button>
                </div>
                <p class="meta" style="margin: 0">
                  Bundle zip includes stored workflow JSON files, per-operation assignments, and
                  parameter defaults / editable-field settings. Re-import restores them into tools storage.
                </p>
                @if (workflowUploadFile) {
                  <span class="meta">Selected: {{ workflowUploadFile.name }}</span>
                }
                @if (comfyWorkflows.length) {
                  <ul class="cs-workflow-list" style="margin: 0; padding-left: 0; list-style: none">
                    @for (wf of comfyWorkflows; track wf.stem) {
                      <li class="cs-workflow-list-item">
                        <div class="cs-workflow-list-main">
                          <strong>{{ wf.title || wf.stem }}</strong>
                          <span class="meta">
                            ·
                            {{ wf.source === 'package' ? 'built-in' : 'uploaded' }}
                            @if (wf.available === false) {
                              · pending
                            }
                            @if (wf.default_for?.length) {
                              · default for {{ formatOps(wf.default_for) }}
                            }
                            @if (wf.model_count) {
                              · {{ wf.model_count }} model{{ wf.model_count === 1 ? '' : 's' }}
                            }
                          </span>
                          @if (wf.description) {
                            <p class="meta" style="margin: 0.2rem 0 0">{{ wf.description }}</p>
                          }
                          @if (wf.models?.length) {
                            <p class="meta" style="margin: 0.2rem 0 0">
                              Requires:
                              @for (m of wf.models; track m.filename; let last = $last) {
                                <code>{{ m.filename }}</code>{{ last ? '' : ', ' }}
                              }
                            </p>
                          }
                        </div>
                        <div class="page-actions-inline" style="margin: 0">
                          <button
                            type="button"
                            class="cs-inline-btn"
                            (click)="openWorkflowDetails(wf.stem)"
                            [disabled]="busy() || uploadingWorkflow()"
                          >
                            View
                          </button>
                          @if (wf.source === 'user' && wf.available !== false) {
                            <button
                              type="button"
                              class="cs-inline-btn"
                              (click)="deleteWorkflow(wf.filename)"
                              [disabled]="busy() || uploadingWorkflow()"
                            >
                              Delete
                            </button>
                          }
                        </div>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="meta" style="margin: 0">No workflows found yet.</p>
                }
              </div>

              <div class="cs-form-stack" style="gap: 0.55rem">
                <p class="meta" style="margin: 0">
                  Assign a workflow per operation. Empty uses the packaged default when that JSON
                  exists under <code class="cs-mono">src/content_sprout/workflows/</code>.
                </p>
                @if (mediaOpTextToImage === 'comfyui') {
                  <label>
                    <span>Text → image</span>
                    <select
                      [(ngModel)]="comfyWorkflowTextToImage"
                      (ngModelChange)="onWorkflowAssignChange('text_to_image', $event)"
                    >
                      <option value="">
                        {{ defaultOptionLabel('text_to_image') }}
                      </option>
                      @for (wf of assignableWorkflows; track wf.stem) {
                        <option [value]="wf.stem">{{ workflowOptionLabel(wf) }}</option>
                      }
                    </select>
                  </label>
                  <app-workflow-inputs-form
                    mode="configure"
                    [fields]="comfyInputFields['text_to_image']"
                    [values]="comfyInputValues['text_to_image']"
                    [enabled]="comfyInputEnabled['text_to_image']"
                    (valuesChange)="comfyInputValues['text_to_image'] = $event"
                    (enabledChange)="comfyInputEnabled['text_to_image'] = $event"
                    emptyHint="Upload an API-format workflow, then select which fields users may edit when generating."
                  />
                }
                @if (mediaOpTextToVideo === 'comfyui') {
                  <label>
                    <span>Text → video</span>
                    <select
                      [(ngModel)]="comfyWorkflowTextToVideo"
                      (ngModelChange)="onWorkflowAssignChange('text_to_video', $event)"
                    >
                      <option value="">
                        {{ defaultOptionLabel('text_to_video') }}
                      </option>
                      @for (wf of assignableWorkflows; track wf.stem) {
                        <option [value]="wf.stem">{{ workflowOptionLabel(wf) }}</option>
                      }
                    </select>
                  </label>
                  <app-workflow-inputs-form
                    mode="configure"
                    [fields]="comfyInputFields['text_to_video']"
                    [values]="comfyInputValues['text_to_video']"
                    [enabled]="comfyInputEnabled['text_to_video']"
                    (valuesChange)="comfyInputValues['text_to_video'] = $event"
                    (enabledChange)="comfyInputEnabled['text_to_video'] = $event"
                    emptyHint="Upload an API-format workflow, then select which fields users may edit when generating."
                  />
                }
                @if (mediaOpImageToVideo === 'comfyui') {
                  <label>
                    <span>Image + text → video</span>
                    <select
                      [(ngModel)]="comfyWorkflowImageToVideo"
                      (ngModelChange)="onWorkflowAssignChange('image_to_video', $event)"
                    >
                      <option value="">
                        {{ defaultOptionLabel('image_to_video') }}
                      </option>
                      @for (wf of assignableWorkflows; track wf.stem) {
                        <option [value]="wf.stem">{{ workflowOptionLabel(wf) }}</option>
                      }
                    </select>
                  </label>
                  <app-workflow-inputs-form
                    mode="configure"
                    [fields]="comfyInputFields['image_to_video']"
                    [values]="comfyInputValues['image_to_video']"
                    [enabled]="comfyInputEnabled['image_to_video']"
                    (valuesChange)="comfyInputValues['image_to_video'] = $event"
                    (enabledChange)="comfyInputEnabled['image_to_video'] = $event"
                    emptyHint="Upload an API-format workflow, then select which fields users may edit when generating."
                  />
                }
                @if (mediaOpUpscaleVideo === 'comfyui') {
                  <label>
                    <span>Upscale video</span>
                    <select
                      [(ngModel)]="comfyWorkflowUpscaleVideo"
                      (ngModelChange)="onWorkflowAssignChange('upscale_video', $event)"
                    >
                      <option value="">
                        {{ defaultOptionLabel('upscale_video') }}
                      </option>
                      @for (wf of assignableWorkflows; track wf.stem) {
                        <option [value]="wf.stem">{{ workflowOptionLabel(wf) }}</option>
                      }
                    </select>
                  </label>
                  <app-workflow-inputs-form
                    mode="configure"
                    [fields]="comfyInputFields['upscale_video']"
                    [values]="comfyInputValues['upscale_video']"
                    [enabled]="comfyInputEnabled['upscale_video']"
                    (valuesChange)="comfyInputValues['upscale_video'] = $event"
                    (enabledChange)="comfyInputEnabled['upscale_video'] = $event"
                    emptyHint="Upload an API-format workflow, then select which fields users may edit when generating."
                  />
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
      }

      <div class="cs-settings-footer">
        <button type="button" class="primary" (click)="save()" [disabled]="busy()">
          {{ busy() ? 'Saving…' : 'Save settings' }}
        </button>
      </div>

      <app-workflow-detail-dialog
        [isOpen]="workflowDetailOpen()"
        [stem]="workflowDetailStem()"
        (closed)="closeWorkflowDetails()"
      />
    </div>
  `,
  styles: [
    `
      .cs-workflow-list-item {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 1rem;
        justify-content: space-between;
        align-items: flex-start;
        padding: 0.55rem 0;
        border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
      }
      .cs-workflow-list-item:last-child {
        border-bottom: 0;
      }
      .cs-workflow-list-main {
        flex: 1 1 16rem;
        min-width: 0;
      }
      .cs-settings-ldv {
        --ldv-height: min(480px, calc(100vh - 320px));
        margin-top: 0.35rem;
      }
      .cs-settings-ldv app-list-detail-view {
        display: block;
      }
      .cs-settings-comfy-toggle {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        margin: 1rem 0 0.35rem;
        font-weight: 600;
      }
    `,
  ],
})
export class SettingsPage implements OnInit {
  readonly settingsTab = signal<'storage' | 'stock' | 'textVision' | 'genAi'>('storage');
  readonly busy = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly testingLlm = signal(false);
  readonly testingComfy = signal(false);
  readonly uploadingWorkflow = signal(false);
  readonly bundlingWorkflow = signal(false);
  readonly workflowDetailOpen = signal(false);
  readonly workflowDetailStem = signal('');
  readonly llmTest = signal<SettingsTestResult | null>(null);
  readonly llmTestServiceId = signal('');
  readonly comfyTest = signal<SettingsTestResult | null>(null);
  readonly llmTestText = signal('');
  readonly comfyTestText = signal('');

  readonly selectedLlm = signal<EditableAiService | null>(null);
  readonly selectedImage = signal<EditableAiService | null>(null);
  readonly selectedVideo = signal<EditableAiService | null>(null);
  readonly llmSearch = signal('');
  readonly imageSearch = signal('');
  readonly videoSearch = signal('');

  get llmListConfig(): ListDetailConfig<EditableAiService> {
    return {
      listPanelWidth: '280px',
      searchPlaceholder: 'Search services…',
      emptyStateIcon: 'smart_toy',
      emptyStateTitle: 'No Text & Vision services',
      emptyStateMessage: 'Add Ollama, Gemini, OpenAI, or Claude (OpenAI-compatible).',
      getItemId: (item) => item.id,
      getItemTitle: (item) => item.name || 'Untitled service',
      getItemSubtitle: (item) => this.serviceSubtitle(item),
      getItemIcon: (item) => this.serviceIcon(item),
      getItemBadges: (item) => this.serviceBadges(item),
      detailHeaderActions: [
        {
          icon: 'delete',
          label: 'Delete',
          variant: 'danger',
          onClick: (item) => void this.removeAiServiceById('llm', item.id),
        },
      ],
    };
  }

  get imageListConfig(): ListDetailConfig<EditableAiService> {
    return {
      listPanelWidth: '280px',
      searchPlaceholder: 'Search image services…',
      emptyStateIcon: 'image',
      emptyStateTitle: 'No image AI services',
      emptyStateMessage: 'Add a local or cloud image generate/edit service.',
      getItemId: (item) => item.id,
      getItemTitle: (item) => item.name || 'Untitled service',
      getItemSubtitle: (item) => this.serviceSubtitle(item),
      getItemIcon: () => 'image',
      getItemBadges: (item) => this.serviceBadges(item),
      detailHeaderActions: [
        {
          icon: 'delete',
          label: 'Delete',
          variant: 'danger',
          onClick: (item) => void this.removeAiServiceById('image', item.id),
        },
      ],
    };
  }

  get videoListConfig(): ListDetailConfig<EditableAiService> {
    return {
      listPanelWidth: '280px',
      searchPlaceholder: 'Search video services…',
      emptyStateIcon: 'movie',
      emptyStateTitle: 'No video AI services',
      emptyStateMessage: 'Add ComfyUI, OpenAI-compatible video, or Higgsfield.',
      getItemId: (item) => item.id,
      getItemTitle: (item) => item.name || 'Untitled service',
      getItemSubtitle: (item) => this.serviceSubtitle(item),
      getItemIcon: () => 'movie',
      getItemBadges: (item) => this.serviceBadges(item),
      detailHeaderActions: [
        {
          icon: 'delete',
          label: 'Delete',
          variant: 'danger',
          onClick: (item) => void this.removeAiServiceById('video', item.id),
        },
      ],
    };
  }

  storage: StorageSettings = {};

  geminiApiKey = '';
  geminiApiKeyHint = '';
  geminiModel = 'gemini-2.5-flash';
  geminiVisionModel = '';
  geminiTimeout = 180;
  geminiImageModel = 'gemini-2.5-flash-image';
  geminiImageTimeout = 180;

  mediaDefaultBackend = 'comfyui';
  mediaOpTextToImage = 'comfyui';
  mediaOpTextToVideo = 'comfyui';
  mediaOpImageToVideo = 'comfyui';
  mediaOpUpscaleImage = 'inherit';
  mediaOpUpscaleVideo = 'comfyui';
  mediaGenReadyHint = '';
  allowLocalComfyui = false;

  imageAiServices: EditableAiService[] = [];
  videoAiServices: EditableAiService[] = [];
  llmAiServices: EditableAiService[] = [];

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

  comfyProvider = 'off';
  comfyBaseUrl = 'http://127.0.0.1:8188';
  comfyApiKey = '';
  comfyWorkflowsDirResolved = '';
  comfyWorkflows: ComfyWorkflowEntry[] = [];
  packageDefaults: Record<string, string> = {};
  effectiveWorkflows: Record<string, string> = {};
  workflowUploadFile: File | null = null;
  workflowUploadAssignOp = '';
  comfyWorkflowTextToImage = '';
  comfyWorkflowTextToVideo = '';
  comfyWorkflowImageToVideo = '';
  comfyWorkflowUpscaleImage = '';
  comfyWorkflowUpscaleVideo = '';
  comfyInputFields: Record<string, ComfyWorkflowInputField[]> = {
    text_to_image: [],
    text_to_video: [],
    image_to_video: [],
    upscale_video: [],
  };
  comfyInputValues: Record<string, Record<string, string | number | boolean>> = {
    text_to_image: {},
    text_to_video: {},
    image_to_video: {},
    upscale_video: {},
  };
  comfyInputEnabled: Record<string, Record<string, boolean>> = {
    text_to_image: {},
    text_to_video: {},
    image_to_video: {},
    upscale_video: {},
  };
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
  publishPlatforms: PublishPlatform[] = [];

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

  onAllowLocalComfyuiChange(enabled: boolean): void {
    this.allowLocalComfyui = !!enabled;
    if (!this.allowLocalComfyui) {
      this.comfyProvider = 'off';
      return;
    }
    if (this.comfyProvider === 'off') {
      this.comfyProvider = 'local';
    }
  }

  get assignableWorkflows(): ComfyWorkflowEntry[] {
    return this.comfyWorkflows.filter((wf) => wf.available !== false);
  }

  formatOps(ops: string[] | undefined): string {
    if (!ops?.length) return '';
    const labels: Record<string, string> = {
      text_to_image: 'text→image',
      text_to_video: 'text→video',
      image_to_video: 'image→video',
      upscale_image: 'upscale image',
      upscale_video: 'upscale video',
    };
    return ops.map((op) => labels[op] || op).join(', ');
  }

  workflowOptionLabel(wf: ComfyWorkflowEntry): string {
    const title = wf.title || wf.stem;
    const src = wf.source === 'package' ? 'built-in' : 'uploaded';
    const def = wf.default_for?.length ? ' · default' : '';
    return `${title} (${src}${def})`;
  }

  defaultOptionLabel(op: string): string {
    const stem = (this.effectiveWorkflows[op] || this.packageDefaults[op] || '').trim();
    if (!stem) return 'Not configured';
    const available = this.comfyWorkflows.some((wf) => wf.stem === stem && wf.available !== false);
    if (available && !(this.assignmentForOp(op) || '').trim()) {
      return `Packaged default (${stem})`;
    }
    if (this.packageDefaults[op] && !available) {
      return `Not configured (add ${stem}.json to package)`;
    }
    return 'Not configured';
  }

  private assignmentForOp(op: string): string {
    switch (op) {
      case 'text_to_image':
        return this.comfyWorkflowTextToImage;
      case 'text_to_video':
        return this.comfyWorkflowTextToVideo;
      case 'image_to_video':
        return this.comfyWorkflowImageToVideo;
      case 'upscale_image':
        return this.comfyWorkflowUpscaleImage;
      case 'upscale_video':
        return this.comfyWorkflowUpscaleVideo;
      default:
        return '';
    }
  }

  openWorkflowDetails(stem: string): void {
    this.workflowDetailStem.set(stem);
    this.workflowDetailOpen.set(true);
  }

  closeWorkflowDetails(): void {
    this.workflowDetailOpen.set(false);
    this.workflowDetailStem.set('');
  }

  constructor(
    public api: ContentSproutApiService,
    private snackbar: SnackbarService,
    private dialogs: DialogService,
    private route: ActivatedRoute,
  ) {}

  ngOnInit(): void {
    const tab = (this.route.snapshot.queryParamMap.get('tab') || '').trim().toLowerCase();
    if (tab === 'stock' || tab === 'stock-assets' || tab === 'platforms') {
      this.settingsTab.set('stock');
    } else if (tab === 'textvision' || tab === 'text-vision' || tab === 'llm') {
      this.settingsTab.set('textVision');
    } else if (tab === 'genai' || tab === 'gen-ai' || tab === 'comfy') {
      this.settingsTab.set('genAi');
    } else if (tab === 'storage' || tab === 'config') {
      this.settingsTab.set('storage');
    }
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
      const [storage, llm, stock, platforms] = await Promise.all([
        this.api.getStorageSettings(),
        this.api.getLlmSettings(),
        this.api.getStockSettings(),
        this.api.getPublishPlatforms(),
      ]);
      if (!storage || !llm) {
        this.loadError.set('Could not load settings from the API.');
        return;
      }
      this.applyStorage(storage);
      this.applyLlm(llm);
      if (stock) this.applyStock(stock);
      this.publishPlatforms = (platforms || []).map((p) => ({ ...p }));
      if (this.comfyProvider !== 'off') {
        await this.loadWorkflows();
        await this.refreshAllWorkflowInputs();
      } else {
        this.comfyWorkflows = [];
        this.comfyWorkflowsDirResolved = '';
        this.clearWorkflowInputs();
      }
    } finally {
      this.busy.set(false);
    }
  }

  private applyStorage(s: StorageSettings): void {
    this.storage = { ...s };
  }

  private applyLlm(data: LlmSettings): void {
    const gem = data.gemini || {};
    this.geminiApiKey = '';
    this.geminiModel = gem.model || 'gemini-2.5-flash';
    this.geminiVisionModel = gem.vision_model || '';
    this.geminiTimeout = gem.timeout_s ?? 180;
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

    const configured = (data.ai_services || []).filter((s) => !String(s.id || '').startsWith('legacy-'));
    this.imageAiServices = configured
      .filter((s) => s.category === 'image')
      .map((s) => ({ ...s, api_key: '', api_key_secret: '', portkey_virtual_key: '' }));
    this.videoAiServices = configured
      .filter((s) => s.category === 'video')
      .map((s) => ({ ...s, api_key: '', api_key_secret: '', portkey_virtual_key: '' }));
    this.llmAiServices = configured
      .filter((s) => s.category === 'llm')
      .map((s) => ({ ...s, api_key: '', api_key_secret: '', portkey_virtual_key: '' }));
    if (!this.llmAiServices.length) {
      this.llmAiServices = this.seedLlmServicesFromLegacy(data);
    }
    this.selectedLlm.set(this.llmAiServices[0] || null);
    this.selectedImage.set(this.imageAiServices[0] || null);
    this.selectedVideo.set(this.videoAiServices[0] || null);

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

    const cu = data.comfyui || {};
    this.comfyProvider = cu.provider || (cu.enabled ? 'local' : 'off');
    this.allowLocalComfyui = this.comfyProvider !== 'off' || this.anyComfyuiSelected();
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

  addPublishPlatform(): void {
    this.publishPlatforms = [
      ...this.publishPlatforms,
      {
        id: '',
        label: 'Custom platform',
        enabled: true,
        contributor_url: '',
        notes: '',
      },
    ];
  }

  removePublishPlatform(index: number): void {
    this.publishPlatforms = this.publishPlatforms.filter((_, i) => i !== index);
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

      const servicesOk = await this.api.saveAiServices(this.buildAiServicesPayload());
      if (!servicesOk) return;
      this.applySavedAiServices(servicesOk);

      const stockPayload: Record<string, unknown> = {
        daily_download_limit: Number(this.dailyDownloadLimit) || 0,
      };
      if (this.pixabayApiKey.trim()) {
        stockPayload['pixabay_api_key'] = this.pixabayApiKey.trim();
      }
      const stockOk = await this.api.saveStockSettings(stockPayload);
      if (!stockOk) return;

      const platformsOk = await this.api.savePublishPlatforms(this.publishPlatforms);
      if (!platformsOk) return;
      this.publishPlatforms = platformsOk.map((p) => ({ ...p }));

      this.snackbar.show('Settings saved', 'success');
      await this.reload();
    } finally {
      this.busy.set(false);
    }
  }

  private buildLlmPayload(): LlmSettingsUpdate {
    const first = this.llmAiServices.find((s) => s.enabled) || this.llmAiServices[0];
    let provider: LlmSettingsUpdate['provider'] = 'heuristic_only';
    if (first?.protocol === 'ollama') provider = 'ollama';
    else if (first?.protocol === 'gemini') provider = 'gemini';
    else if (first?.protocol === 'openai_chat') provider = 'proxy';

    const payload: LlmSettingsUpdate = {
      provider,
      gemini_model: this.geminiModel.trim() || 'gemini-2.5-flash',
      gemini_vision_model: this.geminiVisionModel.trim(),
      gemini_timeout_s: Math.max(15, Math.min(7200, Number(this.geminiTimeout) || 180)),
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
      comfyui_provider: this.allowLocalComfyui ? this.comfyProvider : 'off',
      comfyui_base_url: this.comfyBaseUrl.trim() || 'http://127.0.0.1:8188',
      comfyui_workflow_text_to_image: this.comfyWorkflowTextToImage.trim(),
      comfyui_workflow_text_to_video: this.comfyWorkflowTextToVideo.trim(),
      comfyui_workflow_image_to_video: this.comfyWorkflowImageToVideo.trim(),
      comfyui_workflow_upscale_image: this.comfyWorkflowUpscaleImage.trim(),
      comfyui_workflow_upscale_video: this.comfyWorkflowUpscaleVideo.trim(),
      comfyui_workflow_input_config: this.buildWorkflowInputConfigPayload(),
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

    // Mirror first LLM service into legacy blocks so older paths stay coherent.
    const ollamaSvc = this.llmAiServices.find((s) => s.protocol === 'ollama' && s.enabled);
    if (ollamaSvc) {
      payload['ollama_host'] = (ollamaSvc.base_url || '').trim() || 'http://localhost:11434';
      payload['ollama_model'] = (ollamaSvc.model || '').trim() || 'gemma4:31b';
      payload['ollama_timeout_s'] = Math.max(15, Math.min(7200, Number(ollamaSvc.timeout_s) || 300));
    }
    const proxySvc = this.llmAiServices.find((s) => s.protocol === 'openai_chat' && s.enabled);
    if (proxySvc) {
      payload['proxy_base_url'] = (proxySvc.base_url || '').trim() || 'https://api.openai.com/v1';
      payload['proxy_model'] = (proxySvc.model || '').trim() || 'gpt-4o';
      payload['proxy_portkey_provider'] = (proxySvc.portkey_provider || '').trim();
      payload['proxy_timeout_s'] = Math.max(15, Math.min(7200, Number(proxySvc.timeout_s) || 180));
      if ((proxySvc.api_key || '').trim()) payload['proxy_api_key'] = proxySvc.api_key!.trim();
      if ((proxySvc.portkey_virtual_key || '').trim()) {
        payload['proxy_portkey_virtual_key'] = proxySvc.portkey_virtual_key!.trim();
      }
    }
    const geminiSvc = this.llmAiServices.find((s) => s.protocol === 'gemini' && s.enabled);
    if (geminiSvc) {
      if ((geminiSvc.model || '').trim()) payload['gemini_model'] = geminiSvc.model!.trim();
      payload['gemini_timeout_s'] = Math.max(15, Math.min(7200, Number(geminiSvc.timeout_s) || 180));
      if ((geminiSvc.api_key || '').trim()) payload['gemini_api_key'] = geminiSvc.api_key!.trim();
    } else if (this.geminiApiKey.trim()) {
      payload['gemini_api_key'] = this.geminiApiKey.trim();
    }

    if (this.higgsfieldApiKeyId.trim()) {
      payload['higgsfield_api_key_id'] = this.higgsfieldApiKeyId.trim();
    }
    if (this.higgsfieldApiKeySecret.trim()) {
      payload['higgsfield_api_key_secret'] = this.higgsfieldApiKeySecret.trim();
    }
    if (this.comfyApiKey.trim()) payload['comfyui_api_key'] = this.comfyApiKey.trim();
    if (this.comfyGatewayApiKey.trim()) {
      payload['comfyui_gateway_api_key'] = this.comfyGatewayApiKey.trim();
    }
    return payload;
  }

  private newServiceId(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : `svc${Date.now().toString(36)}`;
  }

  private seedLlmServicesFromLegacy(data: LlmSettings): EditableAiService[] {
    const out: EditableAiService[] = [];
    const provider = data.provider || 'ollama';
    if (provider === 'heuristic_only') return out;
    if (provider === 'ollama' || data.ollama) {
      out.push({
        id: this.newServiceId(),
        name: 'Ollama',
        category: 'llm',
        host: 'local',
        protocol: 'ollama',
        enabled: provider === 'ollama',
        base_url: data.ollama?.host || 'http://localhost:11434',
        model: data.ollama?.model || 'gemma4:31b',
        timeout_s: data.ollama?.timeout_s ?? 300,
        api_key: '',
      });
    }
    if (provider === 'gemini' || data.gemini) {
      out.push({
        id: this.newServiceId(),
        name: 'Gemini',
        category: 'llm',
        host: 'remote',
        protocol: 'gemini',
        enabled: provider === 'gemini',
        base_url: '',
        model: data.gemini?.model || 'gemini-2.5-flash',
        timeout_s: data.gemini?.timeout_s ?? 180,
        api_key: '',
        api_key_set: !!data.gemini?.api_key_set,
        api_key_masked: data.gemini?.api_key_masked,
        ready: !!data.gemini?.ready && provider === 'gemini',
      });
    }
    if (provider === 'proxy' || data.proxy) {
      out.push({
        id: this.newServiceId(),
        name: 'OpenAI-compatible',
        category: 'llm',
        host: 'remote',
        protocol: 'openai_chat',
        enabled: provider === 'proxy',
        base_url: data.proxy?.base_url || 'https://api.openai.com/v1',
        model: data.proxy?.model || 'gpt-4o',
        timeout_s: data.proxy?.timeout_s ?? 180,
        portkey_provider: data.proxy?.portkey_provider || '',
        api_key: '',
        api_key_set: !!data.proxy?.api_key_set,
        api_key_masked: data.proxy?.api_key_masked,
        portkey_virtual_key_set: !!data.proxy?.portkey_virtual_key_set,
        ready: provider === 'proxy' && !!data.proxy?.api_key_set,
      });
    }
    return out.filter((s) => s.enabled).length ? out.filter((s) => s.enabled) : out.slice(0, 1);
  }

  addAiService(category: 'image' | 'video' | 'llm'): void {
    const id = this.newServiceId();
    if (category === 'llm') {
      const created: EditableAiService = {
        id,
        name: 'Text & Vision AI service',
        category: 'llm',
        host: 'local',
        protocol: 'ollama',
        enabled: true,
        base_url: 'http://localhost:11434',
        model: 'gemma4:31b',
        timeout_s: 300,
        api_key: '',
        api_key_secret: '',
        portkey_virtual_key: '',
      };
      this.llmAiServices = [...this.llmAiServices, created];
      this.selectedLlm.set(created);
      return;
    }
    const base: EditableAiService = {
      id,
      name: category === 'image' ? 'Image AI service' : 'Video AI service',
      category,
      host: 'local',
      protocol: category === 'image' ? 'openai_images' : 'comfyui',
      enabled: true,
      base_url: category === 'image' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:8188',
      model: category === 'image' ? 'gpt-image-1' : '',
      timeout_s: category === 'image' ? 180 : 900,
      api_key: '',
      api_key_secret: '',
    };
    if (category === 'image') {
      this.imageAiServices = [...this.imageAiServices, base];
      this.selectedImage.set(base);
    } else {
      this.videoAiServices = [...this.videoAiServices, base];
      this.selectedVideo.set(base);
    }
  }

  async removeAiServiceById(category: 'image' | 'video' | 'llm', id: string): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Delete service',
      message: 'Remove this AI service configuration?',
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    if (category === 'image') {
      this.imageAiServices = this.imageAiServices.filter((s) => s.id !== id);
      this.selectedImage.set(this.imageAiServices[0] || null);
    } else if (category === 'video') {
      this.videoAiServices = this.videoAiServices.filter((s) => s.id !== id);
      this.selectedVideo.set(this.videoAiServices[0] || null);
    } else {
      this.llmAiServices = this.llmAiServices.filter((s) => s.id !== id);
      this.selectedLlm.set(this.llmAiServices[0] || null);
    }
  }

  filteredLlmServices(): EditableAiService[] {
    return this.filterServices(this.llmAiServices, this.llmSearch());
  }

  filteredImageServices(): EditableAiService[] {
    return this.filterServices(this.imageAiServices, this.imageSearch());
  }

  filteredVideoServices(): EditableAiService[] {
    return this.filterServices(this.videoAiServices, this.videoSearch());
  }

  private filterServices(list: EditableAiService[], query: string): EditableAiService[] {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => {
      const hay = `${s.name} ${s.protocol} ${s.host} ${s.model || ''} ${s.base_url || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  private serviceSubtitle(item: EditableAiService): string {
    const protocol = this.protocolLabel(item.protocol);
    const model = (item.model || '').trim();
    return model ? `${protocol} · ${model}` : protocol;
  }

  private protocolLabel(protocol: string): string {
    switch (protocol) {
      case 'ollama':
        return 'Ollama';
      case 'openai_chat':
        return 'OpenAI-compatible';
      case 'gemini':
        return 'Gemini';
      case 'openai_images':
        return 'OpenAI images';
      case 'openai_video':
        return 'OpenAI video';
      case 'comfyui':
        return 'ComfyUI';
      case 'higgsfield':
        return 'Higgsfield';
      default:
        return protocol || 'Service';
    }
  }

  private serviceIcon(item: EditableAiService): string {
    if (item.protocol === 'ollama') return 'dns';
    if (item.protocol === 'gemini') return 'flare';
    if (item.protocol === 'openai_chat') return 'cloud';
    return 'smart_toy';
  }

  private serviceBadges(item: EditableAiService): { label: string; variant?: 'default' | 'primary' | 'success' | 'danger' | 'warning' }[] {
    const badges: { label: string; variant?: 'default' | 'primary' | 'success' | 'danger' | 'warning' }[] = [];
    if (!item.enabled) badges.push({ label: 'Off', variant: 'warning' });
    else if (item.ready) badges.push({ label: 'Ready', variant: 'success' });
    else badges.push({ label: 'Not ready', variant: 'danger' });
    return badges;
  }

  onLlmProtocolChange(svc: EditableAiService): void {
    if (svc.protocol === 'ollama') {
      svc.host = 'local';
      if (!(svc.base_url || '').trim()) svc.base_url = 'http://localhost:11434';
      if (!(svc.model || '').trim()) svc.model = 'gemma4:31b';
      if (!svc.timeout_s) svc.timeout_s = 300;
    } else if (svc.protocol === 'gemini') {
      svc.host = 'remote';
      if (!(svc.model || '').trim()) svc.model = 'gemini-2.5-flash';
      if (!svc.timeout_s) svc.timeout_s = 180;
    } else if (svc.protocol === 'openai_chat') {
      svc.host = 'remote';
      if (!(svc.base_url || '').trim()) svc.base_url = 'https://api.openai.com/v1';
      if (!(svc.model || '').trim()) svc.model = 'gpt-4o';
      if (!svc.timeout_s) svc.timeout_s = 180;
    }
  }

  applyLlmPreset(
    svc: EditableAiService,
    kind: 'openai' | 'openrouter' | 'portkey' | 'claude',
  ): void {
    svc.protocol = 'openai_chat';
    svc.host = 'remote';
    if (kind === 'openai') {
      svc.name = svc.name?.includes('AI') ? svc.name : 'OpenAI';
      svc.base_url = 'https://api.openai.com/v1';
      svc.model = 'gpt-4o';
      svc.portkey_provider = '';
    } else if (kind === 'openrouter') {
      svc.name = svc.name?.includes('AI') ? svc.name : 'OpenRouter';
      svc.base_url = 'https://openrouter.ai/api/v1';
      svc.model = 'openai/gpt-4o';
      svc.portkey_provider = '';
    } else if (kind === 'portkey') {
      svc.name = svc.name?.includes('AI') ? svc.name : 'Portkey';
      svc.base_url = 'https://api.portkey.ai/v1';
      svc.model = 'gpt-4o';
      svc.portkey_provider = svc.portkey_provider || 'openai';
    } else {
      svc.name = 'Claude';
      svc.base_url = 'https://openrouter.ai/api/v1';
      svc.model = 'anthropic/claude-sonnet-4';
      svc.portkey_provider = '';
    }
  }

  private buildAiServicesPayload(): Array<Record<string, unknown>> {
    const pack = (list: EditableAiService[]): Array<Record<string, unknown>> =>
      list.map((svc) => {
        const row: Record<string, unknown> = {
          id: svc.id,
          name: svc.name,
          category: svc.category,
          host: svc.host,
          protocol: svc.protocol,
          enabled: !!svc.enabled,
          base_url: (svc.base_url || '').trim(),
          model: (svc.model || '').trim(),
          timeout_s: Number(svc.timeout_s) || 180,
          portkey_provider: (svc.portkey_provider || '').trim(),
        };
        if ((svc.api_key || '').trim()) row['api_key'] = svc.api_key!.trim();
        if ((svc.api_key_secret || '').trim()) row['api_key_secret'] = svc.api_key_secret!.trim();
        if ((svc.portkey_virtual_key || '').trim()) {
          row['portkey_virtual_key'] = svc.portkey_virtual_key!.trim();
        }
        return row;
      });
    return [...pack(this.imageAiServices), ...pack(this.videoAiServices), ...pack(this.llmAiServices)];
  }

  async testLlm(svc?: EditableAiService | null): Promise<void> {
    const target = svc || this.selectedLlm();
    if (!target?.id) return;
    this.testingLlm.set(true);
    this.llmTest.set(null);
    this.llmTestText.set('');
    this.llmTestServiceId.set(target.id);
    try {
      // Save first so test uses current form values
      const llmOk = await this.api.saveLlmSettings(this.buildLlmPayload());
      if (!llmOk) return;
      const saved = await this.api.saveAiServices(this.buildAiServicesPayload());
      if (!saved) return;
      this.applySavedAiServices(saved);

      const result = await this.api.testAiService(target.id);
      if (!result) {
        this.llmTest.set({ ok: false });
        this.llmTestText.set(this.api.llmError() || 'LLM connection test failed');
        return;
      }
      this.llmTest.set(result);
      this.llmTestText.set(this.formatTest(result));
      if (result.service) {
        this.applySavedAiServices([result.service], { mergeOnly: true });
      } else if (result.ok) {
        this.patchLlmServiceReady(target.id, true);
      }
    } finally {
      this.testingLlm.set(false);
    }
  }

  /** Merge server-side ready / key-mask fields into local editable lists. */
  private applySavedAiServices(
    saved: AiServiceProfile[],
    opts?: { mergeOnly?: boolean },
  ): void {
    const byId = new Map(saved.map((s) => [s.id, s]));
    const mergeList = (list: EditableAiService[]): EditableAiService[] =>
      list.map((svc) => {
        const remote = byId.get(svc.id);
        if (!remote) return svc;
        return {
          ...svc,
          ready: !!remote.ready,
          can_use_llm: !!remote.can_use_llm,
          can_edit_image: !!remote.can_edit_image,
          api_key_set: !!remote.api_key_set,
          api_key_masked: remote.api_key_masked || '',
          api_key_secret_set: !!remote.api_key_secret_set,
          portkey_virtual_key_set: !!remote.portkey_virtual_key_set,
          // Clear ephemeral secrets after a successful save so we don't re-send.
          ...(opts?.mergeOnly
            ? {}
            : { api_key: '', api_key_secret: '', portkey_virtual_key: '' }),
        };
      });

    this.llmAiServices = mergeList(this.llmAiServices);
    this.imageAiServices = mergeList(this.imageAiServices);
    this.videoAiServices = mergeList(this.videoAiServices);

    const llmId = this.selectedLlm()?.id;
    if (llmId) {
      this.selectedLlm.set(this.llmAiServices.find((s) => s.id === llmId) || null);
    }
    const imageId = this.selectedImage()?.id;
    if (imageId) {
      this.selectedImage.set(this.imageAiServices.find((s) => s.id === imageId) || null);
    }
    const videoId = this.selectedVideo()?.id;
    if (videoId) {
      this.selectedVideo.set(this.videoAiServices.find((s) => s.id === videoId) || null);
    }
  }

  private patchLlmServiceReady(serviceId: string, ready: boolean): void {
    this.llmAiServices = this.llmAiServices.map((svc) =>
      svc.id === serviceId ? { ...svc, ready, can_use_llm: ready && svc.enabled } : svc,
    );
    const sel = this.selectedLlm();
    if (sel?.id === serviceId) {
      this.selectedLlm.set(this.llmAiServices.find((s) => s.id === serviceId) || null);
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
    this.packageDefaults = data.package_defaults || {};
    this.effectiveWorkflows = data.effective_workflows || {};
  }

  onWorkflowFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.workflowUploadFile = input.files?.[0] ?? null;
  }

  async onWorkflowBundleSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    const ok = await this.dialogs.confirm({
      title: 'Import workflow bundle',
      message:
        `Import ${file.name} into tools storage? Matching filenames are overwritten. ` +
        `Operation assignments and parameter defaults from the bundle are applied.`,
      confirmText: 'Import',
      type: 'info',
    });
    if (!ok) return;
    await this.importWorkflowBundle(file, false);
  }

  async downloadWorkflowBundle(): Promise<void> {
    this.bundlingWorkflow.set(true);
    try {
      const ok = await this.api.saveLlmSettings(this.buildLlmPayload());
      if (!ok) return;
      const downloaded = await this.api.downloadComfyuiWorkflowBundle();
      if (downloaded) {
        this.snackbar.show('Workflow bundle downloaded', 'success');
      }
    } finally {
      this.bundlingWorkflow.set(false);
    }
  }

  async importWorkflowBundle(file: File, replaceExisting: boolean): Promise<void> {
    this.bundlingWorkflow.set(true);
    try {
      const data = await this.api.importComfyuiWorkflowBundle(file, replaceExisting);
      if (!data) return;
      this.comfyWorkflows = data.workflows || [];
      this.comfyWorkflowsDirResolved = data.workflows_dir || this.comfyWorkflowsDirResolved;
      const cu = data.comfyui || {};
      if (cu.workflow_text_to_image != null) {
        this.comfyWorkflowTextToImage = cu.workflow_text_to_image;
      }
      if (cu.workflow_text_to_video != null) {
        this.comfyWorkflowTextToVideo = cu.workflow_text_to_video;
      }
      if (cu.workflow_image_to_video != null) {
        this.comfyWorkflowImageToVideo = cu.workflow_image_to_video;
      }
      if (cu.workflow_upscale_image != null) {
        this.comfyWorkflowUpscaleImage = cu.workflow_upscale_image;
      }
      if (cu.workflow_upscale_video != null) {
        this.comfyWorkflowUpscaleVideo = cu.workflow_upscale_video;
      }
      if (cu.frames != null) this.comfyFrames = cu.frames;
      if (cu.fps != null) this.comfyFps = cu.fps;
      if (cu.steps != null) this.comfySteps = cu.steps;
      if (cu.cfg != null) this.comfyCfg = cu.cfg;
      if (cu.negative_prompt != null) this.comfyNegativePrompt = cu.negative_prompt;
      this.snackbar.show(
        `Imported ${data.imported_count} workflow(s)` +
          (data.settings_applied?.length ? ' and applied bundle settings' : ''),
        'success',
      );
      await this.refreshAllWorkflowInputs();
    } finally {
      this.bundlingWorkflow.set(false);
    }
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
      await this.refreshAllWorkflowInputs();
    } finally {
      this.uploadingWorkflow.set(false);
    }
  }

  async deleteWorkflow(filename: string): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Delete workflow',
      message: `Delete workflow ${filename}?`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
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
      await this.refreshAllWorkflowInputs();
    } finally {
      this.uploadingWorkflow.set(false);
    }
  }

  onWorkflowAssignChange(op: string, stem: string): void {
    void this.loadWorkflowInputsForOp(op, stem);
  }

  private clearWorkflowInputs(): void {
    for (const op of Object.keys(this.comfyInputFields)) {
      this.comfyInputFields[op] = [];
      this.comfyInputValues[op] = {};
      this.comfyInputEnabled[op] = {};
    }
  }

  private async refreshAllWorkflowInputs(): Promise<void> {
    await Promise.all([
      this.loadWorkflowInputsForOp('text_to_image', this.comfyWorkflowTextToImage),
      this.loadWorkflowInputsForOp('text_to_video', this.comfyWorkflowTextToVideo),
      this.loadWorkflowInputsForOp('image_to_video', this.comfyWorkflowImageToVideo),
      this.loadWorkflowInputsForOp('upscale_video', this.comfyWorkflowUpscaleVideo),
    ]);
  }

  private async loadWorkflowInputsForOp(op: string, stem: string): Promise<void> {
    const name = (stem || '').trim() || (this.effectiveWorkflows[op] || '').trim();
    if (!name) {
      this.comfyInputFields[op] = [];
      this.comfyInputValues[op] = {};
      this.comfyInputEnabled[op] = {};
      return;
    }
    const data = await this.api.getComfyuiWorkflowInputs(name, op);
    const fields = data?.inputs || [];
    this.comfyInputFields[op] = fields;
    this.comfyInputValues[op] = valuesFromWorkflowInputs(fields);
    this.comfyInputEnabled[op] = enabledFromWorkflowInputs(fields);
  }

  private buildWorkflowInputConfigPayload(): Record<
    string,
    Record<string, { enabled: boolean; default?: string | number | boolean }>
  > {
    const out: Record<
      string,
      Record<string, { enabled: boolean; default?: string | number | boolean }>
    > = {};
    for (const op of Object.keys(this.comfyInputFields)) {
      const fields = this.comfyInputFields[op] || [];
      const values = this.comfyInputValues[op] || {};
      const enabled = this.comfyInputEnabled[op] || {};
      const bucket: Record<string, { enabled: boolean; default?: string | number | boolean }> = {};
      for (const field of fields) {
        if (!enabled[field.id]) continue;
        const entry: { enabled: boolean; default?: string | number | boolean } = { enabled: true };
        if (field.id in values) {
          entry.default = values[field.id];
        }
        bucket[field.id] = entry;
      }
      if (Object.keys(bucket).length) {
        out[op] = bucket;
      }
    }
    return out;
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
