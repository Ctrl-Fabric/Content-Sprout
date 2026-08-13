import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent } from '@ctrlfabric/ui';

interface MicDevice {
  deviceId: string;
  label: string;
}

/**
 * Record audio from the system mic (including Bluetooth headsets) and emit a File.
 * Uses getUserMedia + MediaRecorder — pick the Bluetooth device in the mic list
 * (or set it as the OS default input).
 */
@Component({
  selector: 'app-audio-recorder-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (embedded) {
      @if (isOpen) {
        <ng-container *ngTemplateOutlet="recBody" />
        <div class="cs-rec-actions">
          <ng-container *ngTemplateOutlet="recFooter" />
        </div>
      }
    } @else {
      <app-modal-wrapper
        [isOpen]="isOpen"
        [title]="title"
        subtitle="Uses your selected microphone — Bluetooth mics appear once permission is granted."
        icon="mic"
        size="small"
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
      <div class="cs-rec">
        @if (promptText.trim()) {
          <div class="cs-rec-script">
            <span class="cs-rec-script-label">Script text</span>
            <p>{{ promptText.trim() }}</p>
          </div>
        }
        @if (error()) {
          <p class="cs-rec-error" role="alert">{{ error() }}</p>
        }

        <label class="cs-rec-field">
          <span>Microphone</span>
          <select
            [ngModel]="selectedDeviceId()"
            (ngModelChange)="onDeviceChange($event)"
            [disabled]="recording() || busy()"
            aria-label="Microphone input"
          >
            @if (!devices().length) {
              <option value="">Default input</option>
            }
            @for (d of devices(); track d.deviceId) {
              <option [value]="d.deviceId">{{ d.label }}</option>
            }
          </select>
        </label>

        <div class="cs-rec-meter" aria-hidden="true">
          <div class="cs-rec-meter-fill" [style.width.%]="level() * 100"></div>
        </div>

        <div class="cs-rec-timer tabular" [class.is-live]="recording()">
          {{ formatElapsed(elapsedMs()) }}
        </div>

        @if (previewUrl()) {
          <audio class="cs-rec-preview" [src]="previewUrl()!" controls></audio>
        }
      </div>
    </ng-template>

    <ng-template #recFooter>
      @if (!embedded) {
        <button type="button" (click)="requestClose()" [disabled]="busy()">
          {{ blob() ? 'Discard' : 'Cancel' }}
        </button>
      }
      <button type="button" (click)="refreshDevices()" [disabled]="recording() || busy()">
        Refresh mics
      </button>
      @if (!recording() && !blob()) {
        <button type="button" class="primary" (click)="start()" [disabled]="busy()">
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
          <span class="material-symbols-outlined" aria-hidden="true">{{ embedded ? 'check' : 'upload' }}</span>
          {{ embedded ? 'Use recording' : 'Save to library' }}
        </button>
      }
    </ng-template>
  `,
  styles: [
    `
      .cs-rec {
        display: grid;
        gap: 0.85rem;
      }
      .cs-rec-script {
        display: grid;
        gap: 0.35rem;
        padding: 0.65rem 0.75rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 4%, transparent);
      }
      .cs-rec-script-label {
        font-size: 0.68rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .cs-rec-script p {
        margin: 0;
        font-size: 0.88rem;
        line-height: 1.45;
        white-space: pre-wrap;
        color: var(--text);
      }
      .cs-rec-field {
        display: grid;
        gap: 0.3rem;
        font-size: 0.72rem;
        color: var(--muted);
      }
      .cs-rec-field select {
        width: 100%;
      }
      .cs-rec-error {
        margin: 0;
        padding: 0.55rem 0.7rem;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
        background: color-mix(in srgb, var(--danger) 12%, transparent);
        color: color-mix(in srgb, var(--danger) 85%, var(--text));
        font-size: 0.78rem;
        line-height: 1.4;
      }
      .cs-rec-meter {
        height: 0.45rem;
        border-radius: 999px;
        background: color-mix(in srgb, var(--text) 8%, transparent);
        overflow: hidden;
      }
      .cs-rec-meter-fill {
        height: 100%;
        width: 0;
        border-radius: inherit;
        background: linear-gradient(
          90deg,
          color-mix(in srgb, var(--primary) 70%, #22c55e),
          #22c55e 55%,
          #eab308 82%,
          #ef4444
        );
        transition: width 0.08s linear;
      }
      .cs-rec-timer {
        font-size: 1.65rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-align: center;
        color: var(--text);
        font-variant-numeric: tabular-nums;
      }
      .cs-rec-timer.is-live {
        color: #f87171;
      }
      .cs-rec-preview {
        width: 100%;
      }
      .cs-rec-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.45rem;
        margin-top: 0.85rem;
      }
    `,
  ],
})
export class AudioRecorderDialogComponent implements OnChanges, OnDestroy {
  @Input() isOpen = false;
  @Input() title = 'Record audio';
  /** Suggested basename without extension, e.g. voice-memo. */
  @Input() fileStem = 'recording';
  /** When true, render controls without a modal shell (parent owns the dialog). */
  @Input() embedded = false;
  /** Spoken/script copy shown above the recorder. */
  @Input() promptText = '';

  @Output() close = new EventEmitter<void>();
  @Output() recorded = new EventEmitter<File>();

  readonly devices = signal<MicDevice[]>([]);
  readonly selectedDeviceId = signal('');
  readonly recording = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly elapsedMs = signal(0);
  readonly level = signal(0);
  readonly blob = signal<Blob | null>(null);
  readonly previewUrl = signal<string | null>(null);

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = 'audio/webm';
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meterRaf = 0;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen']) {
      if (this.isOpen) {
        void this.prepare();
      } else {
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

  onDeviceChange(deviceId: string): void {
    this.selectedDeviceId.set(deviceId);
    if (!this.recording()) {
      void this.openPreviewStream();
    }
  }

  async start(): Promise<void> {
    this.error.set(null);
    this.clearPreviewBlob();
    this.busy.set(true);
    try {
      await this.openPreviewStream();
      if (!this.stream) throw new Error('Microphone stream unavailable');
      const mime = pickRecorderMime();
      this.mimeType = mime || 'audio/webm';
      this.chunks = [];
      this.recorder = mime
        ? new MediaRecorder(this.stream, { mimeType: mime })
        : new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (ev) => {
        if (ev.data?.size) this.chunks.push(ev.data);
      };
      this.recorder.onerror = () => {
        this.error.set('Recording failed. Check the microphone and try again.');
        this.recording.set(false);
        this.stopTimer();
      };
      this.recorder.start(250);
      this.recording.set(true);
      this.startedAt = Date.now();
      this.elapsedMs.set(0);
      this.timer = setInterval(() => {
        this.elapsedMs.set(Date.now() - this.startedAt);
      }, 200);
    } catch (err) {
      this.error.set(micErrorMessage(err));
      this.stopTracks();
    } finally {
      this.busy.set(false);
    }
  }

  stop(): void {
    const rec = this.recorder;
    if (!rec || rec.state === 'inactive') {
      this.recording.set(false);
      this.stopTimer();
      return;
    }
    this.busy.set(true);
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
      this.chunks = [];
      this.recorder = null;
      this.recording.set(false);
      this.stopTimer();
      this.stopMeter();
      this.stopTracks();
      if (blob.size < 64) {
        this.error.set('Recording was empty. Check the mic and try again.');
        this.busy.set(false);
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
      this.busy.set(false);
      this.stopTimer();
    }
  }

  resetTake(): void {
    this.clearPreviewBlob();
    this.elapsedMs.set(0);
    this.level.set(0);
    void this.openPreviewStream();
  }

  save(): void {
    const blob = this.blob();
    if (!blob) return;
    const ext = extensionForMime(blob.type || this.mimeType);
    const stem = String(this.fileStem || 'recording')
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
    this.level.set(0);
    this.busy.set(true);
    try {
      // Permission prompt (needed before labels show for Bluetooth devices).
      const warm = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      warm.getTracks().forEach((t) => t.stop());
      await this.loadDevices();
      await this.openPreviewStream();
    } catch (err) {
      this.error.set(micErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  private async loadDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.devices.set([]);
      return;
    }
    const list = await navigator.mediaDevices.enumerateDevices();
    const mics = list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      }));
    this.devices.set(mics);
    if (!this.selectedDeviceId() && mics[0]) {
      this.selectedDeviceId.set(mics[0].deviceId);
    } else if (
      this.selectedDeviceId() &&
      mics.length &&
      !mics.some((m) => m.deviceId === this.selectedDeviceId())
    ) {
      this.selectedDeviceId.set(mics[0].deviceId);
    }
  }

  private async openPreviewStream(): Promise<void> {
    this.stopMeter();
    this.stopTracks();
    const deviceId = this.selectedDeviceId();
    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? {
            deviceId: { exact: deviceId },
            echoCancellation: true,
            noiseSuppression: true,
          }
        : {
            echoCancellation: true,
            noiseSuppression: true,
          },
      video: false,
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.startMeter(this.stream);
    } catch (err) {
      // Fallback without exact device if the chosen Bluetooth mic disconnects.
      if (deviceId) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
          this.startMeter(this.stream);
          return;
        } catch (fallbackErr) {
          this.error.set(micErrorMessage(fallbackErr));
          return;
        }
      }
      this.error.set(micErrorMessage(err));
    }
  }

  private startMeter(stream: MediaStream): void {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctx();
      const source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        this.level.set(Math.min(1, peak * 1.8));
        this.meterRaf = requestAnimationFrame(tick);
      };
      this.meterRaf = requestAnimationFrame(tick);
    } catch {
      this.level.set(0);
    }
  }

  private stopMeter(): void {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = 0;
    this.level.set(0);
    try {
      void this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    this.audioCtx = null;
    this.analyser = null;
  }

  private stopTracks(): void {
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
    this.recorder = null;
    this.chunks = [];
    this.stopTimer();
    this.stopMeter();
    this.stopTracks();
    if (full) {
      this.clearPreviewBlob();
      this.elapsedMs.set(0);
      this.error.set(null);
    }
  }
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

function extensionForMime(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return 'webm';
}

function micErrorMessage(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission denied. Allow mic access in the browser (and macOS) settings.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone found. Connect a Bluetooth mic and pair it in system settings.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Microphone is busy or unavailable. Close other apps using it and retry.';
  }
  const msg = err instanceof Error ? err.message : '';
  return msg || 'Could not open the microphone.';
}
