import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ConfirmDialogComponent, ModalWrapperComponent } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { MediaThumbTileComponent } from '../../shared/media-thumb-tile';
import { AssetInspectComponent } from '../../shared/asset-inspect';
import { AudioRecorderDialogComponent } from '../../shared/audio-recorder-dialog';
import {
  VideoRecorderDialogComponent,
  type VideoCaptureSource,
} from '../../shared/video-recorder-dialog';
import {
  AssetListViewService,
  AssetViewToggleComponent,
} from '../../shared/asset-list-view';
import {
  ASSET_TYPE_FILTERS,
  assetMatchesSearchQuery,
  assetMatchesTypeFilter,
  assetTypeIcon,
  assetTypeLabel,
  assetTabShowsCreate,
  assetTabShowsMicRecord,
  assetTabShowsVideoRecord,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
  type Asset,
} from '../../models/content-sprout.models';
import { AssetTagsEditorComponent } from '../../shared/asset-tags-editor';
import { photoMagicCommands, createPageCommands, assetsCreateReturnUrl } from '../../shared/photo-magic-nav';

import { StockPublishPanelComponent } from './stock-publish-panel';
import { FreeStockDialogComponent } from '../../shared/free-stock-dialog';

type PageTab = 'library' | 'publish';
type TypeTab = (typeof ASSET_TYPE_FILTERS)[number]['id'];
type SortKey =
  | 'newest'
  | 'oldest'
  | 'name'
  | 'name-desc'
  | 'size'
  | 'duration'
  | 'duration-asc'
  | 'dims';
type OrientationFilter = 'all' | 'landscape' | 'portrait' | 'square';
type DurationFilter = 'all' | 'short' | 'medium' | 'long';

interface TypeViewState {
  search: string;
  group: string;
  sort: SortKey;
  orientation: OrientationFilter;
  duration: DurationFilter;
}

interface TypeAssetGroup {
  id: string;
  label: string;
  assets: Asset[];
}

function defaultView(): TypeViewState {
  return { search: '', group: '', sort: 'newest', orientation: 'all', duration: 'all' };
}

function typeFamily(tab: TypeTab): 'image' | 'video' | 'audio' | 'model' | 'all' {
  if (tab === 'all') return 'all';
  if (tab === 'video') return 'video';
  if (tab === 'music' || tab === 'sound') return 'audio';
  if (tab === 'model') return 'model';
  return 'image';
}

