import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface SegmentedTab {
  id: string;
  label: string;
  icon?: string;
  /** Optional count or label chip (omit when not shown). */
  badge?: string | number;
}

@Component({
  selector: 'app-segmented-tab-bar',
  standalone: true,
  templateUrl: './segmented-tab-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SegmentedTabBarComponent {
  readonly tabs = input.required<readonly SegmentedTab[]>();
  readonly activeId = input.required<string>();
  readonly ariaLabel = input<string>('Sections');

  readonly activeIdChange = output<string>();

  select(id: string): void {
    if (id !== this.activeId()) {
      this.activeIdChange.emit(id);
    }
  }

  showBadge(tab: SegmentedTab): boolean {
    const b = tab.badge;
    if (b === undefined || b === null) {
      return false;
    }
    if (typeof b === 'number') {
      return b !== 0;
    }
    return String(b).trim().length > 0;
  }
}
