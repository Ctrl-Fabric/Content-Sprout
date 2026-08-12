import { Injectable, computed, signal } from '@angular/core';
import { storageGet, storageSet } from '@ctrlfabric/ui';

export type EffectiveTheme = 'light' | 'dark';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private static readonly STORAGE_KEY = 'theme';
  private static readonly DEFAULT_THEME = 'dark';

  private started = false;
  private readonly _currentTheme = signal<string>(this.readStored());

  readonly currentTheme = this._currentTheme.asReadonly();
  readonly isDark = computed(() => this._currentTheme() !== 'light');

  init(): void {
    if (this.started) return;
    this.started = true;
    this.apply(this._currentTheme());
  }

  setTheme(themeId: 'light' | 'dark'): void {
    this._currentTheme.set(themeId);
    try {
      storageSet(ThemeService.STORAGE_KEY, themeId);
      storageSet('content-sprout.theme', themeId);
    } catch {
      /* ignore */
    }
    this.apply(themeId);
  }

  toggleLightDark(): void {
    this.setTheme(this.isDark() ? 'light' : 'dark');
  }

  private apply(themeId: string): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-theme', themeId);
    root.style.colorScheme = themeId === 'dark' ? 'dark' : 'light';
  }

  private readStored(): string {
    try {
      const stored = storageGet(ThemeService.STORAGE_KEY) || storageGet('content-sprout.theme');
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      /* ignore */
    }
    return ThemeService.DEFAULT_THEME;
  }
}
