import { Component, Input, Output, EventEmitter, signal, forwardRef, OnInit } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

export interface JsonSchemaProperty {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  required?: boolean;
  default?: any;
  enum?: any[];
  items?: JsonSchemaProperty | { type: string };
  properties?: JsonSchemaProperty[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
}

export interface JsonSchema {
  $schema?: string;
  type?: 'object' | 'array';
  title?: string;
  description?: string;
  properties?: { [key: string]: any };
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: any;
}

@Component({
  selector: 'app-json-schema-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './json-schema-editor.html',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => JsonSchemaEditorComponent),
      multi: true
    }
  ]
})
export class JsonSchemaEditorComponent implements ControlValueAccessor, OnInit {
  @Input() placeholder: string = 'Paste your JSON schema here...';
  @Input() disabled: boolean = false;
  @Input() minLength: number = 5;
  @Input() maxLength: number = 10000;
  @Output() schemaChange = new EventEmitter<string>();

  mode = signal<'visual' | 'code'>('visual');
  codeValue = signal<string>('');
  visualSchema = signal<Partial<JsonSchema>>({});
  jsonError = signal<string | null>(null);
  requiredError = signal<string | null>(null);
  isExpanded = signal<{ [key: string]: boolean }>({});
  includeSchema = signal<boolean>(true);

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  readonly typeOptions = [
    { value: 'string', label: 'String' },
    { value: 'number', label: 'Number' },
    { value: 'integer', label: 'Integer' },
    { value: 'boolean', label: 'Boolean' },
    { value: 'array', label: 'Array' },
    { value: 'object', label: 'Object' },
    { value: 'null', label: 'Null' }
  ];

  readonly formatOptions = [
    { value: '', label: 'None' },
    { value: 'date-time', label: 'Date-Time' },
    { value: 'date', label: 'Date' },
    { value: 'time', label: 'Time' },
    { value: 'email', label: 'Email' },
    { value: 'uri', label: 'URI' },
    { value: 'uuid', label: 'UUID' }
  ];

  ngOnInit(): void {
    // Don't auto-initialize - let writeValue handle initialization
    // This allows the parent component to control the initial state
  }


