import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SnackbarService } from '@ctrlfabric/ui';
import type { Asset } from '../../models/content-sprout.models';
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_VIDEO_SIZE,
  IMAGE_SIZE_PRESETS as IMAGE_SIZE_PRESETS_DATA,
  VIDEO_SIZE_PRESETS as VIDEO_SIZE_PRESETS_DATA,
  VIDEO_UPSCALE_SCALES as VIDEO_UPSCALE_SCALES_DATA,
  sizeKey,
} from '../../shared/gen-presets';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { isImageAsset, isVideoAsset } from '../../models/content-sprout.models';

type GenMode = 'image' | 'video' | 'upscale';

@Component({
  selector: 'app-ai-gen',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="page cs-ai-gen-page">
      <p class="page-intro">
        Generate images/videos with ComfyUI using small preset sizes. Newly generated assets can be associated to project posts.
      </p>

      @if (api.error()) {
        <p class="status-msg error">{{ api.error() }}</p>
      }

      @if (!api.currentProject()) {
        <section class="surface-card cs-empty">
          <h2>Select a project</h2>
          <p>Use the project selector in the header. AI Gen creates assets inside the active project.</p>
        </section>
      } @else {
        <section class="surface-card cs-ai-gen-section">
          <h3 class="cs-section-title">AI Gen</h3>

          @if (caps(); as c) {
            <div class="cs-ai-gen-cap-grid">
              <span class="meta">Image gen: {{ c.text_to_image ? 'Ready' : 'Off' }}</span>
              <span class="meta">Video gen: {{ c.text_to_video || c.image_to_video ? 'Ready' : 'Off' }}</span>
              <span class="meta">Video upscale: {{ c.upscale_video ? 'Ready' : 'Off' }}</span>
            </div>
          }

          <div class="cs-form-row" style="flex-wrap: wrap; gap: 0.6rem; margin-top: 1rem">
            <label class="cs-ai-op">
              <span>Operation</span>
              <select [(ngModel)]="mode">
                <option value="image">Generate image</option>
                <option value="video">Generate video (prompt + reference image)</option>
                <option value="upscale">Scale a video</option>
              </select>
            </label>
          </div>

          @if (mode === 'image') {
            <div class="cs-form-stack cs-ai-form">
              <label>
                <span>Prompt</span>
                <textarea rows="4" [(ngModel)]="imagePrompt" placeholder="Describe the image…"></textarea>
              </label>

              <div class="cs-form-row" style="margin: 0">
                <label>
                  <span>Size preset</span>
                  <select [(ngModel)]="imageSizeKey">
                    @for (s of IMAGE_SIZE_PRESETS; track s.width) {
                      <option [value]="sizeKey(s.width, s.height)">{{ s.label }}</option>
                    }
                  </select>
                </label>
                <label>
                  <span>Name (optional)</span>
                  <input [(ngModel)]="imageName" placeholder="e.g. My image" />
                </label>
              </div>

              <label class="cs-check">
                <input type="checkbox" [(ngModel)]="assetProjectShared" />
                Project-shared asset (not attached to any post)
              </label>
              @if (!assetProjectShared) {
                <label>
                  <span>Attach to post</span>
                  <select [(ngModel)]="targetPostId">
                    <option [ngValue]="null">Select a post…</option>
                    @for (p of (api.currentProject()?.posts || []); track p.id) {
                      <option [value]="p.id">{{ p.name }}</option>
                    }
                  </select>
                </label>
              }

              <div class="page-actions-inline">
                <button type="button" class="primary" (click)="submitImage()" [disabled]="api.busy()">Generate</button>
              </div>
            </div>
          }

          @if (mode === 'video') {
            <div class="cs-form-stack cs-ai-form">
              <label>
                <span>Prompt</span>
                <textarea rows="4" [(ngModel)]="videoPrompt" placeholder="Describe the video…"></textarea>
              </label>

              <div class="cs-form-row" style="margin: 0">
                <label>
                  <span>Reference image</span>
                  <select [(ngModel)]="videoRefImageId">
                    <option value="">Select an image…</option>
                    @for (a of projectImages(); track a.id) {
                      <option [value]="a.id">{{ a.name }}</option>
                    }
                  </select>
                </label>
                <label>
                  <span>Size preset</span>
                  <select [(ngModel)]="videoSizeKey">
                    @for (s of VIDEO_SIZE_PRESETS; track s.width) {
                      <option [value]="sizeKey(s.width, s.height)">{{ s.label }}</option>
                    }
                  </select>
                </label>
              </div>

              <label>
                <span>Name (optional)</span>
                  <input [(ngModel)]="videoName" placeholder="e.g. My video" />
              </label>

              <label class="cs-check">
                <input type="checkbox" [(ngModel)]="assetProjectShared" />
                Project-shared asset (not attached to any post)
              </label>
              @if (!assetProjectShared) {
                <label>
                  <span>Attach to post</span>
                  <select [(ngModel)]="targetPostId">
                    <option [ngValue]="null">Select a post…</option>
                    @for (p of (api.currentProject()?.posts || []); track p.id) {
                      <option [value]="p.id">{{ p.name }}</option>
                    }
                  </select>
                </label>
              }

              <div class="page-actions-inline">
                <button type="button" class="primary" (click)="submitVideo()" [disabled]="api.busy()">Generate</button>
              </div>
            </div>
          }

          @if (mode === 'upscale') {
            <div class="cs-form-stack cs-ai-form">
              <label>
                <span>Video to scale</span>
                <select [(ngModel)]="upscaleVideoId">
                  <option value="">Select a video…</option>
                  @for (a of projectVideos(); track a.id) {
                    <option [value]="a.id">{{ a.name }}</option>
                  }
                </select>
              </label>

              <div class="cs-form-row" style="margin: 0">
                <label>
                  <span>Scale</span>
                  <select [(ngModel)]="upscaleScale">
                    @for (s of VIDEO_UPSCALE_SCALES; track s) {
                      <option [value]="s">{{ s }}×</option>
                    }
                  </select>
                </label>
                <label>
                  <span>Name (optional)</span>
                  <input [(ngModel)]="upscaleName" placeholder="e.g. Upscaled video" />
                </label>
              </div>

              <label class="cs-check">
                <input type="checkbox" [(ngModel)]="assetProjectShared" />
                Project-shared asset (not attached to any post)
              </label>
              @if (!assetProjectShared) {
                <label>
                  <span>Attach to post</span>
                  <select [(ngModel)]="targetPostId">
                    <option [ngValue]="null">Select a post…</option>
                    @for (p of (api.currentProject()?.posts || []); track p.id) {
                      <option [value]="p.id">{{ p.name }}</option>
                    }
                  </select>
                </label>
              }

              <div class="page-actions-inline">
                <button type="button" class="primary" (click)="submitUpscale()" [disabled]="api.busy()">Scale</button>
              </div>
            </div>
          }
        </section>

        <section class="surface-card cs-ai-gen-section" style="margin-top: 1rem">
          <h3 class="cs-section-title">Recent AI assets</h3>
          <p class="meta" style="margin-top: 0">Assets created from this page. You can attach them to a post after generation.</p>

          @if (!recentAssets().length) {
            <p class="cs-empty-inline">Generate something to see it here.</p>
          } @else {
            <div class="cs-ai-results-grid">
              @for (a of recentAssets(); track a.id) {
                <div class="cs-ai-result-card surface-inset">
                  <div class="cs-ai-result-preview">
                    @if (thumbUrl(a); as url) {
                      <img [src]="url" alt="" />
                    } @else {
                      <span class="meta">No preview</span>
                    }
                  </div>
                  <div class="cs-ai-result-body">
                    <div class="cs-ai-result-title">
                      <strong class="truncate">{{ a.name }}</strong>
                      <span class="meta">{{ a.status || 'ready' }}</span>
                    </div>

                    <div class="cs-form-stack" style="gap: 0.5rem">
                      <label>
                        <span>Associate to post</span>
                        <select [(ngModel)]="associationByAsset[a.id]">
                          <option [ngValue]="null">Project-shared</option>
                          @for (p of (api.currentProject()?.posts || []); track p.id) {
                            <option [value]="p.id">{{ p.name }}</option>
                          }
                        </select>
                      </label>
                      <button type="button" (click)="applyAssociation(a.id)" [disabled]="api.busy()">Update</button>
                      @if (a.job_message || a.error) {
                        <p class="meta" style="margin: 0">{{ a.job_message || a.error }}</p>
                      }
                    </div>
                  </div>
                </div>
              }
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class AiGenPage implements OnInit, OnDestroy {
  readonly IMAGE_SIZE_PRESETS = IMAGE_SIZE_PRESETS_DATA;
  readonly VIDEO_SIZE_PRESETS = VIDEO_SIZE_PRESETS_DATA;
  readonly VIDEO_UPSCALE_SCALES = VIDEO_UPSCALE_SCALES_DATA;
  readonly sizeKey = sizeKey;

  readonly caps = signal<any | null>(null);

  mode: GenMode = 'image';

  // Shared association controls for new generations.
  assetProjectShared = true;
  targetPostId: string | null = null;

  // Image gen
  imagePrompt = '';
  imageName = '';
  imageSizeKey = sizeKey(DEFAULT_IMAGE_SIZE.width, DEFAULT_IMAGE_SIZE.height);

  // Video gen (prompt + ref image)
  videoPrompt = '';
  videoName = '';
  videoSizeKey = sizeKey(DEFAULT_VIDEO_SIZE.width, DEFAULT_VIDEO_SIZE.height);
  videoRefImageId = '';

  // Upscale
  upscaleVideoId = '';
  upscaleName = '';
  upscaleScale = VIDEO_UPSCALE_SCALES_DATA[0];

  private readonly recentAssetIds = signal<string[]>([]);
  associationByAsset: Record<string, string | null> = {};

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;

  constructor(public api: ContentSproutApiService, private snackbar: SnackbarService) {}

  ngOnInit(): void {
    void this.api.refreshCurrentProject();
    void this.loadCaps();

    effect(() => {
      const processing = this.recentAssets().some((a) => String(a.status).toLowerCase() === 'processing');
      if (processing) this.ensurePolling();
      else this.maybeStopPolling();
    });
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async loadCaps(): Promise<void> {
    const c = await this.api.getAiCapabilities();
    this.caps.set(c);
  }

  projectImages(): Asset[] {
    return (this.api.currentProject()?.assets || []).filter((a) => isImageAsset(a.type) && a.status === 'ready');
  }

  projectVideos(): Asset[] {
    return (this.api.currentProject()?.assets || []).filter((a) => isVideoAsset(a.type) && a.status === 'ready');
  }

  recentAssets = computed(() => {
    const ids = this.recentAssetIds();
    const assets = this.api.currentProject()?.assets || [];
    return ids
      .map((id) => assets.find((a) => a.id === id))
      .filter((x): x is Asset => !!x);
  });

  thumbUrl(asset: Asset): string | null {
    return this.api.assetThumbUrl(asset, false);
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), 2500);
    void this.poll();
  }

  private maybeStopPolling(): void {
    if (!this.pollTimer) return;
    const anyProcessing = this.recentAssets().some((a) => String(a.status).toLowerCase() === 'processing');
    if (!anyProcessing) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    const processing = this.recentAssets().some((a) => String(a.status).toLowerCase() === 'processing');
    if (!processing) return;
    this.pollInFlight = true;
    try {
      await this.api.refreshCurrentProject();
    } finally {
      this.pollInFlight = false;
    }
  }

  private newAssetPostId(): string | undefined {
    if (this.assetProjectShared) return undefined;
    const id = (this.targetPostId || '').trim();
    return id || undefined;
  }

  private parseSizeKey(key: string): { width: number; height: number } {
    const [w, h] = String(key || '').split('x').map((s) => Number(s));
    return { width: w, height: h };
  }

  async submitImage(): Promise<void> {
    const projectId = this.api.currentProject()?.id;
    if (!projectId) return;
    if (!this.assetProjectShared && !this.targetPostId) {
      this.snackbar.show('Select a post to attach to', 'error');
      return;
    }
    const prompt = this.imagePrompt.trim();
    if (!prompt) {
      this.snackbar.show('Enter a prompt', 'error');
      return;
    }
    const { width, height } = this.parseSizeKey(this.imageSizeKey);
    const body = {
      prompt,
      width,
      height,
      name: this.imageName.trim() || undefined,
      post_id: this.newAssetPostId(),
    };
    const ok = await this.api.generateProjectImage(projectId, body);
    if (ok?.asset?.id) {
      this.trackAsset(ok.asset.id, ok.asset.post_id ?? null);
    }
  }

  async submitVideo(): Promise<void> {
    const projectId = this.api.currentProject()?.id;
    if (!projectId) return;
    if (!this.assetProjectShared && !this.targetPostId) {
      this.snackbar.show('Select a post to attach to', 'error');
      return;
    }
    const prompt = this.videoPrompt.trim();
    if (!prompt) {
      this.snackbar.show('Enter a prompt', 'error');
      return;
    }
    if (!this.videoRefImageId) {
      this.snackbar.show('Select a reference image', 'error');
      return;
    }
    const { width, height } = this.parseSizeKey(this.videoSizeKey);
    const body = {
      prompt,
      width,
      height,
      name: this.videoName.trim() || undefined,
      post_id: this.newAssetPostId(),
      image_asset_id: this.videoRefImageId,
    };
    const ok = await this.api.generateProjectVideoFromImage(projectId, body);
    if (ok?.asset?.id) this.trackAsset(ok.asset.id, ok.asset.post_id ?? null);
  }

  async submitUpscale(): Promise<void> {
    const projectId = this.api.currentProject()?.id;
    if (!projectId) return;
    if (!this.assetProjectShared && !this.targetPostId) {
      this.snackbar.show('Select a post to attach to', 'error');
      return;
    }
    if (!this.upscaleVideoId) {
      this.snackbar.show('Select a video', 'error');
      return;
    }
    const ok = await this.api.upscaleProjectAsset(projectId, this.upscaleVideoId, {
      scale: Number(this.upscaleScale),
      name: this.upscaleName.trim() || undefined,
      post_id: this.newAssetPostId(),
    });
    if (ok?.asset?.id) this.trackAsset(ok.asset.id, ok.asset.post_id ?? null);
  }

  private trackAsset(assetId: string, postId: string | null): void {
    const ids = [assetId, ...this.recentAssetIds().filter((x) => x !== assetId)];
    this.recentAssetIds.set(ids.slice(0, 8));
    this.associationByAsset = { ...this.associationByAsset, [assetId]: postId };
  }

  async applyAssociation(assetId: string): Promise<void> {
    const postId = this.associationByAsset[assetId] || null;
    const ok = await this.api.patchProjectAsset(assetId, { post_id: postId });
    if (!ok) return;
    this.snackbar.show('Asset association updated', 'success');
  }
}

