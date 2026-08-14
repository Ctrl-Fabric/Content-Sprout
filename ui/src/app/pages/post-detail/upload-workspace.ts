import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { storageSet, SnackbarService } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import {
  Post,
  ProjectSocialAccount,
  PublishAttempt,
  platformIcon,
  platformLabel,
} from '../../models/content-sprout.models';

const HUB_TAB_KEY = 'content-sprout.hub-tab';

@Component({
  selector: 'app-upload-workspace',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="cs-dist surface-card cs-upload">
      <div class="cs-upload-head">
        <div class="min-w-0">
          <h3 class="cs-section-title">Upload</h3>
          <p class="meta cs-upload-lead">
            Pick accounts, write a title and caption, then send the latest export.
            Connected accounts publish automatically; others get a hand-off on Monitor.
          </p>
        </div>
        <a routerLink="/media-studio" class="cs-upload-ghost" (click)="openAccounts()">
          Manage accounts
        </a>
      </div>

      @if (!enabledAccounts.length) {
        <div class="cs-upload-empty">
          <p>
            No enabled social accounts on this project. Add YouTube, Instagram, TikTok, Telegram,
            and others under
            <strong>Media Studio → Accounts</strong>.
          </p>
          <a routerLink="/media-studio" class="primary" (click)="openAccounts()">Open Accounts</a>
        </div>
      } @else {
        <div class="cs-upload-body">
          <section class="cs-upload-block" aria-label="Accounts">
            <div class="cs-upload-block-head">
              <span class="cs-field-label">Accounts</span>
              <span class="meta">{{ selectedIds().size }} selected</span>
            </div>
            <div class="cs-upload-accounts" role="group" aria-label="Social accounts">
              @for (a of enabledAccounts; track a.id) {
                <button
                  type="button"
                  class="cs-upload-account"
                  [class.is-selected]="selectedIds().has(a.id)"
                  [class.is-needs-setup]="needsYoutubeSetup(a)"
                  [attr.aria-pressed]="selectedIds().has(a.id)"
                  (click)="toggleAccount(a)"
                  [title]="accountTitle(a)"
                >
                  <span class="cs-upload-account-icon material-symbols-outlined" aria-hidden="true">{{
                    icon(a.platform)
                  }}</span>
                  <span class="cs-upload-account-copy">
                    <span class="cs-upload-account-name">{{ a.label || label(a.platform) }}</span>
                    <span class="cs-upload-account-sub">{{ accountSubtitle(a) }}</span>
                  </span>
                </button>
              }
            </div>
          </section>

          <section class="cs-upload-block" aria-label="Post copy">
            <label class="cs-upload-field">
              <span class="cs-field-label">Title</span>
              <input type="text" [(ngModel)]="title" placeholder="Post title" />
            </label>
            <label class="cs-upload-field">
              <span class="cs-upload-field-head">
                <span class="cs-field-label">Caption / description</span>
                <button
                  type="button"
                  class="cs-upload-ghost cs-upload-ghost--compact"
                  [disabled]="busy() || !canSuggestHashtags()"
                  (click)="suggestHashtags()"
                  title="AI suggests trendy hashtags from this description"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">tag</span>
                  {{ suggestingHashtags() ? 'Suggesting…' : 'Suggest hashtags' }}
                </button>
              </span>
              <textarea
                rows="5"
                [(ngModel)]="caption"
                placeholder="Caption / description — AI uses this for hashtag ideas"
              ></textarea>
            </label>

            @if (suggestedHashtags().length) {
              <div class="cs-hashtags">
                <div class="cs-upload-block-head">
                  <span class="cs-field-label">Suggested hashtags</span>
                  <div class="cs-hashtag-actions">
                    <button type="button" class="cs-upload-ghost cs-upload-ghost--compact" (click)="appendAllHashtags()">
                      Add all
                    </button>
                    <button type="button" class="cs-upload-ghost cs-upload-ghost--compact" (click)="clearHashtagSuggestions()">
                      Clear
                    </button>
                  </div>
                </div>
                @if (hashtagNote()) {
                  <p class="meta cs-hashtag-note">{{ hashtagNote() }}</p>
                }
                <div class="cs-hashtag-chips" role="group" aria-label="Suggested hashtags">
                  @for (tag of suggestedHashtags(); track tag) {
                    <button
                      type="button"
                      class="cs-hashtag-chip"
                      [class.is-in-caption]="captionHasTag(tag)"
                      [attr.aria-pressed]="captionHasTag(tag)"
                      (click)="toggleHashtagInCaption(tag)"
                      [title]="captionHasTag(tag) ? 'Remove from caption' : 'Add to caption'"
                    >
                      {{ tag }}
                    </button>
                  }
                </div>
              </div>
            }
          </section>
        </div>

        <div class="cs-upload-foot">
          <div class="cs-upload-notes">
            @if (selectedNeedsYoutubeSetup()) {
              <p class="cs-dist-note">
                A selected YouTube account is missing API credentials. Open
                <a routerLink="/media-studio" class="cs-inline-link" (click)="openAccounts()">Accounts</a>
                and add the Google OAuth client ID and secret, then connect the channel.
              </p>
            }
            @if (!didExport) {
              <p class="cs-dist-note">Export this post first — Upload needs a finished file in exports.</p>
            }
            @if (disabledAccounts.length) {
              <p class="cs-dist-note">
                {{ disabledAccounts.length }} disabled account{{ disabledAccounts.length === 1 ? '' : 's' }}
                hidden — enable them under Accounts to use here.
              </p>
            }
          </div>
          <button type="button" class="primary" [disabled]="!canPublish()" (click)="publish()">
            {{ busy() ? 'Uploading…' : 'Upload to selected accounts' }}
          </button>
        </div>
      }

      @if (lastResults().length) {
        <ul class="cs-upload-results" role="list">
          @for (r of lastResults(); track r.id || $index) {
            <li [attr.data-status]="r.status">
              <span class="material-symbols-outlined" aria-hidden="true">{{
                icon(r.platform || '')
              }}</span>
              <span class="cs-monitor-name">{{ r.account_label || label(r.platform || '') }}</span>
              <span class="cs-monitor-status">{{ statusLabel(r.status) }}</span>
              @if (r.message) {
                <span class="meta">{{ r.message }}</span>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cs-upload {
        display: grid;
        gap: 1.15rem;
        max-width: 52rem;
      }
      .cs-upload .cs-section-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 650;
      }
      .cs-upload-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.85rem;
      }
      .cs-upload-lead {
        margin: 0.35rem 0 0;
        max-width: 40rem;
        line-height: 1.45;
      }
      .cs-upload-ghost {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        flex-shrink: 0;
        padding: 0.38rem 0.7rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--bg);
        color: var(--text);
        font: inherit;
        font-size: 0.78rem;
        font-weight: 600;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
      }
      .cs-upload-ghost:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
        background: color-mix(in srgb, var(--primary) 8%, var(--bg));
      }
      .cs-upload-ghost:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .cs-upload-ghost--compact {
        padding: 0.2rem 0.5rem;
        font-size: 0.72rem;
      }
      .cs-upload-ghost .material-symbols-outlined {
        font-size: 1rem;
      }
      .cs-upload-empty {
        display: grid;
        gap: 0.75rem;
        justify-items: start;
        padding: 1rem;
        border: 1px dashed var(--border);
        border-radius: 12px;
        background: var(--bg);
      }
      .cs-upload-empty p {
        margin: 0;
        max-width: 36rem;
        color: var(--muted);
        line-height: 1.45;
      }
      .cs-upload-body {
        display: grid;
        gap: 1.15rem;
      }
      .cs-upload-block {
        display: grid;
        gap: 0.65rem;
      }
      .cs-upload-block-head,
      .cs-upload-field-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
      }
      .cs-upload-block-head .cs-field-label,
      .cs-upload-field-head .cs-field-label {
        margin: 0;
      }
      .cs-upload-accounts {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(16.5rem, 1fr));
        gap: 0.55rem;
      }
      .cs-upload-account {
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 0.7rem;
        min-height: 3.6rem;
        padding: 0.7rem 0.85rem;
        text-align: left;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: var(--bg);
        color: var(--text);
        box-shadow: none;
      }
      .cs-upload-account:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
        background: color-mix(in srgb, var(--primary) 7%, var(--bg));
      }
      .cs-upload-account.is-selected {
        border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
        background: var(--primary-soft);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 22%, transparent);
      }
      .cs-upload-account.is-needs-setup {
        border-color: color-mix(in srgb, #f59e0b 50%, var(--border));
      }
      .cs-upload-account-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.1rem;
        height: 2.1rem;
        border-radius: 8px;
        font-size: 1.2rem;
        color: var(--primary-hover, var(--primary));
        background: color-mix(in srgb, var(--primary) 14%, transparent);
      }
      .cs-upload-account-copy {
        display: grid;
        gap: 0.12rem;
        min-width: 0;
      }
      .cs-upload-account-name {
        font-size: 0.84rem;
        font-weight: 650;
        line-height: 1.25;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cs-upload-account-sub {
        font-size: 0.72rem;
        color: var(--muted);
        line-height: 1.3;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cs-upload-account.is-needs-setup .cs-upload-account-sub {
        color: #f59e0b;
      }
      .cs-upload-field {
        display: grid;
        gap: 0.35rem;
      }
      .cs-upload-field .cs-field-label {
        margin: 0;
      }
      .cs-upload-field input,
      .cs-upload-field textarea {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--bg);
        color: var(--text);
        padding: 0.62rem 0.75rem;
        font: inherit;
        font-size: 0.86rem;
        line-height: 1.4;
      }
      .cs-upload-field textarea {
        min-height: 7.5rem;
        resize: vertical;
      }
      .cs-upload-field input:focus,
      .cs-upload-field textarea:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 16%, transparent);
      }
      .cs-hashtags {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 0.75rem 0.85rem;
        background: var(--bg);
      }
      .cs-hashtag-note {
        margin: 0 0 0.45rem;
      }
      .cs-hashtag-actions {
        display: flex;
        gap: 0.35rem;
      }
      .cs-hashtag-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }
      .cs-hashtag-chip {
        border: 1px solid var(--border);
        border-radius: 999px;
        background: var(--surface);
        color: var(--text);
        padding: 0.28rem 0.7rem;
        font: inherit;
        font-size: 0.78rem;
        cursor: pointer;
      }
      .cs-hashtag-chip.is-in-caption {
        background: var(--primary-soft);
        border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
      }
      .cs-inline-link {
        color: var(--primary-hover, var(--primary));
      }
      .cs-upload-foot {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem 1rem;
        padding-top: 0.85rem;
        border-top: 1px solid var(--border);
      }
      .cs-upload-notes {
        display: grid;
        gap: 0.3rem;
        min-width: 0;
        flex: 1 1 16rem;
      }
      .cs-upload-results {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
      }
      .cs-upload-results li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 0.35rem 0.65rem;
        align-items: start;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.65rem 0.75rem;
        background: var(--bg);
      }
      .cs-upload-results li .meta {
        grid-column: 2 / -1;
      }
    `,
  ],
})
export class UploadWorkspaceComponent implements OnChanges {
  private readonly api = inject(ContentSproutApiService);
  private readonly snackbar = inject(SnackbarService);

  @Input({ required: true }) postId!: string;
  @Input() postName = '';
  @Input() accounts: ProjectSocialAccount[] = [];
  @Input() selectedPlatforms: Set<string> = new Set();
  @Input() didExport = false;
  @Input() attempts: PublishAttempt[] = [];

  @Output() platformsChange = new EventEmitter<string[]>();
  @Output() published = new EventEmitter<Post>();

  readonly busy = this.api.busy;
  readonly selectedIds = signal<Set<string>>(new Set());
  readonly lastResults = signal<PublishAttempt[]>([]);
  readonly suggestedHashtags = signal<string[]>([]);
  readonly hashtagNote = signal('');
  readonly suggestingHashtags = signal(false);

  title = '';
  caption = '';

  readonly icon = platformIcon;
  readonly label = platformLabel;

  get enabledAccounts(): ProjectSocialAccount[] {
    return (this.accounts || []).filter((a) => a.enabled !== false);
  }

  get disabledAccounts(): ProjectSocialAccount[] {
    return (this.accounts || []).filter((a) => a.enabled === false);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['postName'] || changes['postId']) {
      if (!this.title) this.title = this.postName || '';
      if (!this.caption) this.caption = this.postName || '';
    }
    if (changes['accounts'] || changes['selectedPlatforms'] || changes['postId']) {
      this.seedSelection();
    }
    if (changes['attempts'] && this.attempts?.length) {
      this.lastResults.set([...this.attempts].slice(-8).reverse());
    }
  }

  accountTitle(a: ProjectSocialAccount): string {
    const base = [a.label || this.label(a.platform), a.handle].filter(Boolean).join(' · ');
    if (this.needsYoutubeSetup(a)) {
      return `${base} — needs YouTube API client credentials`;
    }
    return base;
  }

  accountSubtitle(a: ProjectSocialAccount): string {
    const bits = [this.label(a.platform)];
    if (a.handle) bits.push(a.handle);
    if (this.needsYoutubeSetup(a)) bits.push('Needs API client');
    else if (a.platform === 'youtube' && a.has_app_credentials && !a.publish_ready) {
      bits.push('Connect channel');
    }
    return bits.join(' · ');
  }

  needsYoutubeSetup(a: ProjectSocialAccount): boolean {
    return a.platform === 'youtube' && !a.has_app_credentials && !a.publish_ready;
  }

  selectedNeedsYoutubeSetup(): boolean {
    const ids = this.selectedIds();
    return this.enabledAccounts.some((a) => ids.has(a.id) && this.needsYoutubeSetup(a));
  }

  statusLabel(status?: string): string {
    switch (status) {
      case 'published':
        return 'Published';
      case 'failed':
        return 'Failed';
      case 'manual':
        return 'Manual upload';
      case 'queued':
        return 'Queued';
      default:
        return status || 'Unknown';
    }
  }

  openAccounts(): void {
    storageSet(HUB_TAB_KEY, 'accounts');
  }

  toggleAccount(a: ProjectSocialAccount): void {
    const next = new Set(this.selectedIds());
    if (next.has(a.id)) next.delete(a.id);
    else next.add(a.id);
    this.selectedIds.set(next);
    this.emitPlatforms();
  }

  canPublish(): boolean {
    return (
      this.didExport &&
      this.selectedIds().size > 0 &&
      !this.busy() &&
      !this.selectedNeedsYoutubeSetup()
    );
  }

  canSuggestHashtags(): boolean {
    return !!(this.caption.trim() || this.title.trim());
  }

  async suggestHashtags(): Promise<void> {
    if (!this.canSuggestHashtags() || this.busy()) return;
    this.suggestingHashtags.set(true);
    try {
      const platforms = [
        ...new Set(
          this.enabledAccounts
            .filter((a) => this.selectedIds().has(a.id))
            .map((a) => a.platform),
        ),
      ];
      const data = await this.api.suggestHashtags(this.postId, {
        description: this.caption.trim(),
        title: this.title.trim(),
        platforms,
        count: 14,
      });
      if (!data) return;
      this.suggestedHashtags.set(data.hashtags);
      this.hashtagNote.set(data.note || '');
    } finally {
      this.suggestingHashtags.set(false);
    }
  }

  captionHasTag(tag: string): boolean {
    const needle = tag.toLowerCase();
    return this.captionTokens().some((t) => t.toLowerCase() === needle);
  }

  toggleHashtagInCaption(tag: string): void {
    if (this.captionHasTag(tag)) {
      this.caption = this.removeTagFromCaption(this.caption, tag);
    } else {
      this.caption = this.appendTagsToCaption(this.caption, [tag]);
    }
  }

  appendAllHashtags(): void {
    this.caption = this.appendTagsToCaption(this.caption, this.suggestedHashtags());
  }

  clearHashtagSuggestions(): void {
    this.suggestedHashtags.set([]);
    this.hashtagNote.set('');
  }

  private captionTokens(): string[] {
    return (this.caption.match(/#[A-Za-z0-9_]+/g) || []);
  }

  private removeTagFromCaption(caption: string, tag: string): string {
    const re = new RegExp(`(?:^|\\s)${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi');
    return caption.replace(re, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  private appendTagsToCaption(caption: string, tags: string[]): string {
    const existing = new Set(this.captionTokens().map((t) => t.toLowerCase()));
    const toAdd = tags.filter((t) => !existing.has(t.toLowerCase()));
    if (!toAdd.length) return caption;
    const base = caption.trimEnd();
    const block = toAdd.join(' ');
    if (!base) return block;
    if (/\n\s*$/.test(caption) || /#[A-Za-z0-9_]+(\s+#[A-Za-z0-9_]+)*\s*$/.test(base)) {
      return `${base} ${block}`.trim();
    }
    return `${base}\n\n${block}`;
  }

  async publish(): Promise<void> {
    if (this.selectedNeedsYoutubeSetup()) {
      this.snackbar.show(
        'Add YouTube OAuth client ID and secret under Accounts before uploading.',
        'error',
      );
      return;
    }
    if (!this.canPublish()) return;
    const data = await this.api.publishPost(this.postId, {
      account_ids: [...this.selectedIds()],
      caption: this.caption.trim(),
      title: this.title.trim(),
    });
    if (!data?.post) return;
    const attempts = (data.post.publish_attempts || []) as PublishAttempt[];
    this.lastResults.set([...attempts].slice(-this.selectedIds().size).reverse());
    this.emitPlatforms();
    this.published.emit(data.post);
  }

  private seedSelection(): void {
    const enabled = this.enabledAccounts;
    if (!enabled.length) {
      this.selectedIds.set(new Set());
      return;
    }
    const platforms = this.selectedPlatforms || new Set<string>();
    let picked = enabled.filter((a) => platforms.has(a.platform)).map((a) => a.id);
    if (!picked.length) picked = enabled.map((a) => a.id);
    this.selectedIds.set(new Set(picked));
  }

  private emitPlatforms(): void {
    const ids = this.selectedIds();
    const platforms = [
      ...new Set(
        this.enabledAccounts.filter((a) => ids.has(a.id)).map((a) => a.platform),
      ),
    ];
    this.platformsChange.emit(platforms);
  }
}
