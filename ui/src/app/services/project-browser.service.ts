import { Injectable, signal } from '@angular/core';

/** Shared open/close for the header project browser (also usable from pages). */
@Injectable({ providedIn: 'root' })
export class ProjectBrowserService {
  private readonly _open = signal(false);
  readonly isOpen = this._open.asReadonly();

  open(): void {
    this._open.set(true);
  }

  close(): void {
    this._open.set(false);
  }

  toggle(): void {
    this._open.update((v) => !v);
  }
}
