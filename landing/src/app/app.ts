import { Component, OnInit, inject, signal } from '@angular/core';
import { AdBand } from './ads/ad-band';
import { APP_PROPERTIES } from './app.properties';
import { SeoService } from './seo/seo.service';

const THEME_KEY = 'content-sprout.theme';

type Theme = 'light' | 'dark';

@Component({
  selector: 'app-root',
  imports: [AdBand],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private readonly seo = inject(SeoService);

  protected readonly theme = signal<Theme>('dark');
  protected readonly githubRepoUrl = APP_PROPERTIES.githubRepoUrl;
  protected readonly githubReleasesUrl = APP_PROPERTIES.githubReleasesUrl;

  ngOnInit(): void {
    this.seo.applyDefaults();
    this.applyTheme(this.readInitialTheme(), false);
  }

  protected toggleTheme(): void {
    this.applyTheme(this.theme() === 'light' ? 'dark' : 'light');
  }

  protected themeToggleLabel(): string {
    return this.theme() === 'light' ? 'Dark' : 'Light';
  }

  protected themeToggleTitle(): string {
    return this.theme() === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  }

  protected faviconHref(): string {
    return this.theme() === 'light'
      ? '/assets/brand-logo-dark.png'
      : '/assets/brand-logo-light.png';
  }

  private readInitialTheme(): Theme {
    try {
      const stored =
        localStorage.getItem(THEME_KEY) ||
        localStorage.getItem('theme') ||
        localStorage.getItem('qs-theme') ||
        localStorage.getItem('qs.theme');
      if (stored === 'light' || stored === 'dark') return stored;
      if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
    } catch {
      /* ignore */
    }
    return 'dark';
  }

  private applyTheme(next: Theme, persist = true): void {
    this.theme.set(next);
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    const fav = document.getElementById('brandFavicon') as HTMLLinkElement | null;
    if (fav) fav.href = this.faviconHref();
    if (!persist) return;
    try {
      localStorage.setItem(THEME_KEY, next);
      localStorage.setItem('theme', next);
    } catch {
      /* ignore */
    }
  }
}
