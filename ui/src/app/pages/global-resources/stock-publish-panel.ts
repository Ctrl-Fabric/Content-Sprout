import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output,
  computed,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import {
  type PublishPackage,
  type PublishPlatform,
} from '../../models/content-sprout.models';

@Component({
  selector: 'app-stock-publish-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="cs-pm-publish">
      <section class="surface-card">
        <div class="cs-bar">
          <div>
            <h2>Prepare package</h2>
            <p class="meta" style="margin: 0.2rem 0 0">
              Uses the current selection from Shared Library. Configure contributor platforms under
              <a routerLink="/settings" [queryParams]="{ tab: 'stock' }">Settings → Stock Assets Settings</a>.
            </p>
          </div>
        </div>

        <p class="meta">
          @if (!selectedAssetIds.length) {
            No assets selected.
          } @else {
            {{ selectionHint || selectedCountLabel }}
          }
        </p>

        <div class="cs-form-row" style="margin-top: 0.75rem">
          <label>
            <span>Title</span>
            <input [(ngModel)]="publishTitle" />
          </label>
          <label>
            <span>Tags (comma-separated)</span>
            <input [(ngModel)]="publishTags" placeholder="city, night, timelapse" />
          </label>
        </div>
        <div class="cs-form-stack">
          <label>
            <span>Description</span>
            <textarea rows="2" [(ngModel)]="publishDescription"></textarea>
          </label>
        </div>

        <p class="meta" style="margin: 0.75rem 0 0.4rem">Target platforms</p>
        <div class="cs-platform-checks">
          @for (p of enabledPlatforms(); track p.id) {
            <label class="cs-check cs-plat-check">
              <input
                type="checkbox"
                [checked]="publishPlatformIds().has(p.id)"
                (change)="togglePublishPlatform(p.id, $event)"
              />
              {{ p.label || p.id }}
            </label>
          } @empty {
            <p class="cs-empty-inline">
              No enabled platforms —
              <a routerLink="/settings" [queryParams]="{ tab: 'stock' }">configure them in Settings</a>.
            </p>
          }
        </div>

        <div class="page-actions-inline" style="margin-top: 0.85rem">
          <button
            type="button"
            class="primary"
            [disabled]="!canCreatePackage() || api.busy()"
            (click)="createPackage()"
          >
            Create package
          </button>
          <button type="button" (click)="requestLibrary.emit()">Back to library</button>
          @if (selectedAssetIds.length) {
            <button type="button" (click)="clearSelection.emit()">Clear selection</button>
          }
        </div>
      </section>

      <section class="surface-card">
        <div class="cs-bar">
          <div>
            <h2>Recent packages</h2>
            <p class="meta" style="margin: 0.2rem 0 0">
              Open contributor sites, then mark submitted when done
            </p>
          </div>
          <button type="button" (click)="reloadPackages()" [disabled]="api.busy()">
            Refresh
          </button>
        </div>

        <ul class="cs-package-list">
          @for (pkg of packages(); track pkg.id) {
            <li class="cs-package-row surface-inset">
              <div class="cs-package-main">
                <strong>{{ pkg.title || '(untitled)' }}</strong>
                <span class="meta">
                  {{ pkg.status || 'draft' }} ·
                  {{ pkg.file_count || pkg.files?.length || 0 }} files ·
                  {{ platformLabels(pkg) }}
                </span>
                @if (pkg.package_dir) {
                  <span class="meta mono truncate" [title]="pkg.package_dir">{{
                    pkg.package_dir
                  }}</span>
                }
              </div>
              <div class="page-actions-inline">
                <button type="button" (click)="openPackage(pkg)">Open portals</button>
                @if (pkg.status !== 'submitted') {
                  <button type="button" class="primary" (click)="markSubmitted(pkg)">
                    Mark submitted
                  </button>
                }
              </div>
            </li>
          } @empty {
            <li class="cs-empty-inline">No packages yet.</li>
          }
        </ul>
      </section>
    </div>
  `,
})
export class StockPublishPanelComponent implements OnInit {
  @Input() selectedAssetIds: string[] = [];
  @Input() selectedCount?: number;
  @Input() selectionHint = '';

  @Output() clearSelection = new EventEmitter<void>();
  @Output() requestLibrary = new EventEmitter<void>();

  readonly platforms = signal<PublishPlatform[]>([]);
  readonly packages = signal<PublishPackage[]>([]);
  readonly publishPlatformIds = signal<Set<string>>(new Set());

  readonly enabledPlatforms = computed(() =>
    this.platforms().filter((p) => p.enabled !== false && !!p.id),
  );

  publishTitle = '';
  publishDescription = '';
  publishTags = '';

  constructor(public api: ContentSproutApiService) {}

  get selectedCountLabel(): string {
    const n = this.selectedCount ?? this.selectedAssetIds.length;
    return `${n} asset${n === 1 ? '' : 's'} selected`;
  }

  canCreatePackage(): boolean {
    return this.selectedAssetIds.length > 0 && this.publishPlatformIds().size > 0;
  }

  ngOnInit(): void {
    void this.loadPublishData();
  }

  async loadPublishData(): Promise<void> {
    const plats = await this.api.getPublishPlatforms();
    this.platforms.set(plats.map((p) => ({ ...p })));
    this.packages.set(await this.api.listPublishPackages());
    this.syncPublishPlatformSelection();
  }

  private syncPublishPlatformSelection(): void {
    const enabled = this.enabledPlatforms();
    this.publishPlatformIds.set(new Set(enabled.map((p) => p.id)));
  }

  togglePublishPlatform(id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const next = new Set(this.publishPlatformIds());
    if (checked) next.add(id);
    else next.delete(id);
    this.publishPlatformIds.set(next);
  }

  async createPackage(): Promise<void> {
    if (!this.canCreatePackage()) return;
    const tags = this.publishTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const pkg = await this.api.createPublishPackage({
      global_asset_ids: this.selectedAssetIds,
      platform_ids: [...this.publishPlatformIds()],
      title: this.publishTitle.trim(),
      description: this.publishDescription.trim(),
      tags,
    });
    if (pkg) {
      await this.reloadPackages();
    }
  }

  async reloadPackages(): Promise<void> {
    this.packages.set(await this.api.listPublishPackages());
  }

  async openPackage(pkg: PublishPackage): Promise<void> {
    const data = await this.api.openPublishPackage(pkg.id);
    if (!data) return;
    this.packages.update((list) =>
      list.map((p) => (p.id === data.package.id ? data.package : p)),
    );
    for (const entry of data.contributor_urls || []) {
      const url = entry.contributor_url?.trim();
      if (url) window.open(url, '_blank', 'noopener');
    }
  }

  async markSubmitted(pkg: PublishPackage): Promise<void> {
    const updated = await this.api.markPublishPackageSubmitted(pkg.id);
    if (updated) {
      this.packages.update((list) => list.map((p) => (p.id === updated.id ? updated : p)));
    }
  }

  platformLabels(pkg: PublishPackage): string {
    const labels = (pkg.platforms || []).map((p) => p.label || p.id).filter(Boolean);
    return labels.length ? labels.join(', ') : 'no platforms';
  }
}
