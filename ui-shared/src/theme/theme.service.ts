import { Injectable, computed, signal } from '@angular/core';
import { storageGet, storageSet } from '../utils/legacy-storage';

/** Concrete light/dark resolution, used for asset swaps (logos) and `color-scheme`. */
export type EffectiveTheme = 'light' | 'dark';

/** Preview swatches used to render a theme card without applying the theme. */
export interface ThemeSwatches {
  canvas: string;
  primary: string;
  surface: string;
  text: string;
}

export interface ThemeDefinition {
  id: string;
  label: string;
  description: string;
  /** Whether this palette is fundamentally dark (drives `color-scheme` + logo swaps). */
  dark: boolean;
  swatches: ThemeSwatches;
}

/**
 * Shared theme service for product consoles (`--*` design tokens).
 * Defaults to dark; optional light for daytime use.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** localStorage key — shared across consoles (origins are separate, so values stay per-app). */
  private static readonly STORAGE_KEY = 'theme';
  private static readonly DEFAULT_THEME = 'dark';

  readonly themes: readonly ThemeDefinition[] = [
    {
      id: 'dark',
      label: 'Dark',
      description: 'Default dark palette.',
      dark: true,
      swatches: { canvas: '#0a0a0b', primary: '#5d96ea', surface: '#111114', text: '#f4f4f6' },
    },
    {
      id: 'light',
      label: 'Light',
      description: 'Default light palette.',
      dark: false,
      swatches: { canvas: '#ffffff', primary: '#2c5fb8', surface: '#fafafb', text: '#0a0a0b' },
    },
  ];

  private readonly themeIds = new Set(this.themes.map((t) => t.id));
  private started = false;

  private readonly _currentTheme = signal<string>(this.readStored());

  /** The active theme id. */
  readonly currentTheme = this._currentTheme.asReadonly();

  /** Concrete light/dark resolution of the active theme. */
  readonly effective = computed<EffectiveTheme>(() =>
    this.themes.find((t) => t.id === this._currentTheme())?.dark ? 'dark' : 'light'
  );

  /** True when the active theme is a dark palette. */
  readonly isDark = computed(() => this.effective() === 'dark');

  /** Call once at app startup to apply the stored theme. */
  init(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.apply(this._currentTheme());
  }

  /** Select a theme by id (no-op for unknown ids). */
  setTheme(themeId: string): void {
    if (!this.themeIds.has(themeId)) {
      return;
    }
    this._currentTheme.set(themeId);
    storageSet(ThemeService.STORAGE_KEY, themeId);
    this.apply(themeId);
  }

  /** Quick light/dark switch for header toggles. */
  toggleLightDark(): void {
    this.setTheme(this.isDark() ? 'light' : 'dark');
  }

  private apply(themeId: string): void {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;
    root.setAttribute('data-theme', themeId);
    const def = this.themes.find((t) => t.id === themeId);
    root.style.colorScheme = def?.dark ? 'dark' : 'light';
  }

  private readStored(): string {
    const stored = storageGet(ThemeService.STORAGE_KEY);
    if (stored && this.themeIds.has(stored)) {
      return stored;
    }
    // Migrate away from curated themes (midnight/ocean/…) and navy console dark.
    if (stored) {
      return ThemeService.DEFAULT_THEME;
    }
    return ThemeService.DEFAULT_THEME;
  }
}
