import { Component, Input, Output, EventEmitter, forwardRef, signal, computed, effect, ElementRef, ViewChild, SimpleChanges, OnChanges } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

import { FormsModule } from '@angular/forms';

export interface AutocompleteOption {
  value: string;
  label: string;
  [key: string]: any; // Allow additional properties
}

@Component({
  selector: 'app-autocomplete',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './autocomplete.html',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => AutocompleteComponent),
      multi: true
    }
  ]
})
export class AutocompleteComponent implements ControlValueAccessor, OnChanges {
  @Input() options: AutocompleteOption[] = [];
  @Input() placeholder: string = 'Type to search...';
  @Input() disabled: boolean = false;
  @Input() displayProperty: string = 'label';
  @Input() valueProperty: string = 'value';
  @Input() minSearchLength: number = 0;
  @Input() showClearButton: boolean = true;
  @Input() multiple: boolean = false; // Enable multi-select mode

  // Signal-backed options for reactivity in computed
  private optionsSignal = signal<AutocompleteOption[]>([]);

  @Output() selectionChange = new EventEmitter<AutocompleteOption | null | AutocompleteOption[]>();
  @Output() searchChange = new EventEmitter<string>();

  value = signal<string>('');
  multiValue = signal<string[]>([]); // For multi-select mode
  searchText = signal<string>('');
  isOpen = signal<boolean>(false);
  highlightedIndex = signal<number>(-1);
  selectedOption = signal<AutocompleteOption | null>(null);
  selectedOptions = signal<AutocompleteOption[]>([]); // For multi-select mode

  @ViewChild('inputRef', { static: false }) inputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('dropdownRef', { static: false }) dropdownRef!: ElementRef<HTMLDivElement>;

