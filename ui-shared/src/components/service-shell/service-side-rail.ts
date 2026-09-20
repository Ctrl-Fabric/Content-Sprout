import { CommonModule } from '@angular/common';
import {
  Component,
  Input,
  OnDestroy,
  OnChanges,
  SimpleChanges,
  HostListener,
  inject,
  signal,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import {
  DEFAULT_SERVICE_USER_MENU_ITEMS,
  ServiceNavChild,
  ServiceNavItem,
  ServiceRailBrand,
  ServiceRailUserProfile,
  ServiceUserMenuItem,
} from './service-shell.models';

/**
 * Icon rail used by product service consoles.
 * Collapsed: icon rail with hover flyouts.
 * Expanded: floating two-column overlay (labeled nav + rich panel) with backdrop blur.
 * Markup + classes match `_service-layout.scss`.
 */
@Component({
  selector: 'app-service-side-rail',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.Default,
  host: { class: 'service-side-rail' },
  template: `
    <nav
      class="sidebar-rail"
      [class.sidebar-rail--overlay-open]="expanded"
      [attr.aria-label]="ariaLabel"
    >
      <a class="brand-link" [routerLink]="brand.href" [attr.aria-label]="brand.ariaLabel">
        @if (brand.imgSrc) {
          <img class="brand-img" [src]="brand.imgSrc" alt="" />
        } @else if (brand.markIcon) {
          <span class="brand-mark material-symbols-outlined" aria-hidden="true">{{
            brand.markIcon
          }}</span>
        }
      </a>

      <div class="rail-items">
        @for (item of items; track item.route + item.label; let i = $index) {
          <div
            class="item-wrap"
            [class.flyout-open]="!expanded && openFlyoutIndex() === i"
            (mouseenter)="openFlyout(i)"
            (mouseleave)="scheduleCloseFlyout()"
          >
            <a
              class="nav-item"
              [routerLink]="item.route"
              [class.active]="isItemActive(item)"
              [class.has-active-route]="isItemActive(item)"
              [attr.aria-label]="item.label"
              (click)="closeFlyout()"
            >
              <span class="material-symbols-outlined">{{ item.icon }}</span>
            </a>

            <div class="flyout" (mouseenter)="openFlyout(i)" (mouseleave)="scheduleCloseFlyout()">
              <a
                class="flyout-title"
                [routerLink]="item.route"
                [class.active]="isItemActive(item) && !item.children?.length"
                (click)="closeFlyout()"
              >
                <span>{{ item.label }}</span>
                @if (item.badge || item.planned) {
                  <span class="rail-badge">{{ item.badge || 'Soon' }}</span>
                }
              </a>
              @if (item.children?.length) {
                <div class="flyout-children">
                  @for (child of item.children; track child.route) {
                    <a
                      class="flyout-child"
                      [routerLink]="child.route"
                      [class.active]="isChildActive(item, child)"
                      (click)="closeFlyout()"
                    >
                      <span class="material-symbols-outlined">{{ child.icon }}</span>
                      {{ child.label }}
                    </a>
                  }
                </div>
              }
            </div>
          </div>
        }
      </div>

      <div class="rail-footer">
        @if (expandable) {
          <button
            type="button"
            class="nav-item ghost rail-expand-toggle"
            (click)="toggleExpanded()"
            [attr.aria-label]="expanded ? 'Collapse side menu' : 'Expand side menu'"
            [attr.aria-expanded]="expanded"
            [title]="expanded ? 'Collapse menu' : 'Expand menu'"
          >
            <span class="material-symbols-outlined">{{
              expanded ? 'left_panel_close' : 'left_panel_open'
            }}</span>
          </button>
        }

        @if (settingsRoute || settingsChildren?.length) {
          <div
            class="item-wrap"
            [class.flyout-open]="!expanded && openFlyoutIndex() === -1"
            (mouseenter)="openFlyout(-1)"
            (mouseleave)="scheduleCloseFlyout()"
          >
            <a
              class="nav-item ghost"
              [routerLink]="settingsRoute || settingsChildren?.[0]?.route || '/app/settings'"
              [class.active]="isSettingsActive()"
              [class.has-active-route]="isSettingsActive()"
              aria-label="Settings"
              (click)="closeFlyout()"
            >
              <span class="material-symbols-outlined">settings</span>
            </a>
            <div
              class="flyout"
              (mouseenter)="openFlyout(-1)"
              (mouseleave)="scheduleCloseFlyout()"
            >
              <a
                class="flyout-title"
                [routerLink]="settingsRoute || '/app/settings'"
                [class.active]="isSettingsRouteActive()"
                (click)="closeFlyout()"
              >
                Settings
              </a>
              @if (settingsChildren?.length) {
                <div class="flyout-children">
                  @for (child of settingsChildren; track child.route) {
                    <a
                      class="flyout-child"
                      [routerLink]="child.route"
                      routerLinkActive="active"
                      [routerLinkActiveOptions]="{ exact: false }"
                      (click)="closeFlyout()"
                    >
                      <span class="material-symbols-outlined">{{ child.icon }}</span>
                      {{ child.label }}
                    </a>
                  }
                </div>
              }
            </div>
          </div>
        }
      </div>
    </nav>

    @if (expandable) {
      <div
        class="rail-overlay-backdrop"
        [class.rail-overlay-backdrop--open]="expanded"
        (click)="setExpanded(false)"
        aria-hidden="true"
      ></div>

      <div
        class="rail-overlay-panel"
        [class.rail-overlay-panel--open]="expanded"
        role="dialog"
        [attr.aria-modal]="expanded"
        [attr.aria-hidden]="!expanded"
        [attr.aria-label]="ariaLabel + ' expanded'"
      >
        <div class="rail-overlay-nav">
          <a
            class="brand-link brand-link--overlay"
            [routerLink]="brand.href"
            [attr.aria-label]="brand.ariaLabel"
            (click)="setExpanded(false)"
          >
            @if (brand.imgSrc) {
              <img class="brand-img" [src]="brand.imgSrc" alt="" />
            } @else if (brand.markIcon) {
              <span class="brand-mark material-symbols-outlined" aria-hidden="true">{{
                brand.markIcon
              }}</span>
            }
            <span class="brand-wordmark">Ctrl-Fabric</span>
          </a>

          <div class="rail-overlay-nav-scroll">
            @for (item of items; track item.route + item.label) {
              @if (item.children?.length) {
                <div class="rail-group" [class.has-active-route]="isItemActive(item)">
                  <div class="rail-group-label">
                    <span class="material-symbols-outlined">{{ item.icon }}</span>
                    <span>{{ item.label }}</span>
                  </div>
                  <div class="rail-group-children">
                    @for (child of item.children; track child.route) {
                      <a
                        class="nav-item nav-item--child"
                        [routerLink]="child.route"
                        [class.active]="isChildActive(item, child)"
                        [class.is-active]="isChildActive(item, child)"
                        [attr.aria-label]="child.label"
                        (click)="onOverlayNavClick()"
                      >
                        <span class="material-symbols-outlined">{{ child.icon }}</span>
                        <span class="nav-label">{{ child.label }}</span>
                      </a>
                    }
                  </div>
                </div>
              } @else {
                <a
                  class="nav-item"
                  [routerLink]="item.route"
                  [class.active]="isItemActive(item)"
                  [class.has-active-route]="isItemActive(item)"
                  [class.is-active]="isItemActive(item)"
                  [attr.aria-label]="item.label"
                  (click)="onOverlayNavClick()"
                >
                  <span class="material-symbols-outlined">{{ item.icon }}</span>
                  <span class="nav-label">{{ item.label }}</span>
                  @if (item.badge || item.planned) {
                    <span class="rail-badge">{{ item.badge || 'Soon' }}</span>
                  }
                </a>
              }
            }
          </div>

          <div class="rail-overlay-nav-footer">
            <button
              type="button"
              class="nav-item ghost rail-expand-toggle"
              (click)="setExpanded(false)"
              aria-label="Collapse side menu"
              [attr.aria-expanded]="true"
            >
              <span class="material-symbols-outlined">left_panel_close</span>
              <span class="nav-label">Collapse menu</span>
            </button>

            @if (settingsRoute || settingsChildren?.length) {
              @if (settingsChildren?.length) {
                <div class="rail-group" [class.has-active-route]="isSettingsActive()">
                  <div class="rail-group-label">
                    <span class="material-symbols-outlined">settings</span>
                    <span>Settings</span>
                  </div>
                  <div class="rail-group-children">
                    @for (child of settingsChildren; track child.route) {
                      <a
                        class="nav-item nav-item--child ghost"
                        [routerLink]="child.route"
                        [class.active]="pathMatches(activePath, child.route)"
                        [class.is-active]="pathMatches(activePath, child.route)"
                        (click)="onOverlayNavClick()"
                      >
                        <span class="material-symbols-outlined">{{ child.icon }}</span>
                        <span class="nav-label">{{ child.label }}</span>
                      </a>
                    }
                  </div>
                </div>
              } @else {
                <a
                  class="nav-item ghost"
                  [routerLink]="settingsRoute || '/app/settings'"
                  [class.active]="isSettingsActive()"
                  [class.has-active-route]="isSettingsActive()"
                  [class.is-active]="isSettingsActive()"
                  aria-label="Settings"
                  (click)="onOverlayNavClick()"
                >
                  <span class="material-symbols-outlined">settings</span>
                  <span class="nav-label">Settings</span>
                </a>
              }
            }
          </div>
        </div>

        <div class="rail-rich-panel">
          @if (userProfile) {
            <div class="rail-user-card rail-card">
              <div class="rail-user-card__head">
                <div class="rail-user-avatar" aria-hidden="true">
                  @if (userProfile.avatarUrl) {
                    <img [src]="userProfile.avatarUrl" alt="" />
                  } @else if (profileInitials) {
                    <span class="rail-user-initials">{{ profileInitials }}</span>
                  } @else {
                    <span class="material-symbols-outlined">account_circle</span>
                  }
                </div>
                <div class="rail-user-meta">
                  @if (userProfile.displayName) {
                    <div class="rail-user-name">{{ userProfile.displayName }}</div>
                  }
                  @if (userProfile.email) {
                    <div class="rail-user-email">{{ userProfile.email }}</div>
                  }
                  @if (userProfile.tenantName) {
                    <div class="rail-user-tenant">{{ userProfile.tenantName }}</div>
                  }
                </div>
              </div>
              @if (resolvedUserMenuItems.length) {
                <div class="rail-user-actions">
                  @for (item of resolvedUserMenuItems; track item.id) {
                    <button
                      type="button"
                      class="rail-user-action"
                      [class.rail-user-action--danger]="item.danger"
                      (click)="onUserMenuItem(item)"
                    >
                      <span class="material-symbols-outlined">{{ item.icon }}</span>
                      <span>{{ item.label }}</span>
                    </button>
                  }
                </div>
              }
            </div>
          }

          <ng-content select="[railCards]"></ng-content>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        position: relative;
      }
    `,
  ],
})
export class ServiceSideRailComponent implements OnDestroy, OnChanges {
  @Input({ required: true }) items: ServiceNavItem[] = [];
  @Input({ required: true }) brand!: ServiceRailBrand;
  @Input() activePath = '';
  @Input() ariaLabel = 'Primary';
  @Input() settingsRoute: string | null = '/app/settings';
  @Input() settingsChildren: ServiceNavChild[] | null = null;
  /** Extra paths that should mark Settings as active (e.g. `/update-identity`). */
  @Input() settingsActivePaths: string[] = [];
  /** Hide delay for flyouts (ms). Allows cursor travel across the gap. */
  @Input() flyoutHideDelayMs = 180;

