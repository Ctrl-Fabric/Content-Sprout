import type { ServiceNavItem, ServiceRailBrand } from 'shared/ui';

export const APP_NAV: ServiceNavItem[] = [
  {
    label: 'Media Studio',
    route: '/media-studio',
    icon: 'movie_filter',
  },
  {
    label: 'Shared Library',
    route: '/global-resources',
    icon: 'perm_media',
  },
];

export const APP_BRAND: ServiceRailBrand = {
  href: '/media-studio',
  ariaLabel: 'Content-Sprout home',
  imgSrc: 'assets/logos/logo_short.png',
};

export function titleForPath(path: string, projectName?: string | null): string {
  if (path.startsWith('/global-resources')) return 'Shared Library';
  if (path.startsWith('/settings')) return 'Settings';
  if (path.startsWith('/setup')) return 'Setup Guide';
  if (
    path.startsWith('/create') ||
    path.startsWith('/ai-gen') ||
    path.startsWith('/photo-magic')
  ) {
    return 'Create';
  }
  if (path.startsWith('/media-studio/posts/')) return 'Post';
  if (path.startsWith('/media-studio')) {
    const name = String(projectName || '').trim();
    return name || 'Media Studio';
  }
  return 'Content-Sprout';
}
