import { Component, Input, Output, EventEmitter, ContentChild, TemplateRef, OnInit, OnDestroy, OnChanges, SimpleChanges, Renderer2, Inject, PLATFORM_ID, ChangeDetectionStrategy, NgZone } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';

@Component({
  selector: 'app-modal-wrapper',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './modal-wrapper.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ModalWrapperComponent implements OnInit, OnDestroy, OnChanges {
  @Input() isOpen: boolean = false;
  @Input() title?: string;
  @Input() subtitle?: string;
  @Input() icon?: string;
  @Input() showCloseButton: boolean = true;
  @Input() closeButtonPosition: 'header' | 'footer' | 'both' = 'footer';
  @Input() closeOnOverlayClick: boolean = true;
  /** When true, blocks overlay click and the header close button (e.g. while saving). */
  @Input() closeDisabled: boolean = false;
  @Input() size: 'small' | 'medium' | 'large' | 'xlarge' = 'medium';
  @Input() customClass: string = '';
  @Output() close = new EventEmitter<void>();
  @ContentChild('headerContent') headerContent?: TemplateRef<any>;
  @ContentChild('footerActions') footerActions?: TemplateRef<any>;

  constructor(
    private renderer: Renderer2,
    private ngZone: NgZone,
    @Inject(PLATFORM_ID) private platformId: Object
  ) {}

  ngOnInit(): void {
    // Update modal-open class based on initial isOpen state
    this.updateModalOpenClass();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Update modal-open class when isOpen changes
    if (changes['isOpen']) {
      this.updateModalOpenClass();
    }
  }

  ngOnDestroy(): void {
    // Remove modal-open class when modal is destroyed
    if (isPlatformBrowser(this.platformId)) {
      this.ngZone.runOutsideAngular(() => {
        this.renderer.removeClass(document.body, 'modal-open');
      });
    }
  }

  private updateModalOpenClass(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.ngZone.runOutsideAngular(() => {
        if (this.isOpen) {
          this.renderer.addClass(document.body, 'modal-open');
        } else {
          this.renderer.removeClass(document.body, 'modal-open');
        }
      });
    }
  }

  onClose(): void {
    if (this.closeDisabled) {
      return;
    }
    this.close.emit();
  }

  onOverlayClick(event: Event): void {
    if (this.closeDisabled) {
      return;
    }
    if (this.closeOnOverlayClick && event.target === event.currentTarget) {
      this.onClose();
    }
  }
}

