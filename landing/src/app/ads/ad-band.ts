import {
  AfterViewInit,
  Component,
  ElementRef,
  ViewChild,
  computed,
  inject,
  input,
} from '@angular/core';
import { ADS_CONFIG, AdPlacement } from './ads.config';
import { AdsenseLoader } from './adsense-loader.service';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

@Component({
  selector: 'app-ad-band',
  standalone: true,
  template: `
    @if (enabled()) {
      <aside class="ad-band" [class.ad-band--compact]="compact()" aria-label="Sponsored">
        <div class="container ad-band-inner">
          <span class="ad-label">Sponsored</span>
          <ins
            #adEl
            class="adsbygoogle ad-unit"
            [class.ad-unit--compact]="compact()"
            style="display:block"
            [attr.data-ad-client]="client()"
            [attr.data-ad-slot]="slotId() || null"
            [attr.data-ad-format]="compact() ? 'rectangle' : 'horizontal'"
            data-full-width-responsive="true"
          ></ins>
        </div>
      </aside>
    }
  `,
})
export class AdBand implements AfterViewInit {
  private readonly loader = inject(AdsenseLoader);
  private pushed = false;

  readonly placement = input.required<AdPlacement>();
  readonly compact = input(false);

  @ViewChild('adEl') private adEl?: ElementRef<HTMLElement>;

  readonly enabled = computed(() => ADS_CONFIG.enabled && !!ADS_CONFIG.adsenseClient.trim());
  readonly client = computed(() => ADS_CONFIG.adsenseClient.trim());
  readonly slotId = computed(() => ADS_CONFIG.slots[this.placement()].trim());

  ngAfterViewInit(): void {
    if (!this.enabled()) return;
    void this.loader.ensureLoaded(this.client()).then(() => this.pushWhenReady());
  }

  private pushWhenReady(attempt = 0): void {
    if (this.pushed) return;
    const el = this.adEl?.nativeElement;
    if (!el) return;

    const width = el.getBoundingClientRect().width || el.offsetWidth;
    if (width < 2) {
      if (attempt < 20) {
        requestAnimationFrame(() => this.pushWhenReady(attempt + 1));
      }
      return;
    }

    requestAnimationFrame(() => {
      if (this.pushed) return;
      this.pushed = true;
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch (err) {
        this.pushed = false;
        console.warn('[AdSense]', this.placement(), err);
      }
    });
  }
}
