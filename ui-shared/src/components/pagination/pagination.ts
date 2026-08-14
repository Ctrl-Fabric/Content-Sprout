import { Component, Input, Output, EventEmitter } from '@angular/core';


@Component({
  selector: 'app-pagination',
  standalone: true,
  imports: [],
  templateUrl: './pagination.html',
})
export class PaginationComponent {
  @Input() currentPage: number = 1;
  @Input() totalPages: number = 1;
  @Input() totalCount: number = 0;
  @Input() itemName: string = 'items'; // e.g., 'workflows', 'users', 'tenants'
  @Input() showItemCount: boolean = true;
  @Input() showPageNumbers: boolean = true; // when false, only show current page text + prev/next arrows
  @Input() maxVisiblePages: number = 7; // Maximum number of page buttons to show
  
  @Output() pageChange = new EventEmitter<number>();

  // Get page numbers to display
  get pageNumbers(): number[] {
    const total = this.totalPages;
    const current = this.currentPage;
    const maxVisible = this.maxVisiblePages;
    
    if (total <= 0) return [];
    if (total <= maxVisible) {
      // Show all pages if total is less than maxVisible
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    
    // Calculate start and end page numbers
    let startPage = Math.max(1, current - Math.floor(maxVisible / 2));
    let endPage = Math.min(total, startPage + maxVisible - 1);
    
    // Adjust start page if we're near the end
    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }
    
    return Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
  }

  // Check if we need to show ellipsis before the first page
  get showStartEllipsis(): boolean {
    return this.pageNumbers.length > 0 && this.pageNumbers[0] > 2;
  }

  // Check if we need to show ellipsis after the last page
  get showEndEllipsis(): boolean {
    const pages = this.pageNumbers;
    return pages.length > 0 && pages[pages.length - 1] < this.totalPages - 1;
  }

  // Check if we can go to previous page
  get canGoPrevious(): boolean {
    return this.currentPage > 1;
  }

  // Check if we can go to next page
  get canGoNext(): boolean {
    return this.currentPage < this.totalPages;
  }

  previousPage(): void {
    if (this.canGoPrevious) {
      this.pageChange.emit(this.currentPage - 1);
    }
  }

  nextPage(): void {
    if (this.canGoNext) {
      this.pageChange.emit(this.currentPage + 1);
    }
  }

  goToPage(page: number): void {
    if (page >= 1 && page <= this.totalPages && page !== this.currentPage) {
      this.pageChange.emit(page);
    }
  }

  goToFirstPage(): void {
    if (this.currentPage > 1) {
      this.pageChange.emit(1);
    }
  }

  goToLastPage(): void {
    if (this.currentPage < this.totalPages) {
      this.pageChange.emit(this.totalPages);
    }
  }
}

