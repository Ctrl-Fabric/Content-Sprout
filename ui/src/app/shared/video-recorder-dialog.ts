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
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent } from 'shared/ui';

interface AvDevice {
  deviceId: string;
  label: string;
}

/**
 * Record camera + mic video and emit a File (webm/mp4).
 * Mirrors the audio recorder pattern for script / asset attach flows.
 */
@Component({
  selector: 'app-video-recorder-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (embedded) {
      @if (isOpen) {
        <ng-container *ngTemplateOutlet="recBody" />
        <div class="cs-vrec-actions">
          <ng-container *ngTemplateOutlet="recFooter" />
        </div>
      }
    } @else {
      <app-modal-wrapper
        [isOpen]="isOpen"
        [title]="title"
        subtitle="Uses your selected camera and microphone."
        icon="videocam"
        size="medium"
        customClass="cs-console-modal"
        closeButtonPosition="header"
        [closeDisabled]="recording()"
        [closeOnOverlayClick]="!recording()"
        (close)="requestClose()"
      >
        <ng-container *ngTemplateOutlet="recBody" />
        <ng-template #footerActions>
          <ng-container *ngTemplateOutlet="recFooter" />
        </ng-template>
      </app-modal-wrapper>
    }

    <ng-template #recBody>
      <div class="cs-vrec">
        @if (promptText.trim()) {
          <div class="cs-vrec-script">
            <span class="cs-vrec-script-label">For</span>
            <p>{{ promptText.trim() }}</p>
          </div>
        }
        @if (error()) {
          <p class="cs-vrec-error" role="alert">{{ error() }}</p>
        }

        <div class="cs-vrec-stage" [class.is-live]="recording()">
          @if (previewUrl() && !recording()) {
            <video
              class="cs-vrec-video"
              [src]="previewUrl()!"
              controls
              playsinline
            ></video>
          } @else {
            <video
              #liveVideo
              class="cs-vrec-video"
              autoplay
              muted
              playsinline
              [attr.aria-label]="recording() ? 'Recording preview' : 'Camera preview'"
            ></video>
            @if (!streamReady()) {
              <div class="cs-vrec-placeholder">
                <span class="material-symbols-outlined" aria-hidden="true">videocam</span>
                <p>{{ busy() ? 'Opening camera…' : 'Camera preview' }}</p>
              </div>
            }
          }
          @if (recording()) {
            <span class="cs-vrec-live-badge" aria-hidden="true">REC</span>
          }
        </div>

        <div class="cs-vrec-fields">
          <label class="cs-vrec-field">
            <span>Camera</span>
            <select
              [ngModel]="selectedVideoId()"
              (ngModelChange)="onVideoDeviceChange($event)"
              [disabled]="recording() || busy()"
              aria-label="Camera"
            >
              @if (!videoDevices().length) {
                <option value="">Default camera</option>
              }
              @for (d of videoDevices(); track d.deviceId) {
                <option [value]="d.deviceId">{{ d.label }}</option>
              }
            </select>
          </label>
          <label class="cs-vrec-field">
            <span>Microphone</span>
            <select
              [ngModel]="selectedAudioId()"
              (ngModelChange)="onAudioDeviceChange($event)"
              [disabled]="recording() || busy()"
              aria-label="Microphone"
            >
              @if (!audioDevices().length) {
                <option value="">Default mic</option>
              }
              @for (d of audioDevices(); track d.deviceId) {
                <option [value]="d.deviceId">{{ d.label }}</option>
              }
            </select>
          </label>
        </div>

        <div class="cs-vrec-timer tabular" [class.is-live]="recording()">
          {{ formatElapsed(elapsedMs()) }}
        </div>
      </div>
    </ng-template>

    <ng-template #recFooter>
      @if (!embedded) {
        <button type="button" (click)="requestClose()" [disabled]="busy()">
          {{ blob() ? 'Discard' : 'Cancel' }}
        </button>
      }
      <button type="button" (click)="refreshDevices()" [disabled]="recording() || busy()">
        Refresh devices
      </button>
      @if (!recording() && !blob()) {
        <button type="button" class="primary" (click)="start()" [disabled]="busy() || !streamReady()">
          <span class="material-symbols-outlined" aria-hidden="true">fiber_manual_record</span>
          Record
        </button>
      }
      @if (recording()) {
        <button type="button" class="danger" (click)="stop()" [disabled]="busy()">
          <span class="material-symbols-outlined" aria-hidden="true">stop</span>
          Stop
        </button>
      }
      @if (blob() && !recording()) {
        <button type="button" (click)="resetTake()" [disabled]="busy()">Re-record</button>
        <button type="button" class="primary" (click)="save()" [disabled]="busy()">
          <span class="material-symbols-outlined" aria-hidden="true">{{
            embedded ? 'check' : 'upload'
          }}</span>
          {{ embedded ? 'Use recording' : 'Save to library' }}
        </button>
      }
    </ng-template>
  `,
  styles: [
    `
      .cs-vrec {
        display: grid;
        gap: 0.85rem;
      }
      .cs-vrec-script {
        display: grid;
        gap: 0.35rem;
        padding: 0.65rem 0.75rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 4%, transparent);
      }
      .cs-vrec-script-label {
        font-size: 0.68rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .cs-vrec-script p {
        margin: 0;
        font-size: 0.88rem;
        line-height: 1.45;
        white-space: pre-wrap;
        color: var(--text);
      }
      .cs-vrec-error {
        margin: 0;
        padding: 0.55rem 0.7rem;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
        background: color-mix(in srgb, var(--danger) 12%, transparent);
        color: color-mix(in srgb, var(--danger) 85%, var(--text));
        font-size: 0.78rem;
        line-height: 1.4;
      }
      .cs-vrec-stage {
        position: relative;
        aspect-ratio: 16 / 9;
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid var(--border);
        background: #0b0b10;
      }
      .cs-vrec-stage.is-live {
        border-color: color-mix(in srgb, #ef4444 55%, var(--border));
      }
      .cs-vrec-video {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        background: #0b0b10;
      }
      .cs-vrec-placeholder {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        gap: 0.35rem;
        justify-items: center;
        color: color-mix(in srgb, #fff 55%, transparent);
        pointer-events: none;
      }
      .cs-vrec-placeholder .material-symbols-outlined {
        font-size: 2rem;
      }
      .cs-vrec-placeholder p {
        margin: 0;
        font-size: 0.78rem;
      }
      .cs-vrec-live-badge {
        position: absolute;
        top: 0.55rem;
        left: 0.55rem;
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
        background: #ef4444;
        color: #fff;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.06em;
      }
      .cs-vrec-fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.55rem;
      }
      .cs-vrec-field {
        display: grid;
        gap: 0.3rem;
        font-size: 0.72rem;
        color: var(--muted);
        min-width: 0;
      }
      .cs-vrec-field select {
        width: 100%;
      }
      .cs-vrec-timer {
        font-size: 1.65rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-align: center;
        color: var(--text);
        font-variant-numeric: tabular-nums;
      }
      .cs-vrec-timer.is-live {
        color: #f87171;
      }
      .cs-vrec-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.45rem;
        margin-top: 0.85rem;
      }
      @media (max-width: 560px) {
        .cs-vrec-fields {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class VideoRecorderDialogComponent implements OnChanges, OnDestroy {
  @Input() isOpen = false;
  @Input() title = 'Record video';
  @Input() fileStem = 'recording';
  @Input() embedded = false;
  @Input() promptText = '';

  @Output() close = new EventEmitter<void>();
  @Output() recorded = new EventEmitter<File>();
  @Output() recordingChange = new EventEmitter<boolean>();

  @ViewChild('liveVideo') private liveVideo?: ElementRef<HTMLVideoElement>;

  readonly videoDevices = signal<AvDevice[]>([]);
  readonly audioDevices = signal<AvDevice[]>([]);
  readonly selectedVideoId = signal('');
  readonly selectedAudioId = signal('');
  readonly recording = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly elapsedMs = signal(0);
  readonly blob = signal<Blob | null>(null);
  readonly previewUrl = signal<string | null>(null);
  readonly streamReady = signal(false);

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = 'video/webm';
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen']) {
      if (this.isOpen) {
        void this.prepare();
      } else if (!this.recording()) {
        this.teardown(true);
      }
    }
  }

  ngOnDestroy(): void {
    this.teardown(true);
  }

  requestClose(): void {
    if (this.recording()) return;
    this.teardown(true);
    this.close.emit();
  }

  async refreshDevices(): Promise<void> {
    await this.loadDevices();
  }

  onVideoDeviceChange(deviceId: string): void {
    this.selectedVideoId.set(deviceId);
    if (!this.recording() && !this.blob()) {
      void this.openPreviewStream();
    }
  }

  onAudioDeviceChange(deviceId: string): void {
    this.selectedAudioId.set(deviceId);
    if (!this.recording() && !this.blob()) {
      void this.openPreviewStream();
    }
  }

  async start(): Promise<void> {
    this.error.set(null);
    this.clearPreviewBlob();
    this.busy.set(true);
    try {
      await this.openPreviewStream();
      if (!this.stream) throw new Error('Camera stream unavailable');
      const mime = pickVideoRecorderMime();
      this.mimeType = mime || 'video/webm';
      this.chunks = [];
      this.recorder = mime
        ? new MediaRecorder(this.stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 })
        : new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (ev) => {
        if (ev.data?.size) this.chunks.push(ev.data);
      };
      this.recorder.onerror = () => {
        this.error.set('Recording failed. Check the camera and try again.');
        this.recording.set(false);
        this.recordingChange.emit(false);
        this.stopTimer();
      };
      this.recorder.start(250);
      this.recording.set(true);
      this.recordingChange.emit(true);
      this.startedAt = Date.now();
      this.elapsedMs.set(0);
      this.timer = setInterval(() => {
        this.elapsedMs.set(Date.now() - this.startedAt);
      }, 200);
    } catch (err) {
      this.error.set(cameraErrorMessage(err));
      this.stopTracks();
      this.streamReady.set(false);
    } finally {
      this.busy.set(false);
    }
  }

  stop(): void {
    const rec = this.recorder;
    if (!rec || rec.state === 'inactive') {
      this.recording.set(false);
      this.recordingChange.emit(false);
      this.stopTimer();
      return;
    }
    this.busy.set(true);
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType || 'video/webm' });
      this.chunks = [];
      this.recorder = null;
      this.recording.set(false);
      this.recordingChange.emit(false);
      this.stopTimer();
      this.stopTracks();
      this.streamReady.set(false);
      if (blob.size < 256) {
        this.error.set('Recording was empty. Check the camera and try again.');
        this.busy.set(false);
        void this.openPreviewStream();
        return;
      }
      this.blob.set(blob);
      this.revokePreviewUrl();
      this.previewUrl.set(URL.createObjectURL(blob));
      this.busy.set(false);
    };
    try {
      rec.stop();
    } catch {
      this.recording.set(false);
      this.recordingChange.emit(false);
      this.busy.set(false);
      this.stopTimer();
    }
  }

  resetTake(): void {
    this.clearPreviewBlob();
    this.elapsedMs.set(0);
    void this.openPreviewStream();
  }

  save(): void {
    const blob = this.blob();
    if (!blob) return;
    const ext = extensionForVideoMime(blob.type || this.mimeType);
    const stem =
      String(this.fileStem || 'recording')
        .trim()
        .replace(/[^\w\-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'recording';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = new File([blob], `${stem}-${stamp}.${ext}`, {
      type: blob.type || this.mimeType,
      lastModified: Date.now(),
    });
    this.recorded.emit(file);
    this.teardown(true);
    this.close.emit();
  }

  formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  private async prepare(): Promise<void> {
    this.error.set(null);
    this.clearPreviewBlob();
    this.elapsedMs.set(0);
    this.streamReady.set(false);
    this.busy.set(true);
    try {
      const warm = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      warm.getTracks().forEach((t) => t.stop());
      await this.loadDevices();
      await this.openPreviewStream();
    } catch (err) {
      this.error.set(cameraErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  private async loadDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.videoDevices.set([]);
      this.audioDevices.set([]);
      return;
    }
    const list = await navigator.mediaDevices.enumerateDevices();
    const cams = list
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
      }));
    const mics = list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      }));
    this.videoDevices.set(cams);
    this.audioDevices.set(mics);
    if (!this.selectedVideoId() && cams[0]) this.selectedVideoId.set(cams[0].deviceId);
    else if (
      this.selectedVideoId() &&
      cams.length &&
      !cams.some((c) => c.deviceId === this.selectedVideoId())
    ) {
      this.selectedVideoId.set(cams[0].deviceId);
    }
    if (!this.selectedAudioId() && mics[0]) this.selectedAudioId.set(mics[0].deviceId);
    else if (
      this.selectedAudioId() &&
      mics.length &&
      !mics.some((m) => m.deviceId === this.selectedAudioId())
    ) {
      this.selectedAudioId.set(mics[0].deviceId);
    }
  }

  private async openPreviewStream(): Promise<void> {
    this.stopTracks();
    this.streamReady.set(false);
    const videoId = this.selectedVideoId();
    const audioId = this.selectedAudioId();
    const constraints: MediaStreamConstraints = {
      video: videoId
        ? {
            deviceId: { exact: videoId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: audioId
        ? {
            deviceId: { exact: audioId },
            echoCancellation: true,
            noiseSuppression: true,
          }
        : {
            echoCancellation: true,
            noiseSuppression: true,
          },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.bindLivePreview();
      this.streamReady.set(true);
    } catch (err) {
      if (videoId || audioId) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true,
          });
          this.bindLivePreview();
          this.streamReady.set(true);
          return;
        } catch (fallbackErr) {
          this.error.set(cameraErrorMessage(fallbackErr));
          return;
        }
      }
      this.error.set(cameraErrorMessage(err));
    }
  }

  private bindLivePreview(): void {
    // Wait a tick so the live <video> exists after blob preview is cleared.
    requestAnimationFrame(() => {
      const el = this.liveVideo?.nativeElement;
      if (!el || !this.stream) return;
      el.srcObject = this.stream;
      void el.play().catch(() => {
        /* autoplay can fail muted-ok; ignore */
      });
    });
  }

  private stopTracks(): void {
    const el = this.liveVideo?.nativeElement;
    if (el) el.srcObject = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private revokePreviewUrl(): void {
    const url = this.previewUrl();
    if (url) URL.revokeObjectURL(url);
    this.previewUrl.set(null);
  }

  private clearPreviewBlob(): void {
    this.blob.set(null);
    this.revokePreviewUrl();
  }

  private teardown(full: boolean): void {
    if (this.recording() && this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.recording.set(false);
    this.recordingChange.emit(false);
    this.recorder = null;
    this.chunks = [];
    this.stopTimer();
    this.stopTracks();
    this.streamReady.set(false);
    if (full) {
      this.clearPreviewBlob();
      this.elapsedMs.set(0);
      this.error.set(null);
    }
  }
}

function pickVideoRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined;
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

function extensionForVideoMime(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4')) return 'mp4';
  return 'webm';
}

function cameraErrorMessage(err: unknown): string {
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera or microphone permission denied. Allow access in the browser (and system) settings.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found. Connect a camera and try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is busy or unavailable. Close other apps using it and retry.';
  }
  const msg = err instanceof Error ? err.message : '';
  return msg || 'Could not open the camera.';
}
