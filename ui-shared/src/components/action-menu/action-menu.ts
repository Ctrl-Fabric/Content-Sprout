
import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  Inject,
  Input,
  OnDestroy,
  ViewChild,
  ViewEncapsulation,
} from '@angular/core';

export type ActionMenuItem = {
  label: string;
  icon?: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
};

const MENU_MIN_WIDTH = 180;

@Component({
  selector: 'app-action-menu',
  standalone: true,
  imports: [],
  templateUrl: './action-menu.html',
  styleUrl: './action-menu.scss',
  encapsulation: ViewEncapsulation.None,
})
export class ActionMenuComponent implements AfterViewInit, OnDestroy {
  @Input() items: ActionMenuItem[] = [];
  @Input() ariaLabel = 'More actions';

  @ViewChild('triggerBtn') triggerBtn?: ElementRef<HTMLButtonElement>;
  @ViewChild('menuPanel') menuPanel?: ElementRef<HTMLDivElement>;

  isOpen = false;

  private readonly onScrollCapture = (): void => {
    if (this.isOpen) {
      this.updateMenuPosition();
    }
  };

  constructor(
    private host: ElementRef<HTMLElement>,
    @Inject(DOCUMENT) private document: Document,
  ) {}

  ngAfterViewInit(): void {
    // Portal the panel to <body> so it is never clipped by ancestor overflow or
    // trapped in a stacking context. Angular still owns the view, so @for stays reactive.
    const panel = this.menuPanel?.nativeElement;
    if (panel) {
      this.document.body.appendChild(panel);
    }
    // Capture-phase listener so the menu repositions when scrolling inside detail panels.
    this.document.addEventListener('scroll', this.onScrollCapture, true);
  }

  ngOnDestroy(): void {
    this.document.removeEventListener('scroll', this.onScrollCapture, true);
    const panel = this.menuPanel?.nativeElement;
    if (panel?.parentNode) {
      panel.parentNode.removeChild(panel);
    }
  }

  toggle(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.items?.length) return;
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    const panel = this.menuPanel?.nativeElement;
    if (!panel) return;
    panel.style.display = 'block';
    this.isOpen = true;
    this.updateMenuPosition();
  }

  close(): void {
    const panel = this.menuPanel?.nativeElement;
    if (panel) {
      panel.style.display = 'none';
    }
    this.isOpen = false;
  }

  handleItemClick(item: ActionMenuItem, event: MouseEvent): void {
    event.stopPropagation();
    if (item.disabled) return;
    try {
      item.onClick();
    } finally {
      this.close();
    }
  }

  private updateMenuPosition(): void {
    const trigger = this.triggerBtn?.nativeElement;
    const panel = this.menuPanel?.nativeElement;
    if (!trigger || !panel || typeof window === 'undefined') {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    let left = rect.right - MENU_MIN_WIDTH;
    left = Math.max(margin, Math.min(left, window.innerWidth - MENU_MIN_WIDTH - margin));

    const menuHeight = panel.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      menuHeight > 0 && spaceBelow < menuHeight + margin && rect.top > menuHeight + margin
        ? rect.top - menuHeight - margin
        : rect.bottom + margin;

    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  }

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent): void {
    if (!this.isOpen) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (this.host.nativeElement.contains(target)) return;
    const panel = this.menuPanel?.nativeElement;
    if (panel?.contains(target)) return;
    this.close();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.isOpen) {
      this.updateMenuPosition();
    }
  }

}
