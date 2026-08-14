import { CommonModule, DatePipe } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ModalWrapperComponent } from '../modal-wrapper/modal-wrapper';
import {
  ServiceAccountInfoKind,
  ServiceAccountSessionInfo,
  ServiceAccountUserInfo,
} from './service-shell.models';

/**
 * Lightweight User Information / Session Details dialog for product consoles.
 * Identity admin keeps its richer IAM-specific modals; other apps use this shared UI.
 */
@Component({
  selector: 'app-service-account-info-modal',
  standalone: true,
  imports: [CommonModule, DatePipe, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal-wrapper
      [isOpen]="isOpen"
      [title]="kind === 'user' ? 'User Information' : 'Session Details'"
      [icon]="kind === 'user' ? 'info' : 'lock'"
      size="medium"
      closeButtonPosition="header"
      (close)="closeModal.emit()"
    >

      @if (kind === 'user') {
        <dl class="account-info-grid">
          <dt>Name</dt>
          <dd>{{ display(user?.displayName) }}</dd>
          <dt>Email</dt>
          <dd>{{ display(user?.email) }}</dd>
          <dt>Username</dt>
          <dd>{{ display(user?.userName) }}</dd>
          <dt>User ID</dt>
          <dd class="mono">{{ display(user?.userId) }}</dd>
        </dl>
      } @else {
        <dl class="account-info-grid">
          <dt>Organization</dt>
          <dd>{{ display(session?.organizationName) }}</dd>
          <dt>Tenant ID</dt>
          <dd class="mono">{{ display(session?.tenantId) }}</dd>
          <dt>Application ID</dt>
          <dd class="mono">{{ display(session?.applicationId) }}</dd>
          <dt>User ID</dt>
          <dd class="mono">{{ display(session?.userId) }}</dd>
          <dt>Email</dt>
          <dd>{{ display(session?.userEmail) }}</dd>
          <dt>Session expires</dt>
          <dd>
            @if (session?.expiresAt) {
              {{ session!.expiresAt | date: 'medium' }}
            } @else {
              —
            }
          </dd>
          <dt>Granted scopes</dt>
          <dd>
            @if (session?.scopes?.length) {
              <div class="chips">
                @for (s of session!.scopes!; track s) {
                  <span class="chip">{{ s }}</span>
                }
              </div>
            } @else {
              —
            }
          </dd>
        </dl>
      }
    </app-modal-wrapper>
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .account-info-grid {
        display: grid;
        grid-template-columns: 150px 1fr;
        gap: 0.65rem 1rem;
        margin: 0;
      }
      .account-info-grid dt {
        color: var(--muted, var(--text-muted, #9ca3af));
        font-size: 0.82rem;
      }
      .account-info-grid dd {
        margin: 0;
        font-size: 0.88rem;
        word-break: break-word;
        color: var(--text, var(--text-color, inherit));
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.8rem;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
      .chip {
        font-size: 0.72rem;
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
        background: var(--primary-soft, rgba(93, 150, 234, 0.15));
        color: var(--primary, #5d96ea);
      }
    `,
  ],
})
export class ServiceAccountInfoModalComponent {
  @Input() isOpen = false;
  @Input() kind: ServiceAccountInfoKind = 'user';
  @Input() user: ServiceAccountUserInfo | null = null;
  @Input() session: ServiceAccountSessionInfo | null = null;
  @Output() closeModal = new EventEmitter<void>();

  display(value: string | null | undefined): string {
    const trimmed = (value ?? '').trim();
    return trimmed || '—';
  }
}
