import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  signal,
} from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import {
  FooterComponent,
  ServiceConsoleHeaderComponent,
  ServiceSideRailComponent,
  SnackbarComponent,
  DialogHostComponent,
  type ServiceFooterLink,
} from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { ProjectBrowserService } from '../../services/project-browser.service';
import { ThemeService } from '../../services/theme.service';
import { APP_BRAND, APP_NAV, titleForPath } from '../../shared/menu.config';
import { ProjectBrowserComponent } from '../project-browser/project-browser';
import { FooterInfoDialogsComponent } from './footer-info-dialogs';

@Component({
  selector: 'app-app-shell',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    FooterComponent,
    ServiceConsoleHeaderComponent,
    ServiceSideRailComponent,
    SnackbarComponent,
    DialogHostComponent,
    ProjectBrowserComponent,
    FooterInfoDialogsComponent,
  ],
  template: `
    <div class="layout-root layout-root--glass-shell" [class.dark-theme]="theme.isDark()">
      <aside class="layout-sidebar collapsed">
        <app-service-side-rail
          [items]="menu"
          [brand]="brand"
          [activePath]="currentPath()"
          [settingsRoute]="'/settings'"
          [settingsActivePaths]="['/settings']"
        />
      </aside>

      <div class="layout-main">
        <header class="layout-header">
          <app-service-console-header
            appTitle="Content-Sprout"
            [pageTitle]="pageTitle()"
            [showTenantChip]="false"
            [showUserMenu]="false"
          >
            <div headerExtra class="cs-header-extras">
              @if (showProjectSelector()) {
                <button
                  type="button"
                  class="cs-project-chip"
                  (click)="openProjectBrowser()"
                  [attr.aria-expanded]="browser.isOpen()"
                  aria-haspopup="dialog"
                  title="View and switch projects"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">folder_open</span>
                  <span class="truncate">{{ api.projectName() }}</span>
                  <span class="material-symbols-outlined cs-chip-caret" aria-hidden="true"
                    >expand_more</span
                  >
                </button>
              }
              <span class="cs-project-chip" title="Available system memory">
                <span class="material-symbols-outlined" aria-hidden="true">memory</span>
                <span>{{ memoryText() }}</span>
              </span>
            </div>
          </app-service-console-header>
        </header>

        @if (api.llmError(); as llmErr) {
          <div class="cs-llm-error-banner" role="alert">
            <span class="material-symbols-outlined" aria-hidden="true">error</span>
            <div class="cs-llm-error-banner-body">
              <strong>AI request failed</strong>
              <p>{{ llmErr }}</p>
            </div>
            <button type="button" (click)="api.clearLlmError()" title="Dismiss">Dismiss</button>
          </div>
        }

        <main class="layout-content">
          <router-outlet />
        </main>

        <div class="layout-footer-wrapper">
          <app-footer
            [links]="footerLinks"
            attribution="Content-sprout · MIT License"
            (linkAction)="onFooterAction($event)"
          />
        </div>
      </div>
    </div>

    <app-project-browser (projectSelected)="onProjectSelected()" />
    <app-footer-info-dialogs #infoDialogs [currentPath]="currentPath()" />
    <app-snackbar />
    <app-dialog-host />
  `,
  changeDetection: ChangeDetectionStrategy.Default,
})
export class AppShell implements OnInit, OnDestroy {
  @ViewChild('infoDialogs') infoDialogs?: FooterInfoDialogsComponent;

  menu = APP_NAV;
  brand = APP_BRAND;

  readonly footerLinks: ServiceFooterLink[] = [
    { label: 'Help · walkthrough', action: 'help' },
    { label: 'About · files stay local', action: 'about' },
    { label: 'Credits', action: 'credits' },
  ];

  currentPath = signal('/media-studio');
  pageTitle = computed(() =>
    titleForPath(this.currentPath(), this.api.currentProject()?.name),
  );
  showProjectSelector = computed(() => !this.currentPath().startsWith('/global-resources'));
  memoryText = computed(() => {
    const bytes = this.api.availableMemoryBytes();
    if (bytes == null) return 'Memory: —';
    const gb = bytes / (1024 ** 3);
    return `Memory: ${gb.toFixed(1)} GB free`;
  });

  private sub = new Subscription();
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private memoryDueAt = 0;
  private memoryIntervalMs = 10000;

  constructor(
    public theme: ThemeService,
    public api: ContentSproutApiService,
    public browser: ProjectBrowserService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    document.body.classList.add('app-glass-shell');
    this.onUrl(this.router.url);
    this.sub.add(
      this.router.events
        .pipe(filter((e) => e instanceof NavigationEnd))
        .subscribe((e) => this.onUrl((e as NavigationEnd).urlAfterRedirects)),
    );
    void this.api.loadConfig();
    void this.api.loadProjects();
    void this.tickMemory(true);
    this.memoryTimer = setInterval(() => void this.tickMemory(), 2000);
  }

  private async tickMemory(force = false): Promise<void> {
    if (this.api.busy()) return;
    const now = Date.now();
    if (!force && now < this.memoryDueAt) return;
    this.memoryDueAt = now + this.memoryIntervalMs;
    const ok = await this.api.refreshSystemMemory();
    this.memoryIntervalMs = ok ? 10000 : Math.min(60000, Math.max(10000, this.memoryIntervalMs) * 2);
  }

  ngOnDestroy(): void {
    document.body.classList.remove('app-glass-shell');
    this.sub.unsubscribe();
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }
  }

  openProjectBrowser(): void {
    void this.api.loadProjects();
    this.browser.open();
  }

  onFooterAction(action: string): void {
    this.infoDialogs?.show(action);
  }

  onProjectSelected(): void {
    const path = this.currentPath();
    if (path.startsWith('/media-studio/posts/')) {
      void this.router.navigateByUrl('/media-studio');
      return;
    }
    if (path.startsWith('/settings')) return;
    if (!path.startsWith('/media-studio') && !path.startsWith('/personal-media')) {
      void this.router.navigateByUrl('/media-studio');
    }
  }

  private onUrl(url: string): void {
    const path = (url || '').split('?')[0].split('#')[0].replace(/\/$/, '') || '/media-studio';
    this.currentPath.set(path.startsWith('/') ? path : `/${path}`);
  }
}
