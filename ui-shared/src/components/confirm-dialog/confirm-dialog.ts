import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostListener,
  Input,
  Output,
  ViewEncapsulation,
} from '@angular/core';

/**
 * Shared confirmation dialog — the single common pattern for confirmations across
 * every product UI platform. Self-contained (own markup + styles), so it looks
 * identical regardless of the host app's global stylesheet. Severity is conveyed
 * solely by the action button color (`type`).
 */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialogComponent {
  @Input({ required: true }) isOpen!: boolean;
  @Input() title = 'Confirm Action';
  @Input({ required: true }) message!: string;
  @Input() confirmText = 'Confirm';
  @Input() cancelText = 'Cancel';
  @Input() type: 'warning' | 'danger' | 'info' = 'warning';
  @Input() isLoading = false;
  /** When false, clicking the backdrop will not dismiss the dialog. */
  @Input() closeOnOverlayClick = false;

  @Output() confirm = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  onConfirm(): void {
    if (this.isLoading) return;
    this.confirm.emit();
  }

  onCancel(): void {
    if (this.isLoading) return;
    this.cancel.emit();
  }

  onOverlayClick(): void {
    if (this.closeOnOverlayClick) {
      this.onCancel();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen) {
      this.onCancel();
    }
  }
}
