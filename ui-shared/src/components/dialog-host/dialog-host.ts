import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog';
import { PromptDialogComponent } from '../prompt-dialog/prompt-dialog';
import { DialogService } from '../../services/dialog.service';

/** Renders promise-based confirm/prompt dialogs from {@link DialogService}. */
@Component({
  selector: 'app-dialog-host',
  standalone: true,
  imports: [ConfirmDialogComponent, PromptDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (dialogs.confirmState(); as c) {
      <app-confirm-dialog
        [isOpen]="true"
        [title]="c.title"
        [message]="c.message"
        [confirmText]="c.confirmText"
        [cancelText]="c.cancelText"
        [type]="c.type"
        (confirm)="dialogs.resolveConfirm(true)"
        (cancel)="dialogs.resolveConfirm(false)"
      />
    }
    @if (dialogs.promptState(); as p) {
      <app-prompt-dialog
        [isOpen]="true"
        [title]="p.title"
        [message]="p.message"
        [label]="p.label"
        [defaultValue]="p.defaultValue"
        [placeholder]="p.placeholder"
        [confirmText]="p.confirmText"
        [cancelText]="p.cancelText"
        [required]="p.required"
        (confirm)="dialogs.resolvePrompt($event)"
        (cancel)="dialogs.resolvePrompt(null)"
      />
    }
  `,
})
export class DialogHostComponent {
  readonly dialogs = inject(DialogService);
}
