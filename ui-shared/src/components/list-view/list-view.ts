
import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-list-view',
  standalone: true,
  imports: [],
  templateUrl: './list-view.html',
})
export class ListViewComponent {
  @Input() title = '';
  @Input() subtitle = '';
  @Input() isLoading = false;
  @Input() loadingText = 'Loading...';
  @Input() isEmpty = false;
  @Input() emptyIcon = 'inventory_2';
  @Input() emptyTitle = 'No data found';
  @Input() emptyMessage = 'No records are available.';
}
