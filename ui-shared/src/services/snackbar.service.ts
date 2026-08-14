import { Injectable, signal } from '@angular/core';

export interface SnackbarMessage {
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  duration: number;
  id: number;
}

@Injectable({
  providedIn: 'root'
})
export class SnackbarService {
  private messages = signal<SnackbarMessage[]>([]);
  private idCounter = 0;

  messages$ = this.messages.asReadonly();

  show(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', duration: number = 3000) {
    const id = ++this.idCounter;
    const snackbar: SnackbarMessage = { message, type, duration, id };
    
    this.messages.update(msgs => [...msgs, snackbar]);

    // Auto-remove after duration
    setTimeout(() => {
      this.dismiss(id);
    }, duration);
  }

  success(message: string, duration?: number) {
    this.show(message, 'success', duration);
  }

  error(message: string, duration?: number) {
    this.show(message, 'error', duration || 5000); // Errors stay longer
  }

  warning(message: string, duration?: number) {
    this.show(message, 'warning', duration || 4000);
  }

  info(message: string, duration?: number) {
    this.show(message, 'info', duration);
  }

  dismiss(id: number) {
    this.messages.update(msgs => msgs.filter(m => m.id !== id));
  }
}

