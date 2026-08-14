import { Injectable, TemplateRef, signal } from '@angular/core';

/**
 * Lets a routed page contribute contextual chrome to the shell header:
 * an optional title override and a template of action buttons.
 *
 * Pages declare an `<ng-template>` of actions and register it (typically in
 * `ngOnInit`), then clear it in `ngOnDestroy`. Rendering the template via
 * `ngTemplateOutlet` in the header preserves the page's binding context, so
 * click handlers and reactive disabled state keep working.
 */
@Injectable({ providedIn: 'root' })
export class PageContextService {
  /** When set, overrides the route-derived page title in the header. */
  readonly title = signal<string | null>(null);
  /** Template of page-specific action buttons rendered on the right of the header. */
  readonly actions = signal<TemplateRef<unknown> | null>(null);

  set(title: string | null, actions: TemplateRef<unknown> | null = null): void {
    this.title.set(title);
    this.actions.set(actions);
  }

  setTitle(title: string | null): void {
    this.title.set(title);
  }

  setActions(actions: TemplateRef<unknown> | null): void {
    this.actions.set(actions);
  }

  /** Clears only the actions template (keeps title). */
  clearActions(): void {
    this.actions.set(null);
  }

  clear(): void {
    this.title.set(null);
    this.actions.set(null);
  }
}
