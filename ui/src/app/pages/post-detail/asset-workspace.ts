import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  computed,
  effect,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent, SnackbarService, DialogService } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { MediaThumbTileComponent } from '../../shared/media-thumb-tile';
import { AssetInspectComponent } from '../../shared/asset-inspect';
import { AudioRecorderDialogComponent } from '../../shared/audio-recorder-dialog';
import {
  AssetListViewService,
  AssetViewToggleComponent,
} from '../../shared/asset-list-view';
import {
  ASSET_TYPE_FILTERS,
  assetMatchesTypeFilter,
  assetTypeIcon,
  assetTypeLabel,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
  type Asset,
  type Post,
  type PostType,
  type Scene,
} from '../../models/content-sprout.models';
import {
  AttachVisualAssetDialogComponent,
  type AttachAssetFilter,
  type AttachableAsset,
} from '../../shared/attach-visual-asset-dialog';
import {
  appendCueToSceneBody,
  attachAssetLayerToScene,
  attachScenePrimaryVisual,
  buildAddAssetCueForAsset,
  deriveScriptSceneBlocks,
  extractSceneVisualBlocks,
  findScriptBlockIndexForTimelineScene,
  isLayerEnabled,
  isSceneEnabled,
  rewriteVisualCueWithAsset,
  sceneAllowsBackgroundVisual,
  stitchScriptFromSceneBlocks,
  stripVisualAssetRef,
  visualMediaTypeForLibraryAsset,
  type ScriptSceneBlock,
} from '../../shared/script-scenes';
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_VIDEO_SIZE,
  IMAGE_SIZE_PRESETS,
  IMAGE_UPSCALE_SCALES,
  VIDEO_SIZE_PRESETS,
  VIDEO_UPSCALE_SCALES,
  sizeKey,
} from '../../shared/gen-presets';

type ScopeTab = 'all' | 'resources' | 'project' | 'post';
type ManagerView = 'library' | 'scenes';
type GenMode = 'text_to_image' | 'text_to_video' | 'image_to_video' | 'upscale' | null;

type PaletteAsset = Asset & { is_global?: boolean };

interface SceneAssetSlot {
  id: string;
  role: 'visual' | 'cue' | 'layer' | 'audio' | 'reusable';
  label: string;
  detail: string;
  assetId: string | null;
  missing: boolean;
  attachable: boolean;
  attachLock: AttachAssetFilter | null;
}

interface SceneAssetRow {
  sceneId: string;
  index: number;
  name: string;
  durationS: number;
  enabled: boolean;
  allowBackgroundVisual: boolean;
  needed: number;
  missing: number;
  slots: SceneAssetSlot[];
}

interface AssetGroupBucket {
  name: string;
  assets: PaletteAsset[];
}

