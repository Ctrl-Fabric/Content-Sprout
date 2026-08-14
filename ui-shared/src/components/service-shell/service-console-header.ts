import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { SnackbarService } from '../../services/snackbar.service';
import { ServiceShellHeaderComponent } from './service-shell-header';
import { ServiceTenantChipComponent } from './service-tenant-chip';
import { ServiceUserMenuComponent } from './service-user-menu';
import { ServiceUserMenuItem } from './service-shell.models';

/**
 * Canonical authenticated console header.
 *
 * Owns title/breadcrumb, tenant chip, and user menu. Product apps may only
 * project **additional** actions via `[headerExtra]` (before the tenant chip)
 * or `[headerAfterTenant]` (between tenant chip and user menu). Do not restyle
 * or reimplement tenant/user chrome in app code.
 *
 * Local / unauthenticated apps can hide chrome with {@link showTenantChip} and
 * {@link showUserMenu} (both default `true` so existing consoles are unchanged).
 *
 * Styles live exclusively in `_service-layout.scss`.
 */
@Component({
  selector: 'app-service-console-header',
  standalone: true,
  imports: [
    CommonModule,
    ServiceShellHeaderComponent,
    ServiceTenantChipComponent,
    ServiceUserMenuComponent,
  ],
  template: `
    <app-service-shell-header
      [title]="title"
      [icon]="icon"
      [appTitle]="appTitle"
      [pageTitle]="pageTitle"
    >
      <div headerRight class="header-actions">
        <ng-content select="[headerExtra]" />

        @if (showTenantChip) {
          <app-service-tenant-chip
            [name]="tenantName"
            [tenantId]="tenantId"
            [logoUrl]="tenantLogoUrl"
            (copied)="onTenantCopied($event)"
          />
        }

        <ng-content select="[headerAfterTenant]" />

        @if (showUserMenu) {
          <app-service-user-menu
            [displayName]="displayName"
            [email]="email"
            [items]="userMenuItems"
            (itemSelect)="userMenuSelect.emit($event)"
          />
        }
      </div>
    </app-service-shell-header>
  `,
  styles: [
    `
      :host {
        display: contents;
      }
    `,
  ],
})
export class ServiceConsoleHeaderComponent {
  private readonly snackbar = inject(SnackbarService);

  /** Single-line title when not using breadcrumb. */
  @Input() title = '';
  @Input() icon: string | null = null;
  @Input() appTitle: string | null = null;
  @Input() pageTitle: string | null = null;

  @Input() tenantName = '';
  @Input() tenantId: string | null = null;
  @Input() tenantLogoUrl: string | null = null;
  /**
   * When true (default), render the organization / tenant chip.
   * Set false for local apps that have no tenant context.
   */
  @Input() showTenantChip = true;
  /**
   * When true (default), show a shared snackbar after copying the tenant id.
   * Set false only if the host app uses a different snackbar implementation
   * and listens to {@link tenantIdCopied}.
   */
  @Input() announceTenantCopy = true;

  @Input() displayName = '';
  @Input() email = '';
  /**
   * Menu rows for the avatar dropdown. Prefer
   * {@link DEFAULT_SERVICE_USER_MENU_ITEMS} so every console matches Identity.
   */
  @Input() userMenuItems: ServiceUserMenuItem[] = [];
  /**
   * When true (default), render the user avatar menu.
   * Set false until the product has a signed-in user / profile.
   */
  @Input() showUserMenu = true;

  @Output() userMenuSelect = new EventEmitter<ServiceUserMenuItem>();
  @Output() tenantIdCopied = new EventEmitter<boolean>();

  onTenantCopied(ok: boolean): void {
    this.tenantIdCopied.emit(ok);
    if (!this.announceTenantCopy) {
      return;
    }
    if (ok) {
      this.snackbar.success('Organization ID copied');
    } else {
      this.snackbar.error(
        this.tenantId
          ? 'Failed to copy organization ID'
          : 'No organization ID available to copy',
      );
    }
  }
}