function assetOrientation(asset: Asset): OrientationFilter | null {
  const w = Number(asset.width);
  const h = Number(asset.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (w === h) return 'square';
  return w > h ? 'landscape' : 'portrait';
}

function durationMatches(seconds: number | null | undefined, filter: DurationFilter): boolean {
  if (filter === 'all') return true;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return false;
  if (filter === 'short') return s < 30;
  if (filter === 'medium') return s >= 30 && s <= 120;
  return s > 120;
}

function compareAssets(a: Asset, b: Asset, sort: SortKey): number {
  const name = (x: Asset) => String(x.name || '').toLowerCase();
  const when = (x: Asset) => String(x.updated_at || x.created_at || '');
  const size = (x: Asset) => Number(x.file_size_bytes) || 0;
  const dur = (x: Asset) => Number(x.duration_s) || 0;
  const dims = (x: Asset) => (Number(x.width) || 0) * (Number(x.height) || 0);
  switch (sort) {
    case 'name':
      return name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
    case 'name-desc':
      return name(b).localeCompare(name(a), undefined, { sensitivity: 'base' });
    case 'oldest':
      return when(a).localeCompare(when(b));
    case 'size':
      return size(b) - size(a);
    case 'duration':
      return dur(b) - dur(a);
    case 'duration-asc':
      return dur(a) - dur(b);
    case 'dims':
      return dims(b) - dims(a);
    default:
      return when(b).localeCompare(when(a));
  }
}

const ACCEPT =
  'image/*,video/*,audio/*,.svg,.eps,.ai,.pdf,.glb,.gltf,.obj,.fbx,.stl,.mp3,.wav,.ogg,.flac,.m4a';

@Component({
  selector: 'app-global-resources',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ModalWrapperComponent,
    ConfirmDialogComponent,
    MediaThumbTileComponent,
    AssetInspectComponent,
    AssetTagsEditorComponent,
    AssetViewToggleComponent,
    AudioRecorderDialogComponent,
    VideoRecorderDialogComponent,
    StockPublishPanelComponent,
    FreeStockDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="page cs-global-page">
      <div class="page-intro-bar">
        <p
          class="page-intro"
          style="margin: 0"
          title="Shared library for every project — SFX, logos, reusable clips, and stills."
        >
          Shared library for every project — SFX, logos, reusable clips, and stills. Publish photos
          and videos to stock contributor sites from here.
        </p>
        <div class="cs-tabs" role="tablist" aria-label="Shared Library sections">
          <button
            type="button"
            role="tab"
            [class.active]="pageTab() === 'library'"
            [attr.aria-selected]="pageTab() === 'library'"
            (click)="setPageTab('library')"
          >
            Library
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="pageTab() === 'publish'"
            [attr.aria-selected]="pageTab() === 'publish'"
            (click)="setPageTab('publish')"
          >
            Publish to stock
            @if (selectedIds().size) {
              <span class="cs-am-count">({{ selectedIds().size }})</span>
            }
          </button>
        </div>
      </div>

      @if (pageTab() === 'publish') {
        <app-stock-publish-panel
          [selectedAssetIds]="selectedIdList()"
          [selectionHint]="selectionHint()"
          (requestLibrary)="setPageTab('library')"
          (clearSelection)="clearSelection()"
        />
      } @else {
      <div class="cs-global-type-bar">
        <div class="cs-tabs" role="tablist" aria-label="Asset type">
          @for (tab of typeTabs(); track tab.id) {
            <button
              type="button"
              role="tab"
              [class.active]="typeTab() === tab.id"
              [attr.aria-selected]="typeTab() === tab.id"
              (click)="typeTab.set(tab.id)"
            >
              {{ tab.label }}
              <span class="cs-am-count">({{ tab.count }})</span>
            </button>
          }
        </div>
        <div class="page-actions-inline cs-global-toolbar-actions">
          @if (selectedIds().size) {
            <button
              type="button"
              class="primary"
              title="Prepare stock publish package"
              (click)="preparePublish()"
            >
              Publish ({{ selectedIds().size }})
            </button>
            <button type="button" (click)="clearSelection()">Clear</button>
          }
          @if (assetTabShowsCreate(typeTab())) {
            <button
              type="button"
              title="Create assets with AI Gen or Photo magic"
              aria-label="Create"
              (click)="openCreate()"
            >
              <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
            </button>
          }
          <button
            type="button"
            title="Refresh"
            aria-label="Refresh"
            (click)="refresh()"
            [disabled]="api.busy()"
          >
            <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
          </button>
          @if (assetTabShowsMicRecord(typeTab())) {
            <button
              type="button"
              title="Record from microphone (incl. Bluetooth)"
              aria-label="Record audio"
              (click)="openRecord()"
            >
              <span class="material-symbols-outlined" aria-hidden="true">mic</span>
            </button>
          }
          @if (assetTabShowsVideoRecord(typeTab())) {
            <button
              type="button"
              title="Record from camera (built-in or USB)"
              aria-label="Record camera"
              (click)="openVideoRecord('camera')"
            >
              <span class="material-symbols-outlined" aria-hidden="true">videocam</span>
            </button>
            <button
              type="button"
              title="Record the screen"
              aria-label="Record screen"
              (click)="openVideoRecord('screen')"
            >
              <span class="material-symbols-outlined" aria-hidden="true">screen_share</span>
            </button>
          }
          <button type="button" title="Upload" aria-label="Upload" (click)="openUpload()">
            <span class="material-symbols-outlined" aria-hidden="true">upload</span>
          </button>
          <button type="button" title="Free stock" aria-label="Free stock" (click)="openStock()">
            <span class="material-symbols-outlined" aria-hidden="true">travel_explore</span>
          </button>
        </div>
      </div>

      <div class="cs-global-toolbar">
        <label>
          <span>Search</span>
          <input
            [ngModel]="viewState().search"
            (ngModelChange)="patchView({ search: $event })"
            placeholder="Name, group, or tag…"
            aria-label="Search this type"
          />
        </label>
        <label class="cs-global-narrow">
          <span>Group</span>
          <select
            [ngModel]="viewState().group"
            (ngModelChange)="patchView({ group: $event })"
            aria-label="Filter by group"
          >
            <option value="">All groups</option>
            @for (g of groupsForType(); track g) {
              <option [value]="g">{{ g }}</option>
            }
          </select>
        </label>
        @if (showOrientation()) {
          <label class="cs-global-narrow">
            <span>Orientation</span>
            <select
              [ngModel]="viewState().orientation"
              (ngModelChange)="patchView({ orientation: $event })"
              aria-label="Filter by orientation"
            >
              <option value="all">Any</option>
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
              <option value="square">Square</option>
            </select>
          </label>
        }
        @if (showDuration()) {
          <label class="cs-global-narrow">
            <span>Duration</span>
            <select
              [ngModel]="viewState().duration"
              (ngModelChange)="patchView({ duration: $event })"
              aria-label="Filter by duration"
            >
              <option value="all">Any length</option>
              <option value="short">Under 30s</option>
              <option value="medium">30s – 2m</option>
              <option value="long">Over 2m</option>
            </select>
          </label>
        }
        <label class="cs-global-sort">
          <span>Sort</span>
          <select
            [ngModel]="viewState().sort"
            (ngModelChange)="patchView({ sort: $event })"
            aria-label="Sort this type"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
            <option value="size">Largest file</option>
            @if (showOrientation()) {
              <option value="dims">Largest frame</option>
            }
            @if (showDuration()) {
              <option value="duration">Longest</option>
              <option value="duration-asc">Shortest</option>
            }
          </select>
        </label>
        <p class="meta cs-global-count">
          {{ filtered().length }} shown
          @if (typedAssets().length !== filtered().length) {
            of {{ typedAssets().length }}
          }
        </p>
        <app-asset-view-toggle />
      </div>

      @if (api.error()) {
        <p class="status-msg error">{{ api.error() }}</p>
      }

      <div
        class="cs-global-library-body"
        [class.cs-global-library-body--grouped]="typeTab() === 'all'"
      >
        @if (typeTab() === 'all') {
          @for (group of filteredGroups(); track group.id) {
            <section class="cs-am-group cs-global-type-group">
              <div class="cs-am-group-head">
                <h4>
                  {{ group.label }}
                  <span class="cs-am-count">({{ group.assets.length }})</span>
                </h4>
              </div>
              <div
                class="cs-asset-grid cs-global-tiles"
                [class.cs-asset-grid--tiles]="view.layout() === 'grid'"
                [class.cs-asset-grid--list]="view.layout() === 'list'"
              >
                @for (asset of group.assets; track asset.id) {
                  <app-media-thumb-tile
                    [name]="asset.name"
                    [thumbUrl]="thumbUrl(asset)"
                    [videoUrl]="isVideoAsset(asset.type) ? inspectUrl(asset) : null"
                    [audioUrl]="isAudioAsset(asset.type) ? inspectUrl(asset) : null"
                    [icon]="iconFor(asset)"
                    [typeLabel]="assetTypeLabel(asset.type)"
                    [durationS]="asset.duration_s ?? null"
                    [locked]="!!asset.locked"
                    [layout]="view.layout()"
                    [selectable]="canPublishAsset(asset)"
                    [selected]="selectedIds().has(asset.id)"
                    [inspectable]="true"
                    [renameable]="true"
                    (tileClick)="openDetail(asset)"
                    (inspectClick)="openDetail(asset)"
                    (renameClick)="openDetail(asset)"
                    (selectToggle)="toggleSelect(asset)"
                  />
                }
              </div>
            </section>
          } @empty {
            <p class="cs-empty-inline">
              {{ api.busy() ? 'Loading…' : emptyHint() }}
            </p>
          }
        } @else {
          <div
            class="cs-asset-grid cs-global-tiles"
            [class.cs-asset-grid--tiles]="view.layout() === 'grid'"
            [class.cs-asset-grid--list]="view.layout() === 'list'"
          >
            @for (asset of filtered(); track asset.id) {
              <app-media-thumb-tile
                [name]="asset.name"
                [thumbUrl]="thumbUrl(asset)"
                [videoUrl]="isVideoAsset(asset.type) ? inspectUrl(asset) : null"
                [audioUrl]="isAudioAsset(asset.type) ? inspectUrl(asset) : null"
                [icon]="iconFor(asset)"
                [typeLabel]="assetTypeLabel(asset.type)"
                [durationS]="asset.duration_s ?? null"
                [locked]="!!asset.locked"
                [layout]="view.layout()"
                [selectable]="canPublishAsset(asset)"
                [selected]="selectedIds().has(asset.id)"
                [inspectable]="true"
                [renameable]="true"
                (tileClick)="openDetail(asset)"
                (inspectClick)="openDetail(asset)"
                (renameClick)="openDetail(asset)"
                (selectToggle)="toggleSelect(asset)"
              />
            } @empty {
              <p class="cs-empty-inline">
                {{ api.busy() ? 'Loading…' : emptyHint() }}
              </p>
            }
          </div>
        }
      </div>
      }
    </div>

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
        <dl class="cs-ga-info">
          <dt>Original file</dt>
          <dd class="mono" [title]="asset.original_filename || ''">
            {{ asset.original_filename || '—' }}
          </dd>
          <dt>Size</dt>
          <dd>{{ formatBytes(asset.file_size_bytes) }}</dd>
          <dt>Dimensions</dt>
          <dd>{{ formatDims(asset) }}</dd>
          <dt>Duration</dt>
          <dd>{{ formatDuration(asset.duration_s) }}</dd>
        </dl>

        <div class="cs-ga-edit surface-inset">
          <h4 class="cs-section-title" style="margin-bottom: 0.65rem">Edit</h4>
          <div class="cs-form-stack">
            <label>
              <span>Group</span>
              <input [(ngModel)]="editGroup" list="gaDetailGroups" placeholder="Optional" />
              <datalist id="gaDetailGroups">
                @for (g of api.globalGroups(); track g) {
                  <option [value]="g"></option>
                }
              </datalist>
            </label>
            <label>
              <span>Description</span>
              <textarea rows="3" [(ngModel)]="editDescription"></textarea>
            </label>
            <app-asset-tags-editor
              [value]="editTags"
              [disabled]="api.busy()"
              (tagsChange)="editTags = $event"
            />
            <div class="page-actions-inline">
              @if (isImageAsset(asset.type)) {
                <button type="button" (click)="openPhotoMagic(asset)" [disabled]="api.busy()">
                  <span class="material-symbols-outlined" aria-hidden="true">auto_fix_high</span>
                  Photo magic
                </button>
              }
              <button
                type="button"
                class="primary"
                (click)="saveEdits(asset)"
                [disabled]="api.busy()"
              >
                Save changes
              </button>
              <button
                type="button"
                class="danger"
                title="Delete"
                (click)="pendingDelete.set(asset)"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      }
    </app-asset-inspect>

    <app-modal-wrapper
      [isOpen]="showUpload()"
      title="Upload global assets"
      subtitle="Files stay in the shared library — not copied into projects until used."
      icon="cloud_upload"
      size="medium"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="closeUpload()"
    >
      <div class="cs-form-stack">
        <div
          class="cs-dropzone"
          [class.dragover]="dragOver()"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave($event)"
          (drop)="onDrop($event)"
        >
          <span class="material-symbols-outlined" aria-hidden="true">upload_file</span>
          <p>Drop files here or choose from disk</p>
          <label class="cs-upload-btn">
            Choose files
            <input type="file" multiple hidden [accept]="accept" (change)="onFilesPicked($event)" />
          </label>
        </div>

        @if (pendingFiles().length) {
          <ul class="cs-file-list">
            @for (f of pendingFiles(); track f.name + f.size + f.lastModified) {
              <li>
                <span class="truncate" [title]="f.name">{{ f.name }}</span>
                <span class="meta">{{ formatBytes(f.size) }}</span>
              </li>
            }
          </ul>
        }

        <div class="cs-form-row" style="margin: 0">
          <label>
            <span>Type</span>
            <select [(ngModel)]="uploadType">
              <option value="auto">Auto-detect</option>
              <option value="photo">Photo</option>
              <option value="illustration">Illustration</option>
              <option value="vector">Vector</option>
              <option value="video">Video</option>
              <option value="music">Music</option>
              <option value="sound">SFX</option>
              <option value="model">3D</option>
            </select>
          </label>
          <label>
            <span>Group</span>
            <input [(ngModel)]="uploadGroup" list="gaUploadGroups" placeholder="e.g. SFX" />
            <datalist id="gaUploadGroups">
              @for (g of api.globalGroups(); track g) {
                <option [value]="g"></option>
              }
            </datalist>
          </label>
        </div>
      </div>

      <ng-template #footerActions>
        <button type="button" (click)="closeUpload()">Cancel</button>
        <button
          type="button"
          class="primary"
          (click)="submitUpload()"
          [disabled]="!pendingFiles().length || api.busy()"
        >
          {{ api.busy() ? 'Uploading…' : 'Upload ' + pendingFiles().length + ' file(s)' }}
        </button>
      </ng-template>
    </app-modal-wrapper>

    <app-confirm-dialog
      [isOpen]="!!pendingDelete()"
      title="Delete global asset"
      [message]="
        'Delete “' + (pendingDelete()?.name || 'this asset') + '”? This cannot be undone.'
      "
      confirmText="Delete"
      type="danger"
      (confirm)="confirmDelete()"
      (cancel)="pendingDelete.set(null)"
    />

    <app-audio-recorder-dialog
      [isOpen]="showRecord()"
      title="Record to Resources"
      fileStem="global-mic-recording"
      (close)="closeRecord()"
      (recorded)="onRecordedAudio($event)"
    />

    <app-video-recorder-dialog
      [isOpen]="showVideoRecord()"
      [title]="videoCapture() === 'screen' ? 'Record screen to Resources' : 'Record camera to Resources'"
      [capture]="videoCapture()"
      [fileStem]="videoCapture() === 'screen' ? 'global-screen-recording' : 'global-camera-recording'"
      (close)="closeVideoRecord()"
      (recorded)="onRecordedVideo($event)"
    />

    <app-free-stock-dialog
      [isOpen]="showStock()"
      target="global"
      (close)="showStock.set(false)"
      (imported)="onStockImported()"
    />
  `,
})
export class GlobalResourcesPage implements OnInit {
  readonly accept = ACCEPT;
  readonly pageTab = signal<PageTab>('library');
  readonly selectedIds = signal<Set<string>>(new Set());
  readonly showUpload = signal(false);
  readonly showRecord = signal(false);
  readonly showVideoRecord = signal(false);
  readonly showStock = signal(false);
  readonly videoCapture = signal<VideoCaptureSource>('camera');
  readonly dragOver = signal(false);
  readonly pendingFiles = signal<File[]>([]);
  readonly detailId = signal<string | null>(null);
  readonly pendingDelete = signal<Asset | null>(null);
  readonly typeTab = signal<TypeTab>('all');
  private readonly views = signal<Partial<Record<TypeTab, TypeViewState>>>({});

  uploadType = 'auto';
  uploadGroup = '';
  editGroup = '';
  editDescription = '';
  editTags: string[] = [];

  readonly typeTabs = computed(() => {
    const assets = this.api.globalAssets();
    return ASSET_TYPE_FILTERS.map((t) => ({
      id: t.id as TypeTab,
      label: t.label,
      count: assets.filter((a) => assetMatchesTypeFilter(a.type, t.id)).length,
    }));
  });

  readonly viewState = computed(() => this.views()[this.typeTab()] ?? defaultView());

  readonly typedAssets = computed(() => {
    const tab = this.typeTab();
    return this.api.globalAssets().filter((a) => assetMatchesTypeFilter(a.type, tab));
  });

  readonly groupsForType = computed(() => {
    const set = new Set<string>();
    for (const a of this.typedAssets()) {
      const g = String(a.group || '').trim();
      if (g) set.add(g);
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  });

  readonly filtered = computed(() => {
    const view = this.viewState();
    const q = view.search.trim().toLowerCase();
    const group = view.group.trim();
    const family = typeFamily(this.typeTab());
    const list = this.typedAssets().filter((a) => {
      if (group && String(a.group || '').trim() !== group) return false;
      const isVisual = isImageAsset(a.type) || isVideoAsset(a.type);
      const isTimed = isVideoAsset(a.type) || isAudioAsset(a.type);
      if (family === 'all') {
        if (view.orientation !== 'all' && isVisual && assetOrientation(a) !== view.orientation) {
          return false;
        }
        if (view.duration !== 'all' && isTimed && !durationMatches(a.duration_s, view.duration)) {
          return false;
        }
      } else {
        if (family === 'image' || family === 'video') {
          if (view.orientation !== 'all' && assetOrientation(a) !== view.orientation) return false;
        }
        if (family === 'video' || family === 'audio') {
          if (!durationMatches(a.duration_s, view.duration)) return false;
        }
      }
      if (!q) return true;
      return assetMatchesSearchQuery(a, view.search);
    });
    list.sort((a, b) => compareAssets(a, b, view.sort));
    return list;
  });

  /** All-tab sections ordered like the type filters (only non-empty groups). */
  readonly filteredGroups = computed((): TypeAssetGroup[] => {
    const list = this.filtered();
    if (this.typeTab() !== 'all') {
      const tab = this.typeTabs().find((t) => t.id === this.typeTab());
      return list.length
        ? [{ id: this.typeTab(), label: tab?.label || 'Assets', assets: list }]
        : [];
    }
    const groups: TypeAssetGroup[] = [];
    for (const t of ASSET_TYPE_FILTERS) {
      if (t.id === 'all') continue;
      const assets = list.filter((a) => assetMatchesTypeFilter(a.type, t.id));
      if (assets.length) groups.push({ id: t.id, label: t.label, assets });
    }
    return groups;
  });

  readonly detailAsset = computed(() => {
    const id = this.detailId();
    if (!id) return null;
    return this.api.globalAssets().find((a) => a.id === id) ?? null;
  });

  readonly selectedIdList = computed(() => [...this.selectedIds()]);

  readonly selectionHint = computed(() => {
    const ids = this.selectedIds();
    if (!ids.size) return '';
    const assets = this.api.globalAssets().filter((a) => ids.has(a.id));
    const photos = assets.filter((a) => this.isImageAsset(a.type)).length;
    const videos = assets.filter((a) => this.isVideoAsset(a.type)).length;
    const bits: string[] = [];
    if (photos) bits.push(`${photos} photo${photos === 1 ? '' : 's'}`);
    if (videos) bits.push(`${videos} video${videos === 1 ? '' : 's'}`);
    if (!bits.length) return `${ids.size} selected`;
    return bits.join(', ') + ' selected';
  });

  constructor(
    public api: ContentSproutApiService,
    readonly view: AssetListViewService,
    private router: Router,
  ) {}

  assetTypeLabel = assetTypeLabel;
  assetTabShowsCreate = assetTabShowsCreate;
  assetTabShowsMicRecord = assetTabShowsMicRecord;
  assetTabShowsVideoRecord = assetTabShowsVideoRecord;
  isVideoAsset = isVideoAsset;
  isAudioAsset = isAudioAsset;
  isImageAsset = isImageAsset;

  ngOnInit(): void {
    void this.refresh();
  }

  setPageTab(tab: PageTab): void {
    this.pageTab.set(tab);
  }

  canPublishAsset(asset: Asset): boolean {
    return this.isImageAsset(asset.type) || this.isVideoAsset(asset.type);
  }

  toggleSelect(asset: Asset): void {
    if (!this.canPublishAsset(asset)) return;
    const next = new Set(this.selectedIds());
    if (next.has(asset.id)) next.delete(asset.id);
    else next.add(asset.id);
    this.selectedIds.set(next);
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  preparePublish(): void {
    if (!this.selectedIds().size) return;
    this.setPageTab('publish');
  }

  showOrientation(): boolean {
    const family = typeFamily(this.typeTab());
    return family === 'all' || family === 'image' || family === 'video';
  }

  showDuration(): boolean {
    const family = typeFamily(this.typeTab());
    return family === 'all' || family === 'video' || family === 'audio';
  }

  patchView(patch: Partial<TypeViewState>): void {
    const id = this.typeTab();
    this.views.update((cur) => ({
      ...cur,
      [id]: { ...defaultView(), ...cur[id], ...patch },
    }));
  }

  emptyHint(): string {
    if (this.typeTab() === 'all') {
      if (this.typedAssets().length && !this.filtered().length) {
        return 'No assets match these filters.';
      }
      return 'No assets in Shared Library yet — upload shared media to get started.';
    }
    const label = this.typeTabs().find((t) => t.id === this.typeTab())?.label.toLowerCase() || 'assets';
    if (this.typedAssets().length && !this.filtered().length) {
      return `No ${label} match these filters.`;
    }
    return `No ${label} in Shared Library yet — upload shared media to get started.`;
  }

  async refresh(): Promise<void> {
    await this.api.loadGlobalAssets();
    const cur = this.detailAsset();
    if (cur) this.syncEditFields(cur);
  }

  openDetail(asset: Asset): void {
    this.detailId.set(asset.id);
    this.syncEditFields(asset);
  }

  closeDetail(): void {
    this.detailId.set(null);
  }

  private syncEditFields(asset: Asset): void {
    this.editGroup = asset.group || '';
    this.editDescription = asset.description || '';
    this.editTags = [...(asset.tags || [])];
  }

  openStock(): void {
    this.showStock.set(true);
  }

  onStockImported(): void {
    void this.refresh();
  }

  openUpload(): void {
    this.pendingFiles.set([]);
    this.uploadType = this.typeTab() === 'all' ? 'auto' : this.typeTab();
    this.uploadGroup = this.viewState().group;
    this.showUpload.set(true);
  }

  closeUpload(): void {
    this.showUpload.set(false);
    this.pendingFiles.set([]);
    this.dragOver.set(false);
  }

  openRecord(): void {
    this.showRecord.set(true);
  }

  openPhotoMagic(asset: Asset): void {
    const nav = photoMagicCommands({
      scope: 'global',
      assetId: asset.id,
      assetScope: 'global',
      returnUrl: assetsCreateReturnUrl('global'),
    });
    void this.router.navigate([nav.path], { queryParams: nav.queryParams });
  }

  openCreate(): void {
    const nav = createPageCommands({
      tab: 'ai-gen',
      returnUrl: assetsCreateReturnUrl('global'),
      scope: 'global',
    });
    void this.router.navigate([nav.path], { queryParams: nav.queryParams });
  }

  closeRecord(): void {
    this.showRecord.set(false);
  }

  openVideoRecord(mode: VideoCaptureSource): void {
    this.videoCapture.set(mode);
    this.showVideoRecord.set(true);
  }

  closeVideoRecord(): void {
    this.showVideoRecord.set(false);
  }

  async onRecordedAudio(file: File): Promise<void> {
    this.closeRecord();
    const count = await this.api.uploadGlobalAssets([file], {
      group: this.uploadGroup.trim() || this.viewState().group,
      asset_type: 'sound',
    });
    if (count) await this.refresh();
  }

  async onRecordedVideo(file: File): Promise<void> {
    this.closeVideoRecord();
    this.typeTab.set('video');
    const count = await this.api.uploadGlobalAssets([file], {
      group: this.uploadGroup.trim() || this.viewState().group,
      asset_type: 'video',
    });
    if (count) await this.refresh();
  }

  onFilesPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.addFiles(input.files);
    input.value = '';
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
    this.addFiles(event.dataTransfer?.files || null);
  }

  private addFiles(list: FileList | null): void {
    if (!list?.length) return;
    this.pendingFiles.update((cur) => [...cur, ...Array.from(list)]);
  }

  async submitUpload(): Promise<void> {
    const files = this.pendingFiles();
    if (!files.length) return;
    const count = await this.api.uploadGlobalAssets(files, {
      group: this.uploadGroup.trim(),
      asset_type: this.uploadType,
    });
    if (count) {
      this.closeUpload();
      await this.refresh();
    }
  }

  inspectUrl(asset: Asset): string | null {
    return this.api.assetOriginalUrl(asset, true);
  }

  inspectMeta(asset: Asset): string {
    const bits = [assetTypeLabel(asset.type), asset.group || 'Ungrouped', asset.status || 'ready'];
    return bits.join(' · ');
  }

  download(asset: Asset): void {
    window.open(this.api.globalDownloadUrl(asset.id), '_blank', 'noopener');
  }

  async renameFromInspect(name: string): Promise<void> {
    const asset = this.detailAsset();
    if (!asset || !name.trim() || name.trim() === asset.name) return;
    const ok = await this.api.renameGlobalAsset(asset.id, name.trim());
    if (ok) await this.refresh();
  }

  async saveEdits(asset: Asset): Promise<void> {
    const ok = await this.api.patchGlobalAsset(asset.id, {
      group: this.editGroup.trim(),
      description: this.editDescription,
      tags: this.editTags,
    });
    if (ok) await this.refresh();
  }

  async confirmDelete(): Promise<void> {
    const asset = this.pendingDelete();
    if (!asset) return;
    const ok = await this.api.deleteGlobalAsset(asset.id);
    this.pendingDelete.set(null);
    if (ok) {
      if (this.detailId() === asset.id) this.detailId.set(null);
      await this.refresh();
    }
  }

  thumbUrl(asset: Asset): string | null {
    return this.api.assetThumbUrl(asset, true);
  }

  iconFor(asset: Asset): string {
    return assetTypeIcon(asset.type);
  }

  formatBytes(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  }

  formatDims(asset: Asset): string {
    if (asset.width && asset.height) return `${asset.width} × ${asset.height}`;
    return '—';
  }

  formatDuration(s: number | null | undefined): string {
    if (s == null || !Number.isFinite(s) || s <= 0) return '—';
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return m ? `${m}m ${sec}s` : `${sec}s`;
  }

  formatWhen(raw: string | undefined): string {
    if (!raw) return '—';
    try {
      return new Date(raw).toLocaleString();
    } catch {
      return raw;
    }
  }
}
