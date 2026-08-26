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

export type VideoCaptureSource = 'camera' | 'screen';

interface AvDevice {
  deviceId: string;
  label: string;
}

/**
 * Record camera (built-in or USB) or a screen/window/tab, plus optional mic.
 * Emits a File (webm/mp4). Used on asset pages and the attach-visual dialog.
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
        [subtitle]="
          sourceMode() === 'screen'
            ? 'Pick a screen, window, or tab. Choose with or without microphone.'
            : 'Built-in and USB cameras appear after you allow camera access.'
        "
        [icon]="sourceMode() === 'screen' ? 'screen_share' : 'videocam'"
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

        <div class="cs-vrec-mode" role="tablist" aria-label="Recording source">
          <button
            type="button"
            role="tab"
            [class.active]="sourceMode() === 'camera'"
            [attr.aria-selected]="sourceMode() === 'camera'"
            [disabled]="recording() || busy() || !!blob()"
            (click)="setCapture('camera')"
          >
            <span class="material-symbols-outlined" aria-hidden="true">videocam</span>
            Camera
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="sourceMode() === 'screen'"
            [attr.aria-selected]="sourceMode() === 'screen'"
            [disabled]="recording() || busy() || !!blob()"
            (click)="setCapture('screen')"
          >
            <span class="material-symbols-outlined" aria-hidden="true">screen_share</span>
            Screen
          </button>
        </div>

        <div class="cs-vrec-stage" [class.is-live]="recording()" [class.is-screen]="sourceMode() === 'screen'">
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
              [attr.aria-label]="
                recording()
                  ? 'Recording preview'
                  : sourceMode() === 'screen'
                    ? 'Screen preview'
                    : 'Camera preview'
              "
            ></video>
            @if (!streamReady()) {
              <div class="cs-vrec-placeholder">
                <span class="material-symbols-outlined" aria-hidden="true">{{
                  sourceMode() === 'screen' ? 'screen_share' : 'videocam'
                }}</span>
                <p>
                  @if (busy()) {
                    {{ sourceMode() === 'screen' ? 'Opening screen share…' : 'Opening camera…' }}
                  } @else if (sourceMode() === 'screen') {
                    Share a screen, window, or tab
                  } @else {
                    Camera preview
                  }
                </p>
              </div>
            }
          }
          @if (recording()) {
            <span class="cs-vrec-live-badge" aria-hidden="true">REC</span>
          }
        </div>

        <div
          class="cs-vrec-fields"
          [class.is-single]="sourceMode() === 'screen' && !includeMic()"
        >
          @if (sourceMode() === 'camera') {
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
          } @else {
            <div class="cs-vrec-field">
              <span>Microphone</span>
              <div class="cs-vrec-mic-toggle" role="group" aria-label="Screen recording microphone">
                <button
                  type="button"
                  [class.active]="!includeMic()"
                  [disabled]="recording() || busy() || !!blob()"
                  (click)="setIncludeMic(false)"
                >
                  Without mic
                </button>
                <button
                  type="button"
                  [class.active]="includeMic()"
                  [disabled]="recording() || busy() || !!blob()"
                  (click)="setIncludeMic(true)"
                >
                  With mic
                </button>
              </div>
            </div>
            @if (includeMic()) {
              <label class="cs-vrec-field">
                <span>Mic input</span>
                <select
                  [ngModel]="selectedAudioId()"
                  (ngModelChange)="onAudioDeviceChange($event)"
                  [disabled]="recording() || busy()"
                  aria-label="Microphone input"
                >
                  @if (!audioDevices().length) {
                    <option value="">Default mic</option>
                  }
                  @for (d of audioDevices(); track d.deviceId) {
                    <option [value]="d.deviceId">{{ d.label }}</option>
                  }
                </select>
              </label>
            }
          }
        </div>
        @if (sourceMode() === 'camera') {
          <p class="cs-vrec-hint">
            USB and capture-card cameras appear in this list after the browser is allowed to use
            the camera. Plug in the device, then Refresh devices.
          </p>
        } @else {
          <p class="cs-vrec-hint">
            @if (includeMic()) {
              Narration from the selected mic is mixed into the recording. Chrome can also include
              tab or system audio if you enable it in the share picker.
            } @else {
              No microphone is recorded. Chrome can still include tab or system audio if you enable
              it in the share picker.
            }
          </p>
        }

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
      @if (sourceMode() === 'screen' && !recording() && !blob() && !streamReady()) {
        <button type="button" class="primary" (click)="shareScreen()" [disabled]="busy()">
          <span class="material-symbols-outlined" aria-hidden="true">screen_share</span>
          Share screen
        </button>
      }
      @if (!recording() && !blob() && (sourceMode() === 'camera' || streamReady())) {
        <button
          type="button"
          class="primary"
          (click)="start()"
          [disabled]="busy() || !streamReady()"
        >
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
      .cs-vrec-mode {
        display: flex;
        gap: 0.25rem;
        padding: 0.2rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 3%, transparent);
      }
      .cs-vrec-mode button {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        margin: 0;
        padding: 0.4rem 0.55rem;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 600;
      }
      .cs-vrec-mode button .material-symbols-outlined {
        font-size: 1.05rem;
      }
      .cs-vrec-mode button.active {
        background: color-mix(in srgb, var(--accent, #6366f1) 22%, transparent);
        color: var(--text);
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
      .cs-vrec-stage.is-screen .cs-vrec-video {
        object-fit: contain;
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
      .cs-vrec-fields.is-single {
        grid-template-columns: 1fr;
      }
      .cs-vrec-mic-toggle {
        display: flex;
        gap: 0.25rem;
        padding: 0.2rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 3%, transparent);
      }
      .cs-vrec-mic-toggle button {
        flex: 1;
        margin: 0;
        padding: 0.4rem 0.55rem;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 600;
      }
      .cs-vrec-mic-toggle button.active {
        background: color-mix(in srgb, var(--accent, #6366f1) 22%, transparent);
        color: var(--text);
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
      .cs-vrec-hint {
        margin: -0.35rem 0 0;
        font-size: 0.72rem;
        line-height: 1.4;
        color: var(--muted);
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
  @Input() capture: VideoCaptureSource = 'camera';

  @Output() close = new EventEmitter<void>();
  @Output() recorded = new EventEmitter<File>();
  @Output() recordingChange = new EventEmitter<boolean>();

  @ViewChild('liveVideo') private liveVideo?: ElementRef<HTMLVideoElement>;

  readonly sourceMode = signal<VideoCaptureSource>('camera');
  readonly includeMic = signal(false);
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
  private displayStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private mixCtx: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = 'video/webm';
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private listeningDevices = false;
  private readonly onDeviceChange = (): void => {
    if (!this.isOpen || this.recording() || this.blob()) return;
    void this.loadDevices();
  };

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen']) {
      if (this.isOpen) {
        this.sourceMode.set(this.capture === 'screen' ? 'screen' : 'camera');
        if (this.sourceMode() === 'screen') {
          this.includeMic.set(false);
          this.selectedAudioId.set('');
        }
        void this.prepare();
      } else if (!this.recording()) {
        this.teardown(true);
      }
    } else if (changes['capture'] && this.isOpen && !this.recording() && !this.blob()) {
      this.sourceMode.set(this.capture === 'screen' ? 'screen' : 'camera');
      if (this.sourceMode() === 'screen') {
        this.includeMic.set(false);
        this.selectedAudioId.set('');
      }
      void this.prepare();
    }
  }

  ngOnDestroy(): void {
    this.unbindDeviceListener();
    this.teardown(true);
  }

  requestClose(): void {
    if (this.recording()) return;
    this.teardown(true);
    this.close.emit();
  }

  setCapture(mode: VideoCaptureSource): void {
    if (this.recording() || this.busy() || this.blob()) return;
    if (this.sourceMode() === mode) return;
    this.sourceMode.set(mode);
    this.error.set(null);
    this.clearPreviewBlob();
    if (mode === 'screen') {
      this.includeMic.set(false);
      this.selectedAudioId.set('');
    }
    void this.prepare();
  }

  setIncludeMic(include: boolean): void {
    if (this.recording() || this.busy() || this.blob()) return;
    if (this.includeMic() === include) return;
    this.includeMic.set(include);
    this.error.set(null);
    if (!include) {
      this.selectedAudioId.set('');
      if (this.streamReady()) void this.openPreviewStream();
      return;
    }
    const mics = this.audioDevices();
    if (!this.selectedAudioId() && mics[0]) this.selectedAudioId.set(mics[0].deviceId);
    if (this.streamReady()) void this.openPreviewStream();
    else void this.loadDevices();
  }

  async refreshDevices(): Promise<void> {
    await this.loadDevices();
    if (this.sourceMode() === 'camera' && !this.recording() && !this.blob()) {
      void this.openPreviewStream();
    }
  }

  onVideoDeviceChange(deviceId: string): void {
    this.selectedVideoId.set(deviceId);
    if (!this.recording() && !this.blob()) {
      void this.openPreviewStream();
    }
  }

  onAudioDeviceChange(deviceId: string): void {
    this.selectedAudioId.set(deviceId);
    if (!this.recording() && !this.blob() && this.streamReady()) {
      void this.openPreviewStream();
    }
  }

  async shareScreen(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.openPreviewStream();
    } finally {
      this.busy.set(false);
    }
  }

  async start(): Promise<void> {
    this.error.set(null);
    this.clearPreviewBlob();
    this.busy.set(true);
    try {
      if (!this.stream) await this.openPreviewStream();
      if (!this.stream) {
        throw new Error(
          this.sourceMode() === 'screen' ? 'Screen stream unavailable' : 'Camera stream unavailable',
        );
      }
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
        this.error.set('Recording failed. Check the source and try again.');
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
      this.error.set(captureErrorMessage(err, this.sourceMode()));
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
        this.error.set('Recording was empty. Check the source and try again.');
        this.busy.set(false);
        if (this.sourceMode() === 'camera') void this.openPreviewStream();
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
    if (this.sourceMode() === 'camera') {
      void this.openPreviewStream();
    }
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
    this.stopTracks();
    this.bindDeviceListener();
    this.busy.set(true);
    try {
      if (this.sourceMode() === 'screen') {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          this.error.set('Screen recording is not supported in this browser.');
          return;
        }
        try {
          const warm = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          warm.getTracks().forEach((t) => t.stop());
        } catch {
          /* mic is optional for screen */
        }
        await this.loadDevices();
        return;
      }
      const warm = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      warm.getTracks().forEach((t) => t.stop());
      await this.loadDevices();
      await this.openPreviewStream();
    } catch (err) {
      this.error.set(captureErrorMessage(err, this.sourceMode()));
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
        label: labelForVideoDevice(d, i),
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
    if (this.sourceMode() === 'screen') {
      if (!this.includeMic()) {
        this.selectedAudioId.set('');
        return;
      }
      if (!this.selectedAudioId() && mics[0]) this.selectedAudioId.set(mics[0].deviceId);
      else if (
        this.selectedAudioId() &&
        mics.length &&
        !mics.some((m) => m.deviceId === this.selectedAudioId())
      ) {
        this.selectedAudioId.set(mics[0]?.deviceId || '');
      }
      return;
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
    if (this.sourceMode() === 'screen') {
      await this.openScreenStream();
      return;
    }
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
          this.error.set(captureErrorMessage(fallbackErr, 'camera'));
          return;
        }
      }
      this.error.set(captureErrorMessage(err, 'camera'));
    }
  }

  private async openScreenStream(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error.set('Screen recording is not supported in this browser.');
      return;
    }
    const video: MediaTrackConstraints = {
      frameRate: { ideal: 30 },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    };
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video, audio: true });
    } catch (err) {
      const name = errorName(err);
      if (name === 'NotAllowedError' || name === 'AbortError' || name === 'PermissionDeniedError') {
        this.error.set(captureErrorMessage(err, 'screen'));
        return;
      }
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      } catch (fallbackErr) {
        this.error.set(captureErrorMessage(fallbackErr, 'screen'));
        return;
      }
    }
    this.displayStream = display;
    const videoTrack = display.getVideoTracks()[0];
    videoTrack?.addEventListener(
      'ended',
      () => {
        if (this.recording()) {
          this.stop();
          return;
        }
        this.stopTracks();
        this.streamReady.set(false);
        this.error.set('Screen sharing stopped. Share the screen again to continue.');
      },
      { once: true },
    );

    const audioId = this.includeMic() ? this.selectedAudioId() : '';
    if (audioId) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: audioId },
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch {
        this.error.set('Could not open the selected microphone. Recording without mic audio.');
      }
    }
    this.stream = this.combineDisplayAndMic(display, this.micStream);
    this.bindLivePreview();
    this.streamReady.set(true);
  }

  private combineDisplayAndMic(display: MediaStream, mic: MediaStream | null): MediaStream {
    const videoTracks = display.getVideoTracks();
    const displayAudio = display.getAudioTracks();
    const micAudio = mic?.getAudioTracks() ?? [];
    if (!micAudio.length) {
      return new MediaStream([...videoTracks, ...displayAudio]);
    }
    if (!displayAudio.length) {
      return new MediaStream([...videoTracks, ...micAudio]);
    }
    try {
      const ctx = new AudioContext();
      this.mixCtx = ctx;
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(new MediaStream(displayAudio)).connect(dest);
      ctx.createMediaStreamSource(new MediaStream(micAudio)).connect(dest);
      return new MediaStream([...videoTracks, ...dest.stream.getAudioTracks()]);
    } catch {
      return new MediaStream([...videoTracks, ...displayAudio, ...micAudio]);
    }
  }

  private bindLivePreview(): void {
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
    const seen = new Set<MediaStreamTrack>();
    const stopAll = (s: MediaStream | null): void => {
      s?.getTracks().forEach((t) => {
        if (seen.has(t)) return;
        seen.add(t);
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
    };
    stopAll(this.stream);
    stopAll(this.displayStream);
    stopAll(this.micStream);
    this.stream = null;
    this.displayStream = null;
    this.micStream = null;
    if (this.mixCtx) {
      void this.mixCtx.close().catch(() => undefined);
      this.mixCtx = null;
    }
  }

  private bindDeviceListener(): void {
    if (this.listeningDevices || !navigator.mediaDevices?.addEventListener) return;
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    this.listeningDevices = true;
  }

  private unbindDeviceListener(): void {
    if (!this.listeningDevices || !navigator.mediaDevices?.removeEventListener) return;
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    this.listeningDevices = false;
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
      this.unbindDeviceListener();
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

function labelForVideoDevice(device: MediaDeviceInfo, index: number): string {
  const raw = (device.label || '').trim();
  if (!raw) return `Camera ${index + 1}`;
  return raw;
}

function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err
    ? String((err as { name: string }).name)
    : '';
}

function captureErrorMessage(err: unknown, mode: VideoCaptureSource): string {
  const name = errorName(err);
  if (mode === 'screen') {
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'AbortError') {
      return 'Screen share was cancelled or denied. Click Share screen to try again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No screen or window was available to share.';
    }
    if (name === 'NotSupportedError') {
      return 'Screen recording is not supported in this browser.';
    }
    const msg = err instanceof Error ? err.message : '';
    return msg || 'Could not start screen sharing.';
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera or microphone permission denied. Allow access in the browser (and system) settings.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found. Connect a USB camera or enable the built-in camera, then Refresh devices.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is busy or unavailable. Close other apps using the USB or built-in camera and retry.';
  }
  const msg = err instanceof Error ? err.message : '';
  return msg || 'Could not open the camera.';
}
