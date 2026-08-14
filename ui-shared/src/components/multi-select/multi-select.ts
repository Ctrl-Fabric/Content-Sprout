import { Component, Input, Output, EventEmitter, forwardRef, signal, computed, ElementRef, ViewChild, effect } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

import { FormsModule } from '@angular/forms';
import { ClickOutsideDirective } from '../../directives/click-outside.directive';

export interface MultiSelectOption {
  value: string;
  label: string;
  [key: string]: any;
}

@Component({
  selector: 'app-multi-select',
  standalone: true,
  imports: [FormsModule, ClickOutsideDirective],
  templateUrl: './multi-select.html',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => MultiSelectComponent),
      multi: true
    }
  ]
})
export class MultiSelectComponent implements ControlValueAccessor {
  @Input() options: MultiSelectOption[] = [];
  @Input() placeholder: string = 'Select options...';
  @Input() disabled: boolean = false;
  @Input() displayProperty: string = 'label';
  @Input() valueProperty: string = 'value';
  @Input() searchable: boolean = true;
  @Input() set value(v: string[]) {
    this.writeValue(v);
  }
  
  @Output() selectionChange = new EventEmitter<string[]>();
  @Output() searchChange = new EventEmitter<string>();
  
  selectedValues = signal<string[]>([]);
  searchText = signal<string>('');
  isOpen = signal<boolean>(false);

  @ViewChild('dropdownRef', { static: false }) dropdownRef!: ElementRef<HTMLDivElement>;

  private onChange = (value: string[]) => {};
  private onTouched = () => {};

  filteredOptions = computed(() => {
    const search = this.searchText().toLowerCase();
    const options = this.options || [];
    
    if (!search || !this.searchable) {
      return options;
    }
    
    return options.filter(option => {
      const label = option[this.displayProperty]?.toLowerCase() || '';
      const value = option[this.valueProperty]?.toLowerCase() || '';
      return label.includes(search) || value.includes(search);
    });
  });

  selectedLabels = computed(() => {
    const selected = this.selectedValues();
    return selected.map(val => {
      const option = this.options.find(opt => opt[this.valueProperty] === val);
      return option ? option[this.displayProperty] : val;
    });
  });

  writeValue(value: string[]): void {
    if (value && Array.isArray(value)) {
      this.selectedValues.set([...value]);
    } else {
      this.selectedValues.set([]);
    }
  }

  registerOnChange(fn: (value: string[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  toggleDropdown(): void {
    if (!this.disabled) {
      this.isOpen.set(!this.isOpen());
      if (this.isOpen()) {
        this.onTouched();
      }
    }
  }

  closeDropdown(): void {
    this.isOpen.set(false);
    this.searchText.set('');
  }

  isSelected(value: string): boolean {
    return this.selectedValues().includes(value);
  }

  toggleSelection(value: string): void {
    if (this.disabled) return;
    
    const current = [...this.selectedValues()];
    const index = current.indexOf(value);
    
    if (index >= 0) {
      current.splice(index, 1);
    } else {
      current.push(value);
    }
    
    this.selectedValues.set(current);
    this.onChange(current);
    this.selectionChange.emit(current);
  }

  onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.searchText.set(input.value);
    this.searchChange.emit(input.value);
  }

  selectAll(): void {
    if (this.disabled) return;
    const allValues = this.filteredOptions().map(opt => opt[this.valueProperty]);
    this.selectedValues.set([...new Set([...this.selectedValues(), ...allValues])]);
    this.onChange(this.selectedValues());
    this.selectionChange.emit(this.selectedValues());
  }

  deselectAll(): void {
    if (this.disabled) return;
    const filteredValues = this.filteredOptions().map(opt => opt[this.valueProperty]);
    const remaining = this.selectedValues().filter(val => !filteredValues.includes(val));
    this.selectedValues.set(remaining);
    this.onChange(this.selectedValues());
    this.selectionChange.emit(this.selectedValues());
  }

  removeTag(value: string, event: Event): void {
    event.stopPropagation();
    this.toggleSelection(value);
  }

  onClickOutside(): void {
    this.closeDropdown();
  }

  getOptionLabel(value: string): string {
    const option = this.options.find(opt => opt[this.valueProperty] === value);
    return option ? option[this.displayProperty] : value;
  }

  getOptionValue(option: MultiSelectOption): string {
    return option[this.valueProperty];
  }

  getOptionDisplay(option: MultiSelectOption): string {
    return option[this.displayProperty];
  }
}

