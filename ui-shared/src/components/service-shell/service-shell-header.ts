import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';

/**
 * Shared page-title + icon chrome for authenticated glass shells.
 * Supports Identity-style `App / Page` breadcrumb via `appTitle` + `pageTitle`.
 * Project optional header actions into `[headerRight]`.
 *
 * Styles live in `_service-layout.scss`.
 */
@Component({
  selector: 'app-service-shell-header',
  standalone: true,
  imports: [CommonModule],
  host: { class: 'service-shell-header' },
  template: `
    <div class="header-left">
      @if (icon && !appTitle) {
        <span class="material-symbols-outlined page-icon" aria-hidden="true">{{ icon }}</span>
      }
      <div class="page-title-container">
        @if (appTitle || pageTitle) {
          <h1 class="page-title app-page-breadcrumb">
            @if (appTitle) {
              <span class="app-title">{{ appTitle }}</span>
              @if (pageTitle) {
                <span class="title-separator" aria-hidden="true">/</span>
              }
            }
            @if (pageTitle) {
              <span class="page-title-text">{{ pageTitle }}</span>
            }
          </h1>
        } @else {
          <h1 class="page-title">{{ title }}</h1>
        }
      </div>
      <ng-content select="[headerLeft]" />
    </div>
    <div class="header-right">
      <ng-content select="[headerRight]" />
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        min-width: 0;
        gap: 1rem;
      }
    `,
  ],
})
export class ServiceShellHeaderComponent {
  /** Single-line title when not using breadcrumb (`appTitle` / `pageTitle`). */
  @Input() title = '';
  /** Optional leading Material Symbol when using single `title`. */
  @Input() icon: string | null = null;
  /** Product / app name (left of breadcrumb). */
  @Input() appTitle: string | null = null;
  /** Current page name (right of breadcrumb). */
  @Input() pageTitle: string | null = null;
}
