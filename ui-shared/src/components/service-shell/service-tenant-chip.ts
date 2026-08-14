import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { copyToClipboard } from '../../utils/clipboard';

/**
 * Standard organization / tenant badge for console headers.
 * Styles live in `_service-layout.scss` — apps must not restyle this chrome.
 */
@Component({
  selector: 'app-service-tenant-chip',
  standalone: true,
  template: `
    @if (name) {
      <button
        type="button"
        class="tenant-chip"
        [title]="chipTitle"
        (click)="copyId()"
      >
        @if (resolvedLogoUrl()) {
          <img
            class="tenant-chip-logo"
            [src]="resolvedLogoUrl()!"
            [alt]="name"
            (error)="onLogoError()"
            loading="lazy"
          />
        } @else {
          <span class="material-symbols-outlined">apartment</span>
        }
        <span class="tenant-name">{{ name }}</span>
        <span class="material-symbols-outlined tenant-copy-icon" aria-hidden="true"
          >content_copy</span
        >
      </button>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
    `,
  ],
})
export class ServiceTenantChipComponent {
  @Input() name = '';
  @Input() tenantId: string | null = null;
  @Input() logoUrl: string | null = null;
  /** When true (default), parent may show a snackbar from {@link copied}. */
  @Output() copied = new EventEmitter<boolean>();

  private failedLogoUrl = signal<string | null>(null);

  get chipTitle(): string {
    return this.tenantId
      ? `Copy organization ID (${this.tenantId})`
      : 'No organization ID available';
  }

  resolvedLogoUrl(): string | null {
    const url = this.logoUrl?.trim() || null;
    if (!url || this.failedLogoUrl() === url) {
      return null;
    }
    return url;
  }

  onLogoError(): void {
    this.failedLogoUrl.set(this.logoUrl?.trim() || null);
  }

  async copyId(): Promise<void> {
    if (!this.tenantId) {
      this.copied.emit(false);
      return;
    }
    const ok = await copyToClipboard(this.tenantId);
    this.copied.emit(ok);
  }
}
