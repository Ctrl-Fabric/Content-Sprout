import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';
import { storageGet, storageSet } from '@ctrlfabric/ui';

export type AssetListLayout = 'grid' | 'list';

const LAYOUT_KEY = 'content-sprout.asset-view';

function readLayout(): AssetListLayout {
  return storageGet(LAYOUT_KEY) === 'list' ? 'list' : 'grid';
}

@Injectable({ providedIn: 'root' })
export class AssetListViewService {
  readonly layout = signal<AssetListLayout>(readLayout());

  setLayout(next: AssetListLayout): void {
    this.layout.set(next);
    storageSet(LAYOUT_KEY, next);
  }
}

@Component({
  selector: 'app-asset-view-toggle',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cs-am-view-toggle" role="group" aria-label="Asset view">
      <button
        type="button"
        [class.active]="view.layout() === 'grid'"
        [attr.aria-pressed]="view.layout() === 'grid'"
        title="Grid view"
        (click)="view.setLayout('grid')"
      >
        <span class="material-symbols-outlined" aria-hidden="true">grid_view</span>
      </button>
      <button
        type="button"
        [class.active]="view.layout() === 'list'"
        [attr.aria-pressed]="view.layout() === 'list'"
        title="List view"
        (click)="view.setLayout('list')"
      >
        <span class="material-symbols-outlined" aria-hidden="true">view_list</span>
      </button>
    </div>
  `,
})
export class AssetViewToggleComponent {
  readonly view = inject(AssetListViewService);
}
