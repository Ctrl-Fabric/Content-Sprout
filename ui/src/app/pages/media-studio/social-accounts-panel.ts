import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import {
  EDITOR_PLATFORMS,
  ProjectSocialAccount,
  platformIcon,
  platformLabel,
} from '../../models/content-sprout.models';
import { DialogService } from '@ctrlfabric/ui';

@Component({
  selector: 'app-social-accounts-panel',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="sa">
      <header class="sa-head">
        <div>
          <h2>Social accounts</h2>
          <p>
            Connect project destinations used by the Upload step. For YouTube, add a Google Cloud
            OAuth client with YouTube Data API v3 when you set up the account.
          </p>
        </div>
        <button type="button" class="sa-add" (click)="startAdd()">
          <span class="material-symbols-outlined" aria-hidden="true">add</span>
          Add account
        </button>
      </header>

      @if (editing()) {
        <section class="sa-form card">
          <h3>{{ formId() ? 'Edit account' : 'New account' }}</h3>
          <div class="sa-grid">
            <label>
              <span>Platform</span>
              <select [(ngModel)]="formPlatform">
                @for (p of platforms; track p.id) {
                  <option [value]="p.id">{{ p.label }}</option>
                }
              </select>
            </label>
            <label>
              <span>Label</span>
              <input type="text" [(ngModel)]="formLabel" placeholder="Main channel" />
            </label>
            <label>
              <span>Handle / URL</span>
              <input type="text" [(ngModel)]="formHandle" placeholder="@channel or https://…" />
            </label>
            <label>
              <span>External ID</span>
              <input type="text" [(ngModel)]="formExternalId" placeholder="Optional channel / page id" />
            </label>
            <label class="sa-check">
              <input type="checkbox" [(ngModel)]="formEnabled" />
              <span>Enabled for Upload</span>
            </label>
            <label class="sa-span">
              <span>Notes</span>
              <textarea rows="2" [(ngModel)]="formNotes" placeholder="How this account is used…"></textarea>
            </label>
          </div>
          @if (formPlatform === 'youtube') {
            <div class="sa-yt">
              <h4>YouTube Data API v3</h4>
              <p>
                Paste the OAuth <strong>client ID</strong> and <strong>client secret</strong> from
                Google Cloud, then save and connect the channel. Upload uses these credentials only
                on this machine.
              </p>
              <button type="button" class="sa-yt-help-toggle" (click)="ytHelpOpen.set(!ytHelpOpen())">
                <span class="material-symbols-outlined" aria-hidden="true">{{
                  ytHelpOpen() ? 'expand_less' : 'expand_more'
                }}</span>
                How to create these credentials
              </button>
              @if (ytHelpOpen()) {
                <ol class="sa-yt-steps">
                  <li>
                    Open
                    <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">
                      Google Cloud Console</a
                    >
                    and create a project (or pick an existing one).
                  </li>
                  <li>
                    Go to
                    <a
                      href="https://console.cloud.google.com/apis/library/youtube.googleapis.com"
                      target="_blank"
                      rel="noopener"
                      >APIs &amp; Services → Library</a
                    >, search for <strong>YouTube Data API v3</strong>, and click Enable.
                  </li>
                  <li>
                    Open the
                    <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noopener">
                      OAuth consent screen</a
                    >
                    and choose <strong>External</strong>. Fill in the app name and support email.
                  </li>
                  <li>
                    Add these scopes:
                    <code>https://www.googleapis.com/auth/youtube.upload</code>
                    and
                    <code>https://www.googleapis.com/auth/youtube.readonly</code>
                  </li>
                  <li>
                    Under <strong>Test users</strong>, add the Google account email for the YouTube
                    channel you will upload to. This is required while the Cloud app is in Testing
                    mode.
                  </li>
                  <li>
                    Go to
                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">
                      Credentials</a
                    >
                    → Create credentials → <strong>OAuth client ID</strong>. Choose
                    <strong>Desktop app</strong>, name it, and create.
                  </li>
                  <li>
                    Download the JSON (often named <code>client_secret_….json</code>). Copy
                    <code>client_id</code> and <code>client_secret</code> from the
                    <code>installed</code> block into the fields below. You do not need to keep the
                    file.
                  </li>
                  <li>
                    Desktop clients usually allow the local callback automatically. If Google asks
                    for a redirect URI, or you created a <strong>Web application</strong> client
                    instead, add
                    <code>http://127.0.0.1:8000/api/social-publish/youtube/callback</code>
                    as an authorized redirect URI.
                  </li>
                </ol>
              }
              <div class="sa-grid">
                <label class="sa-span">
                  <span>Client ID</span>
                  <input
                    type="text"
                    [(ngModel)]="formYtClientId"
                    autocomplete="off"
                    placeholder="xxxx.apps.googleusercontent.com"
                  />
                </label>
                <label class="sa-span">
                  <span>Client secret</span>
                  <input
                    type="password"
                    [(ngModel)]="formYtClientSecret"
                    autocomplete="new-password"
                    [placeholder]="ytSecretSet() ? 'Saved — leave blank to keep' : 'OAuth client secret'"
                  />
                </label>
                <label class="sa-span">
                  <span>OAuth redirect URI (optional)</span>
                  <input
                    type="text"
                    [(ngModel)]="formYtRedirect"
                    placeholder="http://127.0.0.1:8000/api/social-publish/youtube/callback"
                  />
                </label>
              </div>
              @if (formId() && canConnectYoutube()) {
                <button type="button" class="primary sa-connect" [disabled]="busy()" (click)="connectYoutube()">
                  <span class="material-symbols-outlined" aria-hidden="true">link</span>
                  Connect YouTube channel
                </button>
              }
            </div>
          }
          <div class="sa-form-actions">
            <button type="button" class="ghost" (click)="cancelEdit()">Cancel</button>
            <button type="button" class="primary" [disabled]="busy()" (click)="save()">
              {{ formId() ? 'Save' : 'Add' }}
            </button>
          </div>
        </section>
      }

      @if (!accounts().length && !editing()) {
        <div class="sa-empty">
          <span class="material-symbols-outlined" aria-hidden="true">share</span>
          <p>No social accounts yet. Add YouTube, Instagram, TikTok, Telegram, and other destinations for this project.</p>
          <button type="button" class="primary" (click)="startAdd()">Add account</button>
        </div>
      } @else {
        <div class="sa-list">
          @for (a of accounts(); track a.id) {
            <article class="sa-card" [class.off]="!a.enabled">
              <div class="sa-card-icon" [attr.data-platform]="a.platform">
                <span class="material-symbols-outlined" aria-hidden="true">{{ iconFor(a.platform) }}</span>
              </div>
              <div class="sa-card-body">
                <div class="sa-card-title">
                  <strong>{{ a.label || labelFor(a.platform) }}</strong>
                  <span class="chip">{{ labelFor(a.platform) }}</span>
                  @if (!a.enabled) {
                    <span class="chip muted">Disabled</span>
                  }
                  @if (a.publish_ready) {
                    <span class="chip ok">Connected</span>
                  } @else if (a.platform === 'youtube' && a.has_app_credentials) {
                    <span class="chip">API client saved</span>
                  } @else if (a.platform === 'youtube') {
                    <span class="chip muted">Needs API client</span>
                  }
                </div>
                <div class="sa-card-meta">
                  @if (a.handle) {
                    <span>{{ a.handle }}</span>
                  }
                  @if (a.status) {
                    <span class="status">{{ a.status }}</span>
                  }
                </div>
                @if (a.notes) {
                  <p class="sa-notes">{{ a.notes }}</p>
                }
              </div>
              <div class="sa-card-actions">
                @if (a.platform === 'youtube' && a.has_app_credentials && !a.publish_ready) {
                  <button type="button" class="ghost" title="Connect YouTube" (click)="connectYoutube(a.id)">
                    <span class="material-symbols-outlined" aria-hidden="true">link</span>
                  </button>
                }
                <button type="button" class="ghost" title="Edit" (click)="startEdit(a)">
                  <span class="material-symbols-outlined" aria-hidden="true">edit</span>
                </button>
                <button
                  type="button"
                  class="ghost"
                  [title]="a.enabled ? 'Disable' : 'Enable'"
                  (click)="toggleEnabled(a)"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">{{
                    a.enabled ? 'toggle_on' : 'toggle_off'
                  }}</span>
                </button>
                <button type="button" class="ghost danger" title="Remove" (click)="remove(a)">
                  <span class="material-symbols-outlined" aria-hidden="true">delete</span>
                </button>
              </div>
            </article>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .sa {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        max-width: 920px;
      }
      .sa-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
      }
      .sa-head h2 {
        margin: 0 0 0.25rem;
        font-size: 1.15rem;
      }
      .sa-head p {
        margin: 0;
        color: var(--cs-text-muted);
        font-size: 0.88rem;
        max-width: 42rem;
        line-height: 1.45;
      }
      .sa-add,
      .primary,
      .ghost {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        border-radius: 8px;
        border: 1px solid var(--cs-border);
        background: var(--cs-surface-2, var(--cs-surface));
        color: var(--cs-text);
        padding: 0.45rem 0.75rem;
        cursor: pointer;
        font: inherit;
      }
      .primary {
        background: var(--cs-accent, #3b82f6);
        border-color: transparent;
        color: #fff;
      }
      .ghost.danger {
        color: #f87171;
      }
      .sa-add .material-symbols-outlined,
      .sa-card-actions .material-symbols-outlined,
      .sa-empty .material-symbols-outlined {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
      .sa-empty .material-symbols-outlined {
        font-size: 36px;
        width: 36px;
        height: 36px;
        opacity: 0.5;
      }
      .card,
      .sa-card {
        border: 1px solid var(--cs-border);
        border-radius: 12px;
        background: var(--cs-surface);
        padding: 1rem;
      }
      .sa-form h3 {
        margin: 0 0 0.75rem;
        font-size: 0.95rem;
      }
      .sa-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem;
      }
      .sa-grid label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.78rem;
        color: var(--cs-text-muted);
      }
      .sa-grid input,
      .sa-grid select,
      .sa-grid textarea {
        border: 1px solid var(--cs-border);
        border-radius: 8px;
        background: var(--cs-bg);
        color: var(--cs-text);
        padding: 0.45rem 0.6rem;
        font: inherit;
      }
      .sa-check {
        flex-direction: row !important;
        align-items: center;
        gap: 0.5rem !important;
        margin-top: 1.4rem;
      }
      .sa-span {
        grid-column: 1 / -1;
      }
      .sa-form-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 0.85rem;
      }
      .sa-empty {
        border: 1px dashed var(--cs-border);
        border-radius: 12px;
        padding: 2rem 1.25rem;
        text-align: center;
        color: var(--cs-text-muted);
      }
      .sa-empty p {
        max-width: 28rem;
        margin: 0.75rem auto 1rem;
        line-height: 1.45;
      }
      .sa-list {
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
      }
      .sa-card {
        display: flex;
        align-items: flex-start;
        gap: 0.85rem;
        padding: 0.85rem 1rem;
      }
      .sa-card.off {
        opacity: 0.62;
      }
      .sa-card-icon {
        width: 40px;
        height: 40px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--cs-accent, #3b82f6) 16%, transparent);
        flex-shrink: 0;
      }
      .sa-card-body {
        flex: 1;
        min-width: 0;
      }
      .sa-card-title {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.4rem;
      }
      .chip {
        font-size: 0.68rem;
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
        border: 1px solid var(--cs-border);
        color: var(--cs-text-muted);
      }
      .chip.muted {
        opacity: 0.8;
      }
      .chip.ok {
        border-color: color-mix(in srgb, #22c55e 45%, var(--cs-border));
        color: #4ade80;
      }
      .sa-yt {
        margin-top: 0.9rem;
        padding: 0.85rem;
        border: 1px dashed var(--cs-border);
        border-radius: 10px;
        background: color-mix(in srgb, var(--cs-accent, #3b82f6) 6%, transparent);
      }
      .sa-yt h4 {
        margin: 0 0 0.35rem;
        font-size: 0.85rem;
      }
      .sa-yt p {
        margin: 0 0 0.75rem;
        font-size: 0.78rem;
        color: var(--cs-text-muted);
        line-height: 1.45;
      }
      .sa-yt-help-toggle {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        margin: 0 0 0.65rem;
        padding: 0;
        border: 0;
        background: none;
        color: var(--cs-accent, #3b82f6);
        font: inherit;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .sa-yt-help-toggle .material-symbols-outlined {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
      .sa-yt-steps {
        margin: 0 0 0.9rem;
        padding: 0 0 0 1.15rem;
        font-size: 0.78rem;
        color: var(--cs-text-muted);
        line-height: 1.5;
      }
      .sa-yt-steps li + li {
        margin-top: 0.45rem;
      }
      .sa-yt-steps a {
        color: var(--cs-accent, #3b82f6);
      }
      .sa-yt-steps code {
        font-size: 0.72rem;
        word-break: break-all;
        color: var(--cs-text);
      }
      .sa-connect {
        margin-top: 0.75rem;
      }
      .sa-card-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.65rem;
        margin-top: 0.25rem;
        font-size: 0.8rem;
        color: var(--cs-text-muted);
      }
      .sa-notes {
        margin: 0.4rem 0 0;
        font-size: 0.8rem;
        color: var(--cs-text-muted);
        line-height: 1.4;
      }
      .sa-card-actions {
        display: flex;
        gap: 0.15rem;
        flex-shrink: 0;
      }
      .sa-card-actions .ghost {
        padding: 0.35rem;
      }
      @media (max-width: 720px) {
        .sa-grid {
          grid-template-columns: 1fr;
        }
        .sa-head {
          flex-direction: column;
        }
      }
    `,
  ],
})
export class SocialAccountsPanelComponent {
  private readonly api = inject(ContentSproutApiService);
  private readonly dialogs = inject(DialogService);

  readonly platforms = EDITOR_PLATFORMS;
  readonly busy = this.api.busy;
  readonly accounts = computed(
    () => this.api.currentProject()?.social_accounts ?? ([] as ProjectSocialAccount[]),
  );

  readonly editing = signal(false);
  readonly formId = signal<string | null>(null);
  readonly ytSecretSet = signal(false);
  readonly ytConnected = signal(false);
  readonly ytHelpOpen = signal(true);
  formPlatform = 'youtube';
  formLabel = '';
  formHandle = '';
  formExternalId = '';
  formEnabled = true;
  formNotes = '';
  formYtClientId = '';
  formYtClientSecret = '';
  formYtRedirect = '';

  iconFor = platformIcon;
  labelFor = platformLabel;

  startAdd(): void {
    this.formId.set(null);
    this.formPlatform = 'youtube';
    this.formLabel = '';
    this.formHandle = '';
    this.formExternalId = '';
    this.formEnabled = true;
    this.formNotes = '';
    this.resetYoutubeCreds();
    this.ytHelpOpen.set(true);
    this.editing.set(true);
  }

  async startEdit(a: ProjectSocialAccount): Promise<void> {
    this.formId.set(a.id);
    this.formPlatform = a.platform;
    this.formLabel = a.label || '';
    this.formHandle = a.handle || '';
    this.formExternalId = a.external_id || '';
    this.formEnabled = a.enabled !== false;
    this.formNotes = a.notes || '';
    this.resetYoutubeCreds();
    this.ytConnected.set(!!a.publish_ready || !!a.has_credentials);
    this.ytHelpOpen.set(!(a.platform === 'youtube' && a.has_app_credentials));
    this.editing.set(true);
    if (a.platform === 'youtube') await this.loadYoutubeCreds(a.id);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.formId.set(null);
    this.resetYoutubeCreds();
  }

  canConnectYoutube(): boolean {
    const hasClient = !!this.formYtClientId.trim();
    const hasSecret = !!this.formYtClientSecret.trim() || this.ytSecretSet();
    return hasClient && hasSecret && !this.ytConnected();
  }

  connectYoutube(accountId?: string): void {
    const id = accountId || this.formId();
    if (!id) return;
    window.location.href = this.api.youtubeOAuthUrl(id);
  }

  async save(): Promise<void> {
    const id = this.formId();
    const payload = {
      platform: this.formPlatform,
      label: this.formLabel.trim(),
      handle: this.formHandle.trim(),
      external_id: this.formExternalId.trim(),
      enabled: this.formEnabled,
      notes: this.formNotes.trim(),
    };
    const account = id
      ? await this.api.updateSocialAccount(id, payload)
      : await this.api.createSocialAccount(payload);
    if (!account) return;
    if (this.formPlatform === 'youtube') {
      const credOk = await this.saveYoutubeCreds(account.id);
      if (!credOk) return;
      this.formId.set(account.id);
      this.formYtClientSecret = '';
      if (this.canConnectYoutube()) return;
    }
    this.cancelEdit();
  }

  private resetYoutubeCreds(): void {
    this.formYtClientId = '';
    this.formYtClientSecret = '';
    this.formYtRedirect = '';
    this.ytSecretSet.set(false);
    this.ytConnected.set(false);
  }

  private async loadYoutubeCreds(accountId: string): Promise<void> {
    const view = await this.api.getSocialAccountCredentials(accountId);
    if (!view?.fields) return;
    for (const field of view.fields) {
      if (field.key === 'client_id') this.formYtClientId = field.value || '';
      if (field.key === 'client_secret') this.ytSecretSet.set(!!field.set);
      if (field.key === 'oauth_redirect_uri') this.formYtRedirect = field.value || '';
      if (field.key === 'refresh_token' || field.key === 'access_token') {
        if (field.set) this.ytConnected.set(true);
      }
    }
  }

  private async saveYoutubeCreds(accountId: string): Promise<boolean> {
    const updates: {
      client_id?: string;
      client_secret?: string;
      oauth_redirect_uri?: string;
    } = {};
    if (this.formYtClientId.trim()) updates.client_id = this.formYtClientId.trim();
    if (this.formYtClientSecret.trim()) updates.client_secret = this.formYtClientSecret.trim();
    if (this.formYtRedirect.trim()) updates.oauth_redirect_uri = this.formYtRedirect.trim();
    if (!Object.keys(updates).length) return true;
    const saved = await this.api.putSocialAccountCredentials(accountId, updates);
    if (saved) this.ytSecretSet.set(!!saved.has_app_credentials || this.ytSecretSet());
    return !!saved;
  }

  async toggleEnabled(a: ProjectSocialAccount): Promise<void> {
    await this.api.updateSocialAccount(a.id, { enabled: !a.enabled });
  }

  async remove(a: ProjectSocialAccount): Promise<void> {
    const label = a.label || this.labelFor(a.platform);
    const ok = await this.dialogs.confirm({
      title: 'Remove social account?',
      message: `Remove “${label}” from this project? Upload will no longer offer it.`,
      confirmText: 'Remove',
      type: 'danger',
    });
    if (!ok) return;
    await this.api.deleteSocialAccount(a.id);
  }
}
