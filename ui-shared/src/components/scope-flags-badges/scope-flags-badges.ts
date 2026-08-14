import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-scope-flags-badges',
  standalone: true,
  templateUrl: './scope-flags-badges.html',
})
export class ScopeFlagsBadgesComponent {
  /** When omitted, treated as true (default for existing scopes). */
  @Input() isUserScope?: boolean;
  @Input() isAppScope?: boolean;
  @Input() allowDelegation?: boolean;

  /** Shown only when the scope is a user scope (omitted = true for legacy data). */
  get showUserScopeBadge(): boolean {
    return this.isUserScope !== false;
  }

  get userOn(): boolean {
    return this.isUserScope !== false;
  }

  get appOn(): boolean {
    return this.isAppScope !== false;
  }

  get showDelegation(): boolean {
    return this.userOn && this.appOn;
  }

  get delegationOn(): boolean {
    return this.allowDelegation !== false;
  }
}
