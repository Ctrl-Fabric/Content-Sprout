import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  computed,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent, SnackbarService } from '@ctrlfabric/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import type {
  ScriptBrief,
  ScriptChatTurn,
  ScriptDocument,
  ScriptSummary,
} from '../../models/content-sprout.models';
import {
  VISUAL_MEDIA_TYPES,
  defaultScriptBrief,
  deriveScriptSceneBlocks,
  ensureScriptDurationMarkers,
  formatScriptCueTag,
  formatScriptDurationLabel,
  formatTypedVisualDetail,
  getScriptEstimatedDurationS,
  makeBlankScriptSceneBlock,
  parseVisualDurationToken,
  promoteUnboundBlocksForInsert,
  scriptSpokenWordCount,
  stitchScriptFromSceneBlocks,
  uniqueNewSceneDetail,
  visualMediaTypeSupportsDuration,
  type VisualMediaTypeId,
} from '../../shared/script-scenes';

type SideTab = 'brief' | 'history' | 'refine';
type ViewMode = 'scenes' | 'text';
type MarkerKind =
  | 'SCENE START'
  | 'SCENE END'
  | 'DURATION'
  | 'HELPER'
  | 'VISUAL'
  | 'ADD ASSET'
  | 'PAUSE SCRIPT'
  | 'RESUME SCRIPT';

