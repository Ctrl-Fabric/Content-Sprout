import type { ServiceNavItem, ServiceRailBrand } from 'shared/ui';

export const APP_NAV: ServiceNavItem[] = [
  {
    label: 'Media Studio',
    route: '/media-studio',
    icon: 'movie_filter',
  },
  {
    label: 'AI Gen',
    route: '/ai-gen',
    icon: 'auto_awesome',
  },
  {
    label: 'Personal Media',
    route: '/personal-media',
    icon: 'photo_library',
  },
  {
    label: 'Global Resources',
    route: '/global-resources',
    icon: 'public',
  },
];

export const APP_BRAND: ServiceRailBrand = {
  href: '/media-studio',
  ariaLabel: 'Content-Sprout home',
  imgSrc: 'assets/logos/logo_short.png',
};

export function titleForPath(path: string, projectName?: string | null): string {
  if (path.startsWith('/personal-media')) return 'Personal Media';
  if (path.startsWith('/global-resources')) return 'Global Resources';
  if (path.startsWith('/settings')) return 'Settings';
  if (path.startsWith('/ai-gen')) return 'AI Gen';
  if (path.startsWith('/media-studio/posts/')) return 'Post';
  if (path.startsWith('/media-studio')) {
    const name = String(projectName || '').trim();
    return name || 'Media Studio';
  }
  return 'Content-Sprout';
}
