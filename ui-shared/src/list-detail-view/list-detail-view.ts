import { CommonModule } from '@angular/common';
import {
  Component,
  ContentChild,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  TemplateRef,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface ListItemBadge {
  label: string;
  variant?: 'default' | 'primary' | 'success' | 'danger' | 'warning';
}

export interface ListItemMeta {
  icon?: string;
  text: string;
}

export interface ListItemAction<T> {
  icon: string;
  label: string;
  onClick: (item: T) => void;
  variant?: 'default' | 'danger';
  shouldShow?: (item: T) => boolean;
}

/**
 * Configuration for {@link ListDetailView}. Intentionally mirrors the shape of the
 * Identity admin UI's `ListDetailConfig` (subset) so pages stay portable between apps.
 */
export interface ListDetailConfig<T = unknown> {
  listTitle?: string;
  emptyStateIcon?: string;
  emptyStateTitle?: string;
  emptyStateMessage?: string;
  showSearch?: boolean;
  searchPlaceholder?: string;
  listPanelWidth?: string;
  autoSelectFirst?: boolean;

  getItemId: (item: T) => string;
  getItemTitle: (item: T) => string;
  getItemIcon?: (item: T) => string;
  /** Optional image/thumbnail URL shown instead of the icon when available. */
  getItemImageUrl?: (item: T) => string | null | undefined;
  /** Optional video URL shown as a muted metadata thumb instead of the icon. */
  getItemVideoUrl?: (item: T) => string | null | undefined;
  getItemSubtitle?: (item: T) => string;
  getItemDescription?: (item: T) => string;
  getItemBadges?: (item: T) => ListItemBadge[];
  getItemMeta?: (item: T) => ListItemMeta[];
  getItemTags?: (item: T) => string[];

  itemActions?: ListItemAction<T>[];
  detailHeaderActions?: ListItemAction<T>[];
}

/**
 * Generic master/detail list view driven by a {@link ListDetailConfig}.
 * Self-contained (own styles, only `--*` CSS variables) so it can be lifted
 * into a shared UI library and reused across apps.
 */
@Component({
  selector: 'app-list-detail-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="ldv">
      <!-- List panel -->
      <div class="list-panel" [style.width]="config.listPanelWidth || '360px'">
        @if (config.showSearch !== false) {
          <div class="search">
            <span class="material-symbols-outlined">search</span>
            <input
              type="text"
              [placeholder]="config.searchPlaceholder || 'Search…'"
              [ngModel]="localSearch()"
              (ngModelChange)="onSearch($event)"
            />
            @if (localSearch()) {
              <button type="button" class="clear" (click)="onSearch('')" title="Clear">
                <span class="material-symbols-outlined">close</span>
              </button>
            }
          </div>
        }

        <div class="list-scroll">
          @if (isLoading) {
            <div class="placeholder">
              <span class="material-symbols-outlined spin">progress_activity</span>
              <p>Loading…</p>
            </div>
          } @else if (!items.length) {
            <div class="placeholder">
              <span class="material-symbols-outlined">{{ config.emptyStateIcon || 'inbox' }}</span>
              <h4>{{ config.emptyStateTitle || 'Nothing here yet' }}</h4>
              <p>{{ config.emptyStateMessage || 'Create a new item to get started.' }}</p>
            </div>
          } @else {
            @for (item of items; track config.getItemId(item)) {
              <button
                type="button"
                class="list-item"
                [class.selected]="isSelected(item)"
                (click)="select(item)"
              >
                @if (config.getItemImageUrl && config.getItemImageUrl(item)) {
                  <img
                    class="item-thumb"
                    [src]="config.getItemImageUrl(item)!"
                    [alt]=""
                    loading="lazy"
                  />
                } @else if (config.getItemVideoUrl && config.getItemVideoUrl(item)) {
                  <video
                    class="item-thumb"
                    [src]="config.getItemVideoUrl(item)!"
                    muted
                    preload="metadata"
                    playsinline
                  ></video>
                } @else if (config.getItemIcon && config.getItemIcon(item)) {
                  <span class="item-icon material-symbols-outlined">{{ config.getItemIcon(item) }}</span>
                }
                <span class="item-main">
                  <span class="item-title">{{ config.getItemTitle(item) }}</span>
                  @if (config.getItemSubtitle && config.getItemSubtitle(item)) {
                    <span class="item-sub">{{ config.getItemSubtitle(item) }}</span>
                  }
                  @if (config.getItemBadges && config.getItemBadges(item).length) {
                    <span class="badges">
                      @for (b of config.getItemBadges(item); track b.label) {
                        <span class="badge" [attr.data-variant]="b.variant || 'default'">{{ b.label }}</span>
                      }
                    </span>
                  }
                </span>
              </button>
            }
          }
        </div>

        @if (showPagination && !isLoading && totalCount > 0) {
          <div class="list-pagination">
            <span class="count">{{ totalCount }} {{ itemName }}</span>
            <div class="nav">
              <button
                type="button"
                title="Previous page"
                (click)="changePage(currentPage - 1)"
                [disabled]="currentPage <= 1"
              >
                <span class="material-symbols-outlined">chevron_left</span>
              </button>
              <span class="page-status">{{ currentPage }} / {{ totalPagesValue }}</span>
              <button
                type="button"
                title="Next page"
                (click)="changePage(currentPage + 1)"
                [disabled]="currentPage >= totalPagesValue"
              >
                <span class="material-symbols-outlined">chevron_right</span>
              </button>
            </div>
          </div>
        }
      </div>

      <div class="divider"></div>

      <!-- Detail panel -->
      <div class="detail-panel">
        @if (selectedItem) {
          <div class="detail-head">
            <h3>
              {{ config.getItemTitle(selectedItem) }}
            </h3>
            @if (config.detailHeaderActions?.length) {
              <div class="detail-actions">
                @for (a of config.detailHeaderActions ?? []; track a.label) {
                  @if (!a.shouldShow || a.shouldShow(selectedItem)) {
                    <button
                      type="button"
                      [class.danger]="a.variant === 'danger'"
                      [title]="a.label"
                      (click)="a.onClick(selectedItem)"
                    >
                      <span class="material-symbols-outlined">{{ a.icon }}</span>
                      <span class="action-label">{{ a.label }}</span>
                    </button>
                  }
                }
              </div>
            }
          </div>
          <div class="detail-body">
            @if (detailTemplate) {
              <ng-container
                [ngTemplateOutlet]="detailTemplate"
                [ngTemplateOutletContext]="{ $implicit: selectedItem }"
              ></ng-container>
            } @else if (config.getItemDescription) {
              <p>{{ config.getItemDescription(selectedItem) }}</p>
            }
          </div>
        } @else {
          <div class="placeholder center">
            <span class="material-symbols-outlined">touch_app</span>
            <p>Select an item to view its details</p>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        /* Fills its container; the list and detail bodies scroll internally
           rather than growing the page. */
        min-height: var(--ldv-min-height, 0);
        height: var(--ldv-height, calc(100vh - 240px));
      }
      .ldv {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
      }
      .list-panel {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
      }
      .search {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        min-height: var(--ldv-header-height, 57px);
        box-sizing: border-box;
        padding: 0.5rem 0.9rem;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }
      .search > .material-symbols-outlined {
        color: var(--muted);
        font-size: 20px;
      }
      .search input {
        flex: 1;
        border: none;
        padding: 0.25rem 0;
        background: transparent;
      }
      .search input:focus {
        outline: none;
        box-shadow: none;
      }
      .clear {
        border: none;
        background: transparent;
        padding: 0.15rem;
        display: grid;
        place-items: center;
        color: var(--muted);
      }
      .clear .material-symbols-outlined {
        font-size: 18px;
      }
      .list-scroll {
        flex: 1;
        overflow-y: auto;
        padding: 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .list-pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.5rem 0.7rem;
        border-top: 1px solid var(--border);
        flex-shrink: 0;
      }
      .list-pagination .count {
        font-size: 0.74rem;
        color: var(--muted);
      }
      .list-pagination .nav {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .list-pagination .page-status {
        font-size: 0.76rem;
        color: var(--muted);
        min-width: 2.5rem;
        text-align: center;
      }
      .list-pagination button {
        display: grid;
        place-items: center;
        box-sizing: border-box;
        width: 28px;
        height: 28px;
        padding: 0;
        line-height: 1;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
        border-radius: 7px;
        cursor: pointer;
      }
      .list-pagination button:hover:not(:disabled) {
        background: var(--canvas);
      }
      .list-pagination button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .list-pagination button .material-symbols-outlined {
        font-size: 18px;
      }
      .list-item {
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        gap: 0.6rem;
        width: 100%;
        text-align: left;
        padding: 0.65rem 0.7rem;
        border: 1px solid transparent;
        border-radius: 10px;
        background: transparent;
      }
      .list-item:hover {
        background: var(--canvas);
      }
      .list-item.selected {
        background: var(--primary-soft);
        border-color: color-mix(in srgb, var(--primary) 25%, transparent);
      }
      .item-thumb {
        width: 40px;
        height: 40px;
        border-radius: 8px;
        object-fit: cover;
        flex-shrink: 0;
        background: var(--canvas);
        border: 1px solid var(--border);
        pointer-events: none;
      }
      .item-icon {
        font-size: 20px;
        color: var(--muted);
        margin-top: 1px;
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        background: var(--canvas);
        border: 1px solid var(--border);
      }
      .list-item.selected .item-icon {
        color: var(--primary);
        border-color: color-mix(in srgb, var(--primary) 30%, transparent);
        background: color-mix(in srgb, var(--primary) 10%, var(--canvas));
      }
      .item-main {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.15rem;
        min-width: 0;
        flex: 1;
        text-align: left;
      }
      .item-title {
        font-weight: 600;
        font-size: 0.9rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item-sub {
        font-size: 0.76rem;
        color: var(--muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        margin-top: 0.2rem;
      }
      .badge {
        font-size: 0.66rem;
        font-weight: 600;
        padding: 0.08rem 0.45rem;
        border-radius: 999px;
        background: var(--bg);
        color: var(--muted);
      }
      .badge[data-variant='primary'] {
        background: var(--primary-soft);
        color: var(--primary);
      }
      .badge[data-variant='success'] {
        background: #dff4ea;
        color: var(--success);
      }
      .badge[data-variant='danger'] {
        background: #fbe6e4;
        color: var(--danger);
      }
      .badge[data-variant='warning'] {
        background: #fcefdc;
        color: var(--warning);
      }
      .divider {
        width: 1px;
        background: var(--border);
        flex-shrink: 0;
      }
      .detail-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
      }
      .detail-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        min-height: var(--ldv-header-height, 57px);
        box-sizing: border-box;
        padding: 0.5rem 1.1rem;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }
      .detail-head h3 {
        margin: 0;
        font-size: 1.02rem;
        font-weight: 700;
      }
      .detail-actions {
        display: flex;
        gap: 0.4rem;
      }
      .detail-actions button {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.82rem;
      }
      .detail-actions button.danger {
        color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
      }
      .detail-actions .material-symbols-outlined {
        font-size: 18px;
      }
      .detail-body {
        flex: 1;
        overflow-y: auto;
        padding: 1.1rem;
      }
      .placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 0.35rem;
        color: var(--muted);
        padding: 2.5rem 1rem;
      }
      .placeholder.center {
        margin: auto;
      }
      .placeholder .material-symbols-outlined {
        font-size: 34px;
        opacity: 0.7;
      }
      .placeholder h4 {
        margin: 0.3rem 0 0;
        color: var(--text);
        font-size: 0.95rem;
      }
      .placeholder p {
        margin: 0;
        font-size: 0.84rem;
      }
      .spin {
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class ListDetailView<T = unknown> implements OnChanges {
  @Input({ required: true }) config!: ListDetailConfig<T>;
  @Input({ required: true }) items: T[] = [];
  @Input() selectedItem: T | null = null;
  @Input() isLoading = false;
  @Input() searchTerm = '';

  /** Show a pagination footer inside the list panel. */
  @Input() showPagination = false;
  @Input() currentPage = 1;
  @Input() totalCount = 0;
  @Input() pageSize = 10;
  @Input() itemName = 'items';

  @Output() itemSelected = new EventEmitter<T>();
  @Output() searchChanged = new EventEmitter<string>();
  @Output() pageChanged = new EventEmitter<number>();

  get totalPagesValue(): number {
    return Math.max(1, Math.ceil(this.totalCount / Math.max(1, this.pageSize)));
  }

  changePage(page: number): void {
    if (page >= 1 && page <= this.totalPagesValue && page !== this.currentPage) {
      this.pageChanged.emit(page);
    }
  }

  @ContentChild('detail') detailTemplate?: TemplateRef<unknown>;

  localSearch = signal('');
  private autoSelected = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['searchTerm']) {
      this.localSearch.set(this.searchTerm ?? '');
    }
    if (changes['items']) {
      const autoSelect = this.config?.autoSelectFirst !== false;
      if (!this.isLoading && autoSelect && this.items.length) {
        const stillExists =
          this.selectedItem &&
          this.items.some(
            (i) => this.config.getItemId(i) === this.config.getItemId(this.selectedItem!)
          );
        if (!this.selectedItem || !stillExists) {
          const first = this.items[0];
          // Defer so the parent is not updated during this component's change detection.
          queueMicrotask(() => this.itemSelected.emit(first));
          this.autoSelected = true;
        }
      } else if (!this.items.length) {
        this.autoSelected = false;
      }
    }
  }

  isSelected(item: T): boolean {
    if (!this.selectedItem) return false;
    return this.config.getItemId(item) === this.config.getItemId(this.selectedItem);
  }

  select(item: T): void {
    this.itemSelected.emit(item);
  }

  onSearch(value: string): void {
    this.localSearch.set(value);
    this.searchChanged.emit(value);
  }
}
