import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SnackbarService, ModalWrapperComponent } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import {
  assetTypeLabel,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
  type Asset,
  type IdeationReference,
  type Post,
  type ProjectSocialAccount,
} from '../../models/content-sprout.models';
import { ScriptWorkspaceComponent } from './script-workspace';
import { TimelineWorkspaceComponent } from './timeline-workspace';
import { AssetWorkspaceComponent } from './asset-workspace';
import { ExportWorkspaceComponent } from './export-workspace';
import { UploadWorkspaceComponent } from './upload-workspace';
import { MonitorWorkspaceComponent } from './monitor-workspace';

type EditorStep = 'ideation' | 'script' | 'assets' | 'timeline' | 'export' | 'upload' | 'monitor';
type IdeationTab = 'notes' | 'references';
type RefKind = 'url' | 'video' | 'image' | 'text' | 'file';

const VIDEO_STEPS: EditorStep[] = [
  'ideation',
  'script',
  'assets',
  'timeline',
  'export',
  'upload',
  'monitor',
];
const IMAGE_STEPS: EditorStep[] = ['ideation', 'assets', 'timeline', 'export', 'upload', 'monitor'];
const ALL_STEPS: EditorStep[] = VIDEO_STEPS;
/** Reusable clips can still export; they skip publish steps. */
const PUBLISH_STEPS: EditorStep[] = ['upload', 'monitor'];

function stepsForPost(post: Post | null | undefined): EditorStep[] {
  const ids = post?.type === 'image' ? IMAGE_STEPS : VIDEO_STEPS;
  if (post?.is_reusable) return ids.filter((id) => !PUBLISH_STEPS.includes(id));
  return ids;
}

const REF_KINDS: { id: RefKind; label: string }[] = [
  { id: 'url', label: 'URL / link' },
  { id: 'video', label: 'Video link' },
  { id: 'image', label: 'Image link' },
  { id: 'text', label: 'Text clip' },
  { id: 'file', label: 'File / other' },
];

