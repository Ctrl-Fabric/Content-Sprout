import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  booleanAttribute,
  signal,
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

function formatClock(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
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
            <div class="cs-video-preview">
              <video
                #videoEl
                [src]="url"
                [attr.poster]="posterUrl || null"
                [autoplay]="autoplay"
                playsinline
                preload="auto"
                (click)="togglePlay()"
                (loadedmetadata)="onVideoMeta($event)"
                (timeupdate)="onVideoTime()"
                (seeked)="onVideoSeeked()"
                (play)="playing.set(true)"
                (pause)="playing.set(false)"
                (ended)="onVideoEnded()"
              ></video>
              <div class="cs-video-scrub" (pointerdown)="$event.stopPropagation()">
                <button
                  type="button"
                  class="cs-video-scrub-play"
                  [disabled]="!duration()"
                  [attr.aria-label]="playing() ? 'Pause' : 'Play'"
                  (click)="togglePlay()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">{{
                    playing() ? 'pause' : 'play_arrow'
                  }}</span>
                </button>
                <input
                  type="range"
                  class="cs-video-scrub-bar"
                  min="0"
                  [max]="duration() || 0"
                  step="any"
                  [value]="currentTime()"
                  [disabled]="!duration()"
                  [attr.aria-valuetext]="clockLabel()"
                  aria-label="Video timeline"
                  (pointerdown)="beginScrub()"
                  (pointerup)="endScrub($event)"
                  (pointercancel)="endScrub($event)"
                  (input)="onScrubInput($event)"
                  (change)="endScrub($event)"
                />
                <span class="cs-video-scrub-time">{{ clockLabel() }}</span>
              </div>
            </div>
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
export class AssetPreviewPaneComponent implements OnChanges, OnDestroy {
  @ViewChild('videoEl') private videoEl?: ElementRef<HTMLVideoElement>;

  @Input() type = '';
  @Input() filename = '';
  @Input() title = '';
  @Input() previewUrl: string | null = null;
  @Input() posterUrl: string | null = null;
  @Input({ transform: booleanAttribute }) compact = false;
  @Input({ transform: booleanAttribute }) autoplay = true;

  @Output() mediaMeta = new EventEmitter<Event>();

  readonly playing = signal(false);
  readonly duration = signal(0);
  readonly currentTime = signal(0);
  readonly scrubbing = signal(false);

  private wasPlayingBeforeScrub = false;
  private pendingSeek: number | null = null;
  private scrubRaf = 0;
  private resumeAfterSeek = false;

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

  clockLabel(): string {
    return `${formatClock(this.currentTime())} / ${formatClock(this.duration())}`;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['previewUrl']) {
      this.playing.set(false);
      this.duration.set(0);
      this.currentTime.set(0);
      this.resetScrubState();
    }
  }

  ngOnDestroy(): void {
    this.cancelScrubRaf();
  }

  togglePlay(): void {
    const el = this.videoEl?.nativeElement;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }

  onVideoMeta(event: Event): void {
    const el = event.target as HTMLVideoElement;
    const dur = Number(el.duration);
    this.duration.set(Number.isFinite(dur) && dur > 0 ? dur : 0);
    this.currentTime.set(Number.isFinite(el.currentTime) ? el.currentTime : 0);
    this.playing.set(!el.paused && !el.ended);
    this.mediaMeta.emit(event);
  }

  onVideoTime(): void {
    if (this.scrubbing()) return;
    const el = this.videoEl?.nativeElement;
    if (!el) return;
    this.currentTime.set(Number.isFinite(el.currentTime) ? el.currentTime : 0);
    const dur = Number(el.duration);
    if (Number.isFinite(dur) && dur > 0) this.duration.set(dur);
  }

  onVideoSeeked(): void {
    if (this.scrubbing()) return;
    this.maybeResumeAfterScrub();
  }

  onVideoEnded(): void {
    this.playing.set(false);
    const el = this.videoEl?.nativeElement;
    if (el && Number.isFinite(el.duration)) this.currentTime.set(el.duration);
  }

  beginScrub(): void {
    const el = this.videoEl?.nativeElement;
    this.scrubbing.set(true);
    if (!el) return;
    this.wasPlayingBeforeScrub = !el.paused && !el.ended;
    if (!el.paused) el.pause();
  }

  onScrubInput(event: Event): void {
    if (!this.scrubbing()) this.beginScrub();
    const next = this.timeFromEvent(event);
    if (next == null) return;
    this.currentTime.set(next);
    this.pendingSeek = next;
    if (this.scrubRaf) return;
    this.scrubRaf = requestAnimationFrame(() => {
      this.scrubRaf = 0;
      const t = this.pendingSeek;
      this.pendingSeek = null;
      if (t == null) return;
      this.commitSeek(t, true);
    });
  }

  endScrub(event: Event): void {
    this.cancelScrubRaf();
    const next = this.timeFromEvent(event);
    this.pendingSeek = null;
    if (next != null) {
      this.currentTime.set(next);
      this.commitSeek(next, false);
    }
    this.scrubbing.set(false);
    this.resumeAfterSeek = this.wasPlayingBeforeScrub;
    if (!this.resumeAfterSeek) this.wasPlayingBeforeScrub = false;
    this.maybeResumeAfterScrub();
  }

  private timeFromEvent(event: Event): number | null {
    const el = this.videoEl?.nativeElement;
    const input = event.target as HTMLInputElement | null;
    const next = Number(input?.value);
    if (!el || !Number.isFinite(next)) return null;
    const dur = Number(el.duration);
    return Math.min(Math.max(0, next), Number.isFinite(dur) && dur > 0 ? dur : next);
  }

  private commitSeek(seconds: number, approx: boolean): void {
    const el = this.videoEl?.nativeElement;
    if (!el) return;
    try {
      if (approx && typeof el.fastSeek === 'function') el.fastSeek(seconds);
      else el.currentTime = seconds;
    } catch {
      /* ignore seek before ready */
    }
  }

  private maybeResumeAfterScrub(): void {
    if (this.scrubbing() || !this.resumeAfterSeek) return;
    const el = this.videoEl?.nativeElement;
    this.resumeAfterSeek = false;
    this.wasPlayingBeforeScrub = false;
    if (!el || el.ended) return;
    void el.play().catch(() => undefined);
  }

  private cancelScrubRaf(): void {
    if (!this.scrubRaf) return;
    cancelAnimationFrame(this.scrubRaf);
    this.scrubRaf = 0;
  }

  private resetScrubState(): void {
    this.cancelScrubRaf();
    this.scrubbing.set(false);
    this.wasPlayingBeforeScrub = false;
    this.resumeAfterSeek = false;
    this.pendingSeek = null;
  }
}
