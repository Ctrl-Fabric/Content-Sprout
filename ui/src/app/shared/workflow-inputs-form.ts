import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ComfyWorkflowInputField } from '../models/content-sprout.models';

@Component({
  selector: 'app-workflow-inputs-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!fields.length) {
      @if (emptyHint) {
        <p class="meta" style="margin: 0.35rem 0 0">{{ emptyHint }}</p>
      }
    } @else if (mode === 'configure') {
      <div class="cs-form-stack" style="gap: 0.55rem; margin-top: 0.35rem">
        <p class="meta" style="margin: 0">
          Select fields users may change when generating. Defaults apply unless overridden at generate time.
        </p>
        @for (field of fields; track field.id) {
          <div class="cs-form-stack" style="gap: 0.25rem; padding: 0.4rem 0; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent)">
            <label class="cs-check" style="margin: 0">
              <input
                type="checkbox"
                [ngModel]="!!enabled[field.id]"
                (ngModelChange)="setEnabled(field.id, $event)"
              />
              <span>{{ field.label }}</span>
              <span class="meta"> · {{ field.type }}</span>
            </label>
            @if (enabled[field.id]) {
              @if (field.type === 'boolean') {
                <label>
                  <span>Default</span>
                  <input
                    type="checkbox"
                    [ngModel]="asBool(values[field.id])"
                    (ngModelChange)="setValue(field.id, $event)"
                  />
                </label>
              } @else if (field.type === 'number') {
                <label>
                  <span>Default</span>
                  <input
                    type="number"
                    [ngModel]="asNumber(values[field.id])"
                    (ngModelChange)="setValue(field.id, $event)"
                  />
                </label>
              } @else {
                <label>
                  <span>Default</span>
                  <textarea
                    rows="2"
                    [ngModel]="asString(values[field.id])"
                    (ngModelChange)="setValue(field.id, $event)"
                  ></textarea>
                </label>
              }
            }
          </div>
        }
      </div>
    } @else {
      <div class="cs-form-stack" style="gap: 0.45rem; margin-top: 0.35rem">
        @for (field of fields; track field.id) {
          <label>
            <span>{{ field.label }}</span>
            @if (field.type === 'boolean') {
              <input
                type="checkbox"
                [ngModel]="asBool(values[field.id])"
                (ngModelChange)="setValue(field.id, $event)"
              />
            } @else if (field.type === 'number') {
              <input
                type="number"
                [ngModel]="asNumber(values[field.id])"
                (ngModelChange)="setValue(field.id, $event)"
              />
            } @else {
              <textarea
                rows="2"
                [ngModel]="asString(values[field.id])"
                (ngModelChange)="setValue(field.id, $event)"
              ></textarea>
            }
          </label>
        }
      </div>
    }
  `,
})
export class WorkflowInputsFormComponent {
  @Input() fields: ComfyWorkflowInputField[] = [];
  @Input() values: Record<string, string | number | boolean> = {};
  @Input() enabled: Record<string, boolean> = {};
  @Input() mode: 'generate' | 'configure' = 'generate';
  @Input() emptyHint = '';
  @Output() valuesChange = new EventEmitter<Record<string, string | number | boolean>>();
  @Output() enabledChange = new EventEmitter<Record<string, boolean>>();

  asBool(v: unknown): boolean {
    return Boolean(v);
  }

  asNumber(v: unknown): number | null {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  asString(v: unknown): string {
    return v === null || v === undefined ? '' : String(v);
  }

  setValue(id: string, value: string | number | boolean | null): void {
    const next = { ...this.values };
    if (value === null || value === undefined) {
      delete next[id];
    } else {
      next[id] = value;
    }
    this.valuesChange.emit(next);
  }

  setEnabled(id: string, on: boolean): void {
    const next = { ...this.enabled, [id]: on };
    this.enabledChange.emit(next);
  }
}

/** Build a values map from field defaults (already merged by the API when using op inputs). */
export function valuesFromWorkflowInputs(
  fields: ComfyWorkflowInputField[],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const v = field.default;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[field.id] = v;
    } else if (v !== null && v !== undefined) {
      out[field.id] = String(v);
    }
  }
  return out;
}

export function enabledFromWorkflowInputs(
  fields: ComfyWorkflowInputField[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const field of fields) {
    out[field.id] = !!field.enabled;
  }
  return out;
}
