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
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import type { ExportVariant, Post } from '../../models/content-sprout.models';

@Component({
  selector: 'app-export-workspace',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="cs-dist surface-card">
      <div class="cs-dist-head">
        <div class="min-w-0">
          <h3 class="cs-section-title" style="margin: 0">Export</h3>
          <p class="meta" style="margin: 0.2rem 0 0">
            @if (isVideo()) {
              Master size is the format chosen for this post. Extra sizes are
              downscales of that master render.
            } @else {
              Export the composition at the size chosen for this post.
            }
          </p>
        </div>
        <button
          type="button"
          class="primary"
          (click)="exportSelected()"
          [disabled]="api.busy() || exporting() || !selectedKeys().length"
        >
          {{ exporting() ? 'Exporting…' : isVideo() ? 'Export selected' : 'Export image' }}
        </button>
      </div>

      @if (loadError()) {
        <p class="status-msg">{{ loadError() }}</p>
      } @else if (!variants().length) {
        <p class="cs-empty-inline">Loading export sizes…</p>
      } @else {
        <ul class="cs-variant-list" role="list">
          @for (v of variants(); track v.key) {
            <li>
              <label class="cs-variant-row">
                <input
                  type="checkbox"
                  [checked]="selectedKeys().includes(v.key)"
                  (change)="toggleKey(v.key)"
                />
                <span class="cs-variant-copy">
                  <strong>{{ v.label }}</strong>
                  <span class="meta">{{ v.width }}×{{ v.height }}@if (v.master) { · master }</span>
                </span>
              </label>
            </li>
          }
        </ul>
        @if (isVideo() && variants().length > 1) {
          <p class="meta" style="margin: 0.75rem 0 0">
            Several sizes download as a zip. The master is rendered once; smaller
            versions are scaled from it.
          </p>
        }
      }
    </div>
  `,
})
export class ExportWorkspaceComponent implements OnChanges {
  @Input({ required: true }) post!: Post;
  @Output() exported = new EventEmitter<void>();

  readonly variants = signal<ExportVariant[]>([]);
  readonly selectedKeys = signal<string[]>([]);
  readonly exporting = signal(false);
  readonly loadError = signal<string | null>(null);

  constructor(public api: ContentSproutApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['post'] && this.post?.id) {
      void this.loadVariants();
    }
  }

  isVideo(): boolean {
    return this.post?.type === 'video';
  }

  async loadVariants(): Promise<void> {
    this.loadError.set(null);
    const data = await this.api.getExportVariants(this.post.id);
    const list = data?.variants?.length ? data.variants : [];
    this.variants.set(list);
    this.selectedKeys.set(list.map((v) => v.key));
    if (!list.length) this.loadError.set('Could not load export sizes');
  }

  toggleKey(key: string): void {
    const next = new Set(this.selectedKeys());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    if (!next.size) {
      const master = this.variants().find((v) => v.master) || this.variants()[0];
      if (master) next.add(master.key);
    }
    this.selectedKeys.set([...next]);
  }

  async exportSelected(): Promise<void> {
    const keys = this.selectedKeys();
    if (!keys.length) return;
    this.exporting.set(true);
    try {
      const ok = this.isVideo()
        ? await this.api.exportPostVideo(this.post.id, keys)
        : await this.api.exportPostImage(this.post.id);
      if (ok) this.exported.emit();
    } finally {
      this.exporting.set(false);
    }
  }
}