  initializeDefaultSchema(): void {
    const defaultSchema: JsonSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      title: '',
      description: '',
      properties: {},
      required: [],
      additionalProperties: false
    };
    this.visualSchema.set(defaultSchema);
    this.includeSchema.set(true);
    this.codeValue.set(JSON.stringify(defaultSchema, null, 2));
    this.requiredError.set(this.validateRequired(defaultSchema));
  }

  switchMode(newMode: 'visual' | 'code'): void {
    if (this.disabled) return;

    if (newMode === 'code' && this.mode() === 'visual') {
      // Convert visual schema to JSON
      try {
        const json = this.buildSchemaFromVisual();
        this.codeValue.set(JSON.stringify(json, null, 2));
        this.jsonError.set(null);
        this.requiredError.set(this.validateRequired(json));
      } catch (error: any) {
        this.jsonError.set('Error converting visual schema: ' + error.message);
      }
    } else if (newMode === 'visual' && this.mode() === 'code') {
      // Parse JSON and convert to visual schema
      try {
        const parsed = JSON.parse(this.codeValue());
        const normalized = this.normalizeRequired(parsed);
        this.visualSchema.set(normalized);
        this.jsonError.set(null);
        this.requiredError.set(this.validateRequired(normalized));
      } catch (error: any) {
        this.jsonError.set('Invalid JSON: ' + error.message);
        return;
      }
    }

    this.mode.set(newMode);
  }

  useAnyJsonSchema(): void {
    if (this.disabled) return;
    const anySchema = '{"$schema":"http://json-schema.org/draft-07/schema#"}';
    this.codeValue.set(anySchema);
    this.jsonError.set(null);
    this.requiredError.set(null);
    this.includeSchema.set(true);
    this.visualSchema.set({});
    this.mode.set('code');
    this.onChange(anySchema);
    this.onTouched();
    this.schemaChange.emit(anySchema);
  }

  onCodeChange(value: string): void {
    this.codeValue.set(value);
    this.jsonError.set(null);
    this.requiredError.set(null);

    try {
      if (value.trim()) {
        const parsed = JSON.parse(value);
        const jsonString = JSON.stringify(parsed);
        this.onChange(jsonString);
        this.onTouched();
        this.schemaChange.emit(jsonString);
        this.requiredError.set(this.validateRequired(parsed));
      } else {
        // Clear the value if empty
        this.onChange('');
        this.onTouched();
        this.schemaChange.emit('');
      }
    } catch (error: any) {
      this.jsonError.set('Invalid JSON: ' + error.message);
      // Still emit the value even if invalid, so parent can handle validation
      this.onChange(value);
      this.onTouched();
    }
  }

  buildSchemaFromVisual(): JsonSchema {
    const schema = this.visualSchema();
    const properties: { [key: string]: any } = {};

    if (schema.properties) {
      Object.keys(schema.properties).forEach(key => {
        const prop = schema.properties![key];
        if (prop && typeof prop === 'object') {
          properties[key] = { ...prop };
        }
      });
    }

    return {
      ...(this.includeSchema()
        ? { $schema: schema.$schema || 'http://json-schema.org/draft-07/schema#' }
        : {}),
      type: schema.type || 'object',
      title: schema.title || '',
      description: schema.description || '',
      properties,
      required: schema.required || [],
      additionalProperties: schema.additionalProperties !== undefined ? schema.additionalProperties : false
    };
  }

  updateVisualSchema(): void {
    try {
      const json = this.buildSchemaFromVisual();
      this.onChange(JSON.stringify(json));
      this.onTouched();
      this.schemaChange.emit(JSON.stringify(json));
      this.requiredError.set(this.validateRequired(json));
    } catch (error: any) {
      console.error('Error updating schema:', error);
    }
  }

  updateSchemaTitle(value: string): void {
    const schema = this.visualSchema();
    this.visualSchema.set({ ...schema, title: value });
    this.updateVisualSchema();
  }

  updateSchemaDescription(value: string): void {
    const schema = this.visualSchema();
    this.visualSchema.set({ ...schema, description: value });
    this.updateVisualSchema();
  }

  updateSchemaType(value: string): void {
    const schema = this.visualSchema();
    this.visualSchema.set({ ...schema, type: value as 'object' | 'array' });
    this.updateVisualSchema();
  }

  updateSchemaAdditionalProperties(value: boolean): void {
    const schema = this.visualSchema();
    this.visualSchema.set({ ...schema, additionalProperties: !value });
    this.updateVisualSchema();
  }

  toggleSchemaAttribute(value: boolean): void {
    this.includeSchema.set(value);
    this.updateVisualSchema();
  }

  // Helper methods for template
  parseInt(value: string): number {
    return parseInt(value, 10);
  }

  parseFloat(value: string): number {
    return parseFloat(value);
  }

  stringify(value: any): string {
    return JSON.stringify(value);
  }

  addProperty(): void {
    const schema = this.visualSchema();
    if (!schema.properties) {
      schema.properties = {};
    }

    const newKey = `property_${Object.keys(schema.properties).length + 1}`;
    schema.properties[newKey] = {
      type: 'string',
      description: ''
    };

    if (!schema.required || schema.required.length === 0) {
      schema.required = [newKey];
    }

    this.visualSchema.set({ ...schema });
    this.updateVisualSchema();
  }

  removeProperty(key: string): void {
    const schema = this.visualSchema();
    if (schema.properties) {
      delete schema.properties[key];
    }

    if (schema.required) {
      schema.required = schema.required.filter(r => r !== key);
    }

    const remainingKeys = Object.keys(schema.properties || {});
    if (schema.type !== 'array') {
      if (remainingKeys.length > 0 && (!schema.required || schema.required.length === 0)) {
        schema.required = [remainingKeys[0]];
      }
      if (remainingKeys.length === 0) {
        schema.required = [];
      }
    }

    this.visualSchema.set({ ...schema });
    this.updateVisualSchema();
  }

  updateProperty(key: string, field: string, value: any): void {
    const schema = this.visualSchema();
    if (schema.properties && schema.properties[key]) {
      if (field === 'name') {
        const newKey = value.trim();
        
        // If the name hasn't changed, do nothing
        if (newKey === key) {
          return;
        }
        
        // Validate the new key
        if (newKey === '') {
          // Empty name - revert to original key (input will show original)
          return;
        }
        
        // Don't rename if the new key already exists (and it's not the same property)
        if (schema.properties[newKey] && newKey !== key) {
          // Property with this name already exists - show error or prevent
          console.warn(`Property "${newKey}" already exists`);
          return;
        }

        // Rename property
        const oldValue = { ...schema.properties[key] };
        delete schema.properties[key];
        schema.properties[newKey] = oldValue;

        // Update required array
        if (schema.required) {
          const index = schema.required.indexOf(key);
          if (index !== -1) {
            schema.required[index] = newKey;
          }
        }

        // Update expanded state
        const expanded = this.isExpanded();
        if (expanded[key]) {
          expanded[newKey] = expanded[key];
          delete expanded[key];
          this.isExpanded.set({ ...expanded });
        }
      } else {
        // Update property field - create new object references so changes persist
        // (important for variable-configured properties and proper change detection)
        const newProps = { ...schema.properties };
        const currentProp = { ...newProps[key] };
        if (value === '' || value === null || value === undefined) {
          delete currentProp[field];
        } else {
          currentProp[field] = value;
        }
        newProps[key] = currentProp;
        schema.properties = newProps;
      }
    }

    this.visualSchema.set({ ...schema });
    this.updateVisualSchema();
  }

  updatePropertyDefault(key: string, value: string): void {
    try {
      const parsed = value.trim() ? JSON.parse(value) : undefined;
      this.updateProperty(key, 'default', parsed);
    } catch (e) {
      // Invalid JSON - don't update, user can fix it
      // Optionally, we could show an error message here
    }
  }

  toggleRequired(propertyKey: string): void {
    const schema = this.visualSchema();
    if (!schema.required) {
      schema.required = [];
    }

    const index = schema.required.indexOf(propertyKey);
    if (index !== -1) {
      const remainingRequired = schema.required.length - 1;
      const totalProperties = Object.keys(schema.properties || {}).length;
      if (schema.type !== 'array' && totalProperties > 0 && remainingRequired === 0) {
        this.requiredError.set('At least one property must be marked as required.');
        return;
      }
      schema.required.splice(index, 1);
    } else {
      schema.required.push(propertyKey);
    }

    this.visualSchema.set({ ...schema });
    this.updateVisualSchema();
  }

  isRequired(propertyKey: string): boolean {
    const schema = this.visualSchema();
    return schema.required?.includes(propertyKey) || false;
  }

  getPropertyKeys(): string[] {
    const schema = this.visualSchema();
    return schema.properties ? Object.keys(schema.properties) : [];
  }

  getProperty(key: string): any {
    const schema = this.visualSchema();
    return schema.properties?.[key] || {};
  }

  /**
   * Get the display type for a property. Handles:
   * - type as array (e.g. ["string", "null"]) - returns first non-null type
   * - type missing (e.g. variable-configured property) - returns 'string' as fallback
   * - type as string - returns as-is
   */
  getPropertyDisplayType(key: string): string {
    const prop = this.getProperty(key);
    const t = prop?.type;
    if (Array.isArray(t)) {
      const primary = t.find((v: string) => v !== 'null');
      return primary || 'string';
    }
    if (typeof t === 'string' && t) {
      return t;
    }
    return 'string';
  }

  toggleExpand(key: string): void {
    this.isExpanded.update(expanded => ({
      ...expanded,
      [key]: !expanded[key]
    }));
  }

  isExpandedKey(key: string): boolean {
    return this.isExpanded()[key] || false;
  }

  // ControlValueAccessor implementation
  writeValue(value: string | null): void {
    if (value && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        this.codeValue.set(JSON.stringify(parsed, null, 2));
        const normalized = this.normalizeRequired(this.deepCopySchema(parsed));
        this.visualSchema.set(normalized);
        this.includeSchema.set(Boolean(parsed.$schema));
        this.jsonError.set(null);
        this.requiredError.set(this.validateRequired(normalized));
      } catch (error: any) {
        this.codeValue.set(value);
        this.jsonError.set('Invalid JSON: ' + error.message);
      }
    } else {
      // Clear the values but don't initialize default automatically
      // Let the user choose to start with a default or paste their own
      this.codeValue.set('');
      this.visualSchema.set({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {},
        required: []
      });
      this.includeSchema.set(true);
      this.jsonError.set(null);
      this.requiredError.set(null);
    }
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

  formatJson(): void {
    try {
      const parsed = JSON.parse(this.codeValue());
      this.codeValue.set(JSON.stringify(parsed, null, 2));
      this.jsonError.set(null);
      this.onCodeChange(this.codeValue());
    } catch (error: any) {
      this.jsonError.set('Invalid JSON: ' + error.message);
    }
  }

  private validateRequired(schema: JsonSchema): string | null {
    if (schema?.type === 'array') {
      return null;
    }
    const propertyKeys = Object.keys(schema?.properties || {});
    if (propertyKeys.length > 0 && (!schema.required || schema.required.length === 0)) {
      return 'At least one property must be marked as required.';
    }
    return null;
  }

  private deepCopySchema(schema: JsonSchema): JsonSchema {
    if (!schema) return schema;
    const copy: JsonSchema = { ...schema };
    if (schema.properties && typeof schema.properties === 'object') {
      copy.properties = {};
      Object.keys(schema.properties).forEach(k => {
        const p = schema.properties![k];
        copy.properties![k] = p && typeof p === 'object' ? { ...p } : p;
      });
    }
    return copy;
  }

  private normalizeRequired(schema: JsonSchema): JsonSchema {
    if (!schema) {
      return schema;
    }
    const propertyKeys = Object.keys(schema.properties || {});
    const filteredRequired = (schema.required || []).filter(key => propertyKeys.includes(key));
    const shouldRequire = schema.type !== 'array' && propertyKeys.length > 0 && filteredRequired.length === 0;
    return {
      ...schema,
      required: shouldRequire ? [propertyKeys[0]] : filteredRequired
    };
  }
}

