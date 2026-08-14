import { Component, Input, Output, EventEmitter, forwardRef, computed, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ClickOutsideDirective } from '../../directives/click-outside.directive';

export interface MultiSelectOption {
  value: string;
  label: string;
  [key: string]: any;
}

@Component({
  selector: 'app-multi-select-with-badges',
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule,
    ClickOutsideDirective
  ],
  templateUrl: './multi-select-with-badges.html',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => MultiSelectWithBadgesComponent),
      multi: true
    }
  ]
})
export class MultiSelectWithBadgesComponent implements ControlValueAccessor {
  @Input() options: MultiSelectOption[] = [];
  @Input() placeholder: string = 'Select options...';
  @Input() label: string = '';
  @Input() disabled: boolean = false;
  @Input() required: boolean = false;
  @Input() badgesPosition: 'above' | 'below' = 'above';
  @Input() showTrigger: boolean = true;
  
  @Output() selectionChange = new EventEmitter<string[]>();
  
  value: string[] = [];
  searchText = signal<string>('');
  isOpen = signal<boolean>(false);
  
  private onChange = (value: string[]) => {};
  private onTouched = () => {};

  // Get filtered options based on search text
  filteredOptions = computed(() => {
    const search = this.searchText().toLowerCase().trim();
    if (!search) {
      return this.options;
    }
    return this.options.filter(option => 
      option.label.toLowerCase().includes(search) ||
      option.value.toLowerCase().includes(search)
    );
  });

  // Get selected options for display
  get selectedOptions(): MultiSelectOption[] {
    const selectedValues = this.value || [];
    return this.options.filter(option => selectedValues.includes(option.value));
  }

  // Check if all filtered options are selected
  get allFilteredSelected(): boolean {
    const filtered = this.filteredOptions();
    if (filtered.length === 0) return false;
    return filtered.every(option => this.value.includes(option.value));
  }

  // Check if some filtered options are selected
  get someFilteredSelected(): boolean {
    const filtered = this.filteredOptions();
    if (filtered.length === 0) return false;
    const selectedCount = filtered.filter(option => this.value.includes(option.value)).length;
    return selectedCount > 0 && selectedCount < filtered.length;
  }

  writeValue(value: string[]): void {
    if (value && Array.isArray(value)) {
      this.value = [...value];
    } else {
      this.value = [];
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

  onSelectionChange(selectedValues: string[]): void {
    this.value = selectedValues || [];
    this.onChange(selectedValues || []);
    this.onTouched();
    this.selectionChange.emit(selectedValues || []);
  }

  toggleDropdown(): void {
    if (!this.disabled) {
      this.isOpen.set(!this.isOpen());
      if (this.isOpen()) {
        this.onTouched();
      } else {
        this.searchText.set(''); // Clear search when closing
      }
    }
  }

  closeDropdown(): void {
    this.isOpen.set(false);
    this.searchText.set('');
  }

  isSelected(value: string): boolean {
    return this.value.includes(value);
  }

  toggleSelection(value: string): void {
    if (this.disabled) return;
    
    const current = [...this.value];
    const index = current.indexOf(value);
    
    if (index >= 0) {
      current.splice(index, 1);
    } else {
      current.push(value);
    }
    
    this.onSelectionChange(current);
  }

  onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.searchText.set(input.value);
  }

  onClickOutside(): void {
    this.closeDropdown();
  }

  removeSelection(valueToRemove: string, event: Event): void {
    event.stopPropagation();
    const currentValues = [...this.value];
    const index = currentValues.indexOf(valueToRemove);
    if (index >= 0) {
      currentValues.splice(index, 1);
      this.onSelectionChange(currentValues);
    }
  }

  selectAll(): void {
    if (this.disabled) return;
    const filtered = this.filteredOptions();
    const filteredValues = filtered.map(option => option.value);
    const currentValues = [...this.value];
    
    // Add all filtered values that aren't already selected
    filteredValues.forEach(value => {
      if (!currentValues.includes(value)) {
        currentValues.push(value);
      }
    });
    
    this.onSelectionChange(currentValues);
  }

  selectNone(): void {
    if (this.disabled) return;
    const filtered = this.filteredOptions();
    const filteredValues = filtered.map(option => option.value);
    const currentValues = this.value.filter(value => !filteredValues.includes(value));
    
    this.onSelectionChange(currentValues);
  }

  clearSearch(): void {
    this.searchText.set('');
  }
}