@Component({
  selector: 'app-post-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ModalWrapperComponent,
    ScriptWorkspaceComponent,
    TimelineWorkspaceComponent,
    AssetWorkspaceComponent,
    ExportWorkspaceComponent,
    UploadWorkspaceComponent,
    MonitorWorkspaceComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="page cs-post-page">
      @if (!api.currentProject()) {
        <section class="surface-card cs-empty">
          <h2>Select a project</h2>
          <p>Open a project from Media Studio, then return to this post.</p>
          <a routerLink="/media-studio" class="linkish">Go to Media Studio</a>
        </section>
      } @else if (loadError()) {
        <section class="surface-card cs-empty">
          <h2>Post not found</h2>
          <p>{{ loadError() }}</p>
          <a routerLink="/media-studio" class="linkish">Back</a>
        </section>
      } @else if (!draft()) {
        <section class="surface-card cs-empty">
          <p class="status-msg muted">Loading post…</p>
        </section>
      } @else {
        <nav class="cs-post-breadcrumb" aria-label="Breadcrumb">
          <a routerLink="/media-studio" class="cs-crumb-link">Media Studio</a>
          <span class="cs-crumb-sep" aria-hidden="true">/</span>
          <a routerLink="/media-studio" class="cs-crumb-link" [title]="api.currentProject()!.name">{{
            api.currentProject()!.name
          }}</a>
          <span class="cs-crumb-sep" aria-hidden="true">/</span>
          <span class="cs-crumb-current" [title]="draft()!.name">{{ draft()!.name }}</span>
          <span class="cs-crumb-badge">{{ draft()!.type }}</span>
          <div class="cs-post-breadcrumb-actions">
            <button
              type="button"
              class="primary"
              (click)="save()"
              [disabled]="api.busy() || !dirty()"
            >
              Save
            </button>
          </div>
        </nav>

        <nav class="cs-workflow-stepper" aria-label="Post workflow">
          <ol class="cs-workflow-steps" role="list">
            @for (step of workflowSteps(); track step.id; let i = $index) {
              @if (i > 0) {
                <li class="cs-workflow-chevron" aria-hidden="true">→</li>
              }
              <li class="cs-workflow-step-item">
                <button
                  type="button"
                  class="cs-workflow-btn"
                  [class.is-current]="editorStep() === step.id"
                  [class.is-done]="isStepDone(step.id)"
                  [attr.aria-current]="editorStep() === step.id ? 'step' : null"
                  (click)="setStep(step.id)"
                >
                  <span class="cs-workflow-num">{{ i + 1 }}</span>
                  <span class="cs-workflow-label">{{ step.label }}</span>
                  <span class="cs-workflow-done-dot" aria-hidden="true"></span>
                </button>
              </li>
            }
          </ol>
          <div class="cs-workflow-actions">
            <button
              type="button"
              class="cs-workflow-action-btn cs-workflow-help-btn"
              (click)="openWorkflowHelp(editorStep())"
              [attr.aria-label]="'Help for ' + currentWorkflowStepLabel()"
              [title]="'Help for ' + currentWorkflowStepLabel()"
            >
              <span class="material-symbols-outlined" aria-hidden="true">help</span>
              Help
            </button>
            @if (editorStep() === 'ideation') {
              <button
                type="button"
                class="primary cs-workflow-action-btn"
                (click)="saveAndContinue()"
                [disabled]="api.busy()"
              >
                {{ continueLabel() }}
              </button>
              @if (isVideo()) {
                <button
                  type="button"
                  class="cs-workflow-action-btn"
                  (click)="skipToTimeline()"
                  [disabled]="api.busy()"
                  title="Skip the script and start a blank video timeline"
                >
                  Skip to Timeline
                </button>
              }
            } @else if (editorStep() === 'script') {
              <button type="button" class="primary cs-workflow-action-btn" (click)="goNext()">
                Continue to Assets
              </button>
              @if (scriptDisabled()) {
                <button
                  type="button"
                  class="cs-workflow-action-btn"
                  (click)="enableScript()"
                  title="Turn the script editor back on"
                >
                  Enable script
                </button>
              } @else {
                <button
                  type="button"
                  class="cs-workflow-action-btn"
                  (click)="disableScript()"
                  [disabled]="api.busy()"
                  title="Turn off the script for this post and compose the timeline by hand"
                >
                  Disable script
                </button>
              }
            } @else if (editorStep() === 'assets') {
              <button type="button" class="primary cs-workflow-action-btn" (click)="goNext()">
                {{ isVideo() ? 'Continue to Timeline' : 'Continue to Canvas' }}
              </button>
            } @else if (editorStep() === 'timeline') {
              <button type="button" class="primary cs-workflow-action-btn" (click)="goNext()">
                Continue to Export
              </button>
              <button type="button" class="cs-workflow-action-btn" (click)="goPrev()">Back</button>
            } @else if (editorStep() === 'export') {
              @if (!isReusablePost()) {
                <button type="button" class="primary cs-workflow-action-btn" (click)="goNext()">
                  Continue to Upload
                </button>
              }
              <button type="button" class="cs-workflow-action-btn" (click)="goPrev()">Back</button>
            } @else if (editorStep() === 'upload') {
              <button
                type="button"
                class="primary cs-workflow-action-btn"
                (click)="saveAndContinue()"
                [disabled]="api.busy()"
              >
                Continue to Monitor
              </button>
              <button type="button" class="cs-workflow-action-btn" (click)="goPrev()">Back</button>
            } @else {
              <button type="button" class="cs-workflow-action-btn" (click)="goPrev()">Back</button>
            }
          </div>
        </nav>

        <div
          class="cs-post-body"
          [class.cs-post-body--scroll]="
            editorStep() === 'ideation' ||
            editorStep() === 'export' ||
            editorStep() === 'upload' ||
            editorStep() === 'monitor'
          "
          [class.cs-post-body--fill]="
            editorStep() === 'script' || editorStep() === 'timeline' || editorStep() === 'assets'
          "
        >
        @if (editorStep() === 'ideation') {
          <div class="cs-split cs-post-layout">
            <div class="cs-post-forms">
              <section class="surface-card cs-ideation-details">
                <h3 class="cs-section-title">Details</h3>
                <div class="cs-form-stack cs-form-stack--tight">
                  <label>
                    <span>Name</span>
                    <input [(ngModel)]="name" (ngModelChange)="markDirty()" />
                  </label>
                  <div class="cs-ideation-meta-row">
                    <label class="cs-ideation-field">
                      <span>Orientation</span>
                      <select [(ngModel)]="targetFormat" (ngModelChange)="markDirty()">
                        <option value="portrait">Portrait</option>
                        <option value="landscape">Landscape</option>
                      </select>
                    </label>
                    @if (isVideo()) {
                      <label class="cs-ideation-field">
                        <span>Video format</span>
                        <select [(ngModel)]="videoFormat" (ngModelChange)="markDirty()">
                          <option value="4k">4K</option>
                          <option value="1440p">1440p</option>
                          <option value="1080p">1080p</option>
                          <option value="720p">720p</option>
                          <option value="standard">Standard</option>
                        </select>
                      </label>
                    }
                  </div>
                  @if (isVideo()) {
                    <label class="cs-check">
                      <input
                        type="checkbox"
                        [(ngModel)]="isReusable"
                        (ngModelChange)="onReusableFlag($event)"
                      />
                      Reusable clip (can be inserted into other video posts)
                    </label>
                  }
                </div>
              </section>

              <section class="surface-card" style="margin-top: 1rem">
                <div class="cs-ideation-tabs" role="tablist" aria-label="Notes and references">
                  <button
                    type="button"
                    role="tab"
                    [class.active]="ideationTab() === 'notes'"
                    [attr.aria-selected]="ideationTab() === 'notes'"
                    (click)="ideationTab.set('notes')"
                  >
                    Notes
                  </button>
                  <button
                    type="button"
                    role="tab"
                    [class.active]="ideationTab() === 'references'"
                    [attr.aria-selected]="ideationTab() === 'references'"
                    (click)="ideationTab.set('references')"
                  >
                    References
                    @if (references().length) {
                      <span class="cs-sg-count">{{ references().length }}</span>
                    }
                  </button>
                </div>

                @if (ideationTab() === 'notes') {
                  <label class="cs-form-stack cs-form-stack--tight">
                    <span>Notes</span>
                    <textarea
                      rows="5"
                      [(ngModel)]="ideationNotes"
                      (ngModelChange)="markDirty()"
                      placeholder="Brief, hooks, talking points…"
                    ></textarea>
                  </label>
                } @else {
                  <div class="cs-ref-pane">
                    <p class="meta cs-ref-hint">Links, videos, images, and clips that inspire this post</p>
                    <form class="cs-ref-form" (ngSubmit)="addReference()">
                      <div class="cs-form-row" style="margin: 0">
                        <label>
                          <span>Type</span>
                          <select [(ngModel)]="refKind" name="refKind">
                            @for (k of refKinds; track k.id) {
                              <option [value]="k.id">{{ k.label }}</option>
                            }
                          </select>
                        </label>
                        <label>
                          <span>Title</span>
                          <input [(ngModel)]="refTitle" name="refTitle" placeholder="Optional label" />
                        </label>
                      </div>
                      @if (refKind !== 'text') {
                        <label>
                          <span>URL</span>
                          <input
                            type="url"
                            [(ngModel)]="refUrl"
                            name="refUrl"
                            placeholder="https://…"
                          />
                        </label>
                      }
                      <label>
                        <span>{{ refKind === 'text' ? 'Text clip' : 'Note' }}</span>
                        <textarea
                          rows="2"
                          [(ngModel)]="refNote"
                          name="refNote"
                          [placeholder]="
                            refKind === 'text'
                              ? 'Paste a quote or talking point'
                              : 'Why this matters / what to borrow'
                          "
                        ></textarea>
                      </label>
                      <div class="page-actions-inline">
                        <button type="submit" class="primary">Add reference</button>
                        <button type="button" (click)="toggleAssetPicker()">
                          {{ showRefAssetPicker() ? 'Hide assets' : 'Attach asset…' }}
                        </button>
                      </div>
                    </form>

                    @if (showRefAssetPicker()) {
                      <div class="cs-ref-asset-picker">
                        @for (asset of attachableAssets(); track asset.id) {
                          <button type="button" class="cs-ref-asset-btn" (click)="attachAsset(asset)">
                            <span class="material-symbols-outlined" aria-hidden="true">{{
                              iconFor(asset)
                            }}</span>
                            <span class="truncate">{{ asset.name }}</span>
                            <span class="meta">{{ assetTypeLabel(asset.type) }}</span>
                          </button>
                        } @empty {
                          <p class="cs-empty-inline">
                            No image/video assets yet. Upload on the Assets step, then attach here.
                          </p>
                        }
                      </div>
                    }

                    <ul class="cs-entity-list cs-ref-list">
                      @for (ref of references(); track ref.id || $index) {
                        <li>
                          <div class="cs-entity-main">
                            <div class="cs-ref-title-row">
                              <span class="cs-ref-kind">{{ refKindLabel(ref.kind) }}</span>
                              <strong>{{ refDisplayTitle(ref) }}</strong>
                            </div>
                            @if (ref.url) {
                              <a
                                class="meta truncate"
                                [href]="ref.url"
                                target="_blank"
                                rel="noopener"
                                >{{ ref.url }}</a
                              >
                            }
                            @if (ref.asset_id) {
                              <span class="meta">Asset · {{ assetName(ref.asset_id) }}</span>
                            }
                            @if (ref.note) {
                              <span class="meta cs-ref-note">{{ ref.note }}</span>
                            }
                          </div>
                          <button type="button" class="danger" (click)="removeReference(ref.id)">
                            Remove
                          </button>
                        </li>
                      } @empty {
                        <li class="cs-empty-inline">
                          No references yet. Paste a URL, add a text clip, or attach a project asset.
                        </li>
                      }
                    </ul>
                  </div>
                }
              </section>
            </div>

            <aside class="surface-card cs-preview-pane">
              <h3 class="cs-section-title">Summary</h3>
              <p class="meta">
                {{ draft()!.type }} · {{ draft()!.target_format || 'portrait' }} ·
                {{ (draft()!.platforms || []).join(', ') || 'no platforms' }}
              </p>
              <p class="page-intro" style="margin-top: 0.75rem">
                Capture notes and references here, then continue to
                {{ isVideo() ? 'Script' : 'Assets' }}. Target platforms live on Upload.
              </p>
            </aside>
          </div>
        }

        @if (editorStep() === 'script') {
          <div class="cs-workflow-panel cs-workflow-panel--script">
            @if (scriptDisabled()) {
              <div class="cs-script-disabled surface-card">
                <span class="material-symbols-outlined" aria-hidden="true">speech_to_text_off</span>
                <h3>Script disabled</h3>
                <p class="meta">
                  This post isn’t using a script. Build scenes on the Timeline by hand, or turn the
                  script back on to draft and generate.
                </p>
                <button type="button" class="primary" (click)="enableScript()">Enable script</button>
              </div>
            } @else {
              <app-script-workspace
                [postId]="draft()!.id"
                [ideationNotes]="ideationNotes"
                (postUpdated)="onScriptPostUpdated($event)"
              />
            }
          </div>
        }

        @if (editorStep() === 'assets') {
          <div class="cs-workflow-panel cs-workflow-panel--assets">
            <app-asset-workspace
              [postId]="draft()!.id"
              [postType]="draft()!.type"
              [post]="draft()!"
              (postChange)="onTimelinePostChange($event)"
            />
          </div>
        }

        @if (editorStep() === 'timeline') {
          <div class="cs-workflow-panel cs-workflow-panel--timeline">
            <app-timeline-workspace
              [post]="draft()!"
              (postChange)="onTimelinePostChange($event)"
              (goAssets)="setStep('assets')"
              (goExport)="setStep('export')"
            />
          </div>
        }

        @if (editorStep() === 'export') {
          <div class="cs-workflow-panel">
            <app-export-workspace [post]="draft()!" (exported)="onExported()" />
          </div>
        }

        @if (editorStep() === 'upload') {
          <div class="cs-workflow-panel">
            <app-upload-workspace
              [postId]="draft()!.id"
              [postName]="draft()!.name"
              [accounts]="socialAccounts()"
              [selectedPlatforms]="selectedPlatforms()"
              [didExport]="didExport()"
              [attempts]="draft()!.publish_attempts || []"
              (platformsChange)="onUploadPlatforms($event)"
              (published)="onPublished($event)"
            />
          </div>
        }

        @if (editorStep() === 'monitor') {
          <div class="cs-workflow-panel">
            <app-monitor-workspace
              [selected]="selectedPlatforms()"
              [attempts]="draft()!.publish_attempts || []"
            />
          </div>
        }
        </div>
      }

      <app-modal-wrapper
        [isOpen]="!!workflowHelpStep()"
        [title]="workflowHelpTitle()"
        subtitle="Tips for this workflow step"
        icon="help"
        size="small"
        customClass="cs-console-modal"
        closeButtonPosition="header"
        (close)="closeWorkflowHelp()"
      >
        <div class="cs-workflow-help-body">
          @switch (workflowHelpStep()) {
            @case ('ideation') {
              <p>
                Capture the post name, orientation, and format here. Use <strong>Notes</strong> for hooks
                and talking points; add <strong>References</strong> for links and inspiration.
              </p>
              <p>
                Save, then continue to {{ isVideo() ? 'Script or Timeline' : 'Assets' }}. Target
                platforms are chosen later on Upload.
              </p>
            }
            @case ('script') {
              <p>
                Markers include timeline times (<code>&#64; 12.5s</code>). Use
                <strong>SCENE</strong>, <strong>HELPER</strong>, and spoken lines in Text view, or edit
                per-scene in Scene view.
              </p>
              <p>
                Enable <strong>Background visual</strong> on a scene to offer a Scene visual plate in
                Assets. <strong>VISUAL</strong> / <strong>ADD ASSET</strong> markers can declare a media
                type and, for video / music / SFX, clip length (<code>video · 3.5s · …</code>).
              </p>
              <p>
                Use <strong>Brief</strong> to generate a first draft, <strong>Drafts</strong> to open
                saved versions, and <strong>Refine</strong> to chat edits into the active draft. Set a
                draft <strong>Active</strong> to sync the timeline — or skip Script and build the timeline
                by hand.
              </p>
            }
            @case ('assets') {
              <p>
                Upload, generate, or pick assets for this post. Filter by type and scope (post, project, or
                scene slots).
              </p>
              <p>
                When a script scene has <strong>Background visual</strong> enabled, attach a plate on the
                Scene visual row. Other script cues show as needed slots you can fill from here.
              </p>
            }
            @case ('timeline') {
              <p>
                Build {{ isVideo() ? 'scenes and layers on the timeline' : 'layers on the canvas' }}.
                Use the scene <strong>+</strong> button to add layers; collapse scenes to focus on one at a
                time.
              </p>
              @if (isVideo()) {
                <p>
                  With an active script, <strong>Regenerate from script</strong> rebuilds scenes from
                  SCENE markers while keeping matching creative layers.
                </p>
              }
            }
            @case ('export') {
              <p>
                Choose export sizes and run <strong>Export</strong>. Finished files appear in the list below
                for download.
              </p>
              @if (isReusablePost()) {
                <p>Reusable clips can export but skip Upload and Monitor.</p>
              }
            }
            @case ('upload') {
              <p>
                Pick target platforms and publish exported files. Export the post first — Upload needs a
                finished file from Export.
              </p>
            }
            @case ('monitor') {
              <p>
                Track publish status per platform. Return here after Upload to see successes, failures, and
                links to live posts.
              </p>
            }
          }
        </div>
        <ng-template #footerActions>
          <button type="button" class="primary" (click)="closeWorkflowHelp()">Got it</button>
        </ng-template>
      </app-modal-wrapper>
    </div>
  `,
})
export class PostDetailPage implements OnInit {
  readonly refKinds = REF_KINDS;
  readonly draft = signal<Post | null>(null);
  readonly dirty = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly selectedPlatforms = signal<Set<string>>(new Set(['youtube']));
  readonly didExport = signal(false);
  readonly editorStep = signal<EditorStep>('ideation');
  readonly ideationTab = signal<IdeationTab>('notes');
  readonly references = signal<IdeationReference[]>([]);
  readonly showRefAssetPicker = signal(false);
  /** When true, Script step shows a disabled state instead of the editor. */
  readonly scriptDisabled = signal(false);
  readonly workflowHelpStep = signal<EditorStep | null>(null);

  name = '';
  targetFormat = 'portrait';
  videoFormat = '1080p';
  isReusable = false;
  ideationNotes = '';
  refKind: RefKind = 'url';
  refTitle = '';
  refUrl = '';
  refNote = '';

  readonly isVideo = computed(() => this.draft()?.type === 'video');
  readonly isReusablePost = computed(() => !!this.draft()?.is_reusable);

  readonly workflowSteps = computed(() => {
    const video = this.isVideo();
    const post = this.draft();
    return stepsForPost(post).map((id) => ({
      id,
      label: id === 'timeline' ? (video ? 'Timeline' : 'Canvas') : this.stepTitle(id),
    }));
  });

  readonly postAssets = computed(() => {
    const post = this.draft();
    if (!post) return [];
    return this.api.postAssets(post.id);
  });

  readonly socialAccounts = computed(
    () => (this.api.currentProject()?.social_accounts || []) as ProjectSocialAccount[],
  );

  readonly attachableAssets = computed(() => {
    const post = this.draft();
    if (!post) return [];
    return (this.api.currentProject()?.assets || []).filter((a) => {
      if (!isImageAsset(a.type) && !isVideoAsset(a.type)) return false;
      return !a.post_id || a.post_id === post.id;
    });
  });

  private postId = '';

  constructor(
    public api: ContentSproutApiService,
    private route: ActivatedRoute,
    private snackbar: SnackbarService,
  ) {
    effect(() => {
      const post = this.draft();
      if (!post) return;
      const step = this.editorStep();
      const allowed = stepsForPost(post);
      if (!allowed.includes(step)) {
        this.editorStep.set(this.normalizeStep(step, post));
      }
    });
  }

  assetTypeLabel = assetTypeLabel;

  ngOnInit(): void {
    this.postId = this.route.snapshot.paramMap.get('postId') || '';
    const step = this.route.snapshot.queryParamMap.get('step') as EditorStep | null;
    if (step && ALL_STEPS.includes(step)) {
      this.editorStep.set(step);
    }
    void this.load();
  }

  async load(): Promise<void> {
    this.loadError.set(null);
    if (!this.postId) {
      this.loadError.set('Missing post id');
      return;
    }
    if (!this.api.currentProject()) {
      await this.api.loadProjects();
    }
    if (!this.api.currentProject()) {
      return;
    }
    const post = await this.api.getPost(this.postId);
    if (!post) {
      this.loadError.set(this.api.error() || 'Could not load post');
      this.draft.set(null);
      return;
    }
    this.applyDraft(post);
    this.editorStep.update((s) => this.normalizeStep(s, post));
  }

  applyDraft(post: Post): void {
    this.draft.set(post);
    this.name = post.name || '';
    this.targetFormat = post.target_format || 'portrait';
    this.videoFormat = post.video_format || '1080p';
    this.isReusable = !!post.is_reusable;
    this.ideationNotes = post.ideation_notes || '';
    this.references.set([...(post.ideation_references || [])]);
    this.selectedPlatforms.set(new Set(post.platforms?.length ? post.platforms : ['youtube']));
    this.scriptDisabled.set(this.readScriptDisabled(post.id));
    this.dirty.set(false);
  }

  onTimelinePostChange(post: Post): void {
    this.draft.set(post);
  }

  onScriptPostUpdated(post: Post): void {
    this.draft.set(post);
    this.dirty.set(false);
  }

  onExported(): void {
    this.didExport.set(true);
  }

  onUploadPlatforms(platforms: string[]): void {
    const next = new Set(platforms.length ? platforms : ['youtube']);
    this.selectedPlatforms.set(next);
    this.markDirty();
  }

  onPublished(post: Post): void {
    this.applyDraft(post);
    this.didExport.set(true);
    this.setStep('monitor');
  }

  private scriptDisabledKey(postId: string): string {
    return `cs-script-disabled:${postId}`;
  }

  private readScriptDisabled(postId: string): boolean {
    try {
      return sessionStorage.getItem(this.scriptDisabledKey(postId)) === '1';
    } catch {
      return false;
    }
  }

  private writeScriptDisabled(postId: string, off: boolean): void {
    try {
      const key = this.scriptDisabledKey(postId);
      if (off) sessionStorage.setItem(key, '1');
      else sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  async disableScript(): Promise<void> {
    const post = this.draft();
    if (!post || post.type !== 'video') return;
    const activeId = post.active_script_id;
    if (activeId) {
      const result = await this.api.activateScript(post.id, activeId, false);
      if (result?.post) {
        this.draft.set({ ...post, ...result.post, active_script_id: null });
      } else {
        this.draft.set({ ...post, active_script_id: null });
      }
    }
    this.scriptDisabled.set(true);
    this.writeScriptDisabled(post.id, true);
    this.snackbar.show('Script disabled — build the timeline by hand', 'info');
  }

  enableScript(): void {
    const post = this.draft();
    if (!post) return;
    this.scriptDisabled.set(false);
    this.writeScriptDisabled(post.id, false);
  }

  private stepTitle(id: EditorStep): string {
    if (id === 'ideation') return 'Ideation';
    if (id === 'script') return 'Script';
    if (id === 'assets') return 'Assets';
    if (id === 'export') return 'Export';
    if (id === 'upload') return 'Upload';
    if (id === 'monitor') return 'Monitor';
    return 'Timeline';
  }

  private normalizeStep(step: EditorStep, post: Post): EditorStep {
    const allowed = stepsForPost(post);
    let next: EditorStep = step;
    if (post.type === 'image' && next === 'script') next = 'assets';
    if (post.is_reusable && PUBLISH_STEPS.includes(next)) next = 'export';
    return allowed.includes(next) ? next : allowed[0];
  }

  onReusableFlag(value: boolean): void {
    this.isReusable = !!value;
    const post = this.draft();
    if (post) this.draft.set({ ...post, is_reusable: this.isReusable });
    this.markDirty();
  }

  setStep(step: EditorStep): void {
    const post = this.draft();
    if (!post) return;
    const next = this.normalizeStep(step, post);
    this.editorStep.set(next);
  }

  openWorkflowHelp(step: EditorStep): void {
    this.workflowHelpStep.set(step);
  }

  closeWorkflowHelp(): void {
    this.workflowHelpStep.set(null);
  }

  workflowHelpTitle(): string {
    const step = this.workflowHelpStep();
    if (!step) return 'Help';
    const found = this.workflowSteps().find((s) => s.id === step);
    return found ? `${found.label} — help` : 'Help';
  }

  currentWorkflowStepLabel(): string {
    const found = this.workflowSteps().find((s) => s.id === this.editorStep());
    return found?.label ?? 'this step';
  }

  goNext(): void {
    const steps = this.workflowSteps().map((s) => s.id);
    const idx = steps.indexOf(this.editorStep());
    if (idx >= 0 && idx < steps.length - 1) this.setStep(steps[idx + 1]);
  }

  goPrev(): void {
    const steps = this.workflowSteps().map((s) => s.id);
    const idx = steps.indexOf(this.editorStep());
    if (idx > 0) this.setStep(steps[idx - 1]);
  }

  continueLabel(): string {
    return this.isVideo() ? 'Continue to Script' : 'Continue to Assets';
  }

  isStepDone(step: EditorStep): boolean {
    const post = this.draft();
    if (!post) return false;
    if (step === 'ideation') {
      return !!(
        this.ideationNotes.trim() ||
        this.references().length ||
        (post.platforms || []).length
      );
    }
    if (step === 'script') {
      return this.scriptDisabled() || !!(post.active_script_id || this.ideationNotes.trim());
    }
    if (step === 'assets') return this.postAssets().length > 0;
    if (step === 'timeline') return !!(post.scenes?.length || post.layers?.length);
    if (step === 'export') return this.didExport();
    if (step === 'upload') return this.selectedPlatforms().size > 0;
    return false;
  }

  async saveAndContinue(): Promise<void> {
    if (this.dirty()) await this.save();
    this.goNext();
  }

  async skipToTimeline(): Promise<void> {
    if (!this.isVideo()) return;
    if (this.dirty()) await this.save();
    this.setStep('timeline');
  }

  markDirty(): void {
    this.dirty.set(true);
  }

  private newRefId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  resetRefForm(): void {
    this.refKind = 'url';
    this.refTitle = '';
    this.refUrl = '';
    this.refNote = '';
  }

  toggleAssetPicker(): void {
    this.showRefAssetPicker.update((v) => !v);
  }

  refKindLabel(kind: string | undefined): string {
    const map: Record<string, string> = {
      url: 'Link',
      video: 'Video',
      image: 'Image',
      text: 'Text',
      file: 'File',
    };
    return map[String(kind || 'url')] || 'Ref';
  }

  refDisplayTitle(ref: IdeationReference): string {
    if (ref.title?.trim()) return ref.title.trim();
    if (ref.asset_id) return this.assetName(ref.asset_id);
    if (ref.url?.trim()) return ref.url.trim();
    return 'Untitled';
  }

  assetName(assetId: string | null | undefined): string {
    if (!assetId) return 'Asset';
    const asset = (this.api.currentProject()?.assets || []).find((a) => a.id === assetId);
    return asset?.name || assetId;
  }

  addReference(): void {
    const kind = this.refKind;
    const url = this.refUrl.trim();
    const title = this.refTitle.trim();
    const note = this.refNote.trim();
    if (kind !== 'text' && !url) {
      this.snackbar.show('Add a URL or attach an asset', 'error');
      return;
    }
    if (kind === 'text' && !note && !title) {
      this.snackbar.show('Write a text clip or title first', 'error');
      return;
    }
    const ref: IdeationReference = {
      id: this.newRefId(),
      kind,
      title: title || (kind === 'text' ? 'Text clip' : ''),
      url,
      asset_id: null,
      note,
      created_at: new Date().toISOString(),
    };
    this.references.update((list) => [ref, ...list]);
    this.resetRefForm();
    this.markDirty();
    this.snackbar.show('Reference added', 'success');
  }

  attachAsset(asset: Asset): void {
    const kind: RefKind = isVideoAsset(asset.type) ? 'video' : 'image';
    const ref: IdeationReference = {
      id: this.newRefId(),
      kind,
      title: asset.name || '',
      url: '',
      asset_id: asset.id,
      note: this.refNote.trim(),
      created_at: new Date().toISOString(),
    };
    this.references.update((list) => [ref, ...list]);
    this.showRefAssetPicker.set(false);
    this.markDirty();
    this.snackbar.show('Asset attached', 'success');
  }

  removeReference(id: string | undefined): void {
    if (!id) return;
    this.references.update((list) => list.filter((r) => r.id !== id));
    this.markDirty();
  }

  async save(): Promise<void> {
    const current = this.draft();
    if (!current) return;
    const prevFormat = current.video_format || '1080p';
    const prevTarget = current.target_format || 'portrait';
    const prevReusable = !!current.is_reusable;
    const updated: Post = {
      ...current,
      name: this.name.trim() || current.name,
      target_format: this.targetFormat,
      video_format: this.videoFormat,
      is_reusable: current.type === 'video' ? this.isReusable : false,
      ideation_notes: this.ideationNotes,
      ideation_references: [...this.references()],
      platforms: [...this.selectedPlatforms()],
    };
    const saved = await this.api.updatePost(updated, undefined, { quiet: true });
    if (saved) {
      this.applyDraft(saved);
      if (saved.type === 'video') {
        const changedBits: string[] = [];
        if ((saved.video_format || '1080p') !== prevFormat) {
          changedBits.push(`video format: ${saved.video_format || '1080p'}`);
        }
        if ((saved.target_format || 'portrait') !== prevTarget) {
          changedBits.push(`orientation: ${saved.target_format || 'portrait'}`);
        }
        if (!!saved.is_reusable !== prevReusable) {
          changedBits.push(saved.is_reusable ? 'marked reusable' : 'marked non-reusable');
        }
        this.snackbar.show(
          changedBits.length
            ? `Post saved — ${changedBits.join(', ')}`
            : 'Post saved — video settings are up to date',
          'success',
        );
      } else {
        this.snackbar.show('Post saved — details updated', 'success');
      }
    }
  }

  iconFor(asset: Asset): string {
    if (isVideoAsset(asset.type)) return 'movie';
    if (isAudioAsset(asset.type)) return 'audiotrack';
    if (asset.type === 'model') return 'view_in_ar';
    if (isImageAsset(asset.type)) return 'image';
    return 'draft';
  }
}
