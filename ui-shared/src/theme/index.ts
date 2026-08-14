/**
 * Shared multi-theme support for the `--*` product consoles.
 *
 * Isolated from the root `shared/ui` barrel so apps can adopt theming
 * without pulling in unrelated components (and their peer deps). Consume via the
 * `shared/ui/theme` path alias:
 *   import { ThemeService, ThemeSelectorComponent } from 'shared/ui/theme';
 *
 * Pair with the token blocks in `shared/ui` `styles/_themes.scss`:
 *   @use '../../ui-shared/src/styles/themes';
 */
export {
  ThemeService,
  type ThemeDefinition,
  type ThemeSwatches,
  type EffectiveTheme
} from './theme.service';
export { ThemeSelectorComponent } from './theme-selector';
