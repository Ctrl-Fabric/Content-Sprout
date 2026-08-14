import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  computed,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent } from 'shared/ui';
import { ContentSproutApiService } from '../services/content-sprout-api.service';
import {
  assetTypeIcon,
  assetTypeLabel,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
  type Asset,
  type StockCapabilities,
  type StockSearchItem,
} from '../models/content-sprout.models';
import { MediaThumbTileComponent } from './media-thumb-tile';

export type AttachAssetFilter = 'all' | 'visual' | 'image' | 'gif' | 'video' | 'music' | 'sound';

export type AttachableAsset = Asset & { is_global?: boolean };

type AttachSource = 'library' | 'stock';

const FILTERS: { id: AttachAssetFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'gif', label: 'GIFs' },
  { id: 'video', label: 'Video' },
  { id: 'music', label: 'Music' },
  { id: 'sound', label: 'SFX' },
];

const STOCK_TYPES: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'photo', label: 'Photos' },
  { id: 'illustration', label: 'Illustrations' },
  { id: 'vector', label: 'Vectors' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
];

export function isGifAsset(asset: Asset): boolean {
  const hay = `${asset.original_filename || ''} ${asset.name || ''}`.toLowerCase();
  return /\.gif(\b|$)/i.test(hay);
}

function matchesFilter(asset: Asset, filter: AttachAssetFilter): boolean {
  if (filter === 'all') {
    return isImageAsset(asset.type) || isVideoAsset(asset.type) || isAudioAsset(asset.type);
  }
  if (filter === 'visual') return isImageAsset(asset.type) || isVideoAsset(asset.type);
  if (filter === 'gif') return isImageAsset(asset.type) && isGifAsset(asset);
  if (filter === 'image') return isImageAsset(asset.type);
  if (filter === 'video') return isVideoAsset(asset.type);
  if (filter === 'music') {
    const t = String(asset.type || '').toLowerCase();
    return t === 'music' || t === 'audio';
  }
  if (filter === 'sound') {
    const t = String(asset.type || '').toLowerCase();
    return t === 'sound' || t === 'sfx';
  }
  return false;
}

function defaultStockType(filter: AttachAssetFilter | null): string {
  switch (filter) {
    case 'video':
      return 'video';
    case 'music':
    case 'sound':
      return 'audio';
    case 'image':
    case 'gif':
      return 'photo';
    default:
      return 'all';
  }
}

function stockTypesForFilter(filter: AttachAssetFilter | null): { id: string; label: string }[] {
  switch (filter) {
    case 'video':
      return STOCK_TYPES.filter((t) => t.id === 'video');
    case 'music':
    case 'sound':
      return STOCK_TYPES.filter((t) => t.id === 'audio');
    case 'image':
    case 'gif':
      return STOCK_TYPES.filter((t) => ['photo', 'illustration', 'vector'].includes(t.id));
    default:
      return STOCK_TYPES;
  }
}

/**
 * Pick a project/post/resource asset to attach to a script scene or visual block.
 * Supports images, GIFs, video, background music, SFX, and free stock search.
 */
