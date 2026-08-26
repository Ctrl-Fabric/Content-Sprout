import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AiGenPage } from '../ai-gen/ai-gen';
import { PhotoMagicPage } from '../photo-magic/photo-magic';
import {
  CREATE_RETURN_URL_PARAM,
  backLabelForReturnUrl,
  parseSafeReturnUrl,
} from '../../shared/photo-magic-nav';

export type CreateTab = 'ai-gen' | 'photo-magic';

@Component({
  selector: 'app-create',
  standalone: true,
  imports: [CommonModule, AiGenPage, PhotoMagicPage],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div
      class="page cs-create-page"
      [class.cs-create-page--fill]="tab() === 'photo-magic'"
    >
      <div class="page-intro-bar">
        <div class="cs-create-intro">
          @if (returnUrl(); as back) {
            <button
              type="button"
              class="cs-create-back"
              (click)="goBack()"
              [attr.aria-label]="backLabel()"
            >
              <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
              {{ backLabel() }}
            </button>
          }
          <p class="cs-create-lede">
            Create and edit assets — generate with AI, or open layered Photo magic compositions.
          </p>
        </div>
        <div class="cs-tabs" role="tablist" aria-label="Create sections">
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'ai-gen'"
            [attr.aria-selected]="tab() === 'ai-gen'"
            (click)="setTab('ai-gen')"
          >
            AI Gen
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'photo-magic'"
            [attr.aria-selected]="tab() === 'photo-magic'"
            (click)="setTab('photo-magic')"
          >
            Photo magic
          </button>
        </div>
      </div>

      <div class="cs-create-panels">
        @if (mountedAiGen()) {
          <div
            class="cs-create-panel"
            [class.cs-create-panel--hidden]="tab() !== 'ai-gen'"
          >
            <app-ai-gen />
          </div>
        }
        @if (mountedPhotoMagic()) {
          <div
            class="cs-create-panel"
            [class.cs-create-panel--hidden]="tab() !== 'photo-magic'"
          >
            <app-photo-magic />
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        height: 100%;
        overflow: auto;
      }
      .cs-create-page {
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        align-items: stretch;
        gap: 0.15rem;
        width: 100%;
        min-height: 0;
        /* Content-sized for AI Gen — full-height flex was pushing tab bodies down. */
        height: auto;
        flex: 0 0 auto;
      }
      .cs-create-page--fill {
        flex: 1 1 auto;
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }
      .cs-create-intro {
        flex: 1 1 12rem;
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
        min-width: 0;
      }
      /* Avoid .page-intro — under .page-intro-bar it gets flex: 1 1 16rem and grows
         vertically inside this column, matching the tab body height. */
      .cs-create-lede {
        margin: 0;
        color: var(--muted);
        font-size: 0.72rem;
        line-height: 1.45;
        max-width: 70ch;
      }
      .cs-create-back {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.2rem 0.55rem;
        font-size: 0.78rem;
        line-height: 1.2;
        border-radius: 999px;
      }
      .cs-create-back .material-symbols-outlined {
        font-size: 1.05rem;
      }
      .cs-create-panels {
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        flex: 0 0 auto;
        min-height: 0;
        width: 100%;
      }
      .cs-create-page--fill .cs-create-panels {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }
      .cs-create-panel {
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        flex: 0 0 auto;
        min-height: 0;
        width: 100%;
      }
      .cs-create-page--fill .cs-create-panel:not(.cs-create-panel--hidden) {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }
      .cs-create-panel--hidden {
        display: none !important;
      }
      .cs-create-panel ::ng-deep app-ai-gen,
      .cs-create-panel ::ng-deep app-photo-magic {
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        width: 100%;
        min-height: 0;
      }
      .cs-create-page--fill .cs-create-panel ::ng-deep app-photo-magic {
        flex: 1 1 auto;
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }
      .cs-create-panel ::ng-deep .page {
        padding: 0;
        max-width: none;
        width: 100%;
      }
      .cs-create-page--fill .cs-create-panel ::ng-deep .cs-photomagic-page {
        flex: 1 1 auto;
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }
    `,
  ],
})
export class CreatePage implements OnInit, OnDestroy {
  readonly tab = signal<CreateTab>('ai-gen');
  readonly mountedAiGen = signal(true);
  readonly mountedPhotoMagic = signal(false);
  readonly returnUrl = signal<string | null>(null);
  readonly backLabel = computed(() => {
    const url = this.returnUrl();
    return url ? backLabelForReturnUrl(url) : 'Back';
  });

  private sub = new Subscription();

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.sub.add(
      this.route.queryParamMap.subscribe((params) => {
        this.returnUrl.set(parseSafeReturnUrl(params.get(CREATE_RETURN_URL_PARAM)));
        const raw = (params.get('tab') || '').trim().toLowerCase();
        const next: CreateTab =
          raw === 'photo-magic' || raw === 'photomagic' || raw === 'photo'
            ? 'photo-magic'
            : raw === 'ai-gen' || raw === 'aigen' || raw === 'gen'
              ? 'ai-gen'
              : this.tabFromUrl();
        this.applyTab(next, false);
      }),
    );
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  setTab(tab: CreateTab): void {
    this.applyTab(tab, true);
  }

  goBack(): void {
    const url = this.returnUrl();
    if (!url) return;
    void this.router.navigateByUrl(url);
  }

  private tabFromUrl(): CreateTab {
    const path = this.router.url.split('?')[0];
    if (path.includes('photo-magic')) return 'photo-magic';
    return 'ai-gen';
  }

  private applyTab(tab: CreateTab, syncUrl: boolean): void {
    this.tab.set(tab);
    if (tab === 'ai-gen') this.mountedAiGen.set(true);
    if (tab === 'photo-magic') this.mountedPhotoMagic.set(true);
    if (!syncUrl) return;
    const q = { ...this.route.snapshot.queryParams, tab };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: q,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
