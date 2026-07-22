import { Injectable } from '@angular/core';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

@Injectable({ providedIn: 'root' })
export class AdsenseLoader {
  private loading: Promise<void> | null = null;

  ensureLoaded(client: string): Promise<void> {
    if (!client) return Promise.resolve();
    if (this.loading) return this.loading;

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-adsense-loader="true"], script[src*="pagead/js/adsbygoogle.js"]',
    );

    if (existing) {
      this.loading = this.waitForScript(existing);
      return this.loading;
    }

    this.loading = new Promise<void>((resolve) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
      script.crossOrigin = 'anonymous';
      script.dataset['adsenseLoader'] = 'true';
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });

    return this.loading;
  }

  private waitForScript(script: HTMLScriptElement): Promise<void> {
    return new Promise<void>((resolve) => {
      if (Array.isArray(window.adsbygoogle) || typeof window.adsbygoogle !== 'undefined') {
        resolve();
        return;
      }

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      script.addEventListener('load', done, { once: true });
      script.addEventListener('error', done, { once: true });
      queueMicrotask(() => {
        if (typeof window.adsbygoogle !== 'undefined') done();
      });
      setTimeout(done, 1500);
    });
  }
}
