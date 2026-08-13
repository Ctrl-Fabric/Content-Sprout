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
import { ModalWrapperComponent } from '@ctrlfabric/ui';
import { ContentSproutApiService } from '../services/content-sprout-api.service';
import {
  assetTypeIcon,
  assetTypeLabel,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
  type Asset,
} from '../models/content-sprout.models';

export type AttachAssetFilter = 'all' | 'visual' | 'image' | 'gif' | 'video' | 'music' | 'sound';

export type AttachableAsset = Asset & { is_global?: boolean };

const FILTERS: { id: AttachAssetFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'gif', label: 'GIFs' },
  { id: 'video', label: 'Video' },
  { id: 'music', label: 'Music' },
  { id: 'sound', label: 'SFX' },
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

/**
 * Pick a project/post/resource asset to attach to a script scene or visual block.
 * Supports images, GIFs, video, background music, and SFX.
 */
@Component({
  selector: 'app-attach-visual-asset-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal-wrapper
      [isOpen]="isOpen"
      [title]="dialogTitle()"
      [subtitle]="dialogSubtitle()"
      [icon]="dialogIcon()"
      size="medium"
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
          <span>Search</span>
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
                    }}{{ asset.is_global ? ' · Resources' : asset.post_id ? ' · Post' : ' · Project' }}</span
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
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="requestClose()">Cancel</button>
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

  constructor(private api: ContentSproutApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] && this.isOpen) {
      this.query.set('');
      this.filter.set(this.lockFilter || 'all');
      this.refreshPool();
    }
    if (changes['lockFilter'] && this.isOpen) {
      this.filter.set(this.lockFilter || 'all');
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
    if (this.lockFilter === 'visual') {
      return 'Choose an image or video for this scene’s visual.';
    }
    if (this.lockFilter) {
      return 'Choose an asset for this script block.';
    }
    return 'Add background music, extra images, GIFs, video, or SFX to this scene.';
  }

  dialogIcon(): string {
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

  iconFor(asset: AttachableAsset): string {
    if (isGifAsset(asset)) return 'gif_box';
    return assetTypeIcon(asset.type);
  }

  labelFor(asset: AttachableAsset): string {
    if (isGifAsset(asset)) return 'GIF';
    return assetTypeLabel(asset.type);
  }

  requestClose(): void {
    this.close.emit();
  }

  pick(asset: AttachableAsset): void {
    this.picked.emit(asset);
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
