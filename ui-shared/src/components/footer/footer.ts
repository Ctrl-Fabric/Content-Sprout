import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { COMPANY_CONTACT } from '../../config/company-contact';
import { ServiceFooterLink } from '../service-shell/service-shell.models';

/**
 * Fixed viewport footer for authenticated glass shells.
 * Place in `.layout-main` as a sibling below `main.layout-content`
 * (inside `.layout-footer-wrapper`).
 */
@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <footer class="app-footer">
      <div class="footer-content">
        @if (links.length) {
          <nav class="footer-legal-nav" aria-label="Legal">
            @for (link of links; track trackLink(link)) {
              @if (link.action) {
                <button type="button" (click)="onAction(link.action!)">{{ link.label }}</button>
              } @else if (link.external) {
                <a [href]="link.path" target="_blank" rel="noopener noreferrer">{{ link.label }}</a>
              } @else {
                <a [routerLink]="link.path" target="_blank" rel="noopener noreferrer">{{
                  link.label
                }}</a>
              }
            }
          </nav>
        }
        @if (attributionText) {
          <span class="copyright">{{ attributionText }}</span>
        }
      </div>
    </footer>
  `,
})
export class FooterComponent {
  private readonly company = inject(COMPANY_CONTACT, { optional: true });

  readonly currentYear = new Date().getFullYear();
  /** Optional legal / utility links (Identity Admin legal hub, etc.). */
  @Input() links: ServiceFooterLink[] = [];
  /**
   * Right-side attribution line. When empty, uses `© {year} {legalName}` from
   * {@link provideCompanyContact}, or year-only if no company was provided.
   */
  @Input() attribution = '';
  /** Fired when a link with `action` is clicked. */
  @Output() linkAction = new EventEmitter<string>();

  get attributionText(): string {
    const override = this.attribution.trim();
    if (override) return override;
    const name = this.company?.legalName?.trim();
    return name
      ? `© ${this.currentYear} ${name}. All rights reserved.`
      : `© ${this.currentYear}`;
  }

  trackLink(link: ServiceFooterLink): string {
    return `${link.action || ''}|${link.path || ''}|${link.label}`;
  }

  onAction(action: string): void {
    this.linkAction.emit(action);
  }
}
