import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ClickOutsideDirective } from '../../directives/click-outside.directive';
import { ServiceUserMenuItem } from './service-shell.models';

/**
 * Glass user avatar + dropdown for authenticated console shells.
 * Styles live in `_service-layout.scss`.
 */
@Component({
  selector: 'app-service-user-menu',
  standalone: true,
  imports: [CommonModule, ClickOutsideDirective],
  template: `
    <div class="user-menu" (clickOutside)="close()">
      <button
        type="button"
        class="user-icon"
        (click)="toggle()"
        aria-label="User menu"
        [attr.aria-expanded]="open"
      >
        <span class="material-symbols-outlined user-avatar">account_circle</span>
      </button>

      <div class="user-dropdown" [class.open]="open">
        @if (displayName || email) {
          <div class="dropdown-header">
            <div class="user-avatar-container">
              <div class="user-avatar-large">
                <span class="material-symbols-outlined">account_circle</span>
              </div>
              <div class="user-info">
                @if (displayName) {
                  <div class="user-name">{{ displayName }}</div>
                }
                @if (email) {
                  <div class="user-email">{{ email }}</div>
                }
              </div>
            </div>
          </div>
        }

        @for (item of items; track item.id) {
          @if (item.dividerBefore) {
            <div class="dropdown-divider"></div>
          }
          <button
            type="button"
            class="dropdown-item"
            [class.sign-out]="item.danger"
            (click)="onSelect(item)"
          >
            <span class="material-symbols-outlined item-icon">{{ item.icon }}</span>
            <span class="item-label">{{ item.label }}</span>
          </button>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: contents;
      }
    `,
  ],
})
export class ServiceUserMenuComponent {
  @Input() displayName = '';
  @Input() email = '';
  @Input() items: ServiceUserMenuItem[] = [];
  @Output() itemSelect = new EventEmitter<ServiceUserMenuItem>();

  open = false;

  toggle(): void {
    this.open = !this.open;
  }

  close(): void {
    this.open = false;
  }

  onSelect(item: ServiceUserMenuItem): void {
    this.close();
    this.itemSelect.emit(item);
  }
}
