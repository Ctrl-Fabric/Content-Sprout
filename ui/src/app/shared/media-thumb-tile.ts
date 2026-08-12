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
import { formatMediaDuration, mediaDurationSeconds } from './media-duration';

@Component({
  selector: 'app-media-thumb-tile',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="cs-asset-tile-wrap"
      [class.selected]="selected"
      [class.locked]="locked"
      [class.is-list]="layout === 'list'"
    >
      <button
        type="button"
        class="cs-asset-tile"
        [class.locked]="locked"
        [class.selected]="selected"
        [class.is-list]="layout === 'list'"
        [title]="name"
        [attr.aria-label]="name"
        [attr.draggable]="draggable ? true : null"
        (dragstart)="onDragStart($event)"
        (click)="onClick()"
        (dblclick)="onDblClick($event)"
      >
        <span class="cs-asset-thumb">
          @if (thumbUrl) {
            <img [src]="thumbUrl" alt="" loading="lazy" />
            @if (videoUrl && !durationLabel) {
              <video
                class="cs-asset-probe"
                [src]="videoUrl"
                muted
                preload="metadata"
                playsinline
                (loadedmetadata)="onMediaMeta($event)"
              ></video>
            }
          } @else if (videoUrl) {
            <video
              [src]="videoUrl"
              muted
              preload="metadata"
              playsinline
              (loadedmetadata)="onMediaMeta($event)"
            ></video>
          } @else {
            <span class="material-symbols-outlined" aria-hidden="true">{{ icon }}</span>
          }
          @if (audioUrl && !durationLabel) {
            <audio
              class="cs-asset-probe"
              [src]="audioUrl"
              preload="metadata"
              (loadedmetadata)="onMediaMeta($event)"
            ></audio>
          }
          @if (layout !== 'list') {
            <span class="cs-asset-type-chip" [title]="typeLabel">
              <span class="material-symbols-outlined" aria-hidden="true">{{ icon }}</span>
            </span>
          }
          @if (durationLabel && layout !== 'list') {
            <span class="cs-asset-duration" [title]="'Duration ' + durationLabel">{{
              durationLabel
            }}</span>
          }
          @if (statusChip) {
            <span
              class="cs-asset-status-chip"
              [class.is-processing]="status === 'processing' || status === 'pending'"
              [class.is-failed]="status === 'failed'"
              [title]="statusDetail || statusChip"
            >
              {{ statusChip }}
            </span>
          }
          @if (locked) {
            <span class="cs-ms-locked">locked</span>
          }
        </span>
        @if (showName) {
          <span class="cs-asset-name" [title]="name">{{ name || 'Untitled' }}</span>
        }
        @if (layout === 'list' && (typeLabel || durationLabel)) {
          <span class="cs-asset-type-meta">
            {{ typeLabel }}
            @if (typeLabel && durationLabel) {
              ·
            }
            {{ durationLabel }}
          </span>
        }
      </button>
      @if (inspectable) {
        <div class="cs-asset-tile-actions">
          <button
            type="button"
            class="cs-asset-tile-action"
            title="Preview"
            [attr.aria-label]="'Preview ' + name"
            (click)="onInspect($event)"
          >
            <span class="material-symbols-outlined" aria-hidden="true">visibility</span>
          </button>
          @if (renameable) {
            <button
              type="button"
              class="cs-asset-tile-action"
              title="Rename"
              [attr.aria-label]="'Rename ' + name"
              (click)="onRename($event)"
            >
              <span class="material-symbols-outlined" aria-hidden="true">edit</span>
            </button>
          }
        </div>
      }
      @if (selectable) {
        <button
          type="button"
          class="cs-asset-select-btn"
          [class.is-on]="selected"
          [attr.aria-pressed]="selected"
          [attr.aria-label]="(selected ? 'Deselect ' : 'Select ') + name"
          (click)="selectToggle.emit()"
        >
          <span class="material-symbols-outlined" aria-hidden="true">{{
            selected ? 'check_circle' : 'circle'
          }}</span>
        </button>
      }
    </div>
  `,
})
export class MediaThumbTileComponent implements OnChanges {
  @Input() name = '';
  @Input() thumbUrl: string | null = null;
  @Input() videoUrl: string | null = null;
  @Input() audioUrl: string | null = null;
  @Input() durationS: number | null = null;
  @Input() icon = 'draft';
  @Input() typeLabel = '';
  @Input() locked = false;
  @Input() selected = false;
  @Input() selectable = false;
  @Input() draggable = false;
  @Input() layout: 'grid' | 'list' = 'grid';
  @Input() showName = true;
  @Input() inspectable = false;
  @Input() renameable = false;
  @Input() status: string | null = null;
  @Input() statusDetail: string | null = null;

  @Output() tileClick = new EventEmitter<void>();
  @Output() selectToggle = new EventEmitter<void>();
  @Output() tileDragStart = new EventEmitter<DragEvent>();
  @Output() inspectClick = new EventEmitter<void>();
  @Output() renameClick = new EventEmitter<void>();
  @Output() tileDblClick = new EventEmitter<void>();

  private dragged = false;
  private readonly probedDuration = signal<number | null>(null);

  get durationLabel(): string {
    return formatMediaDuration(mediaDurationSeconds(this.durationS) ?? this.probedDuration());
  }

  get statusChip(): string | null {
    const s = String(this.status || '').toLowerCase();
    if (s === 'processing' || s === 'pending') return 'Working…';
    if (s === 'failed') return 'Failed';
    return null;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['videoUrl'] || changes['audioUrl'] || changes['durationS']) {
      this.probedDuration.set(null);
    }
  }

  onMediaMeta(event: Event): void {
    if (mediaDurationSeconds(this.durationS)) return;
    const el = event.target as HTMLMediaElement;
    const next = mediaDurationSeconds(el.duration);
    if (next) this.probedDuration.set(next);
  }

  onDragStart(event: DragEvent): void {
    if (!this.draggable) {
      event.preventDefault();
      return;
    }
    this.dragged = true;
    this.tileDragStart.emit(event);
  }

  onClick(): void {
    if (this.dragged) {
      this.dragged = false;
      return;
    }
    this.tileClick.emit();
  }

  onDblClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.tileDblClick.emit();
  }

  onInspect(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.inspectClick.emit();
  }

  onRename(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.renameClick.emit();
  }
}
