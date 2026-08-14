import { Component, Input, Output, EventEmitter, signal, forwardRef, OnInit } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'app-xml-schema-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './xml-schema-editor.html',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => XmlSchemaEditorComponent),
      multi: true
    }
  ]
})
export class XmlSchemaEditorComponent implements ControlValueAccessor, OnInit {
  @Input() placeholder: string = 'Paste your XML schema (XSD) here...';
  @Input() disabled: boolean = false;
  @Input() minLength: number = 5;
  @Input() maxLength: number = 10000;
  @Output() schemaChange = new EventEmitter<string>();

  mode = signal<'visual' | 'code'>('code');
  codeValue = signal<string>('');
  xmlError = signal<string | null>(null);

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  ngOnInit(): void {
    // Don't auto-initialize - let writeValue handle initialization
  }

  switchMode(newMode: 'visual' | 'code'): void {
    if (this.disabled) return;
    this.mode.set(newMode);
  }

  onCodeChange(value: string): void {
    this.codeValue.set(value);
    this.xmlError.set(null);

    try {
      if (value.trim()) {
        // Basic XML validation - check if it's well-formed
        this.validateXml(value);
        this.onChange(value);
        this.onTouched();
        this.schemaChange.emit(value);
      } else {
        // Clear the value if empty
        this.onChange('');
        this.onTouched();
        this.schemaChange.emit('');
      }
    } catch (error: any) {
      this.xmlError.set('Invalid XML: ' + error.message);
      // Still emit the value even if invalid, so parent can handle validation
      this.onChange(value);
      this.onTouched();
    }
  }

  validateXml(xmlString: string): void {
    // Basic XML validation
    if (!xmlString.trim()) {
      return;
    }

    // Check for balanced tags (basic check)
    const openTags = (xmlString.match(/<[^\/!?][^>]*>/g) || []).length;
    const closeTags = (xmlString.match(/<\/[^>]+>/g) || []).length;
    const selfClosingTags = (xmlString.match(/<[^\/!?][^>]*\/>/g) || []).length;

    // Rough validation - this is not perfect but gives basic feedback
    const totalOpened = openTags - selfClosingTags;
    if (totalOpened !== closeTags) {
      // Not a hard error - XML might be valid but this is just a basic check
      // We'll let the backend handle actual XSD validation
    }

    // Check for XML declaration or root element
    const trimmed = xmlString.trim();
    if (!trimmed.startsWith('<')) {
      throw new Error('XML must start with <');
    }
  }

  formatXml(): void {
    try {
      const formatted = this.formatXmlString(this.codeValue());
      this.codeValue.set(formatted);
      this.xmlError.set(null);
      this.onCodeChange(formatted);
    } catch (error: any) {
      this.xmlError.set('Error formatting XML: ' + error.message);
    }
  }

  formatXmlString(xml: string): string {
    // Basic XML formatting - this is a simple formatter
    // For complex XML schemas, users may need to format manually
    try {
      let formatted = '';
      let indent = 0;
      const tab = '  '; // 2 spaces for indentation
      
      // Remove existing whitespace between tags but preserve text content
      xml = xml.replace(/>\s+</g, '><');
      
      // Use regex to find all XML tags and content
      const regex = /(<[^>]+>)/g;
      const parts = xml.split(regex);
      
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.trim()) continue;
        
        if (part.startsWith('<?')) {
          // XML declaration - no indent
          formatted += part + '\n';
        } else if (part.startsWith('<!--')) {
          // Comment - current indent
          formatted += tab.repeat(indent) + part + '\n';
        } else if (part.startsWith('</')) {
          // Closing tag - decrease indent before printing
          indent = Math.max(0, indent - 1);
          formatted += tab.repeat(indent) + part + '\n';
        } else if (part.startsWith('<')) {
          // Opening tag or self-closing tag
          formatted += tab.repeat(indent) + part + '\n';
          // Increase indent if not self-closing and not a special tag
          if (!part.endsWith('/>') && !part.startsWith('<!')) {
            indent++;
          }
        } else {
          // Text content - preserve on same line if it's just whitespace
          const trimmed = part.trim();
          if (trimmed) {
            formatted += tab.repeat(indent) + trimmed + '\n';
          }
        }
      }
      
      return formatted.trim();
    } catch (error) {
      // If formatting fails, return original
      return xml;
    }
  }

  // ControlValueAccessor implementation
  writeValue(value: string | null): void {
    if (value && value.trim()) {
      try {
        this.codeValue.set(value);
        this.validateXml(value);
        this.xmlError.set(null);
      } catch (error: any) {
        this.codeValue.set(value);
        this.xmlError.set('Invalid XML: ' + error.message);
      }
    } else {
      // Clear the values but don't initialize default automatically
      this.codeValue.set('');
      this.xmlError.set(null);
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
}

