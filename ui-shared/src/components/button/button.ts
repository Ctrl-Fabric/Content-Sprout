import { Component, Input, Output, EventEmitter } from '@angular/core';


export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'success'
  | 'danger'
  | 'warning'
  | 'outline'
  | 'outlineSecondary'
  | 'outlineDanger'
  | 'outlineSuccess'
  | 'ghost';

export type ButtonSize = 'default' | 'sm' | 'lg';

@Component({
  selector: 'app-button',
  standalone: true,
  imports: [],
  templateUrl: './button.html',
})
export class ButtonComponent {
  /** Visual variant (maps to global .btn-* classes). */
  @Input() variant: ButtonVariant = 'primary';

  /** Size: default, sm, or lg. */
  @Input() size: ButtonSize = 'default';

  /** Material symbol name for optional leading/trailing icon. */
  @Input() icon?: string;

  /** Icon position when label is present. Ignored when iconOnly is true. */
  @Input() iconPosition: 'left' | 'right' = 'left';

  /** When true, render as icon-only (no projected content). Use with `icon` and optional `ariaLabel`. */
  @Input() iconOnly = false;

  /** Accessible label for icon-only buttons (required when iconOnly is true). */
  @Input() ariaLabel?: string;

  /** Native button type. */
  @Input() type: 'button' | 'submit' | 'reset' = 'button';

  /** Disabled state. */
  @Input() disabled = false;

  /** Loading state: shows spinner and disables click. */
  @Input() loading = false;

  /** Optional extra CSS classes (e.g. 'btn-outline-sm', 'w-full'). */
  @Input() customClass = '';

  /** Emits on click (use for actions). Native submit is still used when type="submit". */
  @Output() click = new EventEmitter<MouseEvent>();

  /** Builds the list of global button classes from variant, size, and iconOnly. */
  get buttonClasses(): string {
    const parts: string[] = ['btn'];

    // Variant class (e.g. btn-primary, btn-outline-secondary)
    const variantClass = this.getVariantClass();
    if (variantClass) parts.push(variantClass);

    // Size
    if (this.size === 'sm') parts.push('btn-sm');
    if (this.size === 'lg') parts.push('btn-lg');

    // Icon-only: use .btn-icon and, for danger, .danger for hover style
    if (this.iconOnly) {
      parts.push('btn-icon');
      if (this.variant === 'danger') parts.push('danger');
    }

    if (this.customClass) parts.push(this.customClass);
    return parts.join(' ');
  }

  private getVariantClass(): string {
    const map: Record<ButtonVariant, string> = {
      primary: 'btn-primary',
      secondary: 'btn-secondary',
      success: 'btn-success',
      danger: 'btn-danger',
      warning: 'btn-warning',
      outline: 'btn-outline',
      outlineSecondary: 'btn-outline-secondary',
      outlineDanger: 'btn-outline-danger',
      outlineSuccess: 'btn-outline-success',
      ghost: 'btn-ghost'
    };
    return map[this.variant] ?? 'btn-primary';
  }

  onClick(event: MouseEvent): void {
    if (this.disabled || this.loading) return;
    this.click.emit(event);
  }
}
