import { Component, Input, ContentChild, TemplateRef, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-page-wrapper',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './page-wrapper.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PageWrapperComponent {
  @Input() title?: string;
  @Input() subtitle?: string;
  @Input() icon?: string;
  /** When false, the header actions (e.g. tab bar) are not shown even if headerActions template is provided. */
  @Input() showHeaderActions = true;
  /**
   * When false, the outer `.card` shell is visually removed (no border, shadow, or fill)
   * so the page can use a single inner surface (e.g. dashboard hero) without double frames.
   */
  @Input() showOuterCard = true;
  @ContentChild('headerActions') headerActions?: TemplateRef<any>;
}
