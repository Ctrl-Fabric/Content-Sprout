import { CommonModule } from '@angular/common';
import {
  Component,
  ContentChild,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  TemplateRef,
} from '@angular/core';

/**
 * Reusable modal dialog.
 *
 * Usage:
 *   <app-modal [open]="open" title="New thing" icon="add" (closed)="open=false">
 *     ...body content (projected)...
 *     <ng-template #footer>
 *       <button (click)="open=false">Cancel</button>
 *       <button class="primary" (click)="save()">Save</button>
 *     </ng-template>
 *   </app-modal>
 *
 * Designed to be portable across product UI apps — it has no external
 * dependencies beyond Angular common and CSS variables (`--*`).
 */
@Component({
  selector: 'app-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (open) {
      <div class="overlay" (click)="onOverlayClick($event)">
        <div class="dialog" [class]="'size-' + size" role="dialog" aria-modal="true">
          <div class="dialog-head">
            <div class="head-text">
              @if (icon) {
                <span class="head-icon material-symbols-outlined">{{ icon }}</span>
              }
              <div>
                <h2 class="title">{{ title }}</h2>
                @if (subtitle) {
                  <p class="subtitle">{{ subtitle }}</p>
                }
              </div>
            </div>
            <button type="button" class="close" (click)="emitClose()" aria-label="Close">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>

          <div class="dialog-body">
            <ng-content></ng-content>
          </div>

          @if (footer) {
            <div class="dialog-footer">
              <ng-container [ngTemplateOutlet]="footer"></ng-container>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        display: grid;
        place-items: center;
        z-index: 1000;
        padding: 1.25rem;
      }
      .dialog {
        width: 100%;
        background: var(--surface);
        border-radius: 16px;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.28);
        display: flex;
        flex-direction: column;
        max-height: calc(100vh - 4rem);
        overflow: hidden;
        animation: pop 0.14s ease-out;
      }
      @keyframes pop {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.99);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
      .size-sm {
        max-width: 440px;
      }
      .size-md {
        max-width: 560px;
      }
      .size-lg {
        max-width: 760px;
      }
      .dialog-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        padding: 1.1rem 1.35rem;
        border-bottom: 1px solid var(--border);
      }
      .head-text {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .head-icon {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 11px;
        background: var(--primary-soft);
        color: var(--primary);
        font-size: 22px;
      }
      .title {
        margin: 0;
        font-size: 1.08rem;
        font-weight: 700;
      }
      .subtitle {
        margin: 0.15rem 0 0;
        font-size: 0.82rem;
        color: var(--muted);
      }
      .close {
        border: none;
        background: transparent;
        padding: 0.3rem;
        border-radius: 8px;
        display: grid;
        place-items: center;
        color: var(--muted);
      }
      .close:hover {
        background: var(--bg);
      }
      .dialog-body {
        padding: 1.35rem;
        overflow-y: auto;
      }
      .dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.6rem;
        padding: 1rem 1.35rem;
        border-top: 1px solid var(--border);
        background: var(--canvas);
      }
    `,
  ],
})
export class Modal implements OnChanges, OnDestroy {
  @Input() open = false;
  @Input() title = '';
  @Input() subtitle?: string;
  @Input() icon?: string;
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Input() closeOnOverlay = true;

  @Output() closed = new EventEmitter<void>();

  @ContentChild('footer') footer?: TemplateRef<unknown>;

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open) this.emitClose();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']) {
      this.toggleBodyLock(this.open);
    }
  }

  ngOnDestroy(): void {
    this.toggleBodyLock(false);
  }

  emitClose(): void {
    this.closed.emit();
  }

  onOverlayClick(event: MouseEvent): void {
    if (this.closeOnOverlay && event.target === event.currentTarget) {
      this.emitClose();
    }
  }

  private toggleBodyLock(lock: boolean): void {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = lock ? 'hidden' : '';
  }
}
