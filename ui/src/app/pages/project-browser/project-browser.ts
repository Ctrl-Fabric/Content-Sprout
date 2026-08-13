import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent, DialogService } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { ProjectBrowserService } from '../../services/project-browser.service';
import type { ProjectSummary } from '../../models/content-sprout.models';

type ProjectSort = 'created' | 'modified';

@Component({
  selector: 'app-project-browser',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <app-modal-wrapper
      [isOpen]="browser.isOpen()"
      title="Projects"
      subtitle="Open a project for Media Studio. Personal Media and Global Resources work from the side rail anytime."
      icon="folder_open"
      size="large"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="close()"
    >
      <div class="cs-pb">
        <div class="cs-pb-toolbar">
          <span class="meta">{{ ordered().length }} project{{ ordered().length === 1 ? '' : 's' }}</span>
          <div class="page-actions-inline">
            <input
              class="cs-pb-search"
              [(ngModel)]="query"
              placeholder="Search…"
              aria-label="Search projects"
            />
            <label class="cs-pb-sort">
              <span>Sort</span>
              <select [(ngModel)]="sort">
                <option value="created">Created date</option>
                <option value="modified">Last modified</option>
              </select>
            </label>
            <button type="button" (click)="refresh()" [disabled]="api.busy()">Refresh</button>
            <button type="button" class="primary cs-pb-new" (click)="startCreate()">
              <span class="material-symbols-outlined" aria-hidden="true">add</span>
              New
            </button>
          </div>
        </div>

        @if (creating()) {
          <div class="surface-inset cs-form-stack" style="margin-bottom: 1rem">
            <label>
              <span>Project name</span>
              <input
                [(ngModel)]="newName"
                placeholder="Campaign / brand"
                (keydown.enter)="create()"
              />
            </label>
            <div class="page-actions-inline">
              <button type="button" class="primary" (click)="create()" [disabled]="api.busy()">
                Create
              </button>
              <button type="button" (click)="creating.set(false)">Cancel</button>
            </div>
          </div>
        }

        <ul class="cs-pb-grid">
          @for (project of ordered(); track project.id) {
            <li>
              <article
                class="cs-pb-card"
                [class.active]="api.currentProject()?.id === project.id"
              >
                <button type="button" class="cs-pb-card-main" (click)="select(project)">
                  <div class="cs-pb-card-top">
                    <strong>{{ project.name }}</strong>
                    @if (api.currentProject()?.id === project.id) {
                      <span class="cs-pb-badge">Open</span>
                    }
                  </div>
                  <span class="meta">
                    {{ project.post_count ?? 0 }} posts · {{ project.asset_count ?? 0 }} assets
                  </span>
                  <span class="meta">
                    {{ sort === 'modified' ? 'Modified' : 'Created' }}
                    {{ formatWhen(project) }}
                  </span>
                </button>
                <div class="cs-pb-card-actions">
                  <button type="button" class="cs-pb-open" (click)="select(project)">Open</button>
                  <button
                    type="button"
                    class="cs-pb-delete"
                    (click)="remove(project, $event)"
                  >
                    Delete
                  </button>
                </div>
              </article>
            </li>
          } @empty {
            <li class="cs-empty-inline" style="grid-column: 1 / -1">
              No projects yet — create one to continue.
            </li>
          }
        </ul>
      </div>
    </app-modal-wrapper>
  `,
})
export class ProjectBrowserComponent {
  @Output() projectSelected = new EventEmitter<ProjectSummary>();

  readonly creating = signal(false);
  query = '';
  sort: ProjectSort = 'modified';
  newName = '';

  constructor(
    public api: ContentSproutApiService,
    public browser: ProjectBrowserService,
    private dialogs: DialogService,
  ) {}

  ordered(): ProjectSummary[] {
    const q = this.query.trim().toLowerCase();
    let list = [...this.api.projects()];
    if (q) {
      list = list.filter((p) => (p.name || '').toLowerCase().includes(q));
    }
    const key = this.sort === 'modified' ? 'updated_at' : 'created_at';
    list.sort((a, b) => String(b[key] || '').localeCompare(String(a[key] || '')));
    return list;
  }

  close(): void {
    this.creating.set(false);
    this.browser.close();
  }

  startCreate(): void {
    this.creating.set(true);
    this.newName = '';
  }

  async refresh(): Promise<void> {
    await this.api.loadProjects();
  }

  async create(): Promise<void> {
    const name = this.newName.trim();
    if (!name) return;
    const project = await this.api.createProject(name);
    if (project) {
      this.creating.set(false);
      this.newName = '';
      this.projectSelected.emit({
        id: project.id,
        name: project.name,
        post_count: project.post_count,
        asset_count: project.asset_count,
        created_at: project.created_at,
        updated_at: project.updated_at,
      });
      this.close();
    }
  }

  async select(project: ProjectSummary): Promise<void> {
    if (this.api.currentProject()?.id !== project.id) {
      await this.api.selectProject(project.id);
    }
    this.projectSelected.emit(project);
    this.close();
  }

  async remove(project: ProjectSummary, event: Event): Promise<void> {
    event.stopPropagation();
    const confirmed = await this.dialogs.confirm({
      title: 'Delete project',
      message: `Delete project “${project.name}”? Posts and assets in this project will be removed.`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!confirmed) return;
    const ok = await this.api.deleteProject(project.id);
    if (ok) this.projectSelected.emit(project);
  }

  formatWhen(project: ProjectSummary): string {
    const raw = this.sort === 'modified' ? project.updated_at : project.created_at;
    if (!raw) return '—';
    try {
      return new Date(raw).toLocaleString();
    } catch {
      return String(raw);
    }
  }
}
