import { Component, Input, inject } from '@angular/core';

import { copyToClipboard } from '../../utils/clipboard';
import { SnackbarService } from '../../services/snackbar.service';

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'teal' | 'gray';
export type BadgeSize = 'small' | 'medium' | 'large';

@Component({
  selector: 'app-badge',
  standalone: true,
  imports: [],
  templateUrl: './badge.html',
})
export class BadgeComponent {
  @Input() variant: BadgeVariant = 'default';
  @Input() size: BadgeSize = 'medium';
  @Input() icon?: string;
  @Input() removable: boolean = false;
  @Input() customClass: string = '';
  @Input() copyable: boolean = false;
  @Input() copyValue?: string;
  @Input() monospace: boolean = false;
  @Input() pill: boolean = false;

  private snackbar = inject(SnackbarService);

  copyToClipboard(event: Event) {
    event.stopPropagation();
    if (this.copyValue) {
      copyToClipboard(this.copyValue).then(ok => {
        if (ok) this.snackbar.success('Copied to clipboard');
        else this.snackbar.error('Failed to copy');
      });
    }
  }
}
