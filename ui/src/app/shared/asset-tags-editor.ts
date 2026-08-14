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
import { normalizeAssetTags } from '../models/content-sprout.models';

@Component({
  selector: 'app-asset-tags-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cs-asset-tags">
      <span class="cs-asset-tags-label">Tags</span>
      <div class="cs-asset-tags-row" role="group" [attr.aria-label]="'Asset tags'">
        @for (tag of tags(); track tag) {
          <button
            type="button"
            class="cs-asset-tag"
            [disabled]="disabled"
            [title]="'Remove ' + tag"
            [attr.aria-label]="'Remove tag ' + tag"
            (click)="remove(tag)"
          >
            {{ tag }}
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        }
        <input
          class="cs-asset-tags-input"
          [(ngModel)]="draft"
          [disabled]="disabled || tags().length >= 24"
          placeholder="Add tag…"
          aria-label="Add tag"
          (keydown)="onKeydown($event)"
          (blur)="commitDraft()"
        />
      </div>
      <p class="meta cs-asset-tags-hint">Press Enter or comma to add. Search with the tag name or #tag.</p>
    </div>
  `,
})
export class AssetTagsEditorComponent implements OnChanges {
  @Input() value: string[] | null | undefined = [];
  @Input() disabled = false;
  @Output() tagsChange = new EventEmitter<string[]>();

  readonly tags = signal<string[]>([]);
  draft = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['value']) {
      this.tags.set(normalizeAssetTags(this.value));
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') {
      this.commitDraft(event);
    }
  }

  remove(tag: string): void {
    if (this.disabled) return;
    const next = this.tags().filter((t) => t.toLowerCase() !== tag.toLowerCase());
    this.emit(next);
  }

  commitDraft(event?: Event): void {
    if (event) event.preventDefault();
    if (this.disabled) return;
    const parts = this.draft
      .split(/[,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) {
      this.draft = '';
      return;
    }
    const next = normalizeAssetTags([...this.tags(), ...parts]);
    this.draft = '';
    this.emit(next);
  }

  private emit(next: string[]): void {
    const prev = normalizeAssetTags(this.value);
    const same =
      prev.length === next.length &&
      prev.every((t, i) => t.toLowerCase() === next[i].toLowerCase());
    this.tags.set(next);
    if (!same) this.tagsChange.emit(next);
  }
}
