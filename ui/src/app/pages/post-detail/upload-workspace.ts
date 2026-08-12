import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';
import {
  EDITOR_PLATFORMS,
  platformIcon,
} from '../../models/content-sprout.models';

@Component({
  selector: 'app-upload-workspace',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="cs-dist surface-card">
      <div class="cs-dist-head">
        <div class="min-w-0">
          <h3 class="cs-section-title" style="margin: 0">Upload</h3>
          <p class="meta" style="margin: 0.2rem 0 0">
            Choose where this post should go. Publishing accounts are not connected
            yet — this step stores the target list for later upload.
          </p>
        </div>
      </div>

      <div class="cs-platforms">
        <div class="cs-platforms-label-row">
          <span class="cs-field-label">Target platforms</span>
          <span class="meta">{{ selected.size }}</span>
        </div>
        <div class="cs-platform-grid" role="group" aria-label="Target platforms">
          @for (p of platforms; track p.id) {
            <button
              type="button"
              class="cs-platform-tile"
              [class.is-selected]="selected.has(p.id)"
              [attr.aria-pressed]="selected.has(p.id)"
              (click)="toggle.emit(p.id)"
              [title]="p.label"
            >
              <span class="cs-platform-icon material-symbols-outlined" aria-hidden="true">{{
                icon(p.id)
              }}</span>
              <span class="cs-platform-name">{{ p.label }}</span>
            </button>
          }
        </div>
      </div>

      <p class="cs-dist-note">
        Direct upload to YouTube, TikTok, and the rest will land here once accounts
        are linked. Until then, export files on the previous step and publish them
        yourself.
      </p>
    </div>
  `,
})
export class UploadWorkspaceComponent {
  @Input({ required: true }) selected!: Set<string>;
  @Output() toggle = new EventEmitter<string>();

  readonly platforms = EDITOR_PLATFORMS;
  readonly icon = platformIcon;
}
