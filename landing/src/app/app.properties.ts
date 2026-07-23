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
  productName: 'Content-Sprout',

  /**
   * Document title (~50–60 chars ideal).
   * Primary keywords: local social media editor, free open source, macOS.
   */
  title: 'Content-Sprout — Free Local Social Media Post Editor',

  /** Meta description (~150–160 chars). */
  description:
    'Free open-source macOS app for social posts and short-form video. Smart crop, logos, script generator, media manager, and video editor — local-first with optional Ollama AI.',

  /** Comma-separated keywords for secondary engines + consistency. */
  keywords:
    'Content-Sprout, social media editor, local video editor, short-form video, free CapCut alternative, smart crop, logo watermark, script generator, media manager, Ollama, open source, macOS',

  /** Absolute path to the Open Graph image (served from /assets). */
  ogImagePath: '/assets/og-image.png',
  ogImageAlt: 'Content-Sprout — free local-first social media post and video editor by Ctrl-Fabric',
  ogImageWidth: '1200',
  ogImageHeight: '630',

  /** Organization home for JSON-LD publisher links. */
  organizationUrl: 'https://ctrlfabric.com',

  /** Source + downloads (binaries live on GitHub Releases, not Firebase Hosting). */
  githubRepoUrl: 'https://github.com/Ctrl-Fabric/Content-Sprout',
  githubReleasesUrl: 'https://github.com/Ctrl-Fabric/Content-Sprout/releases',

  /** FAQ for on-page content + FAQPage structured data. */
  faqs: [
    {
      question: 'Is Content-Sprout free?',
      answer:
        'Yes. Content-Sprout is open source under the MIT license. There is no subscription for the core app. Optional AI can run locally via Ollama.',
    },
    {
      question: 'Does my media leave my computer?',
      answer:
        'By default, no. Projects, uploads, and exports stay on your Mac. Optional cloud LLM proxies or publishing integrations only happen if you configure them.',
    },
    {
      question: 'What can I create with Content-Sprout?',
      answer:
        'Batch smart-crop images into common social formats with logo placement, build multi-scene short videos with layers and TTS, draft scripts for any platform, manage a local media library, and trim clips with copy-on-write edits.',
    },
    {
      question: 'What do I need to install?',
      answer:
        'A Mac (macOS 13+), ffmpeg for video export, and optionally Ollama with a vision model for AI-assisted logo placement. Download the app from GitHub Releases.',
    },
    {
      question: 'Where do I download Content-Sprout?',
      answer:
        'Get the latest macOS ZIP or DMG from the Content-Sprout GitHub Releases page. Source code is also available in the repository.',
    },
  ],
} as const;

/** Absolute OG image URL derived from site config. */
export function ogImageUrl(): string {
  return `${APP_PROPERTIES.siteUrl}${APP_PROPERTIES.ogImagePath}`;
}
