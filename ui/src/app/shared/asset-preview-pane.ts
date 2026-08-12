import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  booleanAttribute,
} from '@angular/core';
import {
  assetTypeIcon,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
} from '../models/content-sprout.models';

export type AssetInspectKind = 'image' | 'video' | 'audio' | 'pdf' | 'none';

export function fileExtension(name?: string | null): string {
  const n = String(name || '').trim();
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i + 1).toLowerCase() : '';
}

export function assetInspectKind(
  type?: string | null,
  filename?: string | null,
): AssetInspectKind {
  const ext = fileExtension(filename);
  if (ext === 'pdf') return 'pdf';
  if (['ai', 'eps', 'psd', 'obj', 'fbx', 'stl', 'blend'].includes(ext)) return 'none';
  if (isVideoAsset(type || undefined) || ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'].includes(ext)) {
    return 'video';
  }
  if (
    isAudioAsset(type || undefined) ||
    ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff'].includes(ext)
  ) {
    return 'audio';
  }
  if (
    isImageAsset(type || undefined) ||
    ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'avif', 'tif', 'tiff'].includes(ext)
  ) {
    return 'image';
  }
  return 'none';
}

@Component({
  selector: 'app-asset-preview-pane',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cs-inspect-preview" [class.is-compact]="compact">
      @switch (kind) {
        @case ('image') {
          <img [src]="previewUrl!" [alt]="title" />
        }
        @case ('video') {
          @for (url of previewUrl ? [previewUrl] : []; track url) {
            <video
              [src]="url"
              [attr.poster]="posterUrl || null"
              controls
              [autoplay]="autoplay"
              playsinline
              preload="metadata"
              (loadedmetadata)="mediaMeta.emit($event)"
            ></video>
          }
        }
        @case ('audio') {
          <div class="cs-inspect-audio">
            <span class="material-symbols-outlined" aria-hidden="true">{{ icon }}</span>
            @for (url of previewUrl ? [previewUrl] : []; track url) {
              <audio
                [src]="url"
                controls
                [autoplay]="autoplay"
                preload="metadata"
                (loadedmetadata)="mediaMeta.emit($event)"
              ></audio>
            }
          </div>
        }
        @case ('pdf') {
          <iframe class="cs-inspect-pdf" [attr.src]="previewUrl || null" title="PDF preview"></iframe>
        }
        @default {
          <div class="cs-inspect-fallback">
            @if (posterUrl) {
              <img [src]="posterUrl" alt="" />
            } @else {
              <span class="material-symbols-outlined" aria-hidden="true">{{ icon }}</span>
            }
            <p class="cs-empty-inline">{{ fallbackHint }}</p>
          </div>
        }
      }
    </div>
  `,
})
export class AssetPreviewPaneComponent {
  @Input() type = '';
  @Input() filename = '';
  @Input() title = '';
  @Input() previewUrl: string | null = null;
  @Input() posterUrl: string | null = null;
  @Input({ transform: booleanAttribute }) compact = false;
  @Input({ transform: booleanAttribute }) autoplay = true;

  @Output() mediaMeta = new EventEmitter<Event>();

  get kind(): AssetInspectKind {
    const k = assetInspectKind(this.type, this.filename || this.title);
    if (k !== 'none' && !this.previewUrl) return 'none';
    return k;
  }

  get icon(): string {
    return assetTypeIcon(this.type);
  }

  get fallbackHint(): string {
    const ext = fileExtension(this.filename || this.title);
    if (this.type === 'model' || ['glb', 'gltf', 'obj', 'fbx', 'stl'].includes(ext)) {
      return '3D files can be downloaded — in-app viewport isn’t available yet.';
    }
    if (['ai', 'eps', 'psd'].includes(ext)) {
      return 'This vector/source format can’t play in the browser. Download to open it.';
    }
    return 'No in-browser preview for this format. Download to open it.';
  }
}
