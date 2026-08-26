import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  computed,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalWrapperComponent, SnackbarService } from 'shared/ui';
import {
  isImageAsset,
  type Asset,
  type ComfyWorkflowInputField,
} from '../models/content-sprout.models';
import { ContentSproutApiService } from '../services/content-sprout-api.service';
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_VIDEO_SIZE,
  IMAGE_SIZE_PRESETS,
  VIDEO_SIZE_PRESETS,
  sizeKey,
} from './gen-presets';
import {
  WorkflowInputsFormComponent,
  valuesFromWorkflowInputs,
} from './workflow-inputs-form';

export type AssetGenMode = 'text_to_image' | 'text_to_video' | 'image_to_video';

@Component({
  selector: 'app-asset-generate-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent, WorkflowInputsFormComponent],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <app-modal-wrapper
      [isOpen]="!!mode()"
      [title]="title()"
      [subtitle]="subtitle()"
      icon="auto_awesome"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="requestClose()"
    >
      <div class="cs-form-stack">
        <label>
          <span>Prompt</span>
          <textarea rows="4" [(ngModel)]="prompt" placeholder="Describe what to generate…"></textarea>
        </label>
        @if (mode() === 'image_to_video') {
          <label>
            <span>Source image</span>
            <select [(ngModel)]="imageAssetId">
              <option value="">Select an image…</option>
              @for (img of imageOptions(); track img.id) {
                <option [value]="img.id">{{ img.name }}</option>
              }
            </select>
          </label>
        }
        <label>
          <span>Size</span>
          <select [(ngModel)]="sizeKeyValue">
            @for (p of sizeOptions(); track sizeKey(p.width, p.height)) {
              <option [value]="sizeKey(p.width, p.height)">{{ p.label }}</option>
            }
          </select>
        </label>
        <label>
          <span>Name (optional)</span>
          <input [(ngModel)]="name" placeholder="Asset name" />
        </label>
        <app-workflow-inputs-form
          [fields]="workflowFields"
          [values]="workflowValues"
          (valuesChange)="workflowValues = $event"
        />
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="requestClose()">Cancel</button>
        <button type="button" class="primary" (click)="submit()" [disabled]="busy()">
          {{ busy() ? 'Queuing…' : 'Generate' }}
        </button>
      </ng-template>
    </app-modal-wrapper>
  `,
})
export class AssetGenerateDialogComponent implements OnChanges {
  /** Active generate mode, or null when closed. */
  @Input() openMode: AssetGenMode | null = null;
  /** Optional post id for post-private assets; omit for project-shared. */
  @Input() postId: string | null = null;
  @Input() destinationHint = 'Saves to project-shared assets.';
  @Output() openModeChange = new EventEmitter<AssetGenMode | null>();
  @Output() queued = new EventEmitter<Asset>();

  readonly busy = signal(false);
  readonly mode = signal<AssetGenMode | null>(null);

  prompt = '';
  name = '';
  imageAssetId = '';
  sizeKeyValue = sizeKey(DEFAULT_IMAGE_SIZE.width, DEFAULT_IMAGE_SIZE.height);
  workflowFields: ComfyWorkflowInputField[] = [];
  workflowValues: Record<string, string | number | boolean> = {};
  sizeKey = sizeKey;

  readonly title = computed(() => {
    switch (this.mode()) {
      case 'text_to_image':
        return 'Generate image';
      case 'text_to_video':
        return 'Generate video';
      case 'image_to_video':
        return 'Generate video from image';
      default:
        return 'Generate';
    }
  });

  readonly subtitle = computed(
    () =>
      `${this.destinationHint} Uses ComfyUI workflows from Settings. Only small size presets are allowed.`,
  );

  constructor(
    private api: ContentSproutApiService,
    private snackbar: SnackbarService,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['openMode']) {
      const next = this.openMode;
      this.mode.set(next);
      if (next) void this.resetForMode(next);
    }
  }

  imageOptions(): Asset[] {
    return (this.api.currentProject()?.assets || []).filter((a) => isImageAsset(a.type));
  }

  sizeOptions() {
    return this.mode() === 'text_to_image' ? IMAGE_SIZE_PRESETS : VIDEO_SIZE_PRESETS;
  }

  requestClose(): void {
    this.openModeChange.emit(null);
  }

  private async resetForMode(mode: AssetGenMode): Promise<void> {
    this.busy.set(false);
    this.prompt = '';
    this.name = '';
    this.imageAssetId = '';
    const preset = mode === 'text_to_image' ? DEFAULT_IMAGE_SIZE : DEFAULT_VIDEO_SIZE;
    this.sizeKeyValue = sizeKey(preset.width, preset.height);
    const data = await this.api.getComfyuiOpInputs(mode);
    const fields = data?.inputs || [];
    this.workflowFields = fields;
    this.workflowValues = valuesFromWorkflowInputs(fields);
  }

  async submit(): Promise<void> {
    const projectId = this.api.currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('No project loaded', 'error');
      return;
    }
    const mode = this.mode();
    if (!mode) return;
    const prompt = this.prompt.trim();
    if (!prompt) {
      this.snackbar.show('Enter a prompt', 'error');
      return;
    }
    const [wStr, hStr] = this.sizeKeyValue.split('x');
    const width = Number(wStr);
    const height = Number(hStr);
    const postId = String(this.postId || '').trim() || undefined;
    const body = {
      prompt,
      width,
      height,
      name: this.name.trim() || undefined,
      post_id: postId,
      workflow_inputs: this.workflowValues,
    };
    this.busy.set(true);
    try {
      let ok: { asset?: Asset; queued?: boolean } | null = null;
      if (mode === 'text_to_image') {
        ok = await this.api.generateProjectImage(projectId, body);
      } else if (mode === 'text_to_video') {
        ok = await this.api.generateProjectVideo(projectId, body);
      } else {
        if (!this.imageAssetId) {
          this.snackbar.show('Select a source image', 'error');
          return;
        }
        ok = await this.api.generateProjectVideoFromImage(projectId, {
          ...body,
          image_asset_id: this.imageAssetId,
        });
      }
      if (ok?.asset) this.queued.emit(ok.asset);
      if (ok) this.requestClose();
    } finally {
      this.busy.set(false);
    }
  }
}
