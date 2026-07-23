import { Injectable, inject, DOCUMENT } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { APP_PROPERTIES, ogImageUrl } from '../app.properties';

const JSON_LD_ID = 'content-sprout-json-ld';

/**
 * Keeps document title, social meta, canonical URL, and JSON-LD aligned with
 * APP_PROPERTIES after the SPA boots (and mirrors static tags in index.html).
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  /** Apply canonical title / description / social tags / structured data. */
  applyDefaults(): void {
    const {
      title,
      description,
      keywords,
      siteUrl,
      siteName,
      productName,
      organizationUrl,
      githubRepoUrl,
      githubReleasesUrl,
      ogImageAlt,
      ogImageWidth,
      ogImageHeight,
      faqs,
    } = APP_PROPERTIES;
    const image = ogImageUrl();
    const pageUrl = `${siteUrl}/`;

    this.title.setTitle(title);
    this.setCanonical(pageUrl);

    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ name: 'keywords', content: keywords });
    this.meta.updateTag({ name: 'author', content: siteName });
    this.meta.updateTag({ name: 'application-name', content: productName });
    this.meta.updateTag({
      name: 'robots',
      content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
    });
    this.meta.updateTag({ name: 'googlebot', content: 'index, follow' });

    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ property: 'og:site_name', content: siteName });
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:url', content: pageUrl });
    this.meta.updateTag({ property: 'og:image', content: image });
    this.meta.updateTag({ property: 'og:image:alt', content: ogImageAlt });
    this.meta.updateTag({ property: 'og:image:width', content: ogImageWidth });
    this.meta.updateTag({ property: 'og:image:height', content: ogImageHeight });
    this.meta.updateTag({ property: 'og:image:type', content: 'image/png' });
    this.meta.updateTag({ property: 'og:locale', content: 'en_US' });

    this.meta.updateTag({ name: 'twitter:card', content: 'summary_large_image' });
    this.meta.updateTag({ name: 'twitter:title', content: title });
    this.meta.updateTag({ name: 'twitter:description', content: description });
    this.meta.updateTag({ name: 'twitter:image', content: image });
    this.meta.updateTag({ name: 'twitter:image:alt', content: ogImageAlt });

    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': `${organizationUrl}/#organization`,
          name: siteName,
          url: `${organizationUrl}/`,
          sameAs: [githubRepoUrl],
        },
        {
          '@type': 'WebSite',
          '@id': `${siteUrl}/#website`,
          url: pageUrl,
          name: productName,
          description,
          publisher: { '@id': `${organizationUrl}/#organization` },
          inLanguage: 'en-US',
        },
        {
          '@type': 'WebPage',
          '@id': `${siteUrl}/#webpage`,
          url: pageUrl,
          name: title,
          description,
          isPartOf: { '@id': `${siteUrl}/#website` },
          about: { '@id': `${siteUrl}/#app` },
          primaryImageOfPage: {
            '@type': 'ImageObject',
            url: image,
            width: Number(ogImageWidth),
            height: Number(ogImageHeight),
          },
          inLanguage: 'en-US',
        },
        {
          '@type': 'SoftwareApplication',
          '@id': `${siteUrl}/#app`,
          name: productName,
          alternateName: ['Content-sprout', 'Content Sprout'],
          url: pageUrl,
          description,
          applicationCategory: 'MultimediaApplication',
          applicationSubCategory: 'Photo & Video',
          operatingSystem: 'macOS 13+',
          downloadUrl: githubReleasesUrl,
          softwareVersion: 'latest',
          license: 'https://opensource.org/licenses/MIT',
          offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
          },
          creator: { '@id': `${organizationUrl}/#organization` },
          publisher: { '@id': `${organizationUrl}/#organization` },
          sameAs: [githubRepoUrl, githubReleasesUrl],
          image: image,
          featureList: [
            'Smart crop to common social aspect ratios',
            'Automatic dark/light logo placement',
            'Multi-scene short-form video editor with layers and TTS',
            'Script Generator — brief to chat drafts for any platform',
            'Media Manager — local folders, preview, and import',
            'Video Editor — clip, mute, and speed (copy-on-write)',
            'Optional local AI via Ollama',
            'Runs entirely on your Mac by default',
          ],
        },
        {
          '@type': 'FAQPage',
          '@id': `${siteUrl}/#faq`,
          mainEntity: faqs.map((item) => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: item.answer,
            },
          })),
        },
      ],
    };

    this.setJsonLd(graph);
  }

  private setCanonical(href: string): void {
    let link = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      this.document.head.appendChild(link);
    }
    link.setAttribute('href', href);
  }

  private setJsonLd(data: unknown): void {
    let script = this.document.getElementById(JSON_LD_ID) as HTMLScriptElement | null;
    if (!script) {
      script = this.document.createElement('script');
      script.type = 'application/ld+json';
      script.id = JSON_LD_ID;
      this.document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(data);
  }
}