  private onChange = (value: string | string[]) => { };
  private onTouched = () => { };

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['options']) {
      this.optionsSignal.set(this.options || []);
      // Re-sync selectedOptions when options load asynchronously (e.g. AVAILABLE_AGENTS: value set before options loaded)
      if (this.multiple && this.multiValue().length > 0) {
        const selected = this.multiValue().map(val =>
          (this.options || []).find(opt => opt[this.valueProperty] === val)
        ).filter(opt => opt !== undefined) as AutocompleteOption[];
        this.selectedOptions.set(selected);
      }
    }
  }

  filteredOptions = computed(() => {
    const search = this.searchText().toLowerCase();
    const options = this.optionsSignal();

    if (!search || search.length < this.minSearchLength) {
      return options.slice(0, 50); // Limit to first 50 when no search
    }

    return options.filter(option => {
      const label = option[this.displayProperty]?.toLowerCase() || '';
      const value = option[this.valueProperty]?.toLowerCase() || '';
      return label.includes(search) || value.includes(search);
    }).slice(0, 50); // Limit results to 50
  });

  constructor() {
    // Sync searchText and selectedOption with value changes
    effect(() => {
      const value = this.value();
      const options = this.options || [];
      if (value) {
        const option = options.find(opt => opt[this.valueProperty] === value);
        if (option) {
          this.selectedOption.set(option);
          if (this.searchText() !== option[this.displayProperty]) {
            this.searchText.set(option[this.displayProperty]);
          }
        } else if (!this.searchText()) {
          // Value exists but option not found - keep current search text or clear
          this.selectedOption.set(null);
        }
      } else {
        if (this.selectedOption()) {
          this.selectedOption.set(null);
        }
        // Don't clear searchText if user is typing
      }
    });
  }

  writeValue(value: string | string[]): void {
    if (this.multiple) {
      if (Array.isArray(value)) {
        this.multiValue.set([...value]);
        // Update selectedOptions based on multiValue
        const selected = value.map(val =>
          this.options.find(opt => opt[this.valueProperty] === val)
        ).filter(opt => opt !== undefined) as AutocompleteOption[];
        this.selectedOptions.set(selected);
      } else {
        this.multiValue.set([]);
        this.selectedOptions.set([]);
      }
    } else {
      this.value.set((value as string) || '');
    }
  }

  registerOnChange(fn: (value: string | string[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  onWrapperClick(): void {
    if (this.disabled) {
      return;
    }
    if (!this.isOpen()) {
      this.isOpen.set(true);
    }
    if (this.inputRef) {
      this.inputRef.nativeElement.focus();
    }
  }

  onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.searchText.set(input.value);
    this.searchChange.emit(input.value);

    if (!this.isOpen() && input.value.length >= this.minSearchLength) {
      this.isOpen.set(true);
    }

    // If search text doesn't match selected option, clear selection
    if (this.selectedOption() && this.searchText() !== this.selectedOption()![this.displayProperty]) {
      this.selectedOption.set(null);
      this.value.set('');
      this.onChange('');
    }
  }

  onFocus(): void {
    // When minSearchLength is 0, open dropdown on focus so options are visible (e.g. when options load async)
    if (this.filteredOptions().length > 0 || this.minSearchLength === 0) {
      this.isOpen.set(true);
    }
    this.onTouched();
  }

  onBlur(): void {
    // Delay to allow click events to fire first
    setTimeout(() => {
      if (this.multiple) {
        // In multi-select mode, just clear search and close dropdown
        this.searchText.set('');
        this.isOpen.set(false);
        this.highlightedIndex.set(-1);
      } else {
        // Single-select mode: try to match and select
        if (!this.selectedOption() && this.searchText()) {
          // If no option is selected and there's text, try to match
          const exactMatch = this.options.find(
            opt => opt[this.displayProperty]?.toLowerCase() === this.searchText().toLowerCase()
          );

          if (exactMatch) {
            this.selectOption(exactMatch);
          } else {
            // Clear search if no match
            this.searchText.set('');
          }
        }
        this.isOpen.set(false);
        this.highlightedIndex.set(-1);
      }
    }, 200);
  }

  /**
   * Handle mousedown on an option so selection runs before blur.
   * Click fires after blur, so the dropdown can close and the click never reaches the option.
   * Mousedown fires before blur, so we select here and preventDefault to avoid focus move.
   */
  onOptionMouseDown(event: MouseEvent, option: AutocompleteOption): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectOption(option);
  }

  selectOption(option: AutocompleteOption): void {
    if (this.multiple) {
      // Multi-select mode: toggle selection
      const currentValues = [...this.multiValue()];
      const optionValue = option[this.valueProperty];
      const index = currentValues.indexOf(optionValue);

      if (index >= 0) {
        // Remove if already selected
        currentValues.splice(index, 1);
        this.selectedOptions.update(opts => opts.filter(opt => opt[this.valueProperty] !== optionValue));
      } else {
        // Add if not selected
        currentValues.push(optionValue);
        this.selectedOptions.update(opts => [...opts, option]);
      }

      this.multiValue.set(currentValues);
      // Don't clear search text in multi-select mode - allow continuous searching
      // this.searchText.set(''); 
      this.onChange(currentValues);
      this.selectionChange.emit([...this.selectedOptions()]);
    } else {
      // Single-select mode
      this.selectedOption.set(option);
      this.value.set(option[this.valueProperty]);
      this.searchText.set(option[this.displayProperty]);
      this.isOpen.set(false);
      this.highlightedIndex.set(-1);
      this.onChange(option[this.valueProperty]);
      this.selectionChange.emit(option);
    }
  }

  isOptionSelected(option: AutocompleteOption): boolean {
    if (this.multiple) {
      return this.multiValue().includes(option[this.valueProperty]);
    }
    return this.selectedOption()?.value === option.value;
  }

  removeSelectedOption(option: AutocompleteOption, event: Event): void {
    event.stopPropagation();
    if (this.multiple) {
      const currentValues = [...this.multiValue()];
      const optionValue = option[this.valueProperty];
      const index = currentValues.indexOf(optionValue);

      if (index >= 0) {
        currentValues.splice(index, 1);
        this.multiValue.set(currentValues);
        this.selectedOptions.update(opts => opts.filter(opt => opt[this.valueProperty] !== optionValue));
        this.onChange(currentValues);
        this.selectionChange.emit([...this.selectedOptions()]);
      }
    }
  }

  selectAll(): void {
    if (this.multiple) {
      const allValues = this.options.map(opt => opt[this.valueProperty]);
      this.multiValue.set(allValues);
      this.selectedOptions.set([...this.options]);
      this.onChange(allValues);
      this.selectionChange.emit([...this.options]);
    }
  }

  deselectAll(): void {
    if (this.multiple) {
      this.multiValue.set([]);
      this.selectedOptions.set([]);
      this.onChange([]);
      this.selectionChange.emit([]);
    }
  }

  clearSelection(): void {
    if (this.multiple) {
      this.multiValue.set([]);
      this.selectedOptions.set([]);
      this.searchText.set('');
      this.isOpen.set(false);
      this.onChange([]);
      this.selectionChange.emit([]);
    } else {
      this.selectedOption.set(null);
      this.value.set('');
      this.searchText.set('');
      this.isOpen.set(false);
      this.onChange('');
      this.selectionChange.emit(null);

      // Focus input after clearing
      setTimeout(() => {
        if (this.inputRef) {
          this.inputRef.nativeElement.focus();
        }
      }, 0);
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    const filtered = this.filteredOptions();

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.isOpen.set(true);
      const next = this.highlightedIndex() < filtered.length - 1
        ? this.highlightedIndex() + 1
        : 0;
      this.highlightedIndex.set(next);
      this.scrollToHighlighted();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.isOpen.set(true);
      const prev = this.highlightedIndex() > 0
        ? this.highlightedIndex() - 1
        : filtered.length - 1;
      this.highlightedIndex.set(prev);
      this.scrollToHighlighted();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (this.isOpen() && this.highlightedIndex() >= 0 && filtered[this.highlightedIndex()]) {
        this.selectOption(filtered[this.highlightedIndex()]);
      }
    } else if (event.key === 'Escape') {
      this.isOpen.set(false);
      this.highlightedIndex.set(-1);
    }
  }

  private scrollToHighlighted(): void {
    if (this.dropdownRef && this.highlightedIndex() >= 0) {
      const dropdown = this.dropdownRef.nativeElement;
      const items = dropdown.querySelectorAll('.autocomplete-option');
      if (items[this.highlightedIndex()]) {
        items[this.highlightedIndex()].scrollIntoView({ block: 'nearest' });
      }
    }
  }
}
