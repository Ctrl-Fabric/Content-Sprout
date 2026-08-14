import { Component, Input, Output, EventEmitter, signal, forwardRef, ChangeDetectionStrategy } from '@angular/core';

import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { ClickOutsideDirective } from '../../directives/click-outside.directive';

export interface SelectOption {
  value: string | number;
  label: string;
  icon?: string;
  disabled?: boolean;
}

@Component({
  selector: 'app-custom-select',
  standalone: true,
  imports: [ClickOutsideDirective],
  templateUrl: './custom-select.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => CustomSelectComponent),
      multi: true
    }
  ]
})
export class CustomSelectComponent implements ControlValueAccessor {
  @Input() options: SelectOption[] = [];
  @Input() placeholder: string = 'Select an option';
  @Input() disabled: boolean = false;
  @Input() size: 'small' | 'medium' | 'large' = 'medium';
  @Input() backgroundColor?: string | null;
  @Input() width?: string;
  @Output() selectionChange = new EventEmitter<string | number>();

  isOpen = signal<boolean>(false);
  selectedValue: string | number | null = null;
  
  private onChange: (value: any) => void = () => {};
  private onTouched: () => void = () => {};

  get selectedOption(): SelectOption | undefined {
    const v = this.selectedValue;
    if (v === null || v === undefined) return undefined;
    return this.options.find(opt => String(opt.value) === String(v));
  }

  get displayLabel(): string {
    return this.selectedOption?.label || this.placeholder;
  }

  get triggerBackground(): string | null {
    if (this.backgroundColor === null) {
      return 'transparent';
    }
    return this.backgroundColor || null;
  }

  get hostWidth(): string | null {
    return this.width || '100%';
  }

  toggleDropdown(): void {
    if (!this.disabled) {
      this.isOpen.update(v => !v);
    }
  }

  closeDropdown(): void {
    this.isOpen.set(false);
  }

  selectOption(option: SelectOption): void {
    if (!option.disabled) {
      this.selectedValue = option.value;
      this.onChange(option.value);
      this.onTouched();
      this.selectionChange.emit(option.value);
      this.closeDropdown();
    }
  }

  // ControlValueAccessor implementation
  writeValue(value: any): void {
    this.selectedValue = value;
  }

  registerOnChange(fn: any): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }
}

