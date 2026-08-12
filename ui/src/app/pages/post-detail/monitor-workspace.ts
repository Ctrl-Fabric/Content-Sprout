import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import {
  EDITOR_PLATFORMS,
  platformIcon,
} from '../../models/content-sprout.models';

@Component({
  selector: 'app-monitor-workspace',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="cs-dist surface-card">
      <div class="cs-dist-head">
        <div class="min-w-0">
          <h3 class="cs-section-title" style="margin: 0">Monitor</h3>
          <p class="meta" style="margin: 0.2rem 0 0">
            Upload status for the platforms chosen on the Upload step.
          </p>
        </div>
      </div>

      @if (!ids.length) {
        <p class="cs-empty-inline">No target platforms yet. Pick them on Upload.</p>
      } @else {
        <ul class="cs-monitor-list" role="list">
          @for (id of ids; track id) {
            <li>
              <span class="material-symbols-outlined" aria-hidden="true">{{ icon(id) }}</span>
              <span class="cs-monitor-name">{{ label(id) }}</span>
              <span class="cs-monitor-status">Not uploaded</span>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class MonitorWorkspaceComponent {
  @Input({ required: true }) selected!: Set<string>;

  readonly icon = platformIcon;

  get ids(): string[] {
    const set = this.selected || new Set<string>();
    return EDITOR_PLATFORMS.map((p) => p.id).filter((id) => set.has(id));
  }

  label(id: string): string {
    return EDITOR_PLATFORMS.find((p) => p.id === id)?.label || id;
  }
}
