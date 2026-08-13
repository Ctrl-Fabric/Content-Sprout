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
import { assetTypeIcon, assetTypeLabel } from '../models/content-sprout.models';
import { AssetPreviewPaneComponent } from './asset-preview-pane';
import { formatMediaDuration, mediaDurationSeconds } from './media-duration';

export { assetInspectKind, fileExtension, type AssetInspectKind } from './asset-preview-pane';

@Component({
  selector: 'app-asset-inspect',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent, AssetPreviewPaneComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal-wrapper
      [isOpen]="open"
      [title]="title || 'Asset'"
      [subtitle]="typeLabel"
      [icon]="icon"
      size="large"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="close.emit()"
    >
      <div class="cs-asset-detail">
        <app-asset-preview-pane
          [type]="type"
          [filename]="filename || title"
          [title]="title"
          [previewUrl]="previewUrl"
          [posterUrl]="posterUrl"
          (mediaMeta)="onMediaMeta($event)"
        />

        <div class="cs-asset-detail-meta">
          @if (durationLabel) {
            <p class="meta cs-inspect-duration" style="margin: 0">
              <span class="material-symbols-outlined" aria-hidden="true">schedule</span>
              {{ durationLabel }}
            </p>
          }
          @if (meta) {
            <p class="meta" style="margin: 0">{{ meta }}</p>
          }
          @if (canRename) {
            <label class="cs-ms-inline-field">
              <span>Name</span>
              <div class="cs-inspect-rename">
                <input
                  [(ngModel)]="draftName"
                  [disabled]="busy"
                  (keydown.enter)="submitRename()"
                  aria-label="Asset name"
                />
                <button
                  type="button"
                  class="primary"
                  [disabled]="!canSubmitRename() || busy"
                  (click)="submitRename()"
                >
                  Rename
                </button>
              </div>
            </label>
          }
          <ng-content />
        </div>
      </div>
      <ng-template #footerActions>
        @if (canDownload) {
          <button type="button" (click)="download.emit()" [disabled]="busy">Download</button>
        }
        <button type="button" class="primary" (click)="close.emit()">Close</button>
      </ng-template>
    </app-modal-wrapper>
  `,
})
export class AssetInspectComponent implements OnChanges {
  @Input() open = false;
  @Input() title = '';
  @Input() type = '';
  @Input() filename = '';
  @Input() previewUrl: string | null = null;
  @Input() posterUrl: string | null = null;
  @Input() meta = '';
  @Input() durationS: number | null = null;
  @Input() canRename = true;
  @Input() canDownload = false;
  @Input() busy = false;

  @Output() close = new EventEmitter<void>();
  @Output() rename = new EventEmitter<string>();
  @Output() download = new EventEmitter<void>();

  draftName = '';
  private readonly probedDuration = signal<number | null>(null);

  get typeLabel(): string {
    const base = assetTypeLabel(this.type);
    return this.durationLabel ? `${base} · ${this.durationLabel}` : base;
  }

  get durationLabel(): string {
    return formatMediaDuration(mediaDurationSeconds(this.durationS) ?? this.probedDuration());
  }

  get icon(): string {
    return assetTypeIcon(this.type);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open'] || changes['title'] || changes['filename']) {
      this.draftName = this.title || '';
    }
    if (changes['open'] || changes['previewUrl'] || changes['durationS']) {
      this.probedDuration.set(null);
    }
  }

  onMediaMeta(event: Event): void {
    if (mediaDurationSeconds(this.durationS)) return;
    const el = event.target as HTMLMediaElement;
    const next = mediaDurationSeconds(el.duration);
    if (next) this.probedDuration.set(next);
  }

  canSubmitRename(): boolean {
    const next = this.draftName.trim();
    return !!next && next !== (this.title || '').trim();
  }

  submitRename(): void {
    if (!this.canRename || !this.canSubmitRename() || this.busy) return;
    this.rename.emit(this.draftName.trim());
  }
}
