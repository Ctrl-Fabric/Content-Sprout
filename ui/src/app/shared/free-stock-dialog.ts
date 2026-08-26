import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent } from 'shared/ui';
import {
  assetTypeIcon,
  assetTypeLabel,
  type Asset,
  type StockCapabilities,
  type StockSearchItem,
} from '../models/content-sprout.models';
import { ContentSproutApiService } from '../services/content-sprout-api.service';
import { AssetPreviewPaneComponent } from './asset-preview-pane';
import { MediaThumbTileComponent } from './media-thumb-tile';

export type FreeStockTarget = 'global' | 'project' | 'post';

@Component({
  selector: 'app-free-stock-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ModalWrapperComponent,
    MediaThumbTileComponent,
    AssetPreviewPaneComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <app-modal-wrapper
      [isOpen]="isOpen"
      title="Free stock"
      [subtitle]="subtitle()"
      icon="travel_explore"
      size="large"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="close.emit()"
    >
      <div class="cs-form-row" style="margin: 0 0 0.75rem">
        <label style="flex: 1">
          <span>Search</span>
          <input
            [(ngModel)]="query"
            (keyup.enter)="runSearch(1)"
            placeholder="e.g. forest night"
          />
        </label>
        <label>
          <span>Type</span>
          <select [(ngModel)]="mediaType">
            <option value="all">All</option>
            <option value="photo">Photos</option>
            <option value="illustration">Illustrations</option>
            <option value="vector">Vectors</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
          </select>
        </label>
        <div class="page-actions-inline" style="align-self: end">
          <button type="button" class="primary" (click)="runSearch(1)" [disabled]="api.busy()">
            Search
          </button>
        </div>
      </div>
      @if (caps()) {
        <p class="meta" style="margin: 0 0 0.75rem">
          Quota:
          {{ caps()!.downloads_used_today ?? 0 }} used
          @if (caps()!.downloads_remaining_today != null) {
            · {{ caps()!.downloads_remaining_today }} remaining today
          }
        </p>
      }
      @if (note()) {
        <p class="meta" style="margin: 0 0 0.75rem">{{ note() }}</p>
      }
      @if (detail(); as item) {
        <button type="button" class="cs-stock-back" (click)="detail.set(null)">← Results</button>
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
              (click)="importItem(item)"
              [disabled]="api.busy()"
            >
              {{ importLabel() }}
            </button>
          </div>
        </div>
      } @else {
        <div class="cs-asset-grid cs-asset-grid--tiles cs-ms-stock-grid">
          @for (item of results(); track item.id + (item.source || '')) {
            <app-media-thumb-tile
              [name]="item.title || 'Untitled'"
              [thumbUrl]="item.thumb_url || item.preview_url || null"
              [icon]="iconForType(item.kind || item.type)"
              [typeLabel]="assetTypeLabel(item.kind || item.type)"
              (tileClick)="detail.set(item)"
            />
          } @empty {
            <p class="cs-empty-inline">Search to browse free media.</p>
          }
        </div>
      }
      <ng-template #footerActions>
        <button type="button" (click)="runSearch(page() - 1)" [disabled]="page() <= 1">
          Previous
        </button>
        <span class="meta">Page {{ page() }}</span>
        <button
          type="button"
          (click)="runSearch(page() + 1)"
          [disabled]="!results().length"
        >
          Next
        </button>
        <button type="button" class="primary" (click)="close.emit()">Close</button>
      </ng-template>
    </app-modal-wrapper>
  `,
})
export class FreeStockDialogComponent implements OnChanges {
  @Input() isOpen = false;
  /** Where imported stock lands. */
  @Input() target: FreeStockTarget = 'project';
  /** Required when target is ``post``. */
  @Input() postId: string | null = null;
  @Output() close = new EventEmitter<void>();
  @Output() imported = new EventEmitter<Asset>();

  readonly results = signal<StockSearchItem[]>([]);
  readonly detail = signal<StockSearchItem | null>(null);
  readonly caps = signal<StockCapabilities | null>(null);
  readonly note = signal('');
  readonly page = signal(1);

  query = '';
  mediaType = 'all';

  assetTypeLabel = assetTypeLabel;

  constructor(public api: ContentSproutApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen']?.currentValue === true) {
      void this.ensureCaps();
    }
    if (changes['isOpen'] && !changes['isOpen'].currentValue) {
      this.detail.set(null);
    }
  }

  subtitle(): string {
    switch (this.target) {
      case 'global':
        return 'Search openly licensed media and add locked copies to Shared Library.';
      case 'post':
        return 'Search openly licensed media and add locked copies to this post.';
      default:
        return 'Search openly licensed media and add locked copies into this project.';
    }
  }

  importLabel(): string {
    switch (this.target) {
      case 'global':
        return 'Add to Shared Library';
      case 'post':
        return 'Add to post';
      default:
        return 'Add to project';
    }
  }

  iconForType(type: string | undefined): string {
    return assetTypeIcon(type);
  }

  private async ensureCaps(): Promise<void> {
    if (this.caps()) return;
    this.caps.set(await this.api.getStockCapabilities());
  }

  async runSearch(page: number): Promise<void> {
    if (page < 1) return;
    const q = this.query.trim();
    if (!q) return;
    this.detail.set(null);
    const result = await this.api.searchStock({
      q,
      media_type: this.mediaType,
      page,
      page_size: 24,
    });
    if (!result) return;
    this.results.set(result.results || []);
    this.page.set(result.page || page);
    this.note.set(result.note || '');
    if (result.capabilities) this.caps.set(result.capabilities);
  }

  async importItem(item: StockSearchItem): Promise<void> {
    let asset: Asset | null = null;
    if (this.target === 'global') {
      asset = await this.api.importGlobalStockAsset(item);
    } else {
      asset = await this.api.importStockAsset(item, {
        postId: this.target === 'post' ? this.postId || undefined : undefined,
      });
    }
    if (!asset) return;
    this.imported.emit(asset);
    this.detail.set(null);
  }
}
