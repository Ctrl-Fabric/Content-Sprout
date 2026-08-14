/**
 * Shared nav / chrome models for service glass shells.
 */
export interface ServiceNavChild {
  label: string;
  route: string;
  icon: string;
}

export interface ServiceNavItem {
  label: string;
  /** Primary route opened when the rail icon is clicked. */
  route: string;
  icon: string;
  children?: ServiceNavChild[];
  /** Optional flyout badge (e.g. "Soon"). */
  badge?: string;
  planned?: boolean;
}

export interface ServiceRailBrand {
  href: string;
  ariaLabel: string;
  /** Image under assets/, e.g. `assets/logos/logo_short.png`. */
  imgSrc?: string;
  /** Fallback Material Symbol when no image is provided. */
  markIcon?: string;
}

/** Footer legal / utility link. */
export interface ServiceFooterLink {
  label: string;
  /** Router path (internal) or absolute URL. Required unless `action` is set. */
  path?: string;
  /** When true, open in a new tab via href instead of routerLink. */
  external?: boolean;
  /**
   * App-handled action id (e.g. `help`, `about`). When set, the footer emits
   * `linkAction` instead of navigating.
   */
  action?: string;
}

/** User-menu row in the glass header dropdown. */
export interface ServiceUserMenuItem {
  id: string;
  label: string;
  icon: string;
  /** Marks the row as destructive (e.g. Sign out). */
  danger?: boolean;
  /** Insert a divider before this item. */
  dividerBefore?: boolean;
}

/**
 * Canonical console user-menu items (Identity UI).
 * Product apps should pass this list and handle `user` / `session` / `sign-out`.
 */
export const DEFAULT_SERVICE_USER_MENU_ITEMS: readonly ServiceUserMenuItem[] = [
  { id: 'user', label: 'User Information', icon: 'info' },
  { id: 'session', label: 'Session Details', icon: 'lock' },
  { id: 'sign-out', label: 'Sign Out', icon: 'logout', danger: true, dividerBefore: true },
];

/** Kind of account dialog opened from the header user menu. */
export type ServiceAccountInfoKind = 'user' | 'session';

/** Fields shown in the shared User Information dialog. */
export interface ServiceAccountUserInfo {
  displayName?: string | null;
  email?: string | null;
  userName?: string | null;
  userId?: string | null;
}

/** Fields shown in the shared Session Details dialog. */
export interface ServiceAccountSessionInfo {
  organizationName?: string | null;
  tenantId?: string | null;
  applicationId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  expiresAt?: number | string | Date | null;
  scopes?: string[] | null;
}