@Component({
  selector: 'app-attach-visual-asset-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent, MediaThumbTileComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal-wrapper
      [isOpen]="isOpen"
      [title]="dialogTitle()"
      [subtitle]="dialogSubtitle()"
      [icon]="dialogIcon()"
      [size]="source() === 'stock' ? 'large' : 'medium'"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="requestClose()"
    >
      <div class="cs-attach-vis">
        @if (promptText.trim()) {
          <div class="cs-attach-vis-prompt">
            <span>{{ promptLabel || 'For' }}</span>
            <p>{{ promptText.trim() }}</p>
          </div>
        }

        <div class="cs-attach-vis-source" role="tablist" aria-label="Asset source">
          <button
            type="button"
            role="tab"
            [class.active]="source() === 'library'"
            [attr.aria-selected]="source() === 'library'"
            (click)="source.set('library')"
          >
            Project library
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="source() === 'stock'"
            [attr.aria-selected]="source() === 'stock'"
            (click)="openStockTab()"
          >
            Free stock
          </button>
        </div>

        @if (source() === 'library') {
          @if (!lockFilter) {
            <div class="cs-attach-vis-filters" role="tablist" aria-label="Asset type">
              @for (f of filters; track f.id) {
                <button
                  type="button"
                  role="tab"
                  [class.active]="filter() === f.id"
                  [attr.aria-selected]="filter() === f.id"
                  (click)="filter.set(f.id)"
                >
                  {{ f.label }}
                </button>
              }
            </div>
          }

          <label class="cs-attach-vis-search">
            <span>Search library</span>
            <input
              type="search"
              [ngModel]="query()"
              (ngModelChange)="query.set($event)"
              placeholder="Name or group…"
              aria-label="Search assets"
            />
          </label>
          <ul class="cs-attach-vis-list" role="listbox" aria-label="Assets">
            @for (asset of filtered(); track assetKey(asset)) {
              <li>
                <button
                  type="button"
                  role="option"
                  class="cs-attach-vis-item"
                  (click)="pick(asset)"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">{{
                    iconFor(asset)
                  }}</span>
                  <span class="cs-attach-vis-item-main">
                    <strong class="truncate">{{ asset.name }}</strong>
                    <span class="meta"
                      >{{ labelFor(asset)
                      }}{{
                        asset.is_global ? ' · Resources' : asset.post_id ? ' · Post' : ' · Project'
                      }}</span
                    >
                  </span>
                </button>
              </li>
            } @empty {
              <li class="cs-empty-inline">
                No matching assets. Upload or generate one on the Assets step first.
              </li>
            }
          </ul>
        } @else {
          <div class="cs-attach-vis-stock-search">
            <label class="cs-attach-vis-search">
              <span>Search free stock</span>
              <input
                type="search"
                [(ngModel)]="stockQuery"
                (keyup.enter)="runStockSearch(1)"
                placeholder="e.g. forest night, city timelapse"
                aria-label="Search free stock"
              />
            </label>
            @if (stockTypeOptions().length > 1) {
              <label class="cs-attach-vis-stock-type">
                <span>Type</span>
                <select [(ngModel)]="stockType">
                  @for (t of stockTypeOptions(); track t.id) {
                    <option [value]="t.id">{{ t.label }}</option>
                  }
                </select>
              </label>
            }
            <button
              type="button"
              class="primary"
              (click)="runStockSearch(1)"
              [disabled]="api.busy() || importing()"
            >
              Search
            </button>
          </div>

          @if (stockCaps()) {
            <p class="meta cs-attach-vis-stock-meta">
              Stock quota: {{ stockCaps()!.downloads_used_today ?? 0 }} used today
              @if (stockCaps()!.downloads_remaining_today != null) {
                · {{ stockCaps()!.downloads_remaining_today }} remaining
              }
            </p>
          }
          @if (stockNote()) {
            <p class="meta cs-attach-vis-stock-meta">{{ stockNote() }}</p>
          }
          @if (!stockConfigured()) {
            <p class="cs-empty-inline">
              Add a Pixabay API key in Settings to search free stock. Imports are locked to this
              project.
            </p>
          }

          <div class="cs-attach-vis-stock-grid">
            @for (item of stockResults(); track stockItemKey(item)) {
              <app-media-thumb-tile
                [name]="item.title || 'Untitled'"
                [thumbUrl]="item.thumb_url || item.preview_url || null"
                [icon]="stockIcon(item)"
                [typeLabel]="stockTypeLabel(item)"
                [durationS]="item.duration_s ?? null"
                [locked]="true"
                (tileClick)="pickStock(item)"
              />
            } @empty {
              <p class="cs-empty-inline cs-attach-vis-stock-empty">
                @if (stockQuery.trim()) {
                  Search to browse openly licensed media from configured free stock sources.
                } @else {
                  Enter a search term and click Search.
                }
              </p>
            }
          </div>
        }
      </div>
      <ng-template #footerActions>
        @if (source() === 'stock') {
          <button
            type="button"
            (click)="runStockSearch(stockPage() - 1)"
            [disabled]="stockPage() <= 1 || importing()"
          >
            Previous
          </button>
          <span class="meta">Page {{ stockPage() }}</span>
          <button
            type="button"
            (click)="runStockSearch(stockPage() + 1)"
            [disabled]="!stockResults().length || importing()"
          >
            Next
          </button>
        }
        <button type="button" (click)="requestClose()" [disabled]="importing()">Cancel</button>
      </ng-template>
    </app-modal-wrapper>
  `,
  styles: [
    `
      .cs-attach-vis {
        display: grid;
        gap: 0.75rem;
      }
      .cs-attach-vis-prompt {
        display: grid;
        gap: 0.3rem;
        padding: 0.6rem 0.7rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 4%, transparent);
      }
      .cs-attach-vis-prompt > span {
        font-size: 0.68rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .cs-attach-vis-prompt p {
        margin: 0;
        font-size: 0.86rem;
        line-height: 1.4;
        white-space: pre-wrap;
      }
      .cs-attach-vis-source {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
      .cs-attach-vis-source button {
        font-size: 0.74rem;
        font-weight: 600;
        padding: 0.35rem 0.7rem;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--muted);
      }
      .cs-attach-vis-source button.active {
        border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
        background: color-mix(in srgb, var(--primary) 12%, transparent);
        color: var(--text);
      }
      .cs-attach-vis-filters {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
      }
      .cs-attach-vis-filters button {
        font-size: 0.72rem;
        padding: 0.3rem 0.55rem;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--muted);
      }
      .cs-attach-vis-filters button.active {
        border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
        background: color-mix(in srgb, var(--primary) 12%, transparent);
        color: var(--text);
      }
      .cs-attach-vis-search {
        display: grid;
        gap: 0.3rem;
        font-size: 0.72rem;
        color: var(--muted);
        min-width: 0;
      }
      .cs-attach-vis-stock-search {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 0.55rem;
        align-items: end;
      }
      .cs-attach-vis-stock-type {
        display: grid;
        gap: 0.3rem;
        font-size: 0.72rem;
        color: var(--muted);
      }
      .cs-attach-vis-stock-meta {
        margin: 0;
      }
      .cs-attach-vis-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.35rem;
        max-height: min(50vh, 22rem);
        overflow: auto;
      }
      .cs-attach-vis-stock-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
        gap: 0.45rem;
        max-height: min(52vh, 24rem);
        overflow: auto;
      }
      .cs-attach-vis-stock-empty {
        grid-column: 1 / -1;
      }
      .cs-attach-vis-item {
        width: 100%;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.55rem;
        align-items: center;
        text-align: left;
        padding: 0.55rem 0.65rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 3%, transparent);
      }
      .cs-attach-vis-item:hover {
        border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
        background: color-mix(in srgb, var(--primary) 8%, transparent);
      }
      .cs-attach-vis-item .material-symbols-outlined {
        font-size: 1.25rem;
        color: var(--primary);
      }
      .cs-attach-vis-item-main {
        display: grid;
        gap: 0.1rem;
        min-width: 0;
      }
      @media (max-width: 640px) {
        .cs-attach-vis-stock-search {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class AttachVisualAssetDialogComponent implements OnChanges {
  @Input() isOpen = false;
  /** When set, only that asset family is shown (primary visual attach). */
  @Input() lockFilter: AttachAssetFilter | null = null;
  @Input() postId = '';
  @Input() promptText = '';
  @Input() promptLabel = '';
  @Input() title = '';

  @Output() close = new EventEmitter<void>();
  @Output() picked = new EventEmitter<AttachableAsset>();

  readonly filters = FILTERS;
  readonly query = signal('');
  readonly filter = signal<AttachAssetFilter>('all');
  readonly pool = signal<AttachableAsset[]>([]);
  readonly source = signal<AttachSource>('library');
  readonly stockResults = signal<StockSearchItem[]>([]);
  readonly stockPage = signal(1);
  readonly stockNote = signal('');
  readonly stockCaps = signal<StockCapabilities | null>(null);
  readonly importing = signal(false);

  stockQuery = '';
  stockType = 'all';

  readonly stockTypeOptions = computed(() => stockTypesForFilter(this.lockFilter));
  readonly stockConfigured = computed(() => !!this.stockCaps()?.pixabay?.enabled);

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.lockFilter || this.filter();
    return this.pool().filter((a) => {
      if (!matchesFilter(a, f)) return false;
      if (!q) return true;
      const hay = `${a.name || ''} ${a.group || ''} ${a.type || ''} ${a.original_filename || ''}`.toLowerCase();
      return hay.includes(q);
    });
  });

  constructor(readonly api: ContentSproutApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] && this.isOpen) {
      this.query.set('');
      this.filter.set(this.lockFilter || 'all');
      this.source.set('library');
      this.stockQuery = '';
      this.stockType = defaultStockType(this.lockFilter);
      this.stockResults.set([]);
      this.stockPage.set(1);
      this.stockNote.set('');
      this.refreshPool();
    }
    if (changes['lockFilter'] && this.isOpen) {
      this.filter.set(this.lockFilter || 'all');
      this.stockType = defaultStockType(this.lockFilter);
    }
  }

  dialogTitle(): string {
    if (this.title.trim()) return this.title.trim();
    const f = this.lockFilter || this.filter();
    switch (f) {
      case 'visual':
        return 'Attach visual';
      case 'video':
        return 'Attach video';
      case 'image':
        return 'Attach image';
      case 'gif':
        return 'Attach GIF';
      case 'music':
        return 'Attach music';
      case 'sound':
        return 'Attach SFX';
      default:
        return 'Attach asset';
    }
  }

  dialogSubtitle(): string {
    if (this.source() === 'stock') {
      return 'Search free stock sites, import a locked copy, and attach it to this script block.';
    }
    if (this.lockFilter === 'visual') {
      return 'Choose an image or video from your library, or switch to Free stock.';
    }
    if (this.lockFilter) {
      return 'Choose a library asset or search free stock for this script block.';
    }
    return 'Add background music, extra images, GIFs, video, or SFX to this scene.';
  }

  dialogIcon(): string {
    if (this.source() === 'stock') return 'travel_explore';
    const f = this.lockFilter || this.filter();
    if (f === 'video') return 'movie';
    if (f === 'music' || f === 'sound') return 'music_note';
    if (f === 'gif') return 'gif_box';
    if (f === 'image') return 'image';
    return 'attach_file';
  }

  assetKey(asset: AttachableAsset): string {
    return asset.is_global ? `global:${asset.id}` : asset.id;
  }

  stockItemKey(item: StockSearchItem): string {
    return `${item.source || 'stock'}:${item.id}`;
  }

  iconFor(asset: AttachableAsset): string {
    if (isGifAsset(asset)) return 'gif_box';
    return assetTypeIcon(asset.type);
  }

  labelFor(asset: AttachableAsset): string {
    if (isGifAsset(asset)) return 'GIF';
    return assetTypeLabel(asset.type);
  }

  stockIcon(item: StockSearchItem): string {
    return assetTypeIcon(item.kind || item.type || 'image');
  }

  stockTypeLabel(item: StockSearchItem): string {
    const kind = String(item.kind || item.type || 'media').toLowerCase();
    if (kind.includes('video')) return 'Video';
    if (kind.includes('audio') || kind.includes('music')) return 'Audio';
    if (kind.includes('vector')) return 'Vector';
    if (kind.includes('illustration')) return 'Illustration';
    return assetTypeLabel(item.type || 'image');
  }

  requestClose(): void {
    if (this.importing()) return;
    this.close.emit();
  }

  pick(asset: AttachableAsset): void {
    this.picked.emit(asset);
  }

  async openStockTab(): Promise<void> {
    this.source.set('stock');
    if (!this.stockCaps()) {
      this.stockCaps.set(await this.api.getStockCapabilities());
    }
    const options = this.stockTypeOptions();
    if (!options.some((o) => o.id === this.stockType)) {
      this.stockType = options[0]?.id || defaultStockType(this.lockFilter);
    }
  }

  async runStockSearch(page: number): Promise<void> {
    if (page < 1 || this.importing()) return;
    const q = this.stockQuery.trim();
    if (!q) return;
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

  async pickStock(item: StockSearchItem): Promise<void> {
    if (this.importing()) return;
    this.importing.set(true);
    try {
      const asset = await this.api.importStockAsset(item);
      if (asset) {
        this.picked.emit({ ...asset, is_global: false });
        const caps = await this.api.getStockCapabilities();
        if (caps) this.stockCaps.set(caps);
      }
    } finally {
      this.importing.set(false);
    }
  }

  private refreshPool(): void {
    const project = this.api.currentProject();
    const postId = this.postId;
    const projectAssets = (project?.assets || []).filter(
      (a) => !a.post_id || a.post_id === postId,
    );
    const globals = (this.api.globalAssets() || []).map((a) => ({
      ...(a as Asset),
      is_global: true as const,
    }));
    const seen = new Set<string>();
    const out: AttachableAsset[] = [];
    for (const a of projectAssets) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
    for (const a of globals) {
      const key = `global:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    this.pool.set(out);
  }
}