@Component({
  selector: 'app-asset-workspace',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ModalWrapperComponent,
    MediaThumbTileComponent,
    AssetInspectComponent,
    AssetViewToggleComponent,
    AudioRecorderDialogComponent,
    AttachVisualAssetDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="cs-am surface-card">
      <div class="cs-am-head">
        <div class="min-w-0">
          <h3 class="cs-section-title" style="margin: 0">Asset manager</h3>
          <p class="meta" style="margin: 0.2rem 0 0">
            @if (managerView() === 'scenes') {
              Per-scene assets from the script and timeline — attach a library visual to a scene.
            } @else {
              Browse Resources, project-shared, and this post’s private assets.
            }
          </p>
        </div>
        <div class="cs-am-head-actions">
          @if (anyGenReady()) {
            <div class="cs-am-gen-menu">
              <button type="button" (click)="genMenuOpen.set(!genMenuOpen())" [attr.aria-expanded]="genMenuOpen()">
                <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
                Generate
              </button>
              @if (genMenuOpen()) {
                <div class="cs-am-gen-dropdown" role="menu">
                  @if (caps()?.text_to_image) {
                    <button type="button" role="menuitem" (click)="openGenerate('text_to_image')">
                      Image from text
                    </button>
                  }
                  @if (caps()?.text_to_video) {
                    <button type="button" role="menuitem" (click)="openGenerate('text_to_video')">
                      Video from text
                    </button>
                  }
                  @if (caps()?.image_to_video) {
                    <button type="button" role="menuitem" (click)="openGenerate('image_to_video')">
                      Video from image
                    </button>
                  }
                </div>
              }
            </div>
          }
          <button type="button" (click)="openRecordDialog()" title="Record from microphone (incl. Bluetooth)">
            <span class="material-symbols-outlined" aria-hidden="true">mic</span>
            Record
          </button>
          <button type="button" class="primary" (click)="openUploadDialog()">
            <span class="material-symbols-outlined" aria-hidden="true">upload</span>
            Upload
          </button>
        </div>
      </div>

      @if (isVideo()) {
        <div class="cs-am-scope-tabs" role="tablist" aria-label="Asset manager view">
          <button
            type="button"
            role="tab"
            [class.active]="managerView() === 'library'"
            [attr.aria-selected]="managerView() === 'library'"
            (click)="setManagerView('library')"
          >
            Library
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="managerView() === 'scenes'"
            [attr.aria-selected]="managerView() === 'scenes'"
            (click)="setManagerView('scenes')"
          >
            Scenes
            @if (sceneMissingCount() > 0) {
              <span class="cs-am-count">({{ sceneMissingCount() }} needed)</span>
            }
          </button>
        </div>
      }

      @if (managerView() === 'library') {
      <div class="cs-am-scope-tabs" role="tablist" aria-label="Asset scope">
        @for (tab of scopeTabs; track tab.id) {
          <button
            type="button"
            role="tab"
            [class.active]="scopeTab() === tab.id"
            [attr.aria-selected]="scopeTab() === tab.id"
            (click)="setScope(tab.id)"
          >
            {{ tab.label }}
          </button>
        }
      </div>

      <div class="cs-am-type-bar">
        <div class="cs-am-type-tabs" role="tablist" aria-label="Asset type">
          @for (tab of typeTabs(); track tab.id) {
            <button
              type="button"
              role="tab"
              [class.active]="typeFilter() === tab.id"
              [attr.aria-selected]="typeFilter() === tab.id"
              (click)="typeFilter.set(tab.id)"
            >
              {{ tab.label }}
              @if (tab.count != null) {
                <span class="cs-am-count">({{ tab.count }})</span>
              }
            </button>
          }
        </div>
        <app-asset-view-toggle />
      </div>

      <p class="meta cs-am-hint">{{ scopeHint() }}</p>

      @if (activeJobs().length) {
        <div class="cs-am-jobs" aria-live="polite">
          <div class="cs-am-jobs-head">
            <span class="material-symbols-outlined" aria-hidden="true">hourglass_top</span>
            <strong>{{ activeJobs().length }} job{{ activeJobs().length === 1 ? '' : 's' }} running</strong>
          </div>
          <ul>
            @for (job of activeJobs(); track job.id) {
              <li>
                <span class="truncate">{{ job.name }}</span>
                <span class="meta">{{ job.job_message || 'Processing…' }}</span>
              </li>
            }
          </ul>
        </div>
      }

      <div class="cs-am-scroll">
        @for (bucket of groupedAssets(); track bucket.name) {
          <div class="cs-am-group">
            <div class="cs-am-group-head">
              <h4>{{ bucket.name }}</h4>
              @if (
                bucket.name !== 'Ungrouped' &&
                scopeTab() !== 'resources' &&
                projectGroups().includes(bucket.name)
              ) {
                <button
                  type="button"
                  class="danger cs-am-group-del"
                  (click)="deleteGroup(bucket.name)"
                >
                  Delete group
                </button>
              }
            </div>
            <div
              class="cs-asset-grid"
              [class.cs-asset-grid--tiles]="view.layout() === 'grid'"
              [class.cs-asset-grid--list]="view.layout() === 'list'"
            >
              @for (asset of bucket.assets; track assetKey(asset)) {
                <app-media-thumb-tile
                  [name]="asset.name"
                  [thumbUrl]="thumbUrl(asset)"
                  [videoUrl]="isVideoAsset(asset.type) ? inspectUrl(asset) : null"
                  [audioUrl]="isAudioAsset(asset.type) ? inspectUrl(asset) : null"
                  [icon]="iconFor(asset)"
                  [typeLabel]="assetTypeLabel(asset.type)"
                  [durationS]="asset.duration_s ?? null"
                  [locked]="!!asset.locked"
                  [status]="asset.status || null"
                  [statusDetail]="asset.job_message || asset.error || null"
                  [layout]="view.layout()"
                  [inspectable]="true"
                  [renameable]="true"
                  (tileClick)="openDetail(asset)"
                  (inspectClick)="openDetail(asset)"
                  (renameClick)="openDetail(asset)"
                />
              }
            </div>
          </div>
        } @empty {
          <div class="cs-am-empty">
            <p class="cs-empty-inline">No assets in this view.</p>
            <div class="cs-am-empty-actions">
              @if (anyGenReady()) {
                <button type="button" (click)="openGenerateDefault()">
                  <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
                  Generate
                </button>
              }
              <button type="button" (click)="openRecordDialog()">
                <span class="material-symbols-outlined" aria-hidden="true">mic</span>
                Record
              </button>
              <button type="button" class="primary" (click)="openUploadDialog()">
                <span class="material-symbols-outlined" aria-hidden="true">upload</span>
                Upload
              </button>
            </div>
          </div>
        }
      </div>
      } @else {
        <p class="meta cs-am-hint">
          Scene visual is available only when Background visual is enabled on that scene in Script.
          Attach library assets to those plates here.
        </p>
        <div class="cs-am-scroll">
          @for (row of sceneRows(); track row.sceneId) {
            <article class="cs-am-scene" [class.is-skipped]="!row.enabled">
              <div class="cs-am-scene-head">
                <div class="min-w-0">
                  <h4>{{ row.name }}</h4>
                  <p class="meta">
                    {{ row.durationS.toFixed(1) }}s
                    · {{ row.needed }} asset{{ row.needed === 1 ? '' : 's' }}
                    @if (row.missing) {
                      · {{ row.missing }} missing
                    }
                    @if (!row.enabled) {
                      · skipped
                    }
                  </p>
                </div>
                @if (row.allowBackgroundVisual) {
                  <button
                    type="button"
                    class="primary"
                    (click)="openAttachVisual(row.index)"
                    [disabled]="attachBusy() || !row.enabled"
                    title="Attach an existing image or video as this scene’s visual"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">add_photo_alternate</span>
                    Attach visual
                  </button>
                }
              </div>
              <ul class="cs-am-scene-slots">
                @if (!row.slots.length) {
                  <li class="cs-am-scene-slot is-empty">
                    <div class="cs-am-scene-slot-main">
                      <strong>No scene assets yet</strong>
                      <span class="meta">
                        @if (!row.allowBackgroundVisual) {
                          Enable Background visual on this scene in Script to attach a plate.
                        } @else {
                          Attach a visual or add assets from Script.
                        }
                      </span>
                    </div>
                  </li>
                }
                @for (slot of row.slots; track slot.id) {
                  <li class="cs-am-scene-slot" [class.is-missing]="slot.missing">
                    <div class="cs-am-scene-slot-thumb">
                      @if (slotThumb(slot); as url) {
                        <img [src]="url" alt="" />
                      } @else {
                        <span class="material-symbols-outlined" aria-hidden="true">{{
                          slotIcon(slot)
                        }}</span>
                      }
                    </div>
                    <div class="cs-am-scene-slot-main">
                      <strong>{{ slot.label }}</strong>
                      <span class="meta">{{ slot.detail }}</span>
                    </div>
                    @if (slot.assetId && slotAsset(slot); as asset) {
                      <button type="button" class="cs-am-scene-slot-inspect" (click)="openDetail(asset)">
                        Inspect
                      </button>
                    }
                    @if (slot.attachable) {
                      <button
                        type="button"
                        (click)="openAttachSlot(row.index, slot)"
                        [disabled]="attachBusy() || !row.enabled"
                      >
                        {{ slot.missing ? 'Attach' : 'Change' }}
                      </button>
                    }
                  </li>
                }
              </ul>
            </article>
          } @empty {
            <p class="cs-empty-inline">
              No scenes yet. Add scenes on the Timeline or generate from Script.
            </p>
          }
        </div>
      }
    </div>

    <app-attach-visual-asset-dialog
      [isOpen]="showAttach()"
      [lockFilter]="attachLock()"
      [postId]="postId"
      [promptText]="attachPrompt()"
      [promptLabel]="attachPromptLabel()"
      [title]="attachTitle()"
      (close)="closeAttach()"
      (picked)="onAttachPicked($event)"
    />

    <app-modal-wrapper
      [isOpen]="showUpload()"
      [title]="uploadTitle()"
      [subtitle]="uploadSubtitle()"
      icon="upload"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="closeUploadDialog()"
    >
      <div
        class="cs-am-upload cs-am-upload--dialog"
        [class.is-drag]="dragOver()"
        (dragover)="onDragOver($event)"
        (dragleave)="onDragLeave($event)"
        (drop)="onDrop($event)"
      >
        <p class="meta cs-am-upload-drop-hint">Drag files here, or choose files below.</p>
        <div class="cs-form-stack cs-form-stack--tight">
          <label>
            <span>Type</span>
            <select [(ngModel)]="uploadAssetType" aria-label="Upload asset type">
              <option value="auto">Auto type</option>
              <option value="photo">Photo</option>
              <option value="illustration">Illustration</option>
              <option value="vector">Vector</option>
              <option value="video">Video</option>
              <option value="music">Music</option>
              <option value="sound">SFX</option>
              <option value="model">3D</option>
            </select>
          </label>
          @if (libraryTarget() !== 'resources') {
            <label>
              <span>Group</span>
              <select [(ngModel)]="uploadGroup" aria-label="Upload group">
                <option value="">Ungrouped</option>
                @for (g of projectGroups(); track g) {
                  <option [value]="g">{{ g }}</option>
                }
              </select>
            </label>
            <label class="cs-check">
              <input type="checkbox" [(ngModel)]="uploadApplyLogo" />
              Apply logo to photos
            </label>
          } @else {
            <label>
              <span>Group</span>
              <input
                [(ngModel)]="uploadGroup"
                list="amGlobalGroups"
                placeholder="Optional"
                aria-label="Upload group"
              />
              <datalist id="amGlobalGroups">
                @for (g of globalGroups(); track g) {
                  <option [value]="g"></option>
                }
              </datalist>
            </label>
          }
        </div>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="closeUploadDialog()">Cancel</button>
        <label class="cs-upload-btn primary">
          <span class="material-symbols-outlined" aria-hidden="true">upload</span>
          Choose files
          <input
            type="file"
            multiple
            hidden
            accept="image/*,video/*,audio/*,.svg,.eps,.ai,.pdf,.glb,.gltf,.obj,.fbx,.stl,.mp3,.wav,.ogg,.flac,.m4a"
            (change)="onUpload($event)"
          />
        </label>
      </ng-template>
    </app-modal-wrapper>

    <app-audio-recorder-dialog
      [isOpen]="showRecord()"
      [title]="recordTitle()"
      fileStem="mic-recording"
      (close)="closeRecordDialog()"
      (recorded)="onRecordedAudio($event)"
    />

    <app-asset-inspect
      [open]="!!detailAsset()"
      [title]="detailAsset()?.name || ''"
      [type]="detailAsset()?.type || ''"
      [filename]="detailAsset()?.original_filename || detailAsset()?.name || ''"
      [previewUrl]="detailAsset() ? inspectUrl(detailAsset()!) : null"
      [posterUrl]="detailAsset() ? thumbUrl(detailAsset()!) : null"
      [meta]="detailAsset() ? inspectMeta(detailAsset()!) : ''"
      [durationS]="detailAsset()?.duration_s ?? null"
      [canRename]="true"
      [canDownload]="!!detailAsset() && !detailAsset()!.locked"
      [busy]="api.busy()"
      (close)="closeDetail()"
      (rename)="renameFromInspect($event)"
      (download)="detailAsset() && download(detailAsset()!)"
    >
      @if (detailAsset(); as asset) {
        <div class="cs-am-actions">
          @if (!asset.is_global && isVideoAsset(asset.type)) {
            <button type="button" title="Generate thumbnail" (click)="makeThumb(asset)">
              <span class="material-symbols-outlined" aria-hidden="true">photo_camera</span>
            </button>
          }
          @if (canUpscale(asset)) {
            <button type="button" title="Upscale" (click)="openUpscale(asset)">
              <span class="material-symbols-outlined" aria-hidden="true">high_quality</span>
            </button>
          }
          @if (!asset.is_global && asset.post_id === postId) {
            <button type="button" title="Promote to project" (click)="promote(asset)">
              <span class="material-symbols-outlined" aria-hidden="true">share</span>
            </button>
          }
          <button type="button" class="danger" title="Delete" (click)="remove(asset)">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
      }
    </app-asset-inspect>

    <app-modal-wrapper
      [isOpen]="!!genMode()"
      [title]="genTitle()"
      [subtitle]="genSubtitle()"
      icon="auto_awesome"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="closeGenerate()"
    >
      <div class="cs-form-stack">
        @if (genMode() === 'upscale') {
          <p class="meta" style="margin: 0">Source: {{ genSourceName() }}</p>
          <label>
            <span>Scale</span>
            <select [(ngModel)]="genScale">
              @for (s of genScaleOptions(); track s) {
                <option [ngValue]="s">{{ s }}×</option>
              }
            </select>
          </label>
        } @else {
          <label>
            <span>Prompt</span>
            <textarea rows="4" [(ngModel)]="genPrompt" placeholder="Describe what to generate…"></textarea>
          </label>
          @if (genMode() === 'image_to_video') {
            <label>
              <span>Source image</span>
              <select [(ngModel)]="genImageAssetId">
                <option value="">Select an image…</option>
                @for (img of projectImageOptions(); track img.id) {
                  <option [value]="img.id">{{ img.name }}</option>
                }
              </select>
            </label>
          }
          <label>
            <span>Size</span>
            <select [(ngModel)]="genSizeKey">
              @for (p of genSizeOptions(); track sizeKey(p.width, p.height)) {
                <option [value]="sizeKey(p.width, p.height)">{{ p.label }}</option>
              }
            </select>
          </label>
        }
        <label>
          <span>Name (optional)</span>
          <input [(ngModel)]="genName" placeholder="Asset name" />
        </label>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="closeGenerate()">Cancel</button>
        <button type="button" class="primary" (click)="submitGenerate()" [disabled]="genBusy()">
          {{ genBusy() ? 'Queuing…' : 'Generate' }}
        </button>
      </ng-template>
    </app-modal-wrapper>
  `,
})
export class AssetWorkspaceComponent implements OnInit, OnChanges, OnDestroy {
  @Input({ required: true }) postId = '';
  @Input() postType: PostType | string = 'video';
  @Input() post: Post | null = null;
  @Output() postChange = new EventEmitter<Post>();

  readonly scopeTabs: { id: ScopeTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'resources', label: 'Resources' },
    { id: 'project', label: 'Project assets' },
    { id: 'post', label: 'Post assets' },
  ];

  readonly scopeTab = signal<ScopeTab>('all');
  readonly managerView = signal<ManagerView>('library');
  readonly typeFilter = signal<string>('all');
  readonly dragOver = signal(false);
  readonly showUpload = signal(false);
  readonly showRecord = signal(false);
  readonly detailKey = signal<string | null>(null);
  readonly postSig = signal<Post | null>(null);
  readonly scriptBlocks = signal<ScriptSceneBlock[]>([]);
  readonly showAttach = signal(false);
  readonly attachBusy = signal(false);
  readonly attachLock = signal<AttachAssetFilter | null>(null);
  readonly attachPrompt = signal('');
  readonly attachPromptLabel = signal('');
  readonly attachTitle = signal('');
  readonly attachSceneIndex = signal<number | null>(null);
  readonly attachSlotId = signal<string | null>(null);
  readonly caps = signal<{
    text_to_image?: boolean;
    text_to_video?: boolean;
    image_to_video?: boolean;
    upscale_image?: boolean;
    upscale_video?: boolean;
  } | null>(null);
  readonly genMenuOpen = signal(false);
  readonly genMode = signal<GenMode>(null);
  readonly genBusy = signal(false);
  readonly genSourceId = signal<string | null>(null);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly watchedJobs = new Map<string, string>(); // id -> last known status
  private pollInFlight = false;

  uploadAssetType = 'auto';
  uploadGroup = '';
  uploadApplyLogo = false;
  genPrompt = '';
  genName = '';
  genImageAssetId = '';
  genSizeKey = sizeKey(DEFAULT_VIDEO_SIZE.width, DEFAULT_VIDEO_SIZE.height);
  genScale = 2;
  sizeKey = sizeKey;

  readonly projectGroups = computed(() => this.api.currentProject()?.asset_groups || []);
  readonly globalGroups = computed(() => this.api.globalGroups());

  readonly scopedPool = computed((): PaletteAsset[] => {
    const postId = this.postId;
    const projectAssets = this.api.currentProject()?.assets || [];
    const globals = (this.api.globalAssets() || []).map((a) => ({ ...a, is_global: true }));
    const shared = projectAssets.filter((a) => !a.post_id);
    const postOwned = projectAssets.filter((a) => a.post_id === postId);
    switch (this.scopeTab()) {
      case 'resources':
        return globals;
      case 'project':
        return shared;
      case 'post':
        return postOwned;
      default:
        return [...globals, ...shared, ...postOwned];
    }
  });

  readonly typeTabs = computed(() => {
    const pool = this.scopedPool();
    const video = this.postType === 'video';
    return ASSET_TYPE_FILTERS.filter((t) => {
      if (t.id === 'all') return true;
      if (!video && (t.id === 'music' || t.id === 'sound')) return false;
      return true;
    }).map((t) => ({
      id: t.id,
      label: t.label,
      count:
        t.id === 'all'
          ? pool.length
          : pool.filter((a) => assetMatchesTypeFilter(a.type, t.id)).length,
    }));
  });

  readonly filteredAssets = computed(() => {
    const filter = this.typeFilter();
    return this.scopedPool().filter((a) => assetMatchesTypeFilter(a.type, filter));
  });

  readonly detailAsset = computed(() => {
    const key = this.detailKey();
    if (!key) return null;
    return this.scopedPool().find((a) => this.assetKey(a) === key) ?? null;
  });

  readonly groupedAssets = computed((): AssetGroupBucket[] => {
    const items = this.filteredAssets();
    const map = new Map<string, PaletteAsset[]>();
    for (const a of items) {
      const key = String(a.group || '').trim() || 'Ungrouped';
      const list = map.get(key) || [];
      list.push(a);
      map.set(key, list);
    }
    const names = [...map.keys()].sort((a, b) => {
      if (a === 'Ungrouped') return 1;
      if (b === 'Ungrouped') return -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    return names.map((name) => ({ name, assets: map.get(name)! }));
  });

  readonly activeJobs = computed(() => {
    const assets = this.api.currentProject()?.assets || [];
    return assets
      .filter((a) => String(a.status || '').toLowerCase() === 'processing')
      .map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status || 'processing',
        job_message: a.job_message || a.error || null,
      }));
  });

  readonly livePost = computed((): Post | null => {
    this.postSig();
    const id = this.postId;
    const fromProject = (this.api.projectPosts() as Post[]).find((p) => p.id === id);
    return fromProject || this.postSig() || null;
  });

  readonly sceneRows = computed((): SceneAssetRow[] => {
    const post = this.livePost();
    if (!post || post.type !== 'video') return [];
    const scriptBlocks = this.scriptBlocks();
    const scenes = post.scenes || [];
    return scenes.map((scene, index) => {
      const scriptIdx = findScriptBlockIndexForTimelineScene(scriptBlocks, scenes, scene.id);
      const scriptBlock = scriptIdx >= 0 ? scriptBlocks[scriptIdx] || null : scriptBlocks[index] || null;
      return this.buildSceneRow(scene, index, scriptBlock);
    });
  });

  readonly sceneMissingCount = computed(() =>
    this.sceneRows().reduce((n, row) => n + row.missing, 0),
  );

  constructor(
    public api: ContentSproutApiService,
    private snackbar: SnackbarService,
    private dialogs: DialogService,
    readonly view: AssetListViewService,
  ) {
    effect(() => {
      const jobs = this.activeJobs();
      if (jobs.length) this.startJobPolling();
      else this.stopJobPolling();
    });
  }

  assetTypeLabel = assetTypeLabel;
  isVideoAsset = isVideoAsset;
  isAudioAsset = isAudioAsset;

  ngOnInit(): void {
    void this.api.loadGlobalAssets();
    void this.loadCaps();
    this.postSig.set(this.post || null);
    void this.loadScriptNeeds();
    // Resume tracking for any jobs already in flight.
    for (const job of this.activeJobs()) {
      this.watchedJobs.set(job.id, job.status);
    }
    if (this.activeJobs().length) this.startJobPolling();
  }

  ngOnDestroy(): void {
    this.stopJobPolling();
  }

  private startJobPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollJobs(), 2500);
    void this.pollJobs();
  }

  private stopJobPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollJobs(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const before = new Map(
        (this.api.currentProject()?.assets || []).map((a) => [a.id, String(a.status || '')]),
      );
      for (const [id, status] of before) {
        if (status === 'processing') {
          this.watchedJobs.set(id, status);
        }
      }
      await this.api.refreshCurrentProject({ quiet: true });
      const after = this.api.currentProject()?.assets || [];
      for (const [id] of this.watchedJobs) {
        const asset = after.find((a) => a.id === id);
        const next = String(asset?.status || '');
        if (next === 'ready') {
          this.snackbar.show(`${asset?.name || 'Asset'} is ready`, 'success');
          this.watchedJobs.delete(id);
        } else if (next === 'failed') {
          this.snackbar.show(
            asset?.error || `${asset?.name || 'Asset'} failed`,
            'error',
          );
          this.watchedJobs.delete(id);
        } else if (!asset) {
          this.watchedJobs.delete(id);
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async loadCaps(): Promise<void> {
    const caps = await this.api.getAiCapabilities();
    this.caps.set(caps);
  }

  anyGenReady(): boolean {
    const c = this.caps();
    return !!(c?.text_to_image || c?.text_to_video || c?.image_to_video);
  }

  canUpscale(asset: PaletteAsset): boolean {
    if (asset.is_global) return false;
    const c = this.caps();
    if (isImageAsset(asset.type)) return !!c?.upscale_image;
    if (isVideoAsset(asset.type)) return !!c?.upscale_video;
    return false;
  }

  projectImageOptions(): PaletteAsset[] {
    return (this.api.currentProject()?.assets || []).filter((a) => isImageAsset(a.type));
  }

  /** Where new uploads/generates land, based on the active library tab. */
  libraryTarget(): 'resources' | 'project' | 'post' {
    if (this.managerView() === 'scenes') return 'post';
    if (this.scopeTab() === 'resources') return 'resources';
    if (this.scopeTab() === 'project') return 'project';
    return 'post';
  }

  private ownerPostId(): string | undefined {
    return this.libraryTarget() === 'post' ? this.postId || undefined : undefined;
  }

  openGenerateDefault(): void {
    const c = this.caps();
    if (c?.text_to_image) this.openGenerate('text_to_image');
    else if (c?.text_to_video) this.openGenerate('text_to_video');
    else if (c?.image_to_video) this.openGenerate('image_to_video');
  }

  openGenerate(mode: Exclude<GenMode, 'upscale' | null>): void {
    this.genMenuOpen.set(false);
    this.genMode.set(mode);
    this.genPrompt = '';
    this.genName = '';
    this.genImageAssetId = '';
    this.genSourceId.set(null);
    const preset = mode === 'text_to_image' ? DEFAULT_IMAGE_SIZE : DEFAULT_VIDEO_SIZE;
    this.genSizeKey = sizeKey(preset.width, preset.height);
  }

  openUpscale(asset: PaletteAsset): void {
    this.genMenuOpen.set(false);
    this.closeDetail();
    this.genMode.set('upscale');
    this.genSourceId.set(asset.id);
    this.genName = `${asset.name} upscaled`;
    this.genScale = isVideoAsset(asset.type) ? VIDEO_UPSCALE_SCALES[VIDEO_UPSCALE_SCALES.length - 1] : 2;
  }

  closeGenerate(): void {
    this.genMode.set(null);
    this.genBusy.set(false);
    this.genSourceId.set(null);
  }

  genTitle(): string {
    switch (this.genMode()) {
      case 'text_to_image':
        return 'Generate image';
      case 'text_to_video':
        return 'Generate video';
      case 'image_to_video':
        return 'Generate video from image';
      case 'upscale':
        return 'Upscale asset';
      default:
        return 'Generate';
    }
  }

  genSubtitle(): string {
    if (this.genMode() === 'upscale') {
      return 'Creates a new edited asset. Video scale is capped at 2×.';
    }
    const dest =
      this.libraryTarget() === 'project' || this.libraryTarget() === 'resources'
        ? 'Saves to project-shared assets.'
        : 'Saves as a private asset on this post.';
    return `${dest} Uses ComfyUI workflows from Settings. Only small size presets are allowed.`;
  }

  genSourceName(): string {
    const id = this.genSourceId();
    const asset = (this.api.currentProject()?.assets || []).find((a) => a.id === id);
    return asset?.name || id || '—';
  }

  genSizeOptions() {
    return this.genMode() === 'text_to_image' ? IMAGE_SIZE_PRESETS : VIDEO_SIZE_PRESETS;
  }

  genScaleOptions(): number[] {
    const id = this.genSourceId();
    const asset = (this.api.currentProject()?.assets || []).find((a) => a.id === id);
    if (asset && isVideoAsset(asset.type)) return [...VIDEO_UPSCALE_SCALES];
    return [...IMAGE_UPSCALE_SCALES];
  }

  async submitGenerate(): Promise<void> {
    const projectId = this.api.currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('No project loaded', 'error');
      return;
    }
    const mode = this.genMode();
    this.genBusy.set(true);
    try {
      if (mode === 'upscale') {
        const assetId = this.genSourceId();
        if (!assetId) return;
        const ok = await this.api.upscaleProjectAsset(projectId, assetId, {
          scale: Number(this.genScale),
          name: this.genName.trim() || undefined,
          post_id: this.ownerPostId(),
        });
        if (ok?.asset?.id) {
          this.watchedJobs.set(ok.asset.id, String(ok.asset.status || 'processing'));
          this.startJobPolling();
        }
        if (ok) this.closeGenerate();
        return;
      }

      const [wStr, hStr] = this.genSizeKey.split('x');
      const width = Number(wStr);
      const height = Number(hStr);
      const prompt = this.genPrompt.trim();
      if (!prompt) {
        this.snackbar.show('Enter a prompt', 'error');
        return;
      }
      const body = {
        prompt,
        width,
        height,
        name: this.genName.trim() || undefined,
        post_id: this.ownerPostId(),
      };
      let ok: { asset?: Asset; queued?: boolean } | null = null;
      if (mode === 'text_to_image') {
        ok = await this.api.generateProjectImage(projectId, body);
      } else if (mode === 'text_to_video') {
        ok = await this.api.generateProjectVideo(projectId, body);
      } else if (mode === 'image_to_video') {
        if (!this.genImageAssetId) {
          this.snackbar.show('Select a source image', 'error');
          return;
        }
        ok = await this.api.generateProjectVideoFromImage(projectId, {
          ...body,
          image_asset_id: this.genImageAssetId,
        });
      }
      if (ok?.asset?.id) {
        this.watchedJobs.set(ok.asset.id, String(ok.asset.status || 'processing'));
        this.startJobPolling();
        this.closeGenerate();
      } else if (ok) {
        this.closeGenerate();
      }
    } finally {
      this.genBusy.set(false);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['post'] || changes['postId']) {
      this.postSig.set(this.post || null);
      if (this.postType !== 'video' && this.managerView() === 'scenes') {
        this.managerView.set('library');
      }
      void this.loadScriptNeeds();
    }
  }

  isVideo(): boolean {
    return this.postType === 'video' || this.livePost()?.type === 'video';
  }

  setManagerView(view: ManagerView): void {
    this.managerView.set(view);
    if (view === 'scenes') void this.loadScriptNeeds();
  }

  private async loadScriptNeeds(): Promise<void> {
    const post = this.livePost();
    const scriptId = String(post?.active_script_id || '').trim();
    if (!scriptId || !this.postId) {
      this.scriptBlocks.set([]);
      return;
    }
    const data = await this.api.getScript(this.postId, scriptId);
    this.scriptBlocks.set(deriveScriptSceneBlocks(data?.script?.script || ''));
  }

  private buildSceneRow(
    scene: Scene,
    index: number,
    scriptBlock: ScriptSceneBlock | null,
  ): SceneAssetRow {
    const slots: SceneAssetSlot[] = [];
    const usedIds = new Set<string>();
    const layers = (scene.layers || []).filter((l) => isLayerEnabled(l));
    const visuals = layers.filter((l) => l.type === 'image' || l.type === 'video');
    visuals.sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0));
    const primaryLayer = visuals[0] || null;
    const bgId = String(scene.background_asset_id || '').trim() || null;
    const primaryId = String(primaryLayer?.asset_id || bgId || '').trim() || null;
    const allowBackgroundVisual =
      sceneAllowsBackgroundVisual(scriptBlock?.body) || !!scene.allow_background_visual;
    if (allowBackgroundVisual) {
      if (primaryId) usedIds.add(primaryId);
      const primaryAsset = primaryId ? this.lookupAsset(primaryId) : null;
      slots.push({
        id: `visual:${scene.id}`,
        role: 'visual',
        label: 'Scene visual',
        detail: primaryAsset
          ? primaryAsset.name
          : primaryId
            ? 'Linked asset missing from library'
            : 'No image or video attached',
        assetId: primaryId,
        missing: !primaryAsset,
        attachable: true,
        attachLock: 'visual',
      });
    }

    const cues = scriptBlock ? extractSceneVisualBlocks(scriptBlock.body) : [];
    for (const cue of cues) {
      const cueRef = String(cue.assetRef || '').trim() || null;
      if (cueRef && usedIds.has(cueRef)) continue;
      if (cueRef) usedIds.add(cueRef);
      const cueAsset = cueRef ? this.lookupAsset(cueRef) : null;
      const desc = stripVisualAssetRef(cue.description || cue.detail || '').trim() || cue.kind;
      const lock: AttachAssetFilter | null =
        cue.attachKind === 'video'
          ? 'video'
          : cue.attachKind === 'music'
            ? 'music'
            : cue.attachKind === 'sound'
              ? 'sound'
              : cue.attachKind === 'image'
                ? 'image'
                : 'visual';
      slots.push({
        id: `cue:${scene.id}:${cue.full}`,
        role: 'cue',
        label: cue.kind === 'ADD ASSET' ? 'Add asset' : 'Visual cue',
        detail: desc + (cueAsset ? ` · ${cueAsset.name}` : cueRef ? ' · missing from library' : ' · not linked'),
        assetId: cueRef,
        missing: !cueAsset,
        attachable: true,
        attachLock: lock,
      });
    }

    for (const layer of layers) {
      if (allowBackgroundVisual && layer === primaryLayer) continue;
      if (layer.type === 'ref') {
        const refId = String(layer.ref_post_id || '').trim();
        const refPost = refId
          ? (this.api.projectPosts() as Post[]).find((p) => p.id === refId)
          : null;
        slots.push({
          id: `ref:${scene.id}:${layer.id}`,
          role: 'reusable',
          label: 'Reusable clip',
          detail: refPost?.name || layer.title || 'Reusable post',
          assetId: null,
          missing: !refPost,
          attachable: false,
          attachLock: null,
        });
        continue;
      }
      const aid = String(layer.asset_id || '').trim() || null;
      if (!aid || usedIds.has(aid)) continue;
      usedIds.add(aid);
      const asset = this.lookupAsset(aid);
      const audio = layer.type === 'audio' || layer.type === 'tts' || (!!asset && isAudioAsset(asset.type));
      slots.push({
        id: `layer:${scene.id}:${layer.id}`,
        role: audio ? 'audio' : 'layer',
        label: audio
          ? layer.type === 'tts'
            ? 'Voice / TTS'
            : 'Audio'
          : layer.type === 'video'
            ? 'Video'
            : 'Image',
        detail: asset?.name || layer.title || (audio ? 'Audio layer' : 'Layer'),
        assetId: aid,
        missing: !asset,
        attachable: false,
        attachLock: null,
      });
    }

    return {
      sceneId: scene.id || `scene-${index}`,
      index,
      name: scene.name || `Scene ${index + 1}`,
      durationS: Math.max(0.5, Number(scene.duration_s) || 5),
      enabled: isSceneEnabled(scene),
      allowBackgroundVisual,
      needed: slots.length,
      missing: slots.filter((s) => s.missing).length,
      slots,
    };
  }

  lookupAsset(rawId: string | null | undefined): PaletteAsset | null {
    const s = String(rawId || '').trim();
    if (!s) return null;
    const global = s.startsWith('global:');
    const id = global ? s.slice(7) : s;
    if (global) {
      const g = this.api.globalAssets().find((a) => a.id === id);
      return g ? { ...g, is_global: true } : null;
    }
    const local = (this.api.currentProject()?.assets || []).find((a) => a.id === id);
    if (local) return local;
    const fallback = this.api.globalAssets().find((a) => a.id === id);
    return fallback ? { ...fallback, is_global: true } : null;
  }

  slotAsset(slot: SceneAssetSlot): PaletteAsset | null {
    return this.lookupAsset(slot.assetId);
  }

  slotThumb(slot: SceneAssetSlot): string | null {
    const asset = this.slotAsset(slot);
    return asset ? this.thumbUrl(asset) : null;
  }

  slotIcon(slot: SceneAssetSlot): string {
    if (slot.role === 'reusable') return 'library_books';
    if (slot.role === 'audio') return 'music_note';
    if (slot.role === 'visual' || slot.role === 'cue') return slot.missing ? 'image' : 'photo';
    const asset = this.slotAsset(slot);
    return asset ? assetTypeIcon(asset.type) : 'image';
  }

  openAttachVisual(sceneIndex: number): void {
    const row = this.sceneRows()[sceneIndex];
    if (!row?.allowBackgroundVisual) return;
    this.attachSceneIndex.set(sceneIndex);
    this.attachSlotId.set(row ? `visual:${row.sceneId}` : 'visual');
    this.attachLock.set('visual');
    this.attachPrompt.set(row?.name || `Scene ${sceneIndex + 1}`);
    this.attachPromptLabel.set('Scene visual');
    this.attachTitle.set('Attach scene visual');
    this.showAttach.set(true);
    void this.api.loadGlobalAssets();
  }

  openAttachSlot(sceneIndex: number, slot: SceneAssetSlot): void {
    this.attachSceneIndex.set(sceneIndex);
    this.attachSlotId.set(slot.id);
    this.attachLock.set(slot.attachLock);
    this.attachPrompt.set(slot.detail || slot.label);
    this.attachPromptLabel.set(slot.label);
    this.attachTitle.set(slot.role === 'visual' ? 'Attach scene visual' : 'Attach asset');
    this.showAttach.set(true);
    void this.api.loadGlobalAssets();
  }

  closeAttach(): void {
    if (this.attachBusy()) return;
    this.showAttach.set(false);
    this.attachSceneIndex.set(null);
    this.attachSlotId.set(null);
    this.attachPrompt.set('');
    this.attachPromptLabel.set('');
    this.attachTitle.set('');
    this.attachLock.set(null);
  }

  async onAttachPicked(asset: AttachableAsset): Promise<void> {
    const sceneIndex = this.attachSceneIndex();
    const slotId = this.attachSlotId();
    const post = this.livePost();
    if (sceneIndex == null || !post) {
      this.closeAttach();
      return;
    }
    const assetRef = asset.is_global ? `global:${asset.id}` : asset.id;
    const duration = asset.duration_s ?? null;
    this.attachBusy.set(true);
    try {
      const slot = this.sceneRows()[sceneIndex]?.slots.find((s) => s.id === slotId) || null;
      const isVisualSlot = !slot || slot.role === 'visual' || slot.attachLock === 'visual';
      let next: Post | null = null;
      if (isVisualSlot && (isImageAsset(asset.type) || isVideoAsset(asset.type))) {
        next = attachScenePrimaryVisual(
          post,
          sceneIndex,
          assetRef,
          isVideoAsset(asset.type) ? 'video' : 'image',
          { title: asset.name, duration_s: duration },
        );
      } else {
        const kind: 'image' | 'video' | 'audio' = isVideoAsset(asset.type)
          ? 'video'
          : isAudioAsset(asset.type)
            ? 'audio'
            : 'image';
        next = attachAssetLayerToScene(post, sceneIndex, assetRef, kind, {
          title: asset.name,
          duration_s: duration,
          replaceSameRef: true,
        });
      }
      if (!next) {
        this.snackbar.show('Could not attach that asset to the scene', 'error');
        return;
      }
      const saved = await this.api.updatePost(next, undefined, { quiet: true });
      if (saved) {
        this.postSig.set(saved);
        this.postChange.emit(saved);
      }
      await this.syncScriptAfterAttach(sceneIndex, asset, slot, duration);
      this.snackbar.show(`Attached “${asset.name}”`, 'success');
      this.showAttach.set(false);
      this.attachSceneIndex.set(null);
      this.attachSlotId.set(null);
    } finally {
      this.attachBusy.set(false);
    }
  }

  private async syncScriptAfterAttach(
    sceneIndex: number,
    asset: AttachableAsset,
    slot: SceneAssetSlot | null,
    durationS: number | null,
  ): Promise<void> {
    const scriptId = String(this.livePost()?.active_script_id || '').trim();
    if (!scriptId) return;
    const data = await this.api.getScript(this.postId, scriptId);
    const script = data?.script?.script || '';
    if (!script.trim()) return;
    const blocks = deriveScriptSceneBlocks(script);
    const block = blocks[sceneIndex];
    if (!block) return;
    const mediaType = visualMediaTypeForLibraryAsset(asset);
    const assetRef = asset.is_global ? `global:${asset.id}` : asset.id;
    const cues = extractSceneVisualBlocks(block.body);
    let nextBody = block.body;
    const cueFull = slot?.id.startsWith('cue:') ? slot.id.slice(slot.id.indexOf(':', 4) + 1) : '';
    const target =
      (cueFull ? cues.find((c) => c.full === cueFull) : null) ||
      cues.find((c) => !c.assetRef) ||
      cues[0] ||
      null;
    if (target) {
      const rewritten = rewriteVisualCueWithAsset(
        target.full,
        mediaType,
        stripVisualAssetRef(target.description || asset.name || 'Asset'),
        assetRef,
        durationS ?? target.duration_s,
      );
      if (rewritten !== target.full) nextBody = nextBody.replace(target.full, rewritten);
    } else {
      nextBody = appendCueToSceneBody(
        block.body,
        buildAddAssetCueForAsset(mediaType, asset.name || 'Asset', assetRef, durationS),
      );
    }
    if (nextBody === block.body) return;
    blocks[sceneIndex] = { ...block, body: nextBody };
    const next = stitchScriptFromSceneBlocks(blocks);
    await this.api.updateScript(
      this.postId,
      scriptId,
      { script: next, source: 'edited' },
      undefined,
      { quiet: true },
    );
    this.scriptBlocks.set(deriveScriptSceneBlocks(next));
  }

  setScope(tab: ScopeTab): void {
    this.scopeTab.set(tab);
    this.typeFilter.set('all');
  }

  scopeHint(): string {
    switch (this.scopeTab()) {
      case 'resources':
        return 'App-wide Resources — Upload / Record add to the global library.';
      case 'project':
        return 'Project-shared assets — Upload / Generate / Record land here.';
      case 'post':
        return 'Private to this post — Upload / Generate / Record, then promote a card to share with the project.';
      default:
        return 'Global + project + this post — Upload / Generate default to this post (switch tabs to target Resources or project).';
    }
  }

  openUploadDialog(): void {
    this.showUpload.set(true);
  }

  closeUploadDialog(): void {
    this.showUpload.set(false);
    this.dragOver.set(false);
  }

  openRecordDialog(): void {
    this.showRecord.set(true);
  }

  closeRecordDialog(): void {
    this.showRecord.set(false);
  }

  async onRecordedAudio(file: File): Promise<void> {
    this.closeRecordDialog();
    const prevType = this.uploadAssetType;
    this.uploadAssetType = 'sound';
    try {
      await this.uploadFiles([file]);
    } finally {
      this.uploadAssetType = prevType;
    }
  }

  uploadTitle(): string {
    switch (this.libraryTarget()) {
      case 'resources':
        return 'Upload to Resources';
      case 'project':
        return 'Upload to project assets';
      default:
        return 'Upload to this post';
    }
  }

  uploadSubtitle(): string {
    switch (this.libraryTarget()) {
      case 'resources':
        return 'Files are available across all projects.';
      case 'project':
        return 'Files are shared across posts in this project.';
      default:
        return 'Files stay private to this post.';
    }
  }

  recordTitle(): string {
    switch (this.libraryTarget()) {
      case 'resources':
        return 'Record to Resources';
      case 'project':
        return 'Record to project assets';
      default:
        return 'Record to this post';
    }
  }

  assetKey(asset: PaletteAsset): string {
    return asset.is_global ? `g:${asset.id}` : asset.id;
  }

  scopeBadge(asset: PaletteAsset): string {
    if (asset.is_global) return 'Resources';
    if (asset.post_id) return 'Post';
    return 'Project';
  }

  isImageAsset = isImageAsset;

  thumbUrl(asset: PaletteAsset): string | null {
    return this.api.assetThumbUrl(asset, !!asset.is_global);
  }

  playbackUrl(asset: PaletteAsset): string | null {
    return this.api.assetPlaybackUrl(asset, !!asset.is_global);
  }

  inspectUrl(asset: PaletteAsset): string | null {
    return this.api.assetOriginalUrl(asset, !!asset.is_global);
  }

  inspectMeta(asset: PaletteAsset): string {
    const bits = [assetTypeLabel(asset.type), this.scopeBadge(asset)];
    if (asset.status && asset.status !== 'ready') bits.push(String(asset.status));
    if (asset.job_message) bits.push(asset.job_message);
    if (asset.error) bits.push(asset.error);
    if (asset.locked) bits.push('locked');
    return bits.join(' · ');
  }

  iconFor(asset: PaletteAsset): string {
    return assetTypeIcon(asset.type);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files?.length) {
      void this.uploadFiles(files).finally(() => this.closeUploadDialog());
    }
  }

  onUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files?.length) return;
    void this.uploadFiles(files).finally(() => {
      input.value = '';
      this.closeUploadDialog();
    });
  }

  private async uploadFiles(files: FileList | File[]): Promise<void> {
    const target = this.libraryTarget();
    if (target === 'resources') {
      await this.api.uploadGlobalAssets(files, {
        group: this.uploadGroup.trim() || undefined,
        asset_type: this.uploadAssetType,
      });
      return;
    }
    await this.api.uploadProjectAssets(files, {
      post_id: target === 'post' ? this.postId : undefined,
      group: this.uploadGroup.trim() || undefined,
      apply_logo: this.uploadApplyLogo,
      asset_type: this.uploadAssetType,
    });
  }

  openDetail(asset: PaletteAsset): void {
    this.detailKey.set(this.assetKey(asset));
  }

  closeDetail(): void {
    this.detailKey.set(null);
  }

  download(asset: PaletteAsset): void {
    if (asset.locked) {
      this.snackbar.show('Locked stock assets cannot be downloaded', 'warning');
      return;
    }
    const url = asset.is_global
      ? this.api.globalDownloadUrl(asset.id)
      : this.api.assetDownloadUrl(asset.id);
    if (!url) return;
    window.open(url, '_blank', 'noopener');
  }

  async renameFromInspect(name: string): Promise<void> {
    const asset = this.detailAsset();
    const next = name.trim();
    if (!asset || !next || next === asset.name) return;
    const ok = asset.is_global
      ? await this.api.renameGlobalAsset(asset.id, next)
      : await this.api.renameProjectAsset(asset.id, next);
    if (!ok) return;
    // Keep the open preview pointed at the same asset after the library refresh.
    this.detailKey.set(this.assetKey({ ...asset, name: next }));
  }

  async promote(asset: PaletteAsset): Promise<void> {
    if (asset.is_global || asset.post_id !== this.postId) return;
    const ok = await this.dialogs.confirm({
      title: 'Share asset',
      message: 'Move this asset to the project-shared library?',
      confirmText: 'Move',
      type: 'info',
    });
    if (!ok) return;
    await this.api.patchProjectAsset(asset.id, { post_id: null });
  }

  async makeThumb(asset: PaletteAsset): Promise<void> {
    if (asset.is_global) return;
    await this.api.generateAssetThumb(asset.id);
  }

  async remove(asset: PaletteAsset): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Delete asset',
      message: `Delete “${asset.name}”?`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    if (this.detailKey() === this.assetKey(asset)) this.detailKey.set(null);
    if (asset.is_global) await this.api.deleteGlobalAsset(asset.id);
    else await this.api.deleteProjectAsset(asset.id);
  }

  async deleteGroup(name: string): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Delete group',
      message: `Delete group “${name}”? Assets stay and become Ungrouped.`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    await this.api.deleteAssetGroup(name);
  }
}
