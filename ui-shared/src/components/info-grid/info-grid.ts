import { Component, Input, TemplateRef } from '@angular/core';
import { CommonModule } from '@angular/common';

export type InfoGridBadgeVariant =
  | 'active'
  | 'inactive'
  | 'pending'
  | 'expired'
  | 'cancelled'
  | string;

export interface InfoGridBadgeSpec {
  variant: InfoGridBadgeVariant;
  text: string;
}

export interface InfoGridItem {
  icon?: string;
  label: string;
  value?: string | number | boolean | null;
  /**
   * Render complex values (buttons/checkboxes/custom markup) inside the value area.
   * Content should NOT include any outer wrapper; the component provides the value container.
   */
  valueTemplate?: TemplateRef<any>;
  badge?: InfoGridBadgeSpec;
}

export interface InfoGridSpec {
  /**
   * Controls the "auto-fill" grid behavior.
   * If `columns` is provided, `minColumnWidth` is ignored.
   */
  minColumnWidth?: string;
  gap?: string;
  /**
   * If set, uses a fixed column count (e.g. 2 columns).
   * If not set, uses auto-fill with `minColumnWidth`.
   */
  columns?: number;
}

export type InfoGridVariant = 'tiles' | 'section';

@Component({
  selector: 'app-info-grid',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './info-grid.html',
})
export class InfoGridComponent {
  @Input({ required: true }) items: InfoGridItem[] = [];
  @Input() grid: InfoGridSpec = {};
  @Input() variant: InfoGridVariant = 'tiles';

  get gridTemplateColumns(): string {
    const minColumnWidth = this.grid?.minColumnWidth ?? '280px';
    if (typeof this.grid?.columns === 'number' && this.grid.columns > 0) {
      return `repeat(${this.grid.columns}, minmax(0, 1fr))`;
    }
    return `repeat(auto-fill, minmax(${minColumnWidth}, 1fr))`;
  }

  get gridGap(): string {
    return this.grid?.gap ?? '20px';
  }

  badgeClass(variant: InfoGridBadgeVariant): string {
    // Default to `--inactive` look if we don't recognize variant.
    const v = (variant ?? 'inactive').toString().toLowerCase();
    const allowed = new Set(['active', 'inactive', 'pending', 'expired', 'cancelled']);
    const normalized = allowed.has(v) ? v : 'inactive';
    return `ig-badge--${normalized}`;
  }

  /** Stable keys when callers pass freshly allocated item objects each CD (avoids NG0956 identity tracking). */
  trackItemKey(index: number, item: InfoGridItem): string {
    return `${index}:${item.label}`;
  }
}

