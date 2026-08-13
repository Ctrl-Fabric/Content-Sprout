import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import {
  EDITOR_PLATFORMS,
  PublishAttempt,
  platformIcon,
  platformLabel,
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
            Upload status for accounts used on the Upload step.
          </p>
        </div>
      </div>

      @if (rows.length) {
        <ul class="cs-monitor-list" role="list">
          @for (row of rows; track row.key) {
            <li [attr.data-status]="row.status">
              <span class="material-symbols-outlined" aria-hidden="true">{{ icon(row.platform) }}</span>
              <span class="cs-monitor-name">{{ row.label }}</span>
              <span class="cs-monitor-status">{{ row.statusLabel }}</span>
              @if (row.message) {
                <span class="cs-monitor-msg">{{ row.message }}</span>
              }
              @if (row.remoteUrl) {
                <a class="cs-monitor-link" [href]="row.remoteUrl" target="_blank" rel="noopener">
                  Open
                </a>
              }
            </li>
          }
        </ul>
      } @else if (!platformIds.length) {
        <p class="cs-empty-inline">No target accounts yet. Pick them on Upload.</p>
      } @else {
        <ul class="cs-monitor-list" role="list">
          @for (id of platformIds; track id) {
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
  styles: [
    `
      .cs-monitor-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .cs-monitor-list li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 0.25rem 0.65rem;
        align-items: start;
        border: 1px solid var(--cs-border);
        border-radius: 10px;
        padding: 0.65rem 0.75rem;
      }
      .cs-monitor-msg {
        grid-column: 2 / -1;
        font-size: 0.8rem;
        color: var(--cs-text-muted);
        line-height: 1.4;
      }
      .cs-monitor-link {
        grid-column: 3;
        grid-row: 1;
        font-size: 0.8rem;
      }
      .cs-monitor-list li[data-status='failed'] .cs-monitor-status {
        color: #f87171;
      }
      .cs-monitor-list li[data-status='published'] .cs-monitor-status {
        color: #34d399;
      }
      .cs-monitor-list li[data-status='manual'] .cs-monitor-status {
        color: #fbbf24;
      }
    `,
  ],
})
export class MonitorWorkspaceComponent {
  @Input({ required: true }) selected!: Set<string>;
  @Input() attempts: PublishAttempt[] = [];

  readonly icon = platformIcon;
  readonly label = platformLabel;

  get platformIds(): string[] {
    const set = this.selected || new Set<string>();
    return EDITOR_PLATFORMS.map((p) => p.id).filter((id) => set.has(id));
  }

  get rows(): {
    key: string;
    platform: string;
    label: string;
    status: string;
    statusLabel: string;
    message?: string;
    remoteUrl?: string;
  }[] {
    const attempts = [...(this.attempts || [])].reverse();
    if (!attempts.length) return [];
    const seen = new Set<string>();
    const out: {
      key: string;
      platform: string;
      label: string;
      status: string;
      statusLabel: string;
      message?: string;
      remoteUrl?: string;
    }[] = [];
    for (const a of attempts) {
      const key = a.account_id || `${a.platform}:${a.account_label || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        platform: a.platform || 'other',
        label: a.account_label || this.label(a.platform || 'other'),
        status: a.status || 'unknown',
        statusLabel: this.statusLabel(a.status),
        message: a.message,
        remoteUrl: a.remote_url,
      });
    }
    return out;
  }

  statusLabel(status?: string): string {
    switch (status) {
      case 'published':
        return 'Published';
      case 'failed':
        return 'Failed';
      case 'manual':
        return 'Manual upload';
      case 'queued':
        return 'Queued';
      default:
        return status || 'Unknown';
    }
  }
}
