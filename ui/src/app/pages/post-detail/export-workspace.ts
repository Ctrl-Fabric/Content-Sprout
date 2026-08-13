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
import type { ExportJobStatus, ExportVariant, Post, PostExportFile } from '../../models/content-sprout.models';

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
          {{ exportButtonLabel() }}
        </button>
      </div>

      @if (exporting()) {
        <div class="cs-export-progress" role="status" aria-live="polite">
          <div class="cs-export-progress-bar" aria-hidden="true">
            <span [style.width.%]="exportBarWidth()"></span>
          </div>
          <p class="meta cs-export-progress-msg">{{ exportMessage() || 'Starting export…' }}</p>
        </div>
      }

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

      <div class="cs-export-files">
        <div class="cs-export-files-head">
          <h4 class="cs-section-title" style="margin: 0">Exported files</h4>
          <button
            type="button"
            class="linkish"
            (click)="loadExports()"
            [disabled]="exportsLoading()"
          >
            Refresh
          </button>
        </div>
        @if (exportsLoading() && !exports().length) {
          <p class="cs-empty-inline">Loading exports…</p>
        } @else if (!exports().length) {
          <p class="cs-empty-inline">No exports yet. Run Export to create files here.</p>
        } @else {
          <ul class="cs-export-file-list" role="list">
            @for (f of exports(); track f.path) {
              <li>
                <span class="material-symbols-outlined" aria-hidden="true">{{ exportIcon(f.kind) }}</span>
                <div class="cs-export-file-copy">
                  <strong>{{ f.name }}</strong>
                  <span class="meta">{{ formatBytes(f.size_bytes) }} · {{ f.modified_at | date: 'medium' }}</span>
                </div>
                <div class="cs-export-file-actions">
                  @if (openUrl(f); as href) {
                    <a [href]="href" target="_blank" rel="noopener">Open</a>
                  }
                  @if (downloadUrl(f); as href) {
                    <a [href]="href" [attr.download]="f.name">Download</a>
                  }
                </div>
              </li>
            }
          </ul>
        }
      </div>
    </div>
  `,
})
export class ExportWorkspaceComponent implements OnChanges {
  @Input({ required: true }) post!: Post;
  @Output() exported = new EventEmitter<void>();

  readonly variants = signal<ExportVariant[]>([]);
  readonly selectedKeys = signal<string[]>([]);
  readonly exporting = signal(false);
  readonly exportPercent = signal(0);
  readonly exportMessage = signal('');
  readonly loadError = signal<string | null>(null);
  readonly exports = signal<PostExportFile[]>([]);
  readonly exportsLoading = signal(false);

  constructor(public api: ContentSproutApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['post'] && this.post?.id) {
      void this.loadVariants();
      void this.loadExports();
    }
  }

  isVideo(): boolean {
    return this.post?.type === 'video';
  }

  exportButtonLabel(): string {
    if (!this.exporting()) return this.isVideo() ? 'Export selected' : 'Export image';
    const pct = Math.round(this.exportPercent());
    return pct > 0 ? `Exporting… ${pct}%` : 'Exporting…';
  }

  exportBarWidth(): number {
    return Math.max(2, Math.min(100, this.exportPercent() || 0));
  }

  exportIcon(kind?: string): string {
    if (kind === 'video') return 'movie';
    if (kind === 'archive') return 'folder_zip';
    return 'image';
  }

  formatBytes(bytes?: number): string {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    const gb = mb / 1024;
    return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
  }

  openUrl(file: PostExportFile): string | null {
    return this.api.exportFileUrl(file.path, { cacheKey: file.modified_at || null });
  }

  downloadUrl(file: PostExportFile): string | null {
    return this.api.exportFileUrl(file.path, {
      download: true,
      cacheKey: file.modified_at || null,
    });
  }

  async loadVariants(): Promise<void> {
    this.loadError.set(null);
    const data = await this.api.getExportVariants(this.post.id);
    const list = data?.variants?.length ? data.variants : [];
    this.variants.set(list);
    this.selectedKeys.set(list.map((v) => v.key));
    if (!list.length) this.loadError.set('Could not load export sizes');
  }

  async loadExports(): Promise<void> {
    if (!this.post?.id) return;
    this.exportsLoading.set(true);
    try {
      this.exports.set(await this.api.listPostExports(this.post.id));
    } finally {
      this.exportsLoading.set(false);
    }
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
    this.exportPercent.set(1);
    this.exportMessage.set('Starting export…');
    const onProgress = (job: ExportJobStatus) => {
      this.exportPercent.set(Number(job.percent) || 0);
      this.exportMessage.set(job.message || job.error || '');
    };
    try {
      const ok = await this.api.runExportJob(
        this.post.id,
        this.isVideo() ? 'video' : 'image',
        this.isVideo() ? keys : [],
        this.isVideo() ? (keys.length > 1 ? 'post_exports.zip' : 'post.mp4') : 'post.jpg',
        onProgress,
      );
      if (ok) {
        this.exported.emit();
        await this.loadExports();
      }
    } finally {
      this.exporting.set(false);
      this.exportPercent.set(0);
      this.exportMessage.set('');
    }
  }
}
