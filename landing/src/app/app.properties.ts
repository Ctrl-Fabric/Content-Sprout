/**
 * Application-level feature flags and publish settings.
 * Toggle these before deploy without hunting through feature modules.
 */
export const APP_PROPERTIES = {
  /**
   * Show AdSense / ad placeholder sections on the page.
   * Keep `false` until the AdSense account and site are verified, then set `true`
   * and fill slot IDs in `src/app/ads/ads.config.ts` if you use dedicated units.
   */
  adsEnabled: true,

  /** Canonical production origin (no trailing slash). */
  siteUrl: 'https://content-sprout.ctrlfabric.com',

  /** Brand / product names for titles and structured data. */
  siteName: 'Ctrl-Fabric',
  productName: 'Content-sprout',

  /** Document title and social share title. */
  title: 'Content-sprout — Ctrl-Fabric',

  /** Meta description (search + Open Graph / Twitter). */
  description:
    'Free, local-first Instagram images and reels. Smart crop, logos, and a scene editor — optional AI via Ollama so you avoid cloud subscriptions and API bills.',

  /** Absolute path to the Open Graph image (served from /assets). */
  ogImagePath: '/assets/og-image.png',

  /** Organization home for JSON-LD publisher links. */
  organizationUrl: 'https://ctrlfabric.com',

  /** Source + downloads (binaries live on GitHub Releases, not Firebase Hosting). */
  githubRepoUrl: 'https://github.com/Ctrl-Fabric/Content-Sprout',
  githubReleasesUrl: 'https://github.com/Ctrl-Fabric/Content-Sprout/releases',
} as const;

/** Absolute OG image URL derived from site config. */
export function ogImageUrl(): string {
  return `${APP_PROPERTIES.siteUrl}${APP_PROPERTIES.ogImagePath}`;
}
