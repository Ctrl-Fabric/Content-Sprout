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
import { ModalWrapperComponent } from 'shared/ui';
import { ContentSproutApiService } from '../services/content-sprout-api.service';
import {
  assetTypeIcon,
  assetTypeLabel,
  isAudioAsset,
  type Asset,
  type TtsChoice,
  type TtsVoiceInfo,
} from '../models/content-sprout.models';
import { formatMediaDuration } from './media-duration';
import { AudioRecorderDialogComponent } from './audio-recorder-dialog';

export type AttachAudioMode = 'generate' | 'record' | 'asset';

export interface AttachAudioResult {
  mode: AttachAudioMode;
  text: string;
  /** Present when mode === 'record'. */
  file?: File;
  /** Present when mode === 'asset'. */
  asset_id?: string;
  /** Present when mode === 'asset' and the library clip has a known length. */
  duration_s?: number | null;
  voice?: string | null;
  mood?: string | null;
  pacing?: string | null;
}

type AttachableAudio = Asset & { is_global?: boolean };

type Step = 'choose' | 'generate' | 'record' | 'asset';

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
 * Attach spoken audio to a script/text block: pick a library clip, generate via TTS,
 * or record from mic. Always surfaces the text content so the user can confirm what
 * they are voicing.
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
      [size]="step() === 'asset' ? 'medium' : 'small'"
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
            [disabled]="busy() || step() === 'record' || step() === 'asset'"
            spellcheck="true"
            aria-label="Text to attach audio for"
          ></textarea>
        </label>

        @if (step() === 'choose') {
          <div class="cs-attach-audio-choices" role="group" aria-label="How to create audio">
            <button type="button" class="cs-attach-audio-choice" (click)="goAsset()">
              <span class="material-symbols-outlined" aria-hidden="true">library_music</span>
              <strong>From assets</strong>
              <span>Use an existing music or sound clip from the project library</span>
            </button>
            <button type="button" class="cs-attach-audio-choice" (click)="goRecord()">
              <span class="material-symbols-outlined" aria-hidden="true">mic</span>
              <strong>Record audio</strong>
              <span>Capture with your mic (including Bluetooth)</span>
            </button>
            <button type="button" class="cs-attach-audio-choice" (click)="goGenerate()">
              <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
              <strong>Generate audio</strong>
              <span>Create speech from this text with the built-in voice engine</span>
            </button>
          </div>
        }

        @if (step() === 'asset') {
          <label class="cs-attach-audio-search">
            <span>Search library</span>
            <input
              type="search"
              [ngModel]="assetQuery()"
              (ngModelChange)="assetQuery.set($event)"
              placeholder="Name or group…"
              aria-label="Search audio assets"
            />
          </label>
          <ul class="cs-attach-audio-list" role="listbox" aria-label="Audio assets">
            @for (asset of filteredAssets(); track assetKey(asset)) {
              <li>
                <button
                  type="button"
                  role="option"
                  class="cs-attach-audio-item"
                  (click)="pickAsset(asset)"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">{{
                    assetTypeIcon(asset.type)
                  }}</span>
                  <span class="cs-attach-audio-item-main">
                    <strong class="truncate">{{ asset.name }}</strong>
                    <span class="meta"
                      >{{ assetTypeLabel(asset.type)
                      }}{{
                        asset.is_global ? ' · Resources' : asset.post_id ? ' · Post' : ' · Project'
                      }}{{
                        asset.duration_s != null
                          ? ' · ' + formatDur(asset.duration_s)
                          : ''
                      }}</span
                    >
                  </span>
                </button>
              </li>
            } @empty {
              <li class="cs-attach-audio-empty">
                No audio assets yet. Upload music or SFX on the Assets step, or go back and record.
              </li>
            }
          </ul>
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
      .cs-attach-audio-search {
        display: grid;
        gap: 0.35rem;
        font-size: 0.72rem;
        color: var(--muted);
      }
      .cs-attach-audio-search input {
        width: 100%;
        font-size: 0.88rem;
      }
      .cs-attach-audio-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.35rem;
        max-height: min(18rem, 42vh);
        overflow: auto;
      }
      .cs-attach-audio-item {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.65rem;
        align-items: center;
        width: 100%;
        text-align: left;
        padding: 0.65rem 0.75rem;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 3%, transparent);
      }
      .cs-attach-audio-item .material-symbols-outlined {
        font-size: 1.35rem;
        color: var(--primary);
      }
      .cs-attach-audio-item-main {
        display: grid;
        gap: 0.1rem;
        min-width: 0;
      }
      .cs-attach-audio-item-main strong {
        font-size: 0.86rem;
        color: var(--text);
      }
      .cs-attach-audio-item-main .meta {
        font-size: 0.72rem;
        color: var(--muted);
      }
      .cs-attach-audio-item:hover {
        border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
        background: color-mix(in srgb, var(--primary) 8%, transparent);
      }
      .cs-attach-audio-empty {
        padding: 0.85rem 0.5rem;
        font-size: 0.8rem;
        color: var(--muted);
        line-height: 1.4;
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
  /** When set, library assets are scoped to this post (plus project/global). */
  @Input() postId = '';

  @Output() close = new EventEmitter<void>();
  @Output() attached = new EventEmitter<AttachAudioResult>();

  readonly step = signal<Step>('choose');
  readonly draftText = signal('');
  readonly busy = signal(false);
  readonly voices = signal<TtsVoiceInfo[]>([]);
  readonly moods = signal<TtsChoice[]>([{ id: 'neutral', label: 'Neutral' }]);
  readonly pacings = signal<TtsChoice[]>([{ id: 'natural', label: 'Natural' }]);
  readonly voicesError = signal<string | null>(null);
  readonly assetQuery = signal('');
  readonly assetPool = signal<AttachableAudio[]>([]);

  readonly filteredAssets = computed(() => {
    const q = this.assetQuery().trim().toLowerCase();
    return this.assetPool().filter((a) => {
      if (!isAudioAsset(a.type)) return false;
      if (!q) return true;
      const hay = `${a.name || ''} ${a.group || ''} ${a.type || ''} ${a.original_filename || ''}`.toLowerCase();
      return hay.includes(q);
    });
  });

  voiceId = '';
  mood = 'neutral';
  pacing = 'natural';

  assetTypeIcon = assetTypeIcon;
  assetTypeLabel = assetTypeLabel;

  constructor(private api: ContentSproutApiService) {}

  subtitle(): string {
    if (this.step() === 'generate') return 'Generate speech from the text below.';
    if (this.step() === 'record') return 'Record while reading the text below.';
    if (this.step() === 'asset') return 'Pick a music or sound clip from your library.';
    return 'Add audio from assets, record, or generate speech for this text.';
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] && this.isOpen) {
      this.step.set('choose');
      this.draftText.set(String(this.text || '').trim());
      this.busy.set(false);
      this.voicesError.set(null);
      this.assetQuery.set('');
      this.assetPool.set([]);
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

  goAsset(): void {
    this.step.set('asset');
    this.refreshAssetPool();
  }

  assetKey(asset: AttachableAudio): string {
    return asset.is_global ? `global:${asset.id}` : asset.id;
  }

  formatDur(seconds: number | null | undefined): string {
    return formatMediaDuration(seconds);
  }

  pickAsset(asset: AttachableAudio): void {
    const text = this.draftText().trim();
    this.attached.emit({
      mode: 'asset',
      text,
      asset_id: asset.id,
      duration_s: asset.duration_s ?? null,
    });
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

  private refreshAssetPool(): void {
    const project = this.api.currentProject();
    const postId = this.postId;
    const projectAssets = (project?.assets || []).filter(
      (a) => !a.post_id || a.post_id === postId || !postId,
    );
    const globals = (this.api.globalAssets() || []).map((a) => ({
      ...(a as Asset),
      is_global: true as const,
    }));
    const seen = new Set<string>();
    const out: AttachableAudio[] = [];
    for (const a of [...projectAssets, ...globals]) {
      if (!isAudioAsset(a.type) || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
    out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    this.assetPool.set(out);
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
