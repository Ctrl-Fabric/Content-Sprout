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
import { storageSet } from 'shared/ui';
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
    <div class="cs-dist surface-card">
      <div class="cs-dist-head">
        <div class="min-w-0">
          <h3 class="cs-section-title" style="margin: 0">Upload</h3>
          <p class="meta" style="margin: 0.2rem 0 0">
            Choose project social accounts and send the latest export. Automated publish is available
            where connected; otherwise you get a ready hand-off path on Monitor.
          </p>
        </div>
        <a routerLink="/media-studio" class="cs-link-btn" (click)="openAccounts()">Manage accounts</a>
      </div>

      @if (!enabledAccounts.length) {
        <div class="cs-empty-inline">
          <p>
            No enabled social accounts on this project. Add YouTube, Instagram, TikTok, Telegram,
            and others under
            <strong>Media Studio → Accounts</strong>.
          </p>
          <a routerLink="/media-studio" class="cs-primary-btn" (click)="openAccounts()">
            Open Accounts
          </a>
        </div>
      } @else {
        <div class="cs-platforms">
          <div class="cs-platforms-label-row">
            <span class="cs-field-label">Accounts</span>
            <span class="meta">{{ selectedIds().size }} selected</span>
          </div>
          <div class="cs-platform-grid" role="group" aria-label="Social accounts">
            @for (a of enabledAccounts; track a.id) {
              <button
                type="button"
                class="cs-platform-tile"
                [class.is-selected]="selectedIds().has(a.id)"
                [attr.aria-pressed]="selectedIds().has(a.id)"
                (click)="toggleAccount(a)"
                [title]="accountTitle(a)"
              >
                <span class="cs-platform-icon material-symbols-outlined" aria-hidden="true">{{
                  icon(a.platform)
                }}</span>
                <span class="cs-platform-name">{{ a.label || label(a.platform) }}</span>
                <span class="cs-platform-sub">{{ label(a.platform) }}{{ a.handle ? ' · ' + a.handle : '' }}</span>
              </button>
            }
          </div>
        </div>

        <div class="cs-upload-fields">
          <label>
            <span class="cs-field-label">Title</span>
            <input type="text" [(ngModel)]="title" placeholder="Post title" />
          </label>
          <label>
            <div class="cs-caption-head">
              <span class="cs-field-label">Caption / description</span>
              <button
                type="button"
                class="cs-link-btn"
                [disabled]="busy() || !canSuggestHashtags()"
                (click)="suggestHashtags()"
                title="AI suggests trendy hashtags from this description"
              >
                <span class="material-symbols-outlined" aria-hidden="true">tag</span>
                {{ suggestingHashtags() ? 'Suggesting…' : 'Suggest hashtags' }}
              </button>
            </div>
            <textarea
              rows="4"
              [(ngModel)]="caption"
              placeholder="Caption / description — AI uses this for hashtag ideas"
            ></textarea>
          </label>

          @if (suggestedHashtags().length) {
            <div class="cs-hashtags">
              <div class="cs-platforms-label-row">
                <span class="cs-field-label">Suggested hashtags</span>
                <div class="cs-hashtag-actions">
                  <button type="button" class="cs-link-btn" (click)="appendAllHashtags()">
                    Add all
                  </button>
                  <button type="button" class="cs-link-btn" (click)="clearHashtagSuggestions()">
                    Clear
                  </button>
                </div>
              </div>
              @if (hashtagNote()) {
                <p class="meta" style="margin: 0 0 0.4rem">{{ hashtagNote() }}</p>
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
        </div>

        @if (!didExport) {
          <p class="cs-dist-note">Export this post first — Upload needs a finished file in exports.</p>
        }

        <div class="cs-upload-actions">
          <button
            type="button"
            class="cs-primary-btn"
            [disabled]="!canPublish()"
            (click)="publish()"
          >
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

      @if (disabledAccounts.length) {
        <p class="cs-dist-note">
          {{ disabledAccounts.length }} disabled account{{ disabledAccounts.length === 1 ? '' : 's' }}
          hidden — enable them under Accounts to use here.
        </p>
      }
    </div>
  `,
  styles: [
    `
      .cs-link-btn,
      .cs-primary-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        border-radius: 8px;
        border: 1px solid var(--cs-border);
        background: var(--cs-surface-2, var(--cs-surface));
        color: var(--cs-text);
        padding: 0.4rem 0.7rem;
        cursor: pointer;
        font: inherit;
        text-decoration: none;
        white-space: nowrap;
      }
      .cs-primary-btn {
        background: var(--cs-accent, #3b82f6);
        border-color: transparent;
        color: #fff;
      }
      .cs-primary-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .cs-dist-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      .cs-platform-sub {
        display: block;
        font-size: 0.68rem;
        color: var(--cs-text-muted);
        margin-top: 0.15rem;
      }
      .cs-upload-fields {
        display: grid;
        gap: 0.75rem;
        margin: 1rem 0;
      }
      .cs-caption-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-bottom: 0.3rem;
      }
      .cs-caption-head .cs-link-btn .material-symbols-outlined {
        font-size: 16px;
        width: 16px;
        height: 16px;
      }
      .cs-hashtags {
        border: 1px solid var(--cs-border);
        border-radius: 10px;
        padding: 0.75rem;
        background: var(--cs-bg);
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
        border: 1px solid var(--cs-border);
        border-radius: 999px;
        background: var(--cs-surface);
        color: var(--cs-text);
        padding: 0.25rem 0.65rem;
        font: inherit;
        font-size: 0.82rem;
        cursor: pointer;
      }
      .cs-hashtag-chip.is-in-caption {
        background: color-mix(in srgb, var(--cs-accent, #3b82f6) 22%, transparent);
        border-color: color-mix(in srgb, var(--cs-accent, #3b82f6) 45%, var(--cs-border));
      }
      .cs-upload-fields label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }
      .cs-upload-fields input,
      .cs-upload-fields textarea {
        border: 1px solid var(--cs-border);
        border-radius: 8px;
        background: var(--cs-bg);
        color: var(--cs-text);
        padding: 0.5rem 0.65rem;
        font: inherit;
      }
      .cs-upload-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 0.5rem;
      }
      .cs-upload-results {
        list-style: none;
        margin: 1rem 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .cs-upload-results li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 0.35rem 0.65rem;
        align-items: start;
        border: 1px solid var(--cs-border);
        border-radius: 10px;
        padding: 0.65rem 0.75rem;
      }
      .cs-upload-results li .meta {
        grid-column: 2 / -1;
      }
      .cs-empty-inline {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 0.5rem 0;
      }
    `,
  ],
})
export class UploadWorkspaceComponent implements OnChanges {
  private readonly api = inject(ContentSproutApiService);

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
    return [a.label || this.label(a.platform), a.handle].filter(Boolean).join(' · ');
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
    return this.didExport && this.selectedIds().size > 0 && !this.busy();
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
