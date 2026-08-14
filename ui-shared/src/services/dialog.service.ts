import { Injectable, signal } from '@angular/core';

export type DialogSeverity = 'warning' | 'danger' | 'info';

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: DialogSeverity;
}

export interface PromptDialogOptions {
  title?: string;
  message?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  /** When true, empty/whitespace values cannot be submitted. */
  required?: boolean;
}

export interface ConfirmDialogState extends Required<
  Pick<ConfirmDialogOptions, 'title' | 'message' | 'confirmText' | 'cancelText' | 'type'>
> {
  id: number;
}

export interface PromptDialogState extends Required<
  Pick<
    PromptDialogOptions,
    | 'title'
    | 'message'
    | 'label'
    | 'defaultValue'
    | 'placeholder'
    | 'confirmText'
    | 'cancelText'
    | 'required'
  >
> {
  id: number;
}

/**
 * Promise-based app dialogs that replace browser `confirm` / `prompt`.
 * Mount {@link DialogHostComponent} once (e.g. in the app shell).
 */
@Injectable({ providedIn: 'root' })
export class DialogService {
  private idCounter = 0;
  private confirmResolver: ((value: boolean) => void) | null = null;
  private promptResolver: ((value: string | null) => void) | null = null;

  readonly confirmState = signal<ConfirmDialogState | null>(null);
  readonly promptState = signal<PromptDialogState | null>(null);

  confirm(options: ConfirmDialogOptions): Promise<boolean> {
    this.cancelPrompt();
    this.cancelConfirm();
    const id = ++this.idCounter;
    this.confirmState.set({
      id,
      title: options.title || 'Confirm',
      message: options.message,
      confirmText: options.confirmText || 'Confirm',
      cancelText: options.cancelText || 'Cancel',
      type: options.type || 'warning',
    });
    return new Promise<boolean>((resolve) => {
      this.confirmResolver = resolve;
    });
  }

  prompt(options: PromptDialogOptions): Promise<string | null> {
    this.cancelConfirm();
    this.cancelPrompt();
    const id = ++this.idCounter;
    this.promptState.set({
      id,
      title: options.title || 'Input',
      message: options.message || '',
      label: options.label || '',
      defaultValue: options.defaultValue || '',
      placeholder: options.placeholder || '',
      confirmText: options.confirmText || 'OK',
      cancelText: options.cancelText || 'Cancel',
      required: options.required !== false,
    });
    return new Promise<string | null>((resolve) => {
      this.promptResolver = resolve;
    });
  }

  /** Host: user confirmed. */
  resolveConfirm(ok: boolean): void {
    const resolve = this.confirmResolver;
    this.confirmResolver = null;
    this.confirmState.set(null);
    resolve?.(ok);
  }

  /** Host: user submitted or cancelled prompt. */
  resolvePrompt(value: string | null): void {
    const resolve = this.promptResolver;
    this.promptResolver = null;
    this.promptState.set(null);
    resolve?.(value);
  }

  private cancelConfirm(): void {
    if (!this.confirmResolver) return;
    const resolve = this.confirmResolver;
    this.confirmResolver = null;
    this.confirmState.set(null);
    resolve(false);
  }

  private cancelPrompt(): void {
    if (!this.promptResolver) return;
    const resolve = this.promptResolver;
    this.promptResolver = null;
    this.promptState.set(null);
    resolve(null);
  }
}