@Component({
  selector: 'app-script-workspace',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="cs-sg" [class.is-busy]="aiBusy()">
      <aside class="cs-sg-side surface-card">
        <div class="cs-sg-side-tabs" role="tablist" aria-label="Brief, drafts, and refine">
          <button
            type="button"
            role="tab"
            [class.active]="sideTab() === 'brief'"
            [attr.aria-selected]="sideTab() === 'brief'"
            (click)="setSideTab('brief')"
          >
            Brief
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="sideTab() === 'history'"
            [attr.aria-selected]="sideTab() === 'history'"
            (click)="setSideTab('history')"
          >
            Drafts
            @if (history().length) {
              <span class="cs-sg-count">{{ history().length }}</span>
            }
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="sideTab() === 'refine'"
            [attr.aria-selected]="sideTab() === 'refine'"
            (click)="setSideTab('refine')"
          >
            Refine
          </button>
        </div>
        <p class="meta cs-sg-hint">{{ sideHint() }}</p>

        @if (sideTab() === 'brief') {
          <div class="cs-sg-pane cs-sg-brief">
            <div class="cs-sg-brief-head">
              <p class="cs-sg-brief-intro">Topic and constraints for the first draft</p>
              <button
                type="button"
                class="primary cs-sg-brief-save"
                (click)="saveBrief()"
                [disabled]="frozen() || saving()"
              >
                Save brief
              </button>
            </div>

            <label class="cs-sg-brief-field">
              <span class="cs-sg-brief-label">Topic / idea</span>
              <textarea
                rows="4"
                [(ngModel)]="brief.topic"
                (ngModelChange)="onBriefChange()"
                [disabled]="frozen() || aiBusy()"
                placeholder="e.g. 3 morning habits that boost focus for remote workers"
              ></textarea>
            </label>

            <div class="cs-sg-brief-grid">
              <label class="cs-sg-brief-field">
                <span class="cs-sg-brief-label">Tone</span>
                <select
                  [(ngModel)]="brief.tone"
                  (ngModelChange)="onBriefChange()"
                  [disabled]="frozen() || aiBusy()"
                >
                  <option value="conversational">Conversational</option>
                  <option value="energetic">Energetic</option>
                  <option value="calm">Calm / mindful</option>
                  <option value="authoritative">Authoritative</option>
                  <option value="witty">Witty</option>
                  <option value="educational">Educational</option>
                </select>
              </label>
              <label class="cs-sg-brief-field">
                <span class="cs-sg-brief-label">Duration (s)</span>
                <input
                  type="number"
                  min="5"
                  max="600"
                  step="1"
                  [(ngModel)]="brief.duration_s"
                  (ngModelChange)="onDurationChange($event)"
                  [disabled]="frozen() || aiBusy()"
                  title="Target spoken length for Generate only. After a draft exists, timeline and edits follow the script’s scene durations."
                />
                <span class="cs-sg-brief-hint"
                  >Used when you click Generate. Edits, chat refine, and timeline follow the
                  script’s own scene lengths.</span
                >
              </label>
            </div>

            <label class="cs-sg-brief-field">
              <span class="cs-sg-brief-label">Audience</span>
              <input
                type="text"
                [(ngModel)]="brief.audience"
                (ngModelChange)="onBriefChange()"
                [disabled]="frozen() || aiBusy()"
                placeholder="e.g. busy founders, fitness beginners"
              />
            </label>

            <label class="cs-sg-brief-field">
              <span class="cs-sg-brief-label">Language</span>
              <input
                type="text"
                [(ngModel)]="brief.language"
                (ngModelChange)="onBriefChange()"
                [disabled]="frozen() || aiBusy()"
              />
            </label>

            <label class="cs-sg-brief-field">
              <span class="cs-sg-brief-label">Extra notes</span>
              <textarea
                rows="3"
                [(ngModel)]="brief.notes"
                (ngModelChange)="onBriefChange()"
                [disabled]="frozen() || aiBusy()"
                placeholder="Must mention free shipping · avoid jargon · end with CTA to link in bio"
              ></textarea>
            </label>

            <div class="cs-sg-brief-generate">
              <button
                type="button"
                class="primary cs-sg-generate"
                (click)="generate()"
                [disabled]="aiBusy() || frozen()"
              >
                {{ aiBusy() && aiMode() === 'generate' ? 'Generating…' : 'Generate script' }}
              </button>
              <p class="cs-sg-llm-status" [class.is-ready]="llmReady()" [class.is-offline]="!llmReady()">
                {{ llmStatus() }}
              </p>
            </div>
            @if (api.llmError(); as llmErr) {
              <div class="cs-sg-llm-error" role="alert">{{ llmErr }}</div>
            }

            @if (summary()) {
              <p class="cs-sg-summary">{{ summary() }}</p>
            }
          </div>
        }

        @if (sideTab() === 'history') {
          <div class="cs-sg-pane">
            <div class="cs-bar" style="margin: 0 0 0.5rem">
              <p class="meta" style="margin: 0">Saved drafts — set one as active</p>
              <button type="button" class="danger" (click)="clearAllDrafts()" [disabled]="!history().length">
                Clear all
              </button>
            </div>
            <ul class="cs-sg-history">
              @for (item of history(); track item.id) {
                <li [class.is-open]="item.id === activeId()" [class.is-active]="item.active">
                  <button type="button" class="cs-sg-history-open" (click)="openDraft(item.id)">
                    <strong>{{ item.title || 'Untitled' }}</strong>
                    <span class="meta">
                      {{ item.word_count || 0 }} words
                      @if (item.frozen) {
                        · frozen
                      }
                      @if (item.active) {
                        · active
                      }
                    </span>
                    @if (item.preview) {
                      <span class="meta truncate">{{ item.preview }}</span>
                    }
                  </button>
                  <div class="page-actions-inline">
                    @if (!item.active) {
                      <button type="button" (click)="setActive(item.id)">Set active</button>
                    }
                    <button type="button" class="danger" (click)="deleteDraft(item.id)">Delete</button>
                  </div>
                </li>
              } @empty {
                <li class="cs-empty-inline">No drafts yet. Generate or save a script.</li>
              }
            </ul>
          </div>
        }

        @if (sideTab() === 'refine') {
          <div class="cs-sg-pane cs-sg-refine">
            <div class="cs-sg-chat" #chatThread>
              @for (turn of chat(); track $index) {
                <div
                  class="cs-sg-msg"
                  [class.is-user]="turn.role === 'user'"
                  [class.is-assistant]="turn.role !== 'user'"
                >
                  <div class="cs-sg-msg-meta">
                    <span class="cs-sg-msg-avatar" aria-hidden="true">
                      <span class="material-symbols-outlined">{{
                        turn.role === 'user' ? 'person' : 'smart_toy'
                      }}</span>
                    </span>
                    <span class="cs-sg-msg-role">{{ turn.role === 'user' ? 'You' : 'Assistant' }}</span>
                  </div>
                  <div class="cs-sg-bubble">{{ turn.content }}</div>
                </div>
              } @empty {
                <p class="cs-empty-inline">
                  Chat to refine the <strong>active</strong> unfrozen draft. Changes replace the script text.
                </p>
              }
            </div>
            <form class="cs-sg-chat-form" (ngSubmit)="sendChat($event)">
              <textarea
                rows="3"
                [(ngModel)]="chatInput"
                name="chatInput"
                [disabled]="aiBusy() || !canRefine()"
                placeholder="e.g. Make the hook punchier and add a soft CTA at the end"
                (keydown)="onChatKeydown($event)"
              ></textarea>
              <div class="page-actions-inline">
                <button type="submit" class="primary" [disabled]="aiBusy() || !canRefine() || !chatInput.trim()">
                  {{ aiBusy() && aiMode() === 'refine' ? 'Thinking…' : 'Send' }}
                </button>
                <button type="button" (click)="clearChat()" [disabled]="aiBusy() || !chat().length">
                  Clear chat
                </button>
              </div>
              @if (api.llmError(); as llmErr) {
                <div class="cs-sg-llm-error" role="alert">{{ llmErr }}</div>
              }
              @if (!canRefine()) {
                <p class="meta">Open and activate an unfrozen draft to refine.</p>
              }
            </form>
          </div>
        }
      </aside>

      <section class="cs-sg-editor surface-card">
        <div class="cs-sg-editor-head">
          <div class="min-w-0">
            <h3 class="cs-sg-title">{{ title() || 'Untitled script' }}</h3>
            <p class="meta">
              @if (frozen()) {
                Frozen snapshot — unfreeze to edit, or fork a new version.
              } @else {
                Spoken lines + SCENE / HELPER / VISUAL markers — refine replaces this draft.
              }
            </p>
          </div>
          <div class="cs-sg-editor-actions">
            <div class="cs-sg-view-toggle" role="group" aria-label="Script view mode">
              <button
                type="button"
                [class.active]="viewMode() === 'text'"
                (click)="setViewMode('text')"
                title="Text view"
              >
                <span class="material-symbols-outlined" aria-hidden="true">notes</span>
              </button>
              <button
                type="button"
                [class.active]="viewMode() === 'scenes'"
                (click)="setViewMode('scenes')"
                title="Scene view"
              >
                <span class="material-symbols-outlined" aria-hidden="true">view_agenda</span>
              </button>
            </div>
            @if (isActiveDraft()) {
              <span class="cs-sg-badge is-active">Active</span>
            }
            @if (frozen()) {
              <span class="cs-sg-badge is-frozen">Frozen</span>
            }
            @if (!isActiveDraft() && activeId()) {
              <button type="button" (click)="setActive(activeId()!)">Set active</button>
            }
            <button type="button" (click)="newVersion()" [disabled]="!activeId() || aiBusy()">
              New version
            </button>
            @if (!frozen()) {
              <button type="button" (click)="freeze()" [disabled]="!activeId()">Freeze</button>
            } @else {
              <button type="button" (click)="unfreeze()" [disabled]="!activeId()">Unfreeze</button>
            }
            <span class="meta">{{ wordCount() }} words</span>
            <span class="meta cs-sg-est">{{ durationLabel() }}</span>
          </div>
        </div>

        <div class="cs-sg-toolbar">
          <span class="meta uppercase">{{ viewMode() === 'scenes' ? 'Scene view' : 'Script draft' }}</span>
          <div class="page-actions-inline">
            @if (viewMode() === 'scenes') {
              <button type="button" (click)="expandAll()">Expand all</button>
              <button type="button" (click)="collapseAll()">Collapse all</button>
            }
            <button
              type="button"
              (click)="openMarkerDialog()"
              [disabled]="frozen()"
              title="Insert a production marker"
            >
              Insert marker
            </button>
            <button type="button" (click)="newBlank()" [disabled]="frozen()">New blank</button>
            <button type="button" (click)="copyScript()" [disabled]="!scriptText().trim()">Copy</button>
            <button type="button" (click)="downloadScript()" [disabled]="!scriptText().trim()">
              Download
            </button>
            <button type="button" class="danger" (click)="clearDraft()" [disabled]="frozen()">Clear</button>
            <button type="button" class="primary" (click)="saveScript()" [disabled]="frozen() || saving()">
              {{ saving() ? 'Saving…' : 'Save script' }}
            </button>
          </div>
        </div>

        @if (viewMode() === 'text') {
          <textarea
            class="cs-sg-text"
            [ngModel]="scriptText()"
            (ngModelChange)="onScriptTextChange($event)"
            [disabled]="frozen()"
            rows="18"
            spellcheck="true"
            placeholder="Your script will appear here…

[SCENE START: Hook @ 0s]
[DURATION: 8s @ 0s]
[VISUAL: video · 3s · overhead pour of coffee]
Spoken line…
[SCENE END: Hook @ 8s]"
          ></textarea>
        } @else {
          <div class="cs-sg-scenes" aria-label="Script scenes">
            @for (scene of scenes(); track scene.id; let i = $index) {
              <article class="cs-sg-scene" [class.is-open]="isSceneOpen(scene.id)">
                <div class="cs-sg-scene-bar">
                  <button
                    type="button"
                    class="cs-sg-scene-head"
                    (click)="toggleScene(scene.id)"
                    [attr.aria-expanded]="isSceneOpen(scene.id)"
                  >
                    <span class="material-symbols-outlined cs-sg-scene-chevron" aria-hidden="true"
                      >chevron_right</span
                    >
                    <span class="cs-sg-scene-head-main">
                      <span class="cs-sg-scene-title">{{ scene.name }}</span>
                      <span class="cs-sg-scene-meta">
                        <span class="cs-sg-cue-chip">{{ sceneWordCount(scene.body) }} words</span>
                        @for (cue of scene.cueSummary; track cue.kind) {
                          <span class="cs-sg-cue-chip"
                            >{{ cue.kind }}{{ cue.n > 1 ? ' · ' + cue.n : '' }}</span
                          >
                        }
                      </span>
                    </span>
                  </button>
                  <div class="cs-sg-scene-side">
                    <span class="cs-sg-scene-duration" title="Scene duration">
                      <span class="cs-sg-scene-duration-label">Dur</span>
                      {{ formatDur(scene.duration_s) }}
                    </span>
                    @if (!frozen()) {
                      <button
                        type="button"
                        class="cs-sg-scene-insert"
                        title="Insert scene before"
                        (click)="insertScene(i, 'before')"
                      >
                        + Before
                      </button>
                      <button
                        type="button"
                        class="cs-sg-scene-insert"
                        title="Insert scene after"
                        (click)="insertScene(i, 'after')"
                      >
                        + After
                      </button>
                    }
                  </div>
                </div>
                @if (isSceneOpen(scene.id)) {
                  <div class="cs-sg-scene-panel">
                    <div class="cs-sg-scene-panel-tools">
                      <button
                        type="button"
                        class="cs-sg-scene-insert"
                        (click)="openMarkerDialog(i)"
                        [disabled]="frozen()"
                        title="Insert marker into this scene"
                      >
                        + Marker
                      </button>
                    </div>
                    <textarea
                      class="cs-sg-scene-body"
                      [attr.rows]="sceneEditorRows(scene.body)"
                      [ngModel]="scene.body"
                      (ngModelChange)="onSceneBodyChange(i, $event)"
                      [disabled]="frozen()"
                      spellcheck="true"
                      [attr.aria-label]="scene.name + ' script'"
                    ></textarea>
                  </div>
                }
              </article>
            } @empty {
              <div class="cs-sg-scenes-empty">
                <p class="cs-empty-inline">No scenes yet.</p>
                @if (!frozen()) {
                  <button type="button" class="primary" (click)="addFirstScene()">Add first scene</button>
                }
              </div>
            }
          </div>
        }

        <p class="meta cs-sg-foot">
          Markers include timeline times (<code>&#64; 12.5s</code>). VISUAL / ADD ASSET can declare a
          media type and, for video / music / SFX, clip length
          (<code>video · 3.5s · …</code>). Set a draft <strong>Active</strong> to sync the timeline —
          or skip Script and build the timeline by hand.
          <span class="cs-sg-status">{{ saveStatus() }}</span>
        </p>
      </section>

      <app-modal-wrapper
        [isOpen]="showMarkerDialog()"
        title="Insert marker"
        [subtitle]="markerDialogSubtitle()"
        icon="bookmark_add"
        size="small"
        customClass="cs-console-modal"
        closeButtonPosition="header"
        (close)="closeMarkerDialog()"
      >
        <div class="cs-form-stack cs-sg-marker-form">
          <label>
            <span>Marker type</span>
            <select [(ngModel)]="markerKind" (ngModelChange)="onMarkerKindChange($event)">
              @for (k of markerKinds; track k) {
                <option [value]="k">{{ k }}</option>
              }
            </select>
          </label>

          @if (markerNeedsMediaType()) {
            <fieldset class="cs-sg-media-types">
              <legend>Media type</legend>
              <div class="cs-sg-media-type-grid" role="radiogroup" aria-label="Media type">
                @for (t of visualMediaTypes; track t.id) {
                  <button
                    type="button"
                    class="cs-sg-media-type"
                    [class.active]="markerMediaType === t.id"
                    (click)="setMarkerMediaType(t.id)"
                  >
                    {{ t.label }}
                  </button>
                }
              </div>
            </fieldset>
          }

          @if (markerNeedsMediaDuration()) {
            <label>
              <span>Clip duration (optional)</span>
              <input
                type="text"
                [(ngModel)]="markerDuration"
                placeholder="e.g. 3.5 or 3.5s"
                maxlength="24"
                inputmode="decimal"
              />
            </label>
          }

          @if (markerNeedsDetail()) {
            <label>
              <span>{{ markerDetailLabel() }}</span>
              <textarea
                rows="3"
                [(ngModel)]="markerDetail"
                [placeholder]="markerDetailPlaceholder()"
                maxlength="500"
              ></textarea>
            </label>
          }

          <p class="meta cs-sg-marker-preview">
            Preview:
            <code>{{ markerPreview() }}</code>
          </p>
        </div>
        <ng-template #footerActions>
          <button type="button" (click)="closeMarkerDialog()">Cancel</button>
          <button type="button" class="primary" (click)="confirmMarkerInsert()">Insert</button>
        </ng-template>
      </app-modal-wrapper>
    </div>
  `,
})
export class ScriptWorkspaceComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) postId = '';
  @Input() ideationNotes = '';

  readonly sideTab = signal<SideTab>('brief');
  readonly viewMode = signal<ViewMode>('scenes');
  readonly history = signal<ScriptSummary[]>([]);
  readonly postActiveId = signal<string | null>(null);
  readonly activeId = signal<string | null>(null);
  readonly title = signal('Untitled script');
  readonly summary = signal('');
  readonly scriptText = signal('');
  readonly chat = signal<ScriptChatTurn[]>([]);
  readonly frozen = signal(false);
  readonly showMarkerDialog = signal(false);
  readonly markerTargetSceneIndex = signal<number | null>(null);

  readonly markerKinds: MarkerKind[] = [
    'VISUAL',
    'ADD ASSET',
    'HELPER',
    'DURATION',
    'SCENE START',
    'SCENE END',
    'PAUSE SCRIPT',
    'RESUME SCRIPT',
  ];
  readonly visualMediaTypes = VISUAL_MEDIA_TYPES;

  markerKind: MarkerKind = 'VISUAL';
  markerMediaType: VisualMediaTypeId = 'video';
  markerDetail = '';
  markerDuration = '';
  readonly saving = signal(false);
  readonly aiBusy = signal(false);
  readonly aiMode = signal<'generate' | 'refine' | null>(null);
  readonly saveStatus = signal('');
  readonly openSceneIds = signal<Set<string>>(new Set());
  readonly llmReady = signal(false);
  readonly llmStatus = signal('Checking LLM…');

  brief: ScriptBrief = defaultScriptBrief();
  chatInput = '';

  readonly scenes = computed(() => deriveScriptSceneBlocks(this.scriptText()));
  readonly wordCount = computed(() => scriptSpokenWordCount(this.scriptText()));
  readonly durationLabel = computed(() =>
    formatScriptDurationLabel(getScriptEstimatedDurationS(this.scriptText())),
  );
  readonly isActiveDraft = computed(
    () => !!this.activeId() && this.activeId() === this.postActiveId(),
  );
  readonly canRefine = computed(
    () => !!this.activeId() && this.isActiveDraft() && !this.frozen() && !!this.scriptText().trim(),
  );
  readonly sideHint = computed(() => {
    if (this.sideTab() === 'history') return 'Open a draft or set one active for the timeline';
    if (this.sideTab() === 'refine') return 'Chat refinements update the active draft';
    return 'Topic and constraints for the first script draft';
  });

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    public api: ContentSproutApiService,
    private snackbar: SnackbarService,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['postId'] && this.postId) {
      void this.bootstrap();
    }
  }

  ngOnDestroy(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    void this.flushSave();
  }

  formatDur(s: number): string {
    return formatScriptDurationLabel(s);
  }

  sceneWordCount(body: string): number {
    return scriptSpokenWordCount(body);
  }

  sceneEditorRows(body: string): number {
    const lines = String(body || '').split('\n').length;
    return Math.max(8, Math.min(28, lines + 2));
  }

  setSideTab(tab: SideTab): void {
    this.sideTab.set(tab);
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
  }

  markDirty(): void {
    this.dirty = true;
    this.schedulePersist();
  }

  async bootstrap(): Promise<void> {
    void this.refreshLlmStatus();
    const list = await this.api.listScripts(this.postId);
    if (!list) return;
    this.history.set(list.scripts || []);
    this.postActiveId.set(list.active_script_id || null);
    const openId = list.active_script_id || list.scripts?.[0]?.id || null;
    if (openId) await this.openDraft(openId);
    else this.resetEditor();
  }

  private async refreshLlmStatus(): Promise<void> {
    const caps = await this.api.getAiCapabilities();
    const ready = !!(caps?.script_generate ?? caps?.vision_llm);
    this.llmReady.set(ready);
    const model = caps?.model ? ` · ${caps.model}` : '';
    this.llmStatus.set(
      ready ? `LLM ready${model}` : 'LLM offline — enable Ollama or proxy in Settings',
    );
  }

  onBriefChange(): void {
    this.syncLengthFromDuration();
    this.markDirty();
  }

  onDurationChange(value: number | string): void {
    const n = Number(value);
    this.brief.duration_s = Number.isFinite(n) && n > 0 ? Math.min(600, Math.max(5, Math.round(n))) : 60;
    this.onBriefChange();
  }

  private syncLengthFromDuration(): void {
    const d = Number(this.brief.duration_s) || 60;
    if (d <= 30) this.brief.length = 'short';
    else if (d >= 90) this.brief.length = 'long';
    else this.brief.length = 'medium';
  }

  private resetEditor(): void {
    this.activeId.set(null);
    this.title.set('Untitled script');
    this.summary.set('');
    this.scriptText.set('');
    this.chat.set([]);
    this.frozen.set(false);
    this.brief = defaultScriptBrief();
    this.openSceneIds.set(new Set());
    this.dirty = false;
  }

  private applyDoc(doc: ScriptDocument, postActiveId?: string | null): void {
    this.activeId.set(doc.id);
    this.title.set(doc.title || 'Untitled script');
    this.summary.set(doc.summary || '');
    this.scriptText.set(doc.script || '');
    this.chat.set([...(doc.chat || [])]);
    this.frozen.set(!!doc.frozen);
    this.brief = { ...defaultScriptBrief(), ...(doc.brief || {}) };
    if (!this.brief.language) this.brief.language = 'English';
    if (!this.brief.tone) this.brief.tone = 'conversational';
    let duration = Number(this.brief.duration_s);
    if (!Number.isFinite(duration) || duration <= 0) {
      const len = String(this.brief.length || 'medium').toLowerCase();
      duration = len === 'short' ? 25 : len === 'long' ? 120 : 60;
      this.brief.duration_s = duration;
    }
    this.syncLengthFromDuration();
    if (postActiveId !== undefined) this.postActiveId.set(postActiveId || null);
    const blocks = deriveScriptSceneBlocks(doc.script || '');
    this.openSceneIds.set(new Set(blocks.slice(0, 2).map((b) => b.id)));
    this.dirty = false;
  }

  async openDraft(scriptId: string): Promise<void> {
    await this.flushSave();
    const data = await this.api.getScript(this.postId, scriptId);
    if (!data?.script) return;
    this.applyDoc(data.script, data.active_script_id);
    this.refreshHistoryActiveFlags();
  }

  private refreshHistoryActiveFlags(): void {
    const active = this.postActiveId();
    this.history.update((items) =>
      items.map((s) => ({ ...s, active: s.id === active })),
    );
  }

  onScriptTextChange(value: string): void {
    if (this.frozen()) return;
    this.scriptText.set(value);
    this.markDirty();
  }

  onSceneBodyChange(index: number, body: string): void {
    if (this.frozen()) return;
    const blocks = [...this.scenes()];
    if (!blocks[index]) return;
    blocks[index] = { ...blocks[index], body };
    this.scriptText.set(stitchScriptFromSceneBlocks(blocks));
    this.markDirty();
  }

  isSceneOpen(id: string): boolean {
    return this.openSceneIds().has(id);
  }

  toggleScene(id: string): void {
    const next = new Set(this.openSceneIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.openSceneIds.set(next);
  }

  expandAll(): void {
    this.openSceneIds.set(new Set(this.scenes().map((s) => s.id)));
  }

  collapseAll(): void {
    this.openSceneIds.set(new Set());
  }

  insertScene(index: number, where: 'before' | 'after'): void {
    if (this.frozen()) return;
    let blocks = promoteUnboundBlocksForInsert(this.scenes());
    const detail = uniqueNewSceneDetail(blocks);
    const neu = makeBlankScriptSceneBlock(detail);
    const at = where === 'before' ? index : index + 1;
    blocks = [...blocks.slice(0, at), neu, ...blocks.slice(at)];
    this.scriptText.set(stitchScriptFromSceneBlocks(blocks));
    const rederived = deriveScriptSceneBlocks(this.scriptText());
    const match = rederived.find((b) => b.detail === detail);
    if (match) {
      const open = new Set(this.openSceneIds());
      open.add(match.id);
      this.openSceneIds.set(open);
    }
    this.markDirty();
  }

  addFirstScene(): void {
    if (this.frozen()) return;
    const neu = makeBlankScriptSceneBlock('Scene 1');
    this.scriptText.set(stitchScriptFromSceneBlocks([neu]));
    this.openSceneIds.set(new Set(['scene-0']));
    this.markDirty();
  }

  openMarkerDialog(sceneIndex: number | null = null): void {
    if (this.frozen()) return;
    this.markerTargetSceneIndex.set(sceneIndex);
    this.markerKind = 'VISUAL';
    this.markerMediaType = 'video';
    this.markerDetail = '';
    this.markerDuration = '';
    this.showMarkerDialog.set(true);
  }

  closeMarkerDialog(): void {
    this.showMarkerDialog.set(false);
    this.markerTargetSceneIndex.set(null);
  }

  markerDialogSubtitle(): string {
    const i = this.markerTargetSceneIndex();
    if (i == null) return 'Appended to the end of the draft (or open scene when using + Marker).';
    const scene = this.scenes()[i];
    return scene ? `Into scene “${scene.name}”` : 'Into selected scene';
  }

  onMarkerKindChange(kind: MarkerKind): void {
    this.markerKind = kind;
    if (!this.markerNeedsDetail()) this.markerDetail = '';
    if (!this.markerNeedsMediaDuration()) this.markerDuration = '';
  }

  setMarkerMediaType(id: VisualMediaTypeId): void {
    this.markerMediaType = id;
    if (!this.markerNeedsMediaDuration()) this.markerDuration = '';
  }

  markerNeedsMediaType(): boolean {
    return this.markerKind === 'VISUAL' || this.markerKind === 'ADD ASSET';
  }

  markerNeedsMediaDuration(): boolean {
    return this.markerNeedsMediaType() && visualMediaTypeSupportsDuration(this.markerMediaType);
  }

  markerNeedsDetail(): boolean {
    return (
      this.markerKind === 'VISUAL' ||
      this.markerKind === 'ADD ASSET' ||
      this.markerKind === 'HELPER' ||
      this.markerKind === 'DURATION' ||
      this.markerKind === 'SCENE START' ||
      this.markerKind === 'SCENE END' ||
      this.markerKind === 'PAUSE SCRIPT'
    );
  }

  markerDetailLabel(): string {
    switch (this.markerKind) {
      case 'VISUAL':
        return 'Visual description';
      case 'ADD ASSET':
        return 'Asset description';
      case 'HELPER':
        return 'Creator note';
      case 'DURATION':
        return 'Duration (e.g. 8s)';
      case 'SCENE START':
      case 'SCENE END':
        return 'Scene name (optional)';
      case 'PAUSE SCRIPT':
        return 'Pause length (optional, e.g. 1.5s)';
      default:
        return 'Detail';
    }
  }

  markerDetailPlaceholder(): string {
    switch (this.markerKind) {
      case 'VISUAL':
        return 'e.g. overhead pour of coffee into mug';
      case 'ADD ASSET':
        return 'e.g. stock clip of sunrise city skyline, 3–4s';
      case 'HELPER':
        return 'e.g. burn on-screen text for 2s';
      case 'DURATION':
        return '8s';
      case 'SCENE START':
      case 'SCENE END':
        return 'Hook';
      case 'PAUSE SCRIPT':
        return '1.5s';
      default:
        return '';
    }
  }

  private buildMarkerDetail(): string {
    const raw = String(this.markerDetail || '').trim();
    if (this.markerNeedsMediaType()) {
      const durRaw = String(this.markerDuration || '').trim();
      const dur = durRaw ? parseVisualDurationToken(durRaw) : null;
      return formatTypedVisualDetail(this.markerMediaType, raw, dur);
    }
    return raw;
  }

  markerPreview(): string {
    return formatScriptCueTag(this.markerKind, this.buildMarkerDetail());
  }

  confirmMarkerInsert(): void {
    if (this.frozen()) return;
    const kind = this.markerKind;
    const durRaw = String(this.markerDuration || '').trim();
    if (this.markerNeedsMediaDuration() && durRaw && parseVisualDurationToken(durRaw) == null) {
      this.snackbar.show('Enter a duration like 3.5s, or leave blank', 'info');
      return;
    }
    const detail = this.buildMarkerDetail();
    if (this.markerNeedsMediaType() && !String(this.markerDetail || '').trim()) {
      this.snackbar.show(
        kind === 'ADD ASSET' ? 'Describe the asset to add' : 'Describe the visual cue',
        'info',
      );
      return;
    }
    if (kind === 'HELPER' && !detail) {
      this.snackbar.show('Add a helper note', 'info');
      return;
    }
    if (kind === 'DURATION' && !detail) {
      this.snackbar.show('Enter a duration like 8s', 'info');
      return;
    }
    const tag = formatScriptCueTag(kind, detail);
    const sceneIndex = this.markerTargetSceneIndex();
    if (sceneIndex != null && this.viewMode() === 'scenes') {
      const blocks = [...this.scenes()];
      const scene = blocks[sceneIndex];
      if (!scene) {
        this.closeMarkerDialog();
        return;
      }
      const body = String(scene.body || '').trimEnd();
      blocks[sceneIndex] = {
        ...scene,
        body: body ? `${body}\n${tag}` : tag,
      };
      this.scriptText.set(stitchScriptFromSceneBlocks(blocks));
    } else {
      const text = String(this.scriptText() || '').trimEnd();
      this.scriptText.set(text ? `${text}\n${tag}` : tag);
    }
    this.markDirty();
    this.closeMarkerDialog();
    this.snackbar.show(`Inserted ${kind}`, 'success');
  }

  private schedulePersist(): void {
    if (this.frozen() || !this.activeId()) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.flushSave(true), 600);
  }

  async flushSave(quiet = false): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty || this.frozen() || !this.activeId()) return;
    await this.persistCurrent(quiet ? 'edited' : 'edited', { quiet, activate: false });
  }

  async saveBrief(): Promise<void> {
    await this.persistCurrent('edited', { quiet: false, activate: false });
  }

  async saveScript(): Promise<void> {
    await this.persistCurrent('edited', { quiet: false, activate: false });
  }

  private async persistCurrent(
    source: 'edited' | 'generated' | 'refined' | 'manual',
    opts: { quiet: boolean; activate: boolean },
  ): Promise<boolean> {
    this.saving.set(true);
    this.saveStatus.set('Saving…');
    try {
      const payload = {
        title: this.title() || 'Untitled script',
        summary: this.summary(),
        script: this.scriptText(),
        chat: this.chat(),
        brief: { ...this.brief },
        source,
        frozen: this.frozen(),
        activate: opts.activate,
      };
      let result;
      if (this.activeId()) {
        result = await this.api.updateScript(this.postId, this.activeId()!, payload, undefined, {
          quiet: opts.quiet,
        });
      } else {
        result = await this.api.createScript(this.postId, { ...payload, activate: true });
      }
      if (!result?.script) {
        this.saveStatus.set('Save failed');
        return false;
      }
      this.applyDoc(result.script, result.active_script_id);
      await this.reloadHistory();
      this.saveStatus.set(opts.quiet ? 'Saved' : '');
      this.dirty = false;
      return true;
    } finally {
      this.saving.set(false);
    }
  }

  private async reloadHistory(): Promise<void> {
    const list = await this.api.listScripts(this.postId);
    if (!list) return;
    this.history.set(list.scripts || []);
    this.postActiveId.set(list.active_script_id || null);
  }

  async generate(): Promise<void> {
    const topic = String(this.brief.topic || '').trim();
    if (!topic) {
      this.snackbar.show('Enter a topic or idea first', 'error');
      this.setSideTab('brief');
      return;
    }
    if (this.scriptText().trim() && !this.frozen()) {
      await this.persistCurrent('edited', { quiet: true, activate: false });
    }
    this.aiBusy.set(true);
    this.aiMode.set('generate');
    try {
      const data = await this.api.generateScript({
        topic,
        tone: this.brief.tone || 'conversational',
        duration_s: Number(this.brief.duration_s) || 60,
        length: this.brief.length || 'medium',
        audience: this.brief.audience || '',
        language: this.brief.language || 'English',
        notes: this.brief.notes || '',
        ideation_notes: this.ideationNotes || '',
      });
      if (!data) return;
      this.activeId.set(null);
      this.title.set(data.title || 'Untitled script');
      this.summary.set(data.summary || '');
      const script = ensureScriptDurationMarkers(data.script || '', true);
      this.scriptText.set(script);
      this.chat.set([]);
      this.frozen.set(false);
      this.dirty = true;
      const ok = await this.persistCurrent('generated', { quiet: false, activate: true });
      if (ok) {
        this.viewMode.set('scenes');
        this.expandAll();
        this.setSideTab('brief');
      }
    } finally {
      this.aiBusy.set(false);
      this.aiMode.set(null);
    }
  }

  async sendChat(event?: Event): Promise<void> {
    event?.preventDefault();
    const message = this.chatInput.trim();
    if (!message || !this.canRefine()) return;
    this.aiBusy.set(true);
    this.aiMode.set('refine');
    const prior = this.chat();
    this.chat.set([...prior, { role: 'user', content: message }]);
    this.chatInput = '';
    try {
      const data = await this.api.refineScript({
        script: this.scriptText(),
        message,
        history: prior,
        topic: this.brief.topic || '',
        tone: this.brief.tone || '',
        ideation_notes: this.ideationNotes || '',
      });
      if (!data) {
        this.chat.set(prior);
        return;
      }
      const nextScript = ensureScriptDurationMarkers(data.script || this.scriptText(), true);
      this.scriptText.set(nextScript);
      if (data.summary) this.summary.set(data.summary);
      this.chat.set([
        ...prior,
        { role: 'user', content: message },
        { role: 'assistant', content: data.reply || 'Updated the script.' },
      ]);
      this.dirty = true;
      await this.persistCurrent('refined', { quiet: true, activate: false });
    } finally {
      this.aiBusy.set(false);
      this.aiMode.set(null);
    }
  }

  onChatKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.sendChat();
    }
  }

  clearChat(): void {
    if (!confirm('Clear refine chat for this draft?')) return;
    this.chat.set([]);
    this.markDirty();
  }

  async setActive(scriptId: string): Promise<void> {
    const result = await this.api.activateScript(this.postId, scriptId, true);
    if (!result) return;
    this.postActiveId.set(result.active_script_id || scriptId);
    this.refreshHistoryActiveFlags();
    if (this.activeId() === scriptId && result.script) {
      this.applyDoc(result.script, result.active_script_id);
    }
    await this.reloadHistory();
  }

  async deleteDraft(scriptId: string): Promise<void> {
    if (!confirm('Delete this draft permanently?')) return;
    const result = await this.api.deleteScript(this.postId, scriptId);
    if (!result) return;
    if (this.activeId() === scriptId) this.resetEditor();
    await this.reloadHistory();
    if (this.postActiveId() && this.postActiveId() !== scriptId) {
      /* keep */
    } else if (this.history()[0]) {
      await this.openDraft(this.history()[0].id);
    }
  }

  async clearAllDrafts(): Promise<void> {
    if (!confirm('Delete all script drafts for this post?')) return;
    const result = await this.api.clearScripts(this.postId);
    if (!result) return;
    this.resetEditor();
    this.history.set([]);
    this.postActiveId.set(null);
  }

  async newVersion(): Promise<void> {
    if (!this.activeId()) return;
    await this.flushSave(true);
    const baseTitle = (this.title() || 'Untitled script').replace(/\s+v\d+$/i, '');
    const n = this.history().length + 1;
    const result = await this.api.createScript(this.postId, {
      title: `${baseTitle} v${n}`,
      summary: this.summary(),
      script: this.scriptText(),
      chat: [],
      brief: { ...this.brief },
      source: 'edited',
      frozen: false,
      activate: true,
    });
    if (!result?.script) return;
    this.applyDoc(result.script, result.active_script_id);
    await this.reloadHistory();
  }

  async freeze(): Promise<void> {
    if (!this.activeId()) return;
    await this.flushSave(true);
    const result = await this.api.updateScript(this.postId, this.activeId()!, { frozen: true });
    if (!result?.script) return;
    this.applyDoc(result.script, result.active_script_id);
    await this.reloadHistory();
  }

  async unfreeze(): Promise<void> {
    if (!this.activeId()) return;
    const result = await this.api.updateScript(this.postId, this.activeId()!, { frozen: false });
    if (!result?.script) return;
    this.applyDoc(result.script, result.active_script_id);
    await this.reloadHistory();
  }

  newBlank(): void {
    if (this.frozen()) return;
    if (this.scriptText().trim() && !confirm('Clear the editor? Use New version to fork instead.')) {
      return;
    }
    this.activeId.set(null);
    this.title.set('Untitled script');
    this.summary.set('');
    this.scriptText.set('');
    this.chat.set([]);
    this.frozen.set(false);
    this.openSceneIds.set(new Set());
    this.dirty = false;
  }

  clearDraft(): void {
    if (this.frozen()) return;
    if (!confirm('Clear script text in the editor?')) return;
    this.scriptText.set('');
    this.markDirty();
  }

  async copyScript(): Promise<void> {
    const text = this.scriptText();
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      this.saveStatus.set('Copied');
    } catch {
      this.saveStatus.set('Copy failed');
    }
  }

  downloadScript(): void {
    const text = this.scriptText();
    if (!text.trim()) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = (this.title() || 'script').replace(/[^\w\-]+/g, '_').slice(0, 60);
    a.href = url;
    a.download = `${safe || 'script'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
