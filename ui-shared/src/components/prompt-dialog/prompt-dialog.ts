import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * Text-input dialog matching {@link ConfirmDialogComponent} chrome.
 * Used for replacements of browser `prompt()`.
 */
@Component({
  selector: 'app-prompt-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './prompt-dialog.html',
  styleUrl: './prompt-dialog.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PromptDialogComponent implements OnChanges, AfterViewInit {
  @Input({ required: true }) isOpen!: boolean;
  @Input() title = 'Input';
  @Input() message = '';
  @Input() label = '';
  @Input() defaultValue = '';
  @Input() placeholder = '';
  @Input() confirmText = 'OK';
  @Input() cancelText = 'Cancel';
  @Input() required = true;
  @Input() closeOnOverlayClick = false;

  @Output() confirm = new EventEmitter<string>();
  @Output() cancel = new EventEmitter<void>();

  @ViewChild('inputEl') inputEl?: ElementRef<HTMLInputElement>;

  value = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] || changes['defaultValue']) {
      if (this.isOpen) {
        this.value = this.defaultValue || '';
        queueMicrotask(() => this.focusInput());
      }
    }
  }

  ngAfterViewInit(): void {
    if (this.isOpen) this.focusInput();
  }

  onConfirm(): void {
    const trimmed = String(this.value || '').trim();
    if (this.required && !trimmed) return;
    this.confirm.emit(this.required ? trimmed : String(this.value || ''));
  }

  onCancel(): void {
    this.cancel.emit();
  }

  onOverlayClick(): void {
    if (this.closeOnOverlayClick) this.onCancel();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen) this.onCancel();
  }

  private focusInput(): void {
    this.inputEl?.nativeElement?.focus();
    this.inputEl?.nativeElement?.select();
  }
}
