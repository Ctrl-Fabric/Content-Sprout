import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ThemeService } from './theme.service';

/**
 * Shared appearance / theme picker. Renders a card per registered theme and
 * applies the selection via {@link ThemeService}. Styled entirely with `--*`
 * tokens so it fits every product console. Drop it inside a settings page.
 */
@Component({
  selector: 'app-theme-selector',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './theme-selector.html',
  styleUrl: './theme-selector.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ThemeSelectorComponent {
  readonly themeService = inject(ThemeService);

  select(themeId: string): void {
    this.themeService.setTheme(themeId);
  }

  isActive(themeId: string): boolean {
    return this.themeService.currentTheme() === themeId;
  }
}
