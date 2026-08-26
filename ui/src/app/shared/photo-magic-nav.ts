import type { PhotoMagicAssetScope, PhotoMagicScope } from '../models/content-sprout.models';

export const CREATE_RETURN_URL_PARAM = 'returnUrl';

export type CreateTabId = 'ai-gen' | 'photo-magic';

export interface PhotoMagicNavOpts {
  scope: PhotoMagicScope;
  projectId?: string | null;
  postId?: string | null;
  assetId?: string | null;
  assetScope?: PhotoMagicAssetScope | null;
  docId?: string | null;
  /** Full in-app path (+ query) to return to when leaving Create. */
  returnUrl?: string | null;
}

export interface CreatePageNavOpts {
  tab?: CreateTabId;
  returnUrl?: string | null;
  /** Pre-select Photo magic scope without forcing the Photo magic tab. */
  scope?: PhotoMagicScope | null;
  projectId?: string | null;
  postId?: string | null;
  /** When opening Photo magic with a scoped document/asset (forces photo-magic tab). */
  photoMagic?: Omit<PhotoMagicNavOpts, 'returnUrl'>;
}

/** Relative return paths for the three asset scopes that open Create. */
export function assetsCreateReturnUrl(
  kind: 'global' | 'project' | 'post',
  postId?: string | null,
): string {
  if (kind === 'global') return '/global-resources';
  if (kind === 'project') return '/media-studio?hub=assets';
  const id = String(postId || '').trim();
  return id ? `/media-studio/posts/${encodeURIComponent(id)}?step=assets` : '/media-studio';
}

/** Accept only same-app relative paths (no scheme / protocol-relative). */
export function parseSafeReturnUrl(raw: string | null | undefined): string | null {
  const s = String(raw || '').trim();
  if (!s || !s.startsWith('/') || s.startsWith('//') || /:\/\//.test(s)) return null;
  return s;
}

export function backLabelForReturnUrl(returnUrl: string): string {
  const path = returnUrl.split('?')[0] || '';
  if (path.startsWith('/global-resources') || path.startsWith('/personal-media')) {
    return 'Back to Shared Library';
  }
  if (/^\/media-studio\/posts\//.test(path)) return 'Back to post assets';
  if (path.startsWith('/media-studio')) return 'Back to project assets';
  return 'Back';
}

export function createPageCommands(
  opts: CreatePageNavOpts = {},
): { path: string; queryParams: Record<string, string> } {
  const queryParams: Record<string, string> = {
    tab: opts.tab || 'ai-gen',
  };
  const returnUrl = parseSafeReturnUrl(opts.returnUrl);
  if (returnUrl) queryParams[CREATE_RETURN_URL_PARAM] = returnUrl;

  if (opts.scope) queryParams['scope'] = opts.scope;
  if (opts.projectId) queryParams['projectId'] = opts.projectId;
  if (opts.postId) queryParams['postId'] = opts.postId;

  const pm = opts.photoMagic;
  if (pm) {
    queryParams['tab'] = 'photo-magic';
    queryParams['scope'] = pm.scope;
    if (pm.projectId) queryParams['projectId'] = pm.projectId;
    if (pm.postId) queryParams['postId'] = pm.postId;
    if (pm.assetId) queryParams['assetId'] = pm.assetId;
    if (pm.assetScope) queryParams['assetScope'] = pm.assetScope;
    if (pm.docId) queryParams['docId'] = pm.docId;
  }
  return { path: '/create', queryParams };
}

export function photoMagicCommands(opts: PhotoMagicNavOpts): {
  path: string;
  queryParams: Record<string, string>;
} {
  return createPageCommands({
    tab: 'photo-magic',
    returnUrl: opts.returnUrl,
    photoMagic: opts,
  });
}
