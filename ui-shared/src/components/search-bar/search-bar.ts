import { Component, Input, Output, EventEmitter, signal, forwardRef } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'app-search-bar',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './search-bar.html',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SearchBarComponent),
      multi: true
    }
  ]
})
export class SearchBarComponent implements ControlValueAccessor {
  @Input() placeholder: string = 'Search...';
  @Input() disabled: boolean = false;
  @Input() size: 'small' | 'medium' | 'large' = 'medium';
  @Input() showSearchIcon: boolean = true;
  @Input() showClearButton: boolean = true;
  @Input() debounceTime: number = 300;
  @Output() search = new EventEmitter<string>();
  @Output() clear = new EventEmitter<void>();

  searchValue = signal<string>('');
  private debounceTimer: any;
  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchValue.set(value);
    this.onChange(value);
    this.onTouched();

    // Debounce search emit
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.search.emit(value);
    }, this.debounceTime);
  }

  onSearch(): void {
    this.search.emit(this.searchValue());
  }

  onClear(): void {
    this.searchValue.set('');
    this.onChange('');
    this.onTouched();
    this.clear.emit();
    this.search.emit('');
  }

  onKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.onSearch();
    }
  }

  // ControlValueAccessor implementation
  writeValue(value: string): void {
    this.searchValue.set(value || '');
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }
}
