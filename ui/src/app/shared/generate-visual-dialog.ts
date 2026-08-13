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
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_VIDEO_SIZE,
  IMAGE_SIZE_PRESETS,
  VIDEO_SIZE_PRESETS,
  sizeKey,
  type SizePreset,
} from './gen-presets';

export type VisualGenKind = 'image' | 'video';

export interface GenerateVisualResult {
  kind: VisualGenKind;
  prompt: string;
  width: number;
  height: number;
  name?: string;
}

/**
 * Generate an image or video for a script VISUAL / ADD ASSET block.
 * Requires an explicit Image vs Video choice (pre-filled from the marker when known).
 */
@Component({
  selector: 'app-generate-visual-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal-wrapper
      [isOpen]="isOpen"
      [title]="title"
      subtitle="Choose Image or Video for this visual block, then generate."
      icon="auto_awesome"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      [closeDisabled]="busy"
      [closeOnOverlayClick]="!busy"
      (close)="requestClose()"
    >
      <div class="cs-gen-visual cs-form-stack">
        <label>
          <span>Prompt</span>
          <textarea
            rows="5"
            [(ngModel)]="prompt"
            [disabled]="busy"
            spellcheck="true"
            aria-label="Visual generation prompt"
            placeholder="Describe the shot…"
          ></textarea>
        </label>

        <fieldset class="cs-gen-visual-kind">
          <legend>Media type</legend>
          <div class="cs-gen-visual-kind-row" role="radiogroup" aria-label="Image or video">
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="kind() === 'image'"
              [class.active]="kind() === 'image'"
              [disabled]="busy || (!canImage && kind() !== 'image')"
              (click)="setKind('image')"
            >
              <span class="material-symbols-outlined" aria-hidden="true">image</span>
              Image
            </button>
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="kind() === 'video'"
              [class.active]="kind() === 'video'"
              [disabled]="busy || (!canVideo && kind() !== 'video')"
              (click)="setKind('video')"
            >
              <span class="material-symbols-outlined" aria-hidden="true">movie</span>
              Video
            </button>
          </div>
          @if (!kind()) {
            <p class="cs-gen-visual-hint" role="status">Pick Image or Video before generating.</p>
          }
          @if (kind() === 'image' && !canImage) {
            <p class="cs-gen-visual-hint is-warn">Image generation isn’t configured in Settings.</p>
          }
          @if (kind() === 'video' && !canVideo) {
            <p class="cs-gen-visual-hint is-warn">Video generation isn’t configured in Settings.</p>
          }
        </fieldset>

        <label>
          <span>Size</span>
          <select [(ngModel)]="sizeKeyValue" [disabled]="busy || !kind()">
            @for (p of sizeOptions(); track sizeKey(p.width, p.height)) {
              <option [value]="sizeKey(p.width, p.height)">{{ p.label }}</option>
            }
          </select>
        </label>

        <label>
          <span>Asset name (optional)</span>
          <input type="text" [(ngModel)]="name" [disabled]="busy" placeholder="e.g. Hook b-roll" />
        </label>
      </div>

      <ng-template #footerActions>
        <button type="button" (click)="requestClose()" [disabled]="busy">Cancel</button>
        <button
          type="button"
          class="primary"
          (click)="confirm()"
          [disabled]="busy || !canSubmit()"
        >
          {{ busy ? 'Queuing…' : kind() === 'video' ? 'Generate video' : kind() === 'image' ? 'Generate image' : 'Generate' }}
        </button>
      </ng-template>
    </app-modal-wrapper>
  `,
  styles: [
    `
      .cs-gen-visual-kind {
        margin: 0;
        padding: 0;
        border: none;
      }
      .cs-gen-visual-kind legend {
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--muted);
        margin-bottom: 0.35rem;
      }
      .cs-gen-visual-kind-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.45rem;
      }
      .cs-gen-visual-kind-row button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        padding: 0.65rem 0.75rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--text) 3%, transparent);
        font-size: 0.84rem;
      }
      .cs-gen-visual-kind-row button.active {
        border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
        background: color-mix(in srgb, var(--primary) 12%, transparent);
        color: var(--text);
      }
      .cs-gen-visual-kind-row .material-symbols-outlined {
        font-size: 1.15rem;
      }
      .cs-gen-visual-hint {
        margin: 0.45rem 0 0;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .cs-gen-visual-hint.is-warn {
        color: color-mix(in srgb, var(--danger) 75%, var(--text));
      }
    `,
  ],
})
export class GenerateVisualDialogComponent implements OnChanges {
  @Input() isOpen = false;
  @Input() title = 'Generate visual';
  @Input() promptText = '';
  @Input() initialKind: VisualGenKind | null = null;
  @Input() canImage = true;
  @Input() canVideo = true;
  @Input() busy = false;

  @Output() close = new EventEmitter<void>();
  @Output() generate = new EventEmitter<GenerateVisualResult>();

  readonly kind = signal<VisualGenKind | null>(null);
  prompt = '';
  name = '';
  sizeKeyValue = sizeKey(DEFAULT_IMAGE_SIZE.width, DEFAULT_IMAGE_SIZE.height);

  readonly sizeKey = sizeKey;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] && this.isOpen) {
      this.prompt = String(this.promptText || '').trim();
      this.name = '';
      let k = this.initialKind;
      if (k === 'image' && !this.canImage && this.canVideo) k = 'video';
      if (k === 'video' && !this.canVideo && this.canImage) k = 'image';
      if (!k) {
        if (this.canImage) k = 'image';
        else if (this.canVideo) k = 'video';
        else k = null;
      }
      this.kind.set(k);
      this.applyDefaultSize(k);
    }
  }

  setKind(kind: VisualGenKind): void {
    if (kind === 'image' && !this.canImage) return;
    if (kind === 'video' && !this.canVideo) return;
    this.kind.set(kind);
    this.applyDefaultSize(kind);
  }

  sizeOptions(): SizePreset[] {
    return this.kind() === 'video' ? VIDEO_SIZE_PRESETS : IMAGE_SIZE_PRESETS;
  }

  canSubmit(): boolean {
    const k = this.kind();
    if (!k || !this.prompt.trim()) return false;
    if (k === 'image' && !this.canImage) return false;
    if (k === 'video' && !this.canVideo) return false;
    return true;
  }

  requestClose(): void {
    if (this.busy) return;
    this.close.emit();
  }

  confirm(): void {
    const k = this.kind();
    if (!k || !this.canSubmit()) return;
    const preset =
      this.sizeOptions().find((p) => sizeKey(p.width, p.height) === this.sizeKeyValue) ||
      (k === 'video' ? DEFAULT_VIDEO_SIZE : DEFAULT_IMAGE_SIZE);
    this.generate.emit({
      kind: k,
      prompt: this.prompt.trim(),
      width: preset.width,
      height: preset.height,
      name: this.name.trim() || undefined,
    });
  }

  private applyDefaultSize(kind: VisualGenKind | null): void {
    const preset = kind === 'video' ? DEFAULT_VIDEO_SIZE : DEFAULT_IMAGE_SIZE;
    this.sizeKeyValue = sizeKey(preset.width, preset.height);
  }
}
