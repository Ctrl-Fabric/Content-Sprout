import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ModalWrapperComponent, storageGet, storageSet, DialogService, SnackbarService } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { ProjectBrowserService } from '../../services/project-browser.service';
import { MediaThumbTileComponent } from '../../shared/media-thumb-tile';
import { AssetInspectComponent } from '../../shared/asset-inspect';
import { AssetPreviewPaneComponent } from '../../shared/asset-preview-pane';
import { AudioRecorderDialogComponent } from '../../shared/audio-recorder-dialog';
import { SocialAccountsPanelComponent } from './social-accounts-panel';
import {
  exportCanvasSize,
  formatDisplayLabel,
  formatPixelSize,
  normalizeTargetFormat,
  postRuntimeSeconds,
} from '../../shared/post-format';
import {
  AssetListViewService,
  AssetViewToggleComponent,
} from '../../shared/asset-list-view';
import {
  PROJECT_LOGO_SLOTS,
  assetMatchesTypeFilter,
  assetTypeIcon,
  assetTypeLabel,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
  type Asset,
  type Post,
  type PostType,
  type ProjectLogoKind,
  type StockCapabilities,
  type StockSearchItem,
} from '../../models/content-sprout.models';

type HubTab = 'posts' | 'assets' | 'accounts';
type LibraryTab =
  | 'all'
  | 'photo'
  | 'illustration'
  | 'vector'
  | 'video'
  | 'music'
  | 'sound'
  | 'model'
  | 'logos';
type PostSort = 'created' | 'modified';

const HUB_TAB_KEY = 'content-sprout.hub-tab';
const POST_SORT_KEY = 'content-sprout.post-sort';