  /** When true, footer shows expand toggle and overlay can open. */
  @Input() expandable = true;
  /** Controlled expanded (overlay open) state. */
  @Input() expanded = false;
  /** Profile for the rich panel user card. */
  @Input() userProfile: ServiceRailUserProfile | null = null;
  /** Quick actions on the user card; defaults to canonical Identity menu. */
  @Input() userMenuItems: ServiceUserMenuItem[] | null = null;

  readonly expandedChange = output<boolean>();
  readonly userMenuSelect = output<ServiceUserMenuItem>();

  openFlyoutIndex = signal<number | null>(null);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private routerSub: Subscription | null = null;
  private readonly router = inject(Router);

  get resolvedUserMenuItems(): ServiceUserMenuItem[] {
    return this.userMenuItems?.length
      ? this.userMenuItems
      : [...DEFAULT_SERVICE_USER_MENU_ITEMS];
  }

  get profileInitials(): string {
    if (this.userProfile?.initials?.trim()) {
      return this.userProfile.initials.trim().slice(0, 2).toUpperCase();
    }
    const name = (this.userProfile?.displayName || '').trim();
    if (!name) return '';
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  constructor() {
    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => {
        this.closeFlyout();
        if (this.expanded) {
          this.setExpanded(false);
        }
      });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['expanded']) {
      this.syncOverlayBodyClass(this.expanded);
      if (this.expanded) {
        this.closeFlyout();
      }
    }
  }

  ngOnDestroy(): void {
    this.clearHideTimer();
    this.routerSub?.unsubscribe();
    document.body.classList.remove('sidebar-overlay-open');
    document.body.classList.remove('expanded-menu-open');
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.expanded) {
      this.setExpanded(false);
    }
  }

  /** Close flyout when clicking anywhere outside the rail. */
  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (this.openFlyoutIndex() === null) {
      return;
    }
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const insideRail = path.some(
      (node) => node instanceof HTMLElement && node.tagName === 'APP-SERVICE-SIDE-RAIL',
    );
    const rail = (event.target as HTMLElement | null)?.closest?.('app-service-side-rail');
    if (!insideRail && !rail) {
      this.closeFlyout();
    }
  }

  toggleExpanded(): void {
    this.setExpanded(!this.expanded);
  }

  setExpanded(next: boolean): void {
    if (!this.expandable || next === this.expanded) {
      if (next === this.expanded) {
        this.syncOverlayBodyClass(next);
      }
      return;
    }
    if (next) {
      this.closeFlyout();
    }
    this.expandedChange.emit(next);
    // Parent may bind [expanded]; sync body class immediately for fluid feel.
    this.syncOverlayBodyClass(next);
  }

  onOverlayNavClick(): void {
    this.setExpanded(false);
  }

  onUserMenuItem(item: ServiceUserMenuItem): void {
    this.userMenuSelect.emit(item);
  }

  private syncOverlayBodyClass(open: boolean): void {
    if (open) {
      document.body.classList.add('sidebar-overlay-open');
      document.body.classList.add('expanded-menu-open');
    } else {
      document.body.classList.remove('sidebar-overlay-open');
      // Only remove expanded-menu-open if no flyout is holding it.
      if (this.openFlyoutIndex() === null) {
        document.body.classList.remove('expanded-menu-open');
      }
    }
  }

  openFlyout(index: number): void {
    if (this.expanded) {
      return;
    }
    this.clearHideTimer();
    this.openFlyoutIndex.set(index);
    document.body.classList.add('expanded-menu-open');
  }

  scheduleCloseFlyout(): void {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.openFlyoutIndex.set(null);
      this.hideTimer = null;
      if (!this.expanded) {
        document.body.classList.remove('expanded-menu-open');
      }
    }, this.flyoutHideDelayMs);
  }

  closeFlyout(): void {
    this.clearHideTimer();
    this.openFlyoutIndex.set(null);
    if (!this.expanded) {
      document.body.classList.remove('expanded-menu-open');
    }
  }

  private clearHideTimer(): void {
    if (this.hideTimer != null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  isItemActive(item: ServiceNavItem): boolean {
    const path = this.activePath;
    if (this.pathMatches(path, item.route)) {
      return true;
    }
    return !!item.children?.some((child) => this.pathMatches(path, child.route));
  }

  /**
   * Prefer the most specific sibling when child routes nest
   * (e.g. `/subscriptions` vs `/subscriptions/testing`).
   */
  isChildActive(item: ServiceNavItem, child: ServiceNavChild): boolean {
    if (!this.pathMatches(this.activePath, child.route)) {
      return false;
    }
    return !item.children?.some(
      (other) =>
        other.route !== child.route &&
        other.route.length > child.route.length &&
        this.pathMatches(this.activePath, other.route),
    );
  }

  isSettingsRouteActive(): boolean {
    const route = this.settingsRoute || '/app/settings';
    return this.pathMatches(this.activePath, route);
  }

  isSettingsActive(): boolean {
    if (this.isSettingsRouteActive()) return true;
    if (this.settingsChildren?.some((c) => this.pathMatches(this.activePath, c.route))) {
      return true;
    }
    return this.settingsActivePaths.some((p) => this.pathMatches(this.activePath, p));
  }

  pathMatches(path: string, route: string): boolean {
    if (!path || !route) return false;
    return path === route || path.startsWith(route + '/');
  }
}
