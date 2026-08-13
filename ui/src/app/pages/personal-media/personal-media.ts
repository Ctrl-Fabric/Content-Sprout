import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent, DialogService } from '@ctrlfabric/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { ProjectBrowserService } from '../../services/project-browser.service';
import { MediaThumbTileComponent } from '../../shared/media-thumb-tile';
import { AssetInspectComponent } from '../../shared/asset-inspect';
import {
  AssetListViewService,
  AssetViewToggleComponent,
} from '../../shared/asset-list-view';
import {
  assetTypeIcon,
  assetTypeLabel,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
  type MediaFileInfo,
  type ProjectMediaFolder,
  type PublishPackage,
  type PublishPlatform,
} from '../../models/content-sprout.models';

type MmTab = 'local' | 'publish';

@Component({
  selector: 'app-personal-media',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ModalWrapperComponent,
    MediaThumbTileComponent,
    AssetInspectComponent,
    AssetViewToggleComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="page cs-pm-page">
      <div class="page-intro-bar">
        <p class="page-intro" style="margin: 0">
          Browse monitored folders, preview media, import into the open project, and prepare packages
          for stock contributor portals.
        </p>
        <div class="cs-tabs" role="tablist" aria-label="Personal Media sections">
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'local'"
            [attr.aria-selected]="tab() === 'local'"
            (click)="setTab('local')"
          >
            Local library
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'publish'"
            [attr.aria-selected]="tab() === 'publish'"
            (click)="setTab('publish')"
          >
            Publish to stock
          </button>
        </div>
      </div>

      @if (!api.currentProject()) {
        <section class="surface-card cs-empty">
          <span class="material-symbols-outlined" style="font-size: 2rem" aria-hidden="true"
            >folder_open</span
          >
          <h2>Select a project</h2>
          <p>Personal Media folders are scoped to a project. Open one from the header first.</p>
          <div class="page-actions-inline" style="justify-content: center; margin-top: 1rem">
            <button type="button" class="primary" (click)="openBrowser()">Browse projects</button>
          </div>
        </section>
      } @else if (tab() === 'local') {
        <div class="cs-split">
          <section class="surface-card cs-side">
            <div class="cs-bar">
              <h2>Folders</h2>
              <button type="button" class="primary" (click)="showAddFolder.set(true)">Add</button>
            </div>
            <p class="page-intro" style="margin-top: 0">
              Project · <strong>{{ api.currentProject()!.name }}</strong>
            </p>
            <p class="meta" style="margin: 0 0 0.75rem">
              Bookmarks for this project only — register directories to browse (no auto-watch).
            </p>

            @if (showAddFolder()) {
              <div class="cs-form-stack surface-inset cs-pm-side-fixed">
                <label>
                  <span>Label</span>
                  <input [(ngModel)]="newFolderLabel" placeholder="e.g. Downloads" />
                </label>
                <label>
                  <span>Path</span>
                  <div class="page-actions-inline" style="width: 100%">
                    <input
                      class="flex-1"
                      [(ngModel)]="newFolderPath"
                      placeholder="Choose a folder…"
                      readonly
                      style="flex: 1"
                    />
                    <button type="button" (click)="pickFolder()" [disabled]="pickingFolder()">
                      {{ pickingFolder() ? 'Opening…' : 'Browse' }}
                    </button>
                  </div>
                </label>
                <div class="page-actions-inline">
                  <button
                    type="button"
                    class="primary"
                    (click)="addFolder()"
                    [disabled]="!newFolderPath.trim() || pickingFolder()"
                  >
                    Save folder
                  </button>
                  <button type="button" (click)="cancelAddFolder()" [disabled]="pickingFolder()">
                    Cancel
                  </button>
                </div>
              </div>
            }

            <ul class="cs-project-list cs-pm-folder-scroll">
              @for (folder of folders(); track folder.id) {
                <li class="cs-folder-row">
                  <button
                    type="button"
                    class="cs-folder-select"
                    [class.active]="activeFolderId() === folder.id"
                    (click)="selectFolder(folder)"
                  >
                    <strong>
                      {{ folder.label }}
                      @if (folder.enabled === false) {
                        <span class="cs-badge-disabled">disabled</span>
                      }
                    </strong>
                    <span class="meta truncate" [title]="folder.path">{{ folder.path }}</span>
                  </button>
                  <button
                    type="button"
                    class="danger cs-folder-remove"
                    (click)="removeFolder(folder.id)"
                  >
                    Remove
                  </button>
                </li>
              } @empty {
                <li class="cs-empty-inline">No monitored folders yet.</li>
              }
            </ul>
          </section>

          <section class="surface-card cs-main">
            @if (!activeFolderId()) {
              <div class="cs-empty">
                <span class="material-symbols-outlined" style="font-size: 2rem" aria-hidden="true"
                  >photo_library</span
                >
                <h2>Pick a folder</h2>
                <p>Select a monitored folder to list media files.</p>
              </div>
            } @else {
              <div class="cs-bar">
                <div>
                  <h2>Files</h2>
                  <p class="meta" style="margin: 0.2rem 0 0">
                    {{ files().length }} file{{ files().length === 1 ? '' : 's' }}
                    @if (selectedPaths().size) {
                      · {{ selectedPaths().size }} selected
                    }
                  </p>
                </div>
                <div class="page-actions-inline">
                  <button type="button" (click)="loadFiles()" [disabled]="api.busy()">
                    Refresh
                  </button>
                  <button
                    type="button"
                    class="primary"
                    [disabled]="!selectedPaths().size"
                    (click)="openImportDialog()"
                  >
                    Import ({{ selectedPaths().size }})
                  </button>
                  <button
                    type="button"
                    [disabled]="!selectedPaths().size"
                    (click)="preparePublish()"
                  >
                    Prepare publish
                  </button>
                </div>
              </div>

              <div class="cs-pm-toolbar">
                <input
                  [(ngModel)]="fileQuery"
                  (ngModelChange)="onSearchChange()"
                  placeholder="Search files…"
                  aria-label="Search files"
                />
                <select
                  [(ngModel)]="typeFilter"
                  (ngModelChange)="loadFiles()"
                  aria-label="Filter by type"
                >
                  <option value="all">All types</option>
                  <option value="image">Images</option>
                  <option value="video">Video</option>
                  <option value="audio">Audio</option>
                </select>
                <app-asset-view-toggle />
              </div>

              <div class="cs-pm-files-scroll">
                <div
                  class="cs-asset-grid"
                  [class.cs-asset-grid--tiles]="view.layout() === 'grid'"
                  [class.cs-asset-grid--list]="view.layout() === 'list'"
                >
                  @for (file of files(); track file.path) {
                    <app-media-thumb-tile
                      [name]="file.name"
                      [thumbUrl]="isImageThumb(file) ? fileUrl(file) : null"
                      [videoUrl]="isVideoAsset(file.type) ? fileUrl(file) : null"
                      [audioUrl]="isAudioAsset(file.type) ? fileUrl(file) : null"
                      [icon]="iconFor(file)"
                      [typeLabel]="typeLabel(file.type)"
                      [selectable]="true"
                      [selected]="selectedPaths().has(file.path)"
                      [layout]="view.layout()"
                      [inspectable]="true"
                      [renameable]="true"
                      (tileClick)="openPreview(file)"
                      (inspectClick)="openPreview(file)"
                      (renameClick)="openPreview(file)"
                      (selectToggle)="toggleSelect(file.path)"
                    />
                  } @empty {
                    <p class="cs-empty-inline">No matching files.</p>
                  }
                </div>
              </div>
            }
          </section>
        </div>
      } @else {
        <!-- Publish to stock -->
        <div class="cs-pm-publish">
          <section class="surface-card">
            <div class="cs-bar">
              <div>
                <h2>Stock platforms</h2>
                <p class="meta" style="margin: 0.2rem 0 0">
                  Contributor portals — packages prepare files + metadata; upload happens on the site.
                </p>
              </div>
              <div class="page-actions-inline">
                <button type="button" (click)="addPlatform()">Add platform</button>
                <button
                  type="button"
                  class="primary"
                  (click)="savePlatforms()"
                  [disabled]="api.busy()"
                >
                  Save
                </button>
              </div>
            </div>

            <div class="cs-platform-list">
              @for (p of platforms(); track $index; let i = $index) {
                <div class="cs-platform-row surface-inset">
                  <div class="cs-platform-top">
                    <label class="cs-check">
                      <input type="checkbox" [(ngModel)]="p.enabled" />
                      Enabled
                    </label>
                    <input [(ngModel)]="p.label" placeholder="Label" />
                    <button type="button" class="danger" (click)="removePlatform(i)">Remove</button>
                  </div>
                  <input
                    [(ngModel)]="p.contributor_url"
                    placeholder="https://… contributor upload URL"
                  />
                  <input [(ngModel)]="p.notes" placeholder="Notes (optional)" />
                </div>
              } @empty {
                <p class="cs-empty-inline">No platforms yet — add one to get started.</p>
              }
            </div>
          </section>

          <section class="surface-card">
            <div class="cs-bar">
              <div>
                <h2>Prepare package</h2>
                <p class="meta" style="margin: 0.2rem 0 0">
                  Uses the current selection from Local library. Select files there first.
                </p>
              </div>
            </div>

            <p class="meta">
              @if (!selectedPaths().size || !activeFolderId()) {
                No files selected.
              } @else {
                {{ selectedPaths().size }} file{{ selectedPaths().size === 1 ? '' : 's' }} selected
                from Local library.
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
                <p class="cs-empty-inline">Enable at least one platform above.</p>
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
              <button type="button" (click)="setTab('local')">Back to Local library</button>
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
      }
    </div>

    <app-modal-wrapper
      [isOpen]="showImport()"
      title="Import to project"
      [subtitle]="importHint()"
      icon="download"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="showImport.set(false)"
    >
      <div class="cs-form-stack">
        <label>
          <span>Associate with</span>
          <select [(ngModel)]="importScope">
            <option value="">Project shared library</option>
            @for (post of api.projectPosts(); track post.id) {
              <option [value]="post.id">Post · {{ post.name || post.id }}</option>
            }
          </select>
        </label>
        <label>
          <span>Group (optional)</span>
          <input [(ngModel)]="importGroup" placeholder="e.g. Imports" />
        </label>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="showImport.set(false)">Cancel</button>
        <button
          type="button"
          class="primary"
          (click)="confirmImport()"
          [disabled]="api.busy()"
        >
          Import
        </button>
      </ng-template>
    </app-modal-wrapper>

    <app-asset-inspect
      [open]="!!previewFile()"
      [title]="previewFile()?.name || ''"
      [type]="previewFile()?.type || ''"
      [filename]="previewFile()?.name || previewFile()?.path || ''"
      [previewUrl]="previewFile() ? fileUrl(previewFile()!) : null"
      [meta]="previewFile() ? inspectMeta(previewFile()!) : ''"
      [canRename]="true"
      [canDownload]="false"
      [busy]="api.busy()"
      (close)="closePreview()"
      (rename)="renamePreview($event)"
    >
      @if (previewFile(); as file) {
        <div class="page-actions-inline">
          <button type="button" (click)="toggleSelect(file.path)">
            {{ selectedPaths().has(file.path) ? 'Deselect' : 'Select' }}
          </button>
        </div>
      }
    </app-asset-inspect>
  `,
})
export class PersonalMediaPage implements OnDestroy {
  readonly folders = signal<ProjectMediaFolder[]>([]);
  readonly files = signal<MediaFileInfo[]>([]);
  readonly activeFolderId = signal<string | null>(null);
  readonly selectedPaths = signal<Set<string>>(new Set());
  readonly showAddFolder = signal(false);
  readonly pickingFolder = signal(false);
  readonly tab = signal<MmTab>('local');
  readonly showImport = signal(false);
  readonly previewFile = signal<MediaFileInfo | null>(null);
  readonly platforms = signal<PublishPlatform[]>([]);
  readonly packages = signal<PublishPackage[]>([]);
  readonly publishPlatformIds = signal<Set<string>>(new Set());

  readonly enabledPlatforms = computed(() =>
    this.platforms().filter((p) => p.enabled !== false && !!p.id),
  );

  readonly canCreatePackage = computed(
    () =>
      !!this.activeFolderId() &&
      this.selectedPaths().size > 0 &&
      this.publishPlatformIds().size > 0,
  );

  readonly importHint = computed(() => {
    const n = this.selectedPaths().size;
    const name = this.api.currentProject()?.name || 'project';
    return `Import ${n} file${n === 1 ? '' : 's'} into “${name}”.`;
  });

  newFolderLabel = '';
  newFolderPath = '';
  fileQuery = '';
  typeFilter = 'all';
  importScope = '';
  importGroup = '';
  publishTitle = '';
  publishDescription = '';
  publishTags = '';

  isVideoAsset = isVideoAsset;
  isAudioAsset = isAudioAsset;

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public api: ContentSproutApiService,
    private browser: ProjectBrowserService,
    private dialogs: DialogService,
    readonly view: AssetListViewService,
  ) {
    effect(() => {
      const projectId = this.api.currentProject()?.id || null;
      untracked(() => {
        this.activeFolderId.set(null);
        this.files.set([]);
        this.selectedPaths.set(new Set());
        if (projectId) void this.reloadFolders();
        else this.folders.set([]);
      });
    });
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  openBrowser(): void {
    void this.api.loadProjects();
    this.browser.open();
  }

  setTab(tab: MmTab): void {
    this.tab.set(tab);
    if (tab === 'publish') {
      void this.ensurePublishData();
      this.syncPublishPlatformSelection();
    }
  }

  async reloadFolders(): Promise<void> {
    if (!this.api.currentProject()) {
      this.folders.set([]);
      return;
    }
    this.folders.set(await this.api.listMediaFolders());
  }

  async selectFolder(folder: ProjectMediaFolder): Promise<void> {
    this.activeFolderId.set(folder.id);
    this.selectedPaths.set(new Set());
    await this.loadFiles();
  }

  async loadFiles(): Promise<void> {
    const id = this.activeFolderId();
    if (!id) return;
    this.files.set(
      await this.api.listMediaFiles(id, {
        q: this.fileQuery.trim(),
        media_type: this.typeFilter || 'all',
      }),
    );
  }

  onSearchChange(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.loadFiles(), 250);
  }

  async addFolder(): Promise<void> {
    if (!this.newFolderPath.trim()) return;
    const folder = await this.api.addMediaFolder(this.newFolderLabel, this.newFolderPath);
    if (folder) {
      this.cancelAddFolder();
      await this.reloadFolders();
      await this.selectFolder(folder);
    }
  }

  cancelAddFolder(): void {
    this.newFolderLabel = '';
    this.newFolderPath = '';
    this.showAddFolder.set(false);
  }

  async removeFolder(folderId: string): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Remove folder',
      message: 'Remove this monitored folder bookmark? Disk files are not deleted.',
      confirmText: 'Remove',
      type: 'warning',
    });
    if (!ok) return;
    if (await this.api.deleteMediaFolder(folderId)) {
      if (this.activeFolderId() === folderId) {
        this.activeFolderId.set(null);
        this.files.set([]);
        this.selectedPaths.set(new Set());
      }
      await this.reloadFolders();
    }
  }

  async pickFolder(): Promise<void> {
    this.pickingFolder.set(true);
    try {
      const path = await this.api.pickFolderNative('Select a media folder');
      if (!path) return;
      this.newFolderPath = path;
      if (!this.newFolderLabel.trim()) {
        const base = path.split(/[/\\]/).filter(Boolean).pop() || '';
        this.newFolderLabel = base;
      }
    } finally {
      this.pickingFolder.set(false);
    }
  }

  toggleSelect(path: string): void {
    const next = new Set(this.selectedPaths());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.selectedPaths.set(next);
  }

  openImportDialog(): void {
    if (!this.selectedPaths().size || !this.activeFolderId()) return;
    this.importScope = '';
    this.importGroup = '';
    this.showImport.set(true);
  }

  async confirmImport(): Promise<void> {
    const folderId = this.activeFolderId();
    if (!folderId) return;
    const paths = [...this.selectedPaths()];
    if (!paths.length) return;
    const count = await this.api.importMedia(folderId, paths, {
      group: this.importGroup,
      post_id: this.importScope || null,
    });
    if (count) {
      this.selectedPaths.set(new Set());
      this.showImport.set(false);
    }
  }

  preparePublish(): void {
    if (!this.selectedPaths().size) return;
    this.setTab('publish');
  }

  openPreview(file: MediaFileInfo): void {
    this.previewFile.set(file);
  }

  closePreview(): void {
    this.previewFile.set(null);
  }

  inspectMeta(file: MediaFileInfo): string {
    return [this.typeLabel(file.type), file.size_human || file.size, file.path]
      .filter(Boolean)
      .join(' · ');
  }

  async renamePreview(name: string): Promise<void> {
    const file = this.previewFile();
    const folderId = this.activeFolderId();
    if (!file || !folderId || !name.trim() || name.trim() === file.name) return;
    const result = await this.api.renameMediaFile(folderId, file.path, name.trim());
    if (!result) return;
    const selected = new Set(this.selectedPaths());
    if (selected.has(file.path)) {
      selected.delete(file.path);
      selected.add(result.path);
      this.selectedPaths.set(selected);
    }
    await this.loadFiles();
    const next = this.files().find((f) => f.path === result.path);
    this.previewFile.set(next || { ...file, path: result.path, name: result.name });
  }

  private async ensurePublishData(): Promise<void> {
    if (!this.platforms().length) {
      const plats = await this.api.getPublishPlatforms();
      this.platforms.set(plats.map((p) => ({ ...p })));
    }
    if (!this.packages().length) {
      this.packages.set(await this.api.listPublishPackages());
    }
  }

  private syncPublishPlatformSelection(): void {
    const enabled = this.enabledPlatforms();
    this.publishPlatformIds.set(new Set(enabled.map((p) => p.id)));
  }

  addPlatform(): void {
    this.platforms.update((list) => [
      ...list,
      {
        id: '',
        label: 'Custom platform',
        enabled: true,
        contributor_url: '',
        notes: '',
      },
    ]);
  }

  removePlatform(index: number): void {
    this.platforms.update((list) => list.filter((_, i) => i !== index));
    this.syncPublishPlatformSelection();
  }

  async savePlatforms(): Promise<void> {
    const saved = await this.api.savePublishPlatforms(this.platforms());
    if (saved) {
      this.platforms.set(saved.map((p) => ({ ...p })));
      this.syncPublishPlatformSelection();
    }
  }

  togglePublishPlatform(id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const next = new Set(this.publishPlatformIds());
    if (checked) next.add(id);
    else next.delete(id);
    this.publishPlatformIds.set(next);
  }

  async createPackage(): Promise<void> {
    const folderId = this.activeFolderId();
    if (!folderId || !this.canCreatePackage()) return;
    const tags = this.publishTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const pkg = await this.api.createPublishPackage({
      folder_id: folderId,
      paths: [...this.selectedPaths()],
      platform_ids: [...this.publishPlatformIds()],
      title: this.publishTitle.trim(),
      description: this.publishDescription.trim(),
      tags,
    });
    if (pkg) {
      await this.reloadPackages();
      this.tab.set('publish');
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

  isImageThumb(file: MediaFileInfo): boolean {
    return isImageAsset(file.type) || file.type === 'image';
  }

  fileUrl(file: MediaFileInfo): string {
    return this.api.mediaFileUrl(this.activeFolderId() || '', file.path);
  }

  typeLabel(type: string): string {
    return assetTypeLabel(type);
  }

  iconFor(file: MediaFileInfo): string {
    return assetTypeIcon(file.type);
  }
}
