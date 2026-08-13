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
import { ContentSproutApiService } from '../services/content-sprout-api.service';
import type { TtsChoice, TtsVoiceInfo } from '../models/content-sprout.models';
import { AudioRecorderDialogComponent } from './audio-recorder-dialog';

export type AttachAudioMode = 'generate' | 'record';

export interface AttachAudioResult {
  mode: AttachAudioMode;
  text: string;
  /** Present when mode === 'record'. */
  file?: File;
  voice?: string | null;
  mood?: string | null;
  pacing?: string | null;
}

type Step = 'choose' | 'generate' | 'record';

function asTtsChoices(
  raw: Array<string | TtsChoice> | undefined,
  fallback: TtsChoice,
): TtsChoice[] {
  if (!raw?.length) return [fallback];
  const out: TtsChoice[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) out.push({ id, label: id });
      continue;
    }
    const id = String(item?.id || '').trim();
    const label = String(item?.label || id).trim();
    if (id) out.push({ id, label: label || id });
  }
  return out.length ? out : [fallback];
}

/**
 * Attach spoken audio to a script/text block: generate via TTS or record from mic.
 * Always surfaces the text content so the user can confirm what they are voicing.
 */
@Component({
  selector: 'app-attach-audio-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent, AudioRecorderDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal-wrapper
      [isOpen]="isOpen"
      [title]="title"
      [subtitle]="subtitle()"
      icon="record_voice_over"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      [closeDisabled]="busy()"
      [closeOnOverlayClick]="!busy()"
      (close)="requestClose()"
    >
      <div class="cs-attach-audio">
        <label class="cs-attach-audio-text">
          <span>Text content</span>
          <textarea
            rows="5"
            [ngModel]="draftText()"
            (ngModelChange)="draftText.set($event)"
            [disabled]="busy() || step() === 'record'"
            spellcheck="true"
            aria-label="Text to attach audio for"
          ></textarea>
        </label>

        @if (step() === 'choose') {
          <div class="cs-attach-audio-choices" role="group" aria-label="How to create audio">
            <button type="button" class="cs-attach-audio-choice" (click)="goGenerate()">
              <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
              <strong>Generate audio</strong>
              <span>Create speech from this text with the built-in voice engine</span>
            </button>
            <button type="button" class="cs-attach-audio-choice" (click)="goRecord()">
              <span class="material-symbols-outlined" aria-hidden="true">mic</span>
              <strong>Record audio</strong>
              <span>Capture with your mic (including Bluetooth)</span>
            </button>
          </div>
        }

        @if (step() === 'generate') {
          @if (voicesError()) {
            <p class="cs-attach-audio-error" role="alert">{{ voicesError() }}</p>
          }
          <div class="cs-form-stack cs-form-stack--tight">
            <label>
              <span>Voice</span>
              <select [(ngModel)]="voiceId" [disabled]="busy() || !voices().length">
                @if (!voices().length) {
                  <option value="">Default</option>
                }
                @for (v of voices(); track v.id) {
                  <option [value]="v.id">{{ voiceLabel(v) }}</option>
                }
              </select>
            </label>
            <div class="cs-attach-audio-row">
              <label>
                <span>Mood</span>
                <select [(ngModel)]="mood" [disabled]="busy()">
                  @for (m of moods(); track m.id) {
                    <option [value]="m.id">{{ m.label }}</option>
                  }
                </select>
              </label>
              <label>
                <span>Pacing</span>
                <select [(ngModel)]="pacing" [disabled]="busy()">
                  @for (p of pacings(); track p.id) {
                    <option [value]="p.id">{{ p.label }}</option>
                  }
                </select>
              </label>
            </div>
          </div>
        }

        @if (step() === 'record') {
          <app-audio-recorder-dialog
            [isOpen]="true"
            [embedded]="true"
            [fileStem]="fileStem"
            [promptText]="''"
            (recorded)="onRecorded($event)"
          />
        }
      </div>

      <ng-template #footerActions>
        @if (step() === 'choose') {
          <button type="button" (click)="requestClose()">Cancel</button>
        } @else {
          <button type="button" (click)="backToChoose()" [disabled]="busy()">Back</button>
          <button type="button" (click)="requestClose()" [disabled]="busy()">Cancel</button>
          @if (step() === 'generate') {
            <button
              type="button"
              class="primary"
              (click)="confirmGenerate()"
              [disabled]="busy() || !draftText().trim()"
            >
              {{ busy() ? 'Generating…' : 'Generate' }}
            </button>
          }
        }
      </ng-template>
    </app-modal-wrapper>
  `,
  styles: [
    `
      .cs-attach-audio {
        display: grid;
        gap: 0.9rem;
      }
      .cs-attach-audio-text {
        display: grid;
        gap: 0.35rem;
        font-size: 0.72rem;
        color: var(--muted);
      }
      .cs-attach-audio-text textarea {
        width: 100%;
        resize: vertical;
        min-height: 5.5rem;
        font-size: 0.88rem;
        line-height: 1.45;
        color: var(--text);
      }
      .cs-attach-audio-choices {
        display: grid;
        gap: 0.55rem;
      }
      .cs-attach-audio-choice {
        display: grid;
        grid-template-columns: auto 1fr;
        grid-template-rows: auto auto;
        column-gap: 0.65rem;
        row-gap: 0.15rem;
        text-align: left;
        padding: 0.75rem 0.85rem;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 3%, transparent);
      }
      .cs-attach-audio-choice .material-symbols-outlined {
        grid-row: 1 / span 2;
        align-self: center;
        font-size: 1.45rem;
        color: var(--primary);
      }
      .cs-attach-audio-choice strong {
        font-size: 0.88rem;
        color: var(--text);
      }
      .cs-attach-audio-choice span:last-child {
        font-size: 0.75rem;
        color: var(--muted);
        line-height: 1.35;
      }
      .cs-attach-audio-choice:hover {
        border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
        background: color-mix(in srgb, var(--primary) 8%, transparent);
      }
      .cs-attach-audio-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.55rem;
      }
      .cs-attach-audio-error {
        margin: 0;
        padding: 0.55rem 0.7rem;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
        background: color-mix(in srgb, var(--danger) 12%, transparent);
        color: color-mix(in srgb, var(--danger) 85%, var(--text));
        font-size: 0.78rem;
      }
    `,
  ],
})
export class AttachAudioDialogComponent implements OnChanges {
  @Input() isOpen = false;
  @Input() title = 'Attach audio';
  @Input() text = '';
  @Input() fileStem = 'script-audio';
  @Input() defaultVoice: string | null = null;

  @Output() close = new EventEmitter<void>();
  @Output() attached = new EventEmitter<AttachAudioResult>();

  readonly step = signal<Step>('choose');
  readonly draftText = signal('');
  readonly busy = signal(false);
  readonly voices = signal<TtsVoiceInfo[]>([]);
  readonly moods = signal<TtsChoice[]>([{ id: 'neutral', label: 'Neutral' }]);
  readonly pacings = signal<TtsChoice[]>([{ id: 'natural', label: 'Natural' }]);
  readonly voicesError = signal<string | null>(null);

  voiceId = '';
  mood = 'neutral';
  pacing = 'natural';

  constructor(private api: ContentSproutApiService) {}

  subtitle(): string {
    if (this.step() === 'generate') return 'Generate speech from the text below.';
    if (this.step() === 'record') return 'Record while reading the text below.';
    return 'Generate speech or record audio for this text.';
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] && this.isOpen) {
      this.step.set('choose');
      this.draftText.set(String(this.text || '').trim());
      this.busy.set(false);
      this.voicesError.set(null);
    }
    if (changes['text'] && this.isOpen && this.step() === 'choose') {
      this.draftText.set(String(this.text || '').trim());
    }
  }

  requestClose(): void {
    if (this.busy()) return;
    this.step.set('choose');
    this.close.emit();
  }

  backToChoose(): void {
    if (this.busy()) return;
    this.step.set('choose');
  }

  async goGenerate(): Promise<void> {
    this.step.set('generate');
    await this.ensureVoices();
  }

  goRecord(): void {
    this.step.set('record');
  }

  voiceLabel(v: TtsVoiceInfo): string {
    const region = v.region_label || v.region || v.locale || '';
    return region ? `${v.name} · ${region}` : v.name || v.id;
  }

  confirmGenerate(): void {
    const text = this.draftText().trim();
    if (!text) return;
    this.busy.set(true);
    this.attached.emit({
      mode: 'generate',
      text,
      voice: this.voiceId || null,
      mood: this.mood || null,
      pacing: this.pacing || null,
    });
  }

  onRecorded(file: File): void {
    const text = this.draftText().trim();
    this.attached.emit({
      mode: 'record',
      text,
      file,
    });
  }

  private async ensureVoices(): Promise<void> {
    if (this.voices().length) return;
    this.busy.set(true);
    this.voicesError.set(null);
    try {
      const data = await this.api.listTtsVoices();
      if (!data) {
        this.voicesError.set('Could not load voices. You can still try Generate with the default voice.');
        return;
      }
      if (data.available === false) {
        this.voicesError.set('No speech engine is available on this machine.');
      }
      const list = data.voices || [];
      this.voices.set(list);
      this.moods.set(asTtsChoices(data.moods, { id: 'neutral', label: 'Neutral' }));
      this.pacings.set(asTtsChoices(data.pacings, { id: 'natural', label: 'Natural' }));
      const preferred =
        this.defaultVoice ||
        data.default_voice ||
        list[0]?.id ||
        '';
      this.voiceId = preferred;
      if (!this.moods().some((m) => m.id === this.mood)) {
        this.mood = this.moods()[0]?.id || 'neutral';
      }
      if (!this.pacings().some((p) => p.id === this.pacing)) {
        this.pacing = this.pacings()[0]?.id || 'natural';
      }
    } finally {
      this.busy.set(false);
    }
  }
}
