import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  signal,
} from '@angular/core';
import { ModalWrapperComponent } from 'shared/ui';
import { ContentSproutApiService } from '../services/content-sprout-api.service';
import type {
  ComfyWorkflowDetails,
  ComfyWorkflowGraphEdge,
  ComfyWorkflowGraphNode,
  ComfyWorkflowModelRequirement,
} from '../models/content-sprout.models';

@Component({
  selector: 'app-workflow-detail-dialog',
  standalone: true,
  imports: [CommonModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal-wrapper
      [isOpen]="isOpen"
      [title]="details()?.title || stem || 'Workflow'"
      [subtitle]="subtitle()"
      icon="account_tree"
      size="large"
      customClass="cs-console-modal cs-workflow-detail-modal"
      closeButtonPosition="header"
      [closeOnOverlayClick]="true"
      (close)="closed.emit()"
    >
      @if (loading()) {
        <p class="meta">Loading workflow…</p>
      } @else if (error()) {
        <p class="meta" style="color: var(--cs-danger, #b42318)">{{ error() }}</p>
      } @else if (details(); as d) {
        <div class="cs-workflow-detail">
          @if (d.description) {
            <p class="page-intro" style="margin-top: 0">{{ d.description }}</p>
          }

          <div class="cs-workflow-detail-meta">
            <span class="meta"
              >Source: {{ d.source === 'package' ? 'built-in' : 'uploaded' }}</span
            >
            @if (d.default_for?.length) {
              <span class="meta"
                >Default for:
                {{ d.default_for.join(', ') }}</span
              >
            }
            <span class="meta">Nodes: {{ d.node_count || 0 }}</span>
            <span class="meta">Models: {{ d.model_count || 0 }}</span>
            @if (!d.available) {
              <span class="meta">Not installed yet — add {{ d.filename }} to the package workflows folder.</span>
            }
          </div>

          <section class="cs-workflow-detail-section">
            <h4 class="cs-section-title" style="margin: 0 0 0.5rem; font-size: 1rem">
              Required models
            </h4>
            @if (!d.models?.length) {
              <p class="meta" style="margin: 0">
                No model loaders detected{{ d.available ? '' : ' (workflow file missing)' }}.
              </p>
            } @else {
              <ul class="cs-workflow-model-list">
                @for (m of d.models; track m.filename) {
                  <li [class.active]="selectedModel()?.filename === m.filename">
                    <button type="button" (click)="selectModel(m)">
                      <strong>{{ m.filename }}</strong>
                      <span class="meta"> · {{ m.role || 'model' }}{{ m.required === false ? ' · optional' : '' }}</span>
                    </button>
                  </li>
                }
              </ul>
              @if (selectedModel(); as model) {
                <div class="surface-inset cs-workflow-model-detail">
                  <p style="margin: 0">
                    <strong>{{ model.filename }}</strong>
                  </p>
                  <p class="meta" style="margin: 0.25rem 0 0">
                    Role: {{ model.role || 'model' }}
                    @if (model.roles?.length) {
                      · aliases: {{ model.roles.join(', ') }}
                    }
                  </p>
                  @if (model.class_type) {
                    <p class="meta" style="margin: 0.25rem 0 0">
                      Loader: <code>{{ model.class_type }}</code>
                    </p>
                  }
                  @if (model.notes) {
                    <p style="margin: 0.45rem 0 0">{{ model.notes }}</p>
                  }
                  @if (model.nodes?.length) {
                    <p class="meta" style="margin: 0.45rem 0 0">
                      Used by node(s):
                      @for (n of model.nodes; track n.node_id; let last = $last) {
                        <code>{{ n.node_id }}</code
                        >.{{ n.input_key }}{{ last ? '' : ', ' }}
                      }
                    </p>
                  }
                </div>
              }
            }
          </section>

          <section class="cs-workflow-detail-section">
            <h4 class="cs-section-title" style="margin: 0 0 0.5rem; font-size: 1rem">
              Graph
            </h4>
            @if (!d.graph?.nodes?.length) {
              <p class="meta" style="margin: 0">Graph unavailable until the workflow JSON is present.</p>
            } @else {
              <div class="cs-workflow-graph-wrap">
                <svg
                  class="cs-workflow-graph"
                  [attr.viewBox]="'0 0 ' + graphWidth() + ' ' + graphHeight()"
                  [attr.width]="graphWidth()"
                  [attr.height]="graphHeight()"
                  role="img"
                  [attr.aria-label]="'Workflow graph for ' + (d.title || d.stem)"
                >
                  @for (e of d.graph.edges || []; track edgeKey(e)) {
                    <path
                      class="cs-workflow-graph-edge"
                      [attr.d]="edgePath(e)"
                      fill="none"
                    />
                  }
                  @for (n of d.graph.nodes || []; track n.id) {
                    <g
                      class="cs-workflow-graph-node"
                      [class.loader]="n.is_model_loader"
                      [class.selected]="selectedNodeId() === n.id"
                      (click)="selectNode(n)"
                      style="cursor: pointer"
                    >
                      <rect
                        [attr.x]="n.x"
                        [attr.y]="n.y"
                        [attr.width]="d.graph.node_width || 168"
                        [attr.height]="d.graph.node_height || 56"
                        rx="8"
                        ry="8"
                      />
                      <text
                        class="cs-workflow-graph-title"
                        [attr.x]="(n.x || 0) + 10"
                        [attr.y]="(n.y || 0) + 22"
                      >
                        {{ truncate(n.title || n.class_type, 22) }}
                      </text>
                      <text
                        class="cs-workflow-graph-type"
                        [attr.x]="(n.x || 0) + 10"
                        [attr.y]="(n.y || 0) + 40"
                      >
                        {{ truncate(n.class_type, 24) }}
                      </text>
                    </g>
                  }
                </svg>
              </div>
              @if (selectedNode(); as node) {
                <div class="surface-inset" style="margin-top: 0.65rem">
                  <p style="margin: 0">
                    <strong>{{ node.title || node.class_type }}</strong>
                    <span class="meta"> · node {{ node.id }}</span>
                  </p>
                  <p class="meta" style="margin: 0.25rem 0 0">
                    <code>{{ node.class_type }}</code>
                    @if (node.is_model_loader) {
                      · model loader
                    }
                  </p>
                  @if (node.models?.length) {
                    <p class="meta" style="margin: 0.35rem 0 0">
                      Models:
                      @for (name of node.models; track name; let last = $last) {
                        <button type="button" class="cs-inline-btn" (click)="selectModelByName(name)">
                          {{ name }}
                        </button
                        >{{ last ? '' : ' ' }}
                      }
                    </p>
                  }
                </div>
              }
            }
          </section>
        </div>
      }
    </app-modal-wrapper>
  `,
  styles: [
    `
      .cs-workflow-detail {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        max-height: min(70vh, 720px);
        overflow: auto;
      }
      .cs-workflow-detail-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.65rem 1rem;
      }
      .cs-workflow-model-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .cs-workflow-model-list li button {
        width: 100%;
        text-align: left;
        border: 1px solid transparent;
        background: transparent;
        padding: 0.35rem 0.45rem;
        border-radius: 6px;
        cursor: pointer;
      }
      .cs-workflow-model-list li.active button,
      .cs-workflow-model-list li button:hover {
        border-color: color-mix(in srgb, var(--cs-accent, #3b82f6) 40%, transparent);
        background: color-mix(in srgb, var(--cs-accent, #3b82f6) 8%, transparent);
      }
      .cs-workflow-graph-wrap {
        overflow: auto;
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        border-radius: 10px;
        background:
          radial-gradient(circle at 1px 1px, color-mix(in srgb, currentColor 14%, transparent) 1px, transparent 0)
          0 0 / 16px 16px;
        padding: 0.5rem;
      }
      .cs-workflow-graph-node rect {
        fill: color-mix(in srgb, var(--cs-surface, #fff) 92%, #94a3b8);
        stroke: color-mix(in srgb, currentColor 22%, transparent);
        stroke-width: 1.25;
      }
      .cs-workflow-graph-node.loader rect {
        fill: color-mix(in srgb, #f59e0b 18%, var(--cs-surface, #fff));
        stroke: color-mix(in srgb, #d97706 55%, transparent);
      }
      .cs-workflow-graph-node.selected rect {
        stroke: var(--cs-accent, #3b82f6);
        stroke-width: 2;
      }
      .cs-workflow-graph-title {
        font-size: 11px;
        font-weight: 600;
        fill: currentColor;
      }
      .cs-workflow-graph-type {
        font-size: 10px;
        fill: color-mix(in srgb, currentColor 65%, transparent);
      }
      .cs-workflow-graph-edge {
        stroke: color-mix(in srgb, currentColor 35%, transparent);
        stroke-width: 1.5;
      }
    `,
  ],
})
export class WorkflowDetailDialogComponent implements OnChanges {
  @Input() isOpen = false;
  @Input() stem = '';
  @Output() closed = new EventEmitter<void>();

  readonly details = signal<ComfyWorkflowDetails | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly selectedModel = signal<ComfyWorkflowModelRequirement | null>(null);
  readonly selectedNodeId = signal('');

  constructor(private readonly api: ContentSproutApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['isOpen'] || changes['stem']) && this.isOpen && this.stem) {
      void this.load();
    }
    if (changes['isOpen'] && !this.isOpen) {
      this.details.set(null);
      this.error.set('');
      this.selectedModel.set(null);
      this.selectedNodeId.set('');
    }
  }

  subtitle(): string {
    const d = this.details();
    if (!d) return 'Workflow details';
    return d.filename || d.stem;
  }

  graphWidth(): number {
    return Math.max(320, this.details()?.graph?.width || 320);
  }

  graphHeight(): number {
    return Math.max(160, this.details()?.graph?.height || 160);
  }

  selectedNode(): ComfyWorkflowGraphNode | null {
    const id = this.selectedNodeId();
    if (!id) return null;
    return this.details()?.graph?.nodes?.find((n) => n.id === id) || null;
  }

  selectModel(model: ComfyWorkflowModelRequirement): void {
    this.selectedModel.set(model);
    const nodeId = model.nodes?.[0]?.node_id;
    if (nodeId) this.selectedNodeId.set(String(nodeId));
  }

  selectModelByName(name: string): void {
    const model = this.details()?.models?.find((m) => m.filename === name);
    if (model) this.selectModel(model);
  }

  selectNode(node: ComfyWorkflowGraphNode): void {
    this.selectedNodeId.set(node.id);
    if (node.models?.length) {
      this.selectModelByName(node.models[0]);
    }
  }

  truncate(value: string, max: number): string {
    const s = (value || '').trim();
    if (s.length <= max) return s;
    return `${s.slice(0, Math.max(0, max - 1))}…`;
  }

  edgeKey(e: ComfyWorkflowGraphEdge): string {
    return `${e.from}->${e.to}:${e.input_key}:${e.slot}`;
  }

  edgePath(e: ComfyWorkflowGraphEdge): string {
    const d = this.details()?.graph;
    const nodes = d?.nodes || [];
    const nw = d?.node_width || 168;
    const nh = d?.node_height || 56;
    const from = nodes.find((n) => n.id === e.from);
    const to = nodes.find((n) => n.id === e.to);
    if (!from || !to) return '';
    const x1 = (from.x || 0) + nw;
    const y1 = (from.y || 0) + nh / 2;
    const x2 = to.x || 0;
    const y2 = (to.y || 0) + nh / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.details.set(null);
    this.selectedModel.set(null);
    this.selectedNodeId.set('');
    try {
      const data = await this.api.getComfyuiWorkflowDetails(this.stem);
      if (!data) {
        this.error.set('Failed to load workflow details');
        return;
      }
      this.details.set(data);
      if (data.models?.length) {
        this.selectedModel.set(data.models[0]);
      }
      const firstLoader = data.graph?.nodes?.find((n) => n.is_model_loader);
      if (firstLoader) this.selectedNodeId.set(firstLoader.id);
    } finally {
      this.loading.set(false);
    }
  }
}