@Component({
  selector: 'app-media-studio',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ModalWrapperComponent,
    MediaThumbTileComponent,
    AssetInspectComponent,
    AssetPreviewPaneComponent,
    AssetViewToggleComponent,
    AudioRecorderDialogComponent,
    SocialAccountsPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="page cs-ms-page">
      <p class="page-intro">
        Create posts and manage project-shared assets, logos, social accounts, and free stock.
        Switch projects from the header.
      </p>

      @if (api.error()) {
        <p class="status-msg error">{{ api.error() }}</p>
      }

      @if (!api.currentProject()) {
        <section class="surface-card cs-empty cs-ms-workspace">
          <span class="material-symbols-outlined" style="font-size: 2rem" aria-hidden="true"
            >movie_filter</span
          >
          <h2>Select a project</h2>
          <p>Use the project selector in the header to open a project. Posts and assets appear here.</p>
          <div class="page-actions-inline" style="justify-content: center; margin-top: 1rem">
            <button type="button" class="primary" (click)="openBrowser()">Browse projects</button>
          </div>
        </section>
      } @else {
        <section class="surface-card cs-main cs-ms-workspace">
            <div class="cs-bar cs-ms-fixed cs-ms-chrome">
              <div class="cs-ms-chrome-title">
                <h2>{{ api.currentProject()!.name }}</h2>
                <button type="button" class="danger cs-ms-del-project" (click)="deleteCurrentProject()">
                  Delete project
                </button>
              </div>
              <div class="cs-tabs cs-ms-hub-tabs" role="tablist" aria-label="Project details">
                <button
                  type="button"
                  role="tab"
                  [class.active]="hubTab() === 'posts'"
                  [attr.aria-selected]="hubTab() === 'posts'"
                  (click)="setHubTab('posts')"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">dashboard</span>
                  Posts
                </button>
                <button
                  type="button"
                  role="tab"
                  [class.active]="hubTab() === 'assets'"
                  [attr.aria-selected]="hubTab() === 'assets'"
                  (click)="setHubTab('assets')"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">perm_media</span>
                  Assets
                </button>
                <button
                  type="button"
                  role="tab"
                  [class.active]="hubTab() === 'accounts'"
                  [attr.aria-selected]="hubTab() === 'accounts'"
                  (click)="setHubTab('accounts')"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">share</span>
                  Accounts
                </button>
              </div>
            </div>

            @if (hubTab() === 'posts') {
              <div class="cs-ms-body">
                <div class="cs-ms-posts-head cs-ms-fixed">
                  <div class="cs-ms-posts-head-copy">
                    <h3>Posts</h3>
                    <p class="cs-ms-workflow">
                      Open a post — image: Ideation → Assets → Canvas → Export → Upload → Monitor ·
                      video: Ideation → Script (optional) → Assets → Timeline → Export → Upload →
                      Monitor
                    </p>
                  </div>
                  <div class="page-actions-inline cs-ms-posts-tools">
                    <label class="cs-ms-sort">
                      <span>Sort</span>
                      <select [(ngModel)]="postSort" (ngModelChange)="onPostSortChange()" aria-label="Sort posts">
                        <option value="created">Created date</option>
                        <option value="modified">Last modified</option>
                      </select>
                    </label>
                    <label class="cs-ms-post-search cs-ms-post-search--inline">
                      <span class="material-symbols-outlined" aria-hidden="true">search</span>
                      <input
                        type="search"
                        [ngModel]="postQuery()"
                        (ngModelChange)="postQuery.set($event)"
                        placeholder="Search posts…"
                        autocomplete="off"
                        aria-label="Search posts"
                      />
                    </label>
                    <button type="button" class="primary" (click)="showCreatePost.set(true)">
                      + New post
                    </button>
                  </div>
                </div>

                @if (showCreatePost()) {
                  <div class="cs-form-stack surface-inset cs-ms-fixed">
                    <label>
                      <span>Name</span>
                      <input [(ngModel)]="newPostName" placeholder="Post name" />
                    </label>
                    <div class="cs-form-row" style="margin: 0">
                      <label>
                        <span>Type</span>
                        <select [(ngModel)]="newPostType">
                          <option value="image">Image</option>
                          <option value="video">Video</option>
                        </select>
                      </label>
                      <label>
                        <span>Format</span>
                        <select [(ngModel)]="newPostFormat">
                          <option value="square">Square</option>
                          <option value="portrait">Portrait</option>
                          <option value="landscape">Landscape</option>
                          <option value="story">Story</option>
                        </select>
                      </label>
                    </div>
                    @if (newPostType === 'video') {
                      <label class="cs-check">
                        <input type="checkbox" [(ngModel)]="newPostReusable" />
                        Reusable clip
                      </label>
                    }
                    <div class="page-actions-inline">
                      <button
                        type="button"
                        class="primary"
                        (click)="createPost()"
                        [disabled]="api.busy()"
                      >
                        Create post
                      </button>
                      <button type="button" (click)="showCreatePost.set(false)">Cancel</button>
                    </div>
                  </div>
                }

                <div class="cs-ms-scroll">
                  @if (!posts().length) {
                    <p class="cs-empty-inline">No posts yet. Create an image or video post to start editing.</p>
                  } @else if (!postsGrouped().length) {
                    <p class="cs-empty-inline">No posts match “{{ postQuery() }}”.</p>
                  } @else {
                    @for (section of postsGrouped(); track section.key) {
                      <section class="cs-ms-post-section">
                        <div class="cs-ms-post-section-head">
                          <h2 class="cs-ms-post-section-title">{{ section.label }}</h2>
                          <span class="cs-ms-format-rule" aria-hidden="true"></span>
                          <span class="meta tabular">{{ section.count }}</span>
                        </div>
                        <div class="cs-ms-post-grid">
                          @for (post of section.posts; track post.id; let i = $index) {
                            <article
                              class="cs-ms-post-card"
                              [style.animation-delay]="cardDelay(i)"
                            >
                              <a
                                class="cs-ms-post-card-main"
                                [routerLink]="['/media-studio/posts', post.id]"
                                [title]="post.name"
                              >
                                <span
                                  class="cs-ms-card-icon"
                                  [class.cs-ms-card-icon--video]="post.type === 'video'"
                                  [class.cs-ms-card-icon--image]="post.type !== 'video'"
                                  aria-hidden="true"
                                >
                                  <span class="material-symbols-outlined">{{
                                    post.type === 'video' ? 'movie' : 'image'
                                  }}</span>
                                  <span
                                    class="cs-ms-orient-badge"
                                    [attr.title]="postOrientationLabel(post)"
                                  >
                                    <span class="material-symbols-outlined">{{
                                      postOrientationIcon(post)
                                    }}</span>
                                  </span>
                                </span>
                                <span class="cs-ms-post-copy">
                                  <strong class="cs-ms-post-name">{{ post.name }}</strong>
                                  <span class="cs-ms-post-detail">{{ postCardDetail(post) }}</span>
                                  <span class="cs-ms-post-stats">
                                    <span class="cs-ms-card-stat">
                                      <span class="material-symbols-outlined" aria-hidden="true">{{
                                        post.type === 'video' ? 'movie' : 'image'
                                      }}</span>
                                      {{ postCardKind(post) }}
                                    </span>
                                    <span
                                      class="cs-ms-card-stat cs-ms-dim-badge"
                                      [attr.title]="postOrientationLabel(post)"
                                    >
                                      <span class="material-symbols-outlined" aria-hidden="true">{{
                                        postOrientationIcon(post)
                                      }}</span>
                                      <span class="cs-ms-dim-badge-value tabular">{{
                                        postCardSize(post)
                                      }}</span>
                                    </span>
                                    @if (post.type === 'video') {
                                      <span class="cs-ms-card-stat">
                                        <span class="material-symbols-outlined" aria-hidden="true"
                                          >schedule</span
                                        >
                                        {{ postCardDuration(post) }}
                                      </span>
                                    }
                                    <span class="cs-ms-card-stat">
                                      <span class="material-symbols-outlined" aria-hidden="true"
                                        >calendar_month</span
                                      >
                                      {{ postCardWhen(post) }}
                                    </span>
                                  </span>
                                </span>
                              </a>
                              <button
                                type="button"
                                class="cs-ms-post-del"
                                title="Delete post"
                                [attr.aria-label]="'Delete ' + post.name"
                                (click)="deletePost(post.id)"
                              >
                                Delete
                              </button>
                            </article>
                          }
                        </div>
                      </section>
                    }
                  }
                </div>
              </div>
            } @else if (hubTab() === 'accounts') {
              <div class="cs-ms-body" style="padding: 1rem 1.25rem 2rem">
                <app-social-accounts-panel />
              </div>
            } @else {
              <div class="cs-ms-body">
                <div class="cs-bar cs-ms-fixed" style="flex-wrap: wrap">
                  <div class="cs-tabs cs-ms-lib-tabs" role="tablist" aria-label="Asset types">
                    @for (tab of libraryTabs(); track tab.id) {
                      <button
                        type="button"
                        role="tab"
                        [class.active]="libraryTab() === tab.id"
                        (click)="libraryTab.set(tab.id)"
                      >
                        {{ tab.label }}
                        <span class="cs-am-count">({{ tab.count }})</span>
                      </button>
                    }
                  </div>
                  <div class="page-actions-inline">
                    @if (libraryTab() !== 'logos') {
                      <app-asset-view-toggle />
                      <select [(ngModel)]="groupFilter" aria-label="Filter by group">
                        <option value="">All groups</option>
                        @for (g of assetGroups(); track g) {
                          <option [value]="g">{{ g }}</option>
                        }
                      </select>
                      <button type="button" (click)="showGroups.set(true)">Manage groups</button>
                      <button type="button" (click)="openStock()">Free stock</button>
                      <button type="button" (click)="downloadAll()" [disabled]="!assets().length">
                        Download all
                      </button>
                      <button
                        type="button"
                        title="Record from microphone (incl. Bluetooth)"
                        (click)="showRecord.set(true)"
                      >
                        Record
                      </button>
                      <button type="button" class="primary" (click)="showUpload.set(true)">
                        Upload
                      </button>
                    }
                  </div>
                </div>

                @if (showUpload() && libraryTab() !== 'logos') {
                  <div class="cs-form-stack surface-inset cs-ms-fixed">
                    <div class="cs-form-row" style="margin: 0">
                      <label>
                        <span>Type</span>
                        <select [(ngModel)]="uploadAssetType">
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
                        <input
                          [(ngModel)]="uploadGroup"
                          list="msUploadGroups"
                          placeholder="Optional"
                        />
                        <datalist id="msUploadGroups">
                          @for (g of assetGroups(); track g) {
                            <option [value]="g"></option>
                          }
                        </datalist>
                      </label>
                    </div>
                    <label class="cs-check">
                      <input type="checkbox" [(ngModel)]="uploadApplyLogo" />
                      Apply project logo (photos)
                    </label>
                    <div class="page-actions-inline">
                      <label class="cs-upload-btn primary">
                        Choose files
                        <input
                          type="file"
                          multiple
                          hidden
                          accept="image/*,video/*,audio/*,.svg,.eps,.ai,.pdf,.glb,.gltf,.obj,.fbx,.stl,.mp3,.wav,.ogg,.flac,.m4a"
                          (change)="onUploadAssets($event)"
                        />
                      </label>
                      <button type="button" (click)="showUpload.set(false)">Cancel</button>
                    </div>
                  </div>
                }

                <div class="cs-ms-scroll">
                  @if (libraryTab() === 'logos') {
                    <div class="cs-ms-logo-grid">
                      @for (slot of logoSlots; track slot.kind) {
                        <article class="cs-ms-logo-card surface-inset">
                          <h4>{{ slot.label }}</h4>
                          <div class="cs-ms-logo-preview">
                            @if (logoUrl(slot.kind); as url) {
                              <img [src]="url" alt="" />
                            } @else {
                              <span class="material-symbols-outlined" aria-hidden="true"
                                >hide_image</span
                              >
                            }
                          </div>
                          <div class="page-actions-inline">
                            <label class="cs-upload-btn">
                              Upload
                              <input
                                type="file"
                                hidden
                                accept="image/*,.svg,.png,.jpg,.jpeg,.webp"
                                (change)="onLogoUpload(slot.kind, $event)"
                              />
                            </label>
                            <button
                              type="button"
                              class="danger"
                              [disabled]="!logoUrl(slot.kind)"
                              (click)="clearLogo(slot.kind)"
                            >
                              Clear
                            </button>
                          </div>
                        </article>
                      }
                    </div>
                  } @else {
                    <div
                      class="cs-asset-grid"
                      [class.cs-asset-grid--tiles]="view.layout() === 'grid'"
                      [class.cs-asset-grid--list]="view.layout() === 'list'"
                    >
                      @for (asset of filteredAssets(); track asset.id) {
                        <app-media-thumb-tile
                          [name]="asset.name"
                          [thumbUrl]="thumbUrl(asset)"
                          [videoUrl]="isVideoAsset(asset.type) ? inspectUrl(asset) : null"
                          [audioUrl]="isAudioAsset(asset.type) ? playbackUrl(asset) : null"
                          [icon]="iconFor(asset)"
                          [typeLabel]="assetTypeLabel(asset.type)"
                          [durationS]="asset.duration_s ?? null"
                          [locked]="!!asset.locked"
                          [layout]="view.layout()"
                          [inspectable]="true"
                          [renameable]="true"
                          (tileClick)="openDetail(asset)"
                          (inspectClick)="openDetail(asset)"
                          (renameClick)="openDetail(asset)"
                        />
                      } @empty {
                        <p class="cs-empty-inline">No matching project assets.</p>
                      }
                    </div>
                  }
                </div>
              </div>
            }
        </section>
      }
    </div>

    <app-modal-wrapper
      [isOpen]="showGroups()"
      title="Manage asset groups"
      subtitle="Groups organize project-shared assets. Deleting a group clears membership — files stay."
      icon="folder"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="showGroups.set(false)"
    >
      <div class="cs-form-stack">
        <label>
          <span>New group</span>
          <div class="page-actions-inline" style="width: 100%">
            <input style="flex: 1" [(ngModel)]="newGroupName" placeholder="e.g. Branding" />
            <button type="button" class="primary" (click)="addGroup()">Add</button>
          </div>
        </label>
        <ul class="cs-entity-list">
          @for (g of assetGroups(); track g) {
            <li>
              <div class="cs-entity-main"><strong>{{ g }}</strong></div>
              <button type="button" class="danger" (click)="removeGroup(g)">Delete</button>
            </li>
          } @empty {
            <li class="cs-empty-inline">No groups yet.</li>
          }
        </ul>
      </div>
      <ng-template #footerActions>
        <button type="button" class="primary" (click)="showGroups.set(false)">Done</button>
      </ng-template>
    </app-modal-wrapper>

    <app-modal-wrapper
      [isOpen]="showStock()"
      title="Free stock"
      subtitle="Search openly licensed media and add locked copies into this project."
      icon="travel_explore"
      size="large"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="closeStock()"
    >
      <div class="cs-form-row" style="margin: 0 0 0.75rem">
        <label style="flex: 1">
          <span>Search</span>
          <input
            [(ngModel)]="stockQuery"
            (keyup.enter)="runStockSearch(1)"
            placeholder="e.g. forest night"
          />
        </label>
        <label>
          <span>Type</span>
          <select [(ngModel)]="stockType">
            <option value="all">All</option>
            <option value="photo">Photos</option>
            <option value="illustration">Illustrations</option>
            <option value="vector">Vectors</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
          </select>
        </label>
        <div class="page-actions-inline" style="align-self: end">
          <button type="button" class="primary" (click)="runStockSearch(1)" [disabled]="api.busy()">
            Search
          </button>
        </div>
      </div>
      @if (stockCaps()) {
        <p class="meta" style="margin: 0 0 0.75rem">
          Quota:
          {{ stockCaps()!.downloads_used_today ?? 0 }} used
          @if (stockCaps()!.downloads_remaining_today != null) {
            · {{ stockCaps()!.downloads_remaining_today }} remaining today
          }
        </p>
      }
      @if (stockNote()) {
        <p class="meta" style="margin: 0 0 0.75rem">{{ stockNote() }}</p>
      }
      @if (stockDetail(); as item) {
        <button type="button" class="cs-stock-back" (click)="stockDetail.set(null)">
          ← Results
        </button>
        <div class="cs-asset-detail">
          <div class="cs-pm-preview">
            @if (item.preview_url || item.thumb_url; as url) {
              <app-asset-preview-pane
                [type]="item.kind || item.type || ''"
                [filename]="item.title || ''"
                [title]="item.title || 'Stock media'"
                [previewUrl]="url"
                [posterUrl]="item.thumb_url || null"
                [autoplay]="false"
              />
            } @else {
              <p class="cs-empty-inline">No preview available.</p>
            }
          </div>
          <div class="cs-asset-detail-meta">
            <p class="meta" style="margin: 0">
              {{ item.source || 'stock' }} · {{ item.kind || item.type || 'media' }}
            </p>
            @if (item.creator || item.license) {
              <p class="meta" style="margin: 0">
                {{ item.creator || '' }}
                @if (item.creator && item.license) {
                  ·
                }
                {{ item.license || '' }}
              </p>
            }
            <button
              type="button"
              class="primary"
              (click)="importStock(item)"
              [disabled]="api.busy()"
            >
              Add to project
            </button>
          </div>
        </div>
      } @else {
        <div class="cs-asset-grid cs-asset-grid--tiles cs-ms-stock-grid">
          @for (item of stockResults(); track item.id + (item.source || '')) {
            <app-media-thumb-tile
              [name]="item.title || 'Untitled'"
              [thumbUrl]="item.thumb_url || item.preview_url || null"
              [icon]="iconForType(item.kind || item.type)"
              [typeLabel]="assetTypeLabel(item.kind || item.type)"
              (tileClick)="stockDetail.set(item)"
            />
          } @empty {
            <p class="cs-empty-inline">Search to browse free media.</p>
          }
        </div>
      }
      <ng-template #footerActions>
        <button type="button" (click)="runStockSearch(stockPage() - 1)" [disabled]="stockPage() <= 1">
          Previous
        </button>
        <span class="meta">Page {{ stockPage() }}</span>
        <button
          type="button"
          (click)="runStockSearch(stockPage() + 1)"
          [disabled]="!stockResults().length"
        >
          Next
        </button>
        <button type="button" class="primary" (click)="closeStock()">Close</button>
      </ng-template>
    </app-modal-wrapper>

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
      (rename)="renameAsset($event)"
      (download)="detailAsset() && downloadAsset(detailAsset()!)"
    >
      @if (detailAsset(); as asset) {
        <label class="cs-ms-inline-field">
          <span>Group</span>
          <select
            [ngModel]="asset.group || ''"
            (ngModelChange)="onAssetGroupChange(asset, $event)"
          >
            <option value="">Ungrouped</option>
            @for (g of assetGroups(); track g) {
              <option [value]="g">{{ g }}</option>
            }
            <option value="__new__">+ New group…</option>
          </select>
        </label>

        <label class="cs-ms-inline-field">
          <span>Scope</span>
          <select
            [ngModel]="asset.post_id || ''"
            (ngModelChange)="onAssetScopeChange(asset, $event)"
          >
            <option value="">Project shared</option>
            @for (post of posts(); track post.id) {
              <option [value]="post.id">Post · {{ post.name }}</option>
            }
          </select>
        </label>

        @if (isImageThumb(asset)) {
          <label class="cs-check">
            <input
              type="checkbox"
              [ngModel]="!!asset.apply_logo"
              (ngModelChange)="toggleApplyLogo(asset, $event)"
            />
            Apply logo
          </label>
        }

        <div class="cs-am-actions">
          @if (asset.status === 'failed') {
            <button
              type="button"
              title="Retry"
              [attr.aria-label]="'Retry ' + asset.name"
              (click)="retryAsset(asset)"
            >
              <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
            </button>
          }
          @if (isVideoAsset(asset.type)) {
            <button
              type="button"
              title="Generate thumbnail"
              [attr.aria-label]="'Generate thumbnail for ' + asset.name"
              (click)="makeThumb(asset)"
            >
              <span class="material-symbols-outlined" aria-hidden="true">photo_camera</span>
            </button>
          }
          <button
            type="button"
            class="danger"
            title="Delete"
            [attr.aria-label]="'Delete ' + asset.name"
            (click)="deleteAsset(asset.id)"
          >
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
      }
    </app-asset-inspect>

    <app-audio-recorder-dialog
      [isOpen]="showRecord()"
      title="Record to project assets"
      fileStem="project-mic-recording"
      (close)="showRecord.set(false)"
      (recorded)="onRecordedAudio($event)"
    />
  `,
})
export class MediaStudioPage implements OnInit {
  readonly hubTab = signal<HubTab>('posts');
  readonly libraryTab = signal<LibraryTab>('all');
  readonly showCreatePost = signal(false);
  readonly showUpload = signal(false);
  readonly showRecord = signal(false);
  readonly showGroups = signal(false);
  readonly showStock = signal(false);
  readonly detailAssetId = signal<string | null>(null);
  readonly stockDetail = signal<StockSearchItem | null>(null);
  readonly stockResults = signal<StockSearchItem[]>([]);
  readonly stockCaps = signal<StockCapabilities | null>(null);
  readonly stockNote = signal('');
  readonly stockPage = signal(1);

  readonly logoSlots = PROJECT_LOGO_SLOTS;
  private readonly libraryTabDefs: { id: LibraryTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'photo', label: 'Photos' },
    { id: 'illustration', label: 'Illustrations' },
    { id: 'vector', label: 'Vectors' },
    { id: 'video', label: 'Video' },
    { id: 'music', label: 'Music' },
    { id: 'sound', label: 'SFX' },
    { id: 'model', label: '3D' },
    { id: 'logos', label: 'Logos' },
  ];

  readonly libraryTabs = computed(() => {
    const assets = this.assets();
    const logoCount = this.logoSlots.filter((slot) => !!this.logoUrl(slot.kind)).length;
    return this.libraryTabDefs.map((tab) => ({
      ...tab,
      count:
        tab.id === 'logos'
          ? logoCount
          : assets.filter((a) => assetMatchesTypeFilter(a.type, tab.id)).length,
    }));
  });

  newPostName = '';
  newPostType: PostType = 'image';
  newPostFormat = 'portrait';
  newPostReusable = false;
  postSort: PostSort = 'created';
  uploadAssetType = 'auto';
  uploadGroup = '';
  uploadApplyLogo = false;
  groupFilter = '';
  newGroupName = '';
  stockQuery = '';
  stockType = 'all';

  readonly postQuery = signal('');

  readonly posts = computed(() => this.api.projectPosts() as Post[]);
  readonly assets = computed(() => this.api.projectSharedAssets());
  readonly assetGroups = computed(() => this.api.currentProject()?.asset_groups || []);

  /** Posts grouped only by reusable flag (orientation shown on each card). */
  readonly postsGrouped = computed(() => {
    const q = this.postQuery().trim().toLowerCase();
    const list = this.posts().filter((p) => {
      if (!q) return true;
      return (p.name || '').toLowerCase().includes(q);
    });
    list.sort((a, b) => {
      const ak = this.postSort === 'modified' ? a.updated_at || a.created_at || '' : a.created_at || '';
      const bk = this.postSort === 'modified' ? b.updated_at || b.created_at || '' : b.created_at || '';
      return bk.localeCompare(ak);
    });

    const regular = list.filter((p) => !p.is_reusable);
    const reusable = list.filter((p) => !!p.is_reusable);

    const sections: { key: string; label: string; count: number; posts: Post[] }[] = [];
    if (regular.length) {
      sections.push({ key: 'posts', label: 'Posts', count: regular.length, posts: regular });
    }
    if (reusable.length) {
      sections.push({
        key: 'reusable',
        label: 'Reusable media',
        count: reusable.length,
        posts: reusable,
      });
    }
    return sections;
  });

  readonly detailAsset = computed(() => {
    const id = this.detailAssetId();
    if (!id) return null;
    return (this.api.currentProject()?.assets || []).find((a) => a.id === id) ?? null;
  });

  readonly filteredAssets = computed(() => {
    const tab = this.libraryTab();
    const group = this.groupFilter.trim();
    return this.assets().filter((a) => {
      if (group && String(a.group || '').trim() !== group) return false;
      if (tab === 'all' || tab === 'logos') return true;
      const t = String(a.type || '');
      if (tab === 'photo') return t === 'photo' || t === 'image';
      if (tab === 'music') return t === 'music' || t === 'audio';
      return t === tab;
    });
  });

  constructor(
    public api: ContentSproutApiService,
    private router: Router,
    private route: ActivatedRoute,
    private browser: ProjectBrowserService,
    private dialogs: DialogService,
    private snackbar: SnackbarService,
    readonly view: AssetListViewService,
  ) {}

  ngOnInit(): void {
    const tab = storageGet(HUB_TAB_KEY);
    if (tab === 'posts' || tab === 'assets' || tab === 'accounts') this.hubTab.set(tab);
    const sort = storageGet(POST_SORT_KEY);
    if (sort === 'created' || sort === 'modified') this.postSort = sort;
    if (!this.api.projects().length) void this.api.loadProjects();
    this.handleYoutubeOAuthReturn();
  }

  private handleYoutubeOAuthReturn(): void {
    const qp = this.route.snapshot.queryParamMap;
    const connected = qp.get('youtube_connected');
    const error = qp.get('youtube_error');
    if (!connected && !error) return;
    this.setHubTab('accounts');
    void this.api.refreshCurrentProject();
    if (connected) this.snackbar.show('YouTube channel connected', 'success');
    else this.snackbar.show(decodeURIComponent((error || 'YouTube connect failed').replace(/\+/g, ' ')), 'error');
    void this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  assetTypeLabel = assetTypeLabel;
  isVideoAsset = isVideoAsset;
  isAudioAsset = isAudioAsset;

  setHubTab(tab: HubTab): void {
    this.hubTab.set(tab);
    storageSet(HUB_TAB_KEY, tab);
  }

  onPostSortChange(): void {
    storageSet(POST_SORT_KEY, this.postSort);
  }

  openBrowser(): void {
    void this.api.loadProjects();
    this.browser.open();
  }

  async deleteCurrentProject(): Promise<void> {
    const p = this.api.currentProject();
    if (!p) return;
    const ok = await this.dialogs.confirm({
      title: 'Delete project',
      message: `Delete project “${p.name}”? Posts and assets in this project will be removed.`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    await this.api.deleteProject(p.id);
  }

  async createPost(): Promise<void> {
    const name = this.newPostName.trim();
    if (!name) return;
    const post = await this.api.createPost({
      name,
      type: this.newPostType,
      target_format: this.newPostFormat,
      is_reusable: this.newPostReusable,
    });
    if (post) {
      this.newPostName = '';
      this.showCreatePost.set(false);
      void this.router.navigate(['/media-studio/posts', post.id]);
    }
  }

  async deletePost(postId: string): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Delete post',
      message: 'Delete this post?',
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    void this.api.deletePost(postId);
  }

  cardDelay(index: number): string {
    return `${Math.min(index, 16) * 35}ms`;
  }

  postOrientationIcon(post: Post): string {
    const fmt = normalizeTargetFormat(post.target_format);
    if (fmt === 'landscape') return 'crop_landscape';
    if (fmt === 'square') return 'crop_square';
    if (fmt === 'story') return 'crop_portrait';
    return 'crop_portrait';
  }

  postOrientationLabel(post: Post): string {
    return formatDisplayLabel(post.target_format);
  }

  postCardKind(post: Post): string {
    if (post.type === 'video') return post.is_reusable ? 'Reusable video' : 'Video';
    return 'Image';
  }

  postCardDetail(post: Post): string {
    if (post.type === 'video') {
      const scenes = post.scenes?.length || 0;
      const layers = (post.scenes || []).reduce(
        (sum, s) => sum + ((s.layers || []).length || 0),
        0,
      );
      const bits = [
        `${scenes} scene${scenes === 1 ? '' : 's'}`,
        `${layers} layer${layers === 1 ? '' : 's'}`,
      ];
      if (post.is_reusable) bits.push('Reusable');
      return bits.join(' · ');
    }
    const layers = post.layers?.length || 0;
    if (post.is_reusable) return 'Reusable image';
    return layers ? `${layers} layer${layers === 1 ? '' : 's'}` : 'Image post';
  }

  postCardSize(post: Post): string {
    return formatPixelSize(
      exportCanvasSize(post.target_format, post.video_format, post.type === 'video'),
    );
  }

  postCardDuration(post: Post): string {
    return `${postRuntimeSeconds(post, this.posts()).toFixed(1)}s`;
  }

  postCardWhen(post: Post): string {
    const iso = this.postSort === 'modified' ? post.updated_at || post.created_at : post.created_at;
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  onUploadAssets(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files?.length) return;
    void this.api
      .uploadProjectAssets(files, {
        group: this.uploadGroup.trim(),
        asset_type: this.uploadAssetType,
        apply_logo: this.uploadApplyLogo,
      })
      .finally(() => {
        input.value = '';
        this.showUpload.set(false);
      });
  }

  onRecordedAudio(file: File): void {
    this.showRecord.set(false);
    void this.api.uploadProjectAssets([file], {
      group: this.uploadGroup.trim(),
      asset_type: 'sound',
      apply_logo: false,
    });
  }

  thumbUrl(asset: Asset): string | null {
    return this.api.assetThumbUrl(asset);
  }

  playbackUrl(asset: Asset): string | null {
    return this.api.assetPlaybackUrl(asset);
  }

  inspectUrl(asset: Asset): string | null {
    return this.api.assetOriginalUrl(asset);
  }

  inspectMeta(asset: Asset): string {
    const bits = [assetTypeLabel(asset.type), asset.status || 'ready'];
    if (asset.locked) bits.push('locked');
    if (asset.width && asset.height) bits.push(`${asset.width}×${asset.height}`);
    return bits.join(' · ');
  }

  isImageThumb(asset: Asset): boolean {
    return isImageAsset(asset.type) || asset.type === 'image';
  }

  iconFor(asset: Asset): string {
    return assetTypeIcon(asset.type);
  }

  iconForType(type: string | undefined): string {
    return assetTypeIcon(type);
  }

  openDetail(asset: Asset): void {
    this.detailAssetId.set(asset.id);
  }

  closeDetail(): void {
    this.detailAssetId.set(null);
  }

  renameAsset(name: string): void {
    const asset = this.detailAsset();
    if (!asset || !name.trim() || name.trim() === asset.name) return;
    void this.api.renameProjectAsset(asset.id, name.trim());
  }

  async deleteAsset(assetId: string): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Delete asset',
      message: 'Delete this asset?',
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    if (this.detailAssetId() === assetId) this.detailAssetId.set(null);
    void this.api.deleteProjectAsset(assetId);
  }

  downloadAsset(asset: Asset): void {
    if (asset.locked) return;
    const url = this.api.assetDownloadUrl(asset.id);
    if (url) window.open(url, '_blank', 'noopener');
  }

  downloadAll(): void {
    const url = this.api.assetsZipUrl();
    if (url) window.open(url, '_blank', 'noopener');
  }

  retryAsset(asset: Asset): void {
    void this.api.reprocessAsset(asset.id);
  }

  makeThumb(asset: Asset): void {
    void this.api.generateAssetThumb(asset.id);
  }

  async onAssetGroupChange(asset: Asset, value: string): Promise<void> {
    let group = value;
    if (value === '__new__') {
      const name = await this.dialogs.prompt({
        title: 'New group',
        message: 'Name the asset group.',
        label: 'Group name',
        confirmText: 'Create',
        required: true,
      });
      if (!name?.trim()) return;
      group = name.trim();
      if (!this.assetGroups().includes(group)) {
        const ok = await this.api.createAssetGroup(group);
        if (!ok) return;
      }
    }
    if ((asset.group || '') === group) return;
    void this.api.patchProjectAsset(asset.id, { group });
  }

  onAssetScopeChange(asset: Asset, value: string): void {
    const next = value || null;
    if ((asset.post_id || null) === next) return;
    void this.api.patchProjectAsset(asset.id, { post_id: next });
  }

  toggleApplyLogo(asset: Asset, checked: boolean): void {
    void this.api.patchProjectAsset(asset.id, { apply_logo: checked });
  }

  async addGroup(): Promise<void> {
    const name = this.newGroupName.trim();
    if (!name) return;
    if (await this.api.createAssetGroup(name)) this.newGroupName = '';
  }

  async removeGroup(name: string): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Delete group',
      message: `Delete group “${name}”? Assets stay; group membership is cleared.`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    void this.api.deleteAssetGroup(name);
  }

  logoUrl(kind: ProjectLogoKind): string | null {
    return this.api.projectFileUrl(this.api.logoPath(kind));
  }

  onLogoUpload(kind: ProjectLogoKind, event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void this.api.uploadProjectLogo(kind, file).finally(() => {
      input.value = '';
    });
  }

  async clearLogo(kind: ProjectLogoKind): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Clear logo',
      message: 'Clear this logo slot? The asset file is kept.',
      confirmText: 'Clear',
      type: 'warning',
    });
    if (!ok) return;
    void this.api.clearProjectLogo(kind);
  }

  async openStock(): Promise<void> {
    this.stockDetail.set(null);
    this.showStock.set(true);
    if (!this.stockCaps()) {
      this.stockCaps.set(await this.api.getStockCapabilities());
    }
  }

  closeStock(): void {
    this.showStock.set(false);
    this.stockDetail.set(null);
  }

  async runStockSearch(page: number): Promise<void> {
    if (page < 1) return;
    const q = this.stockQuery.trim();
    if (!q) return;
    this.stockDetail.set(null);
    const result = await this.api.searchStock({
      q,
      media_type: this.stockType,
      page,
      page_size: 24,
    });
    if (!result) return;
    this.stockResults.set(result.results || []);
    this.stockPage.set(result.page || page);
    this.stockNote.set(result.note || '');
    if (result.capabilities) this.stockCaps.set(result.capabilities);
  }

  async importStock(item: StockSearchItem): Promise<void> {
    const asset = await this.api.importStockAsset(item);
    if (asset) {
      this.stockDetail.set(null);
      const caps = await this.api.getStockCapabilities();
      if (caps) this.stockCaps.set(caps);
    }
  }
}
