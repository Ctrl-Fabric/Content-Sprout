import { CommonModule } from '@angular/common';
import {
  Component,
  Input,
  OnDestroy,
  HostListener,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import {
  ServiceNavChild,
  ServiceNavItem,
  ServiceRailBrand,
} from './service-shell.models';

/**
 * Collapsed icon rail used by product service consoles.
 * Markup + classes match `_service-layout.scss` so all apps share one chrome.
 * Flyout visibility is JS-driven (`.flyout-open`) so it closes on click,
 * outside click, navigation, and mouse leave — not stuck via CSS `:hover`.
 */
@Component({
  selector: 'app-service-side-rail',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.Default,
  host: { class: 'service-side-rail' },
  template: `
    <nav class="sidebar-rail" [attr.aria-label]="ariaLabel">
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
            [class.flyout-open]="openFlyoutIndex() === i"
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

      @if (settingsRoute || settingsChildren?.length) {
        <div class="rail-footer">
          <div
            class="item-wrap"
            [class.flyout-open]="openFlyoutIndex() === -1"
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
        </div>
      }
    </nav>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
    `,
  ],
})
export class ServiceSideRailComponent implements OnDestroy {
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

  openFlyoutIndex = signal<number | null>(null);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private routerSub: Subscription | null = null;
  private readonly router = inject(Router);

  constructor() {
    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.closeFlyout());
  }

  ngOnDestroy(): void {
    this.clearHideTimer();
    this.routerSub?.unsubscribe();
  }

  /** Close when clicking anywhere outside the rail (content, header, etc.). */
  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (this.openFlyoutIndex() === null) {
      return;
    }
    const target = event.target as Node | null;
    const host = (event.currentTarget as Document | null)
      ? null
      : null;
    void host;
    const rail = (event.target as HTMLElement | null)?.closest?.('app-service-side-rail');
    // Prefer checking against this component's host via composed path / closest
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const insideRail = path.some(
      (node) => node instanceof HTMLElement && node.tagName === 'APP-SERVICE-SIDE-RAIL',
    );
    if (!insideRail && !rail) {
      this.closeFlyout();
    }
  }

  openFlyout(index: number): void {
    this.clearHideTimer();
    this.openFlyoutIndex.set(index);
  }

  scheduleCloseFlyout(): void {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.openFlyoutIndex.set(null);
      this.hideTimer = null;
    }, this.flyoutHideDelayMs);
  }

  closeFlyout(): void {
    this.clearHideTimer();
    this.openFlyoutIndex.set(null);
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

  private pathMatches(path: string, route: string): boolean {
    if (!path || !route) return false;
    return path === route || path.startsWith(route + '/');
  }
}
