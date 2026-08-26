import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogService, ModalWrapperComponent, SnackbarService } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { ProjectBrowserService } from '../../services/project-browser.service';
import {
  isImageAsset,
  type PhotoMagicAssetScope,
  type PhotoMagicDocument,
  type PhotoMagicLayer,
  type PhotoMagicOpened,
  type PhotoMagicScope,
  type PhotoMagicScopeRef,
  type PhotoMagicSummary,
  type AiServiceProfile,
} from '../../models/content-sprout.models';

type CompositionItem = PhotoMagicSummary;
import {
  PhotoMagicDraft,
  deserializeInstructions,
  duplicateLayerName,
  layerSizeForSource,
  newLocalId,
  nextLayerName,
  serializeInstructions,
  type PhotoMagicInstruction,
} from './photo-magic-draft';
import {
  boxMask,
  imageDataFromImage,
  lassoMask,
  magicMask,
  maskHasPixels,
  normalizeBox,
  type LayerSelection,
  type Point,
  type SelectTool,
} from './photo-magic-select';
import {
  applyLayerMask,
  eraseStroke,
  hitHandle,
  paintStroke,
  layerDocCorners,
  measureTextBlock,
  oppositeCorner,
  sourceToBlob,
  type TextStyle,
} from './photo-magic-ops';

const SIZE_PRESETS = [
  { id: 'landscape', label: '1920 × 1080 · landscape', width: 1920, height: 1080 },
  { id: 'square', label: '1080 × 1080 · square', width: 1080, height: 1080 },
  { id: 'portrait', label: '1080 × 1350 · portrait', width: 1080, height: 1350 },
  { id: 'story', label: '1080 × 1920 · story', width: 1080, height: 1920 },
  { id: 'hd', label: '1280 × 720 · HD', width: 1280, height: 720 },
] as const;

const FONT_PRESETS = [
  { id: 'sans', label: 'Sans', family: 'Inter, system-ui, sans-serif' },
  { id: 'serif', label: 'Serif', family: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Mono', family: 'ui-monospace, Menlo, monospace' },
] as const;

type EditTool = 'brush' | 'erase' | 'text' | 'scale' | 'distort' | 'crop';
type EditorTool = 'pointer' | SelectTool | EditTool;

type EditorGesture =
  | { kind: 'select'; start: Point; current: Point; points: Point[] }
  | { kind: 'paint'; points: Point[] }
  | {
      kind: 'scale';
      handle: number;
      current: Point;
      origin: { width: number; height: number; offset_x: number; offset_y: number };
    }
  | { kind: 'distort'; handle: number; corners: [Point, Point, Point, Point] }
  | { kind: 'crop'; start: Point; current: Point }
  | { kind: 'move'; start: Point; current: Point; originX: number; originY: number };

@Component({
  selector: 'app-photo-magic',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="page cs-photomagic-page">
      <div class="cs-photomagic-chrome">
        <div class="cs-photomagic-chrome-copy">
          <p class="page-intro" style="margin: 0">
            Layered photo editor. Compositions are JSON edit logs stored in this scope — Global
            Resources, the current project, or the selected post. Save writes the sequential
            changes. Paint, erase, type, scale, distort, and crop like GIMP. Drag a layer so only
            part of it sits in the frame. New layers land above the selected layer (GIMP order).
          </p>
          <p class="meta cs-photomagic-scope-label">{{ scopeCaption() }}</p>
        </div>
        <div class="cs-tabs" role="tablist" aria-label="Photo Magic scope">
          <button
            type="button"
            role="tab"
            [class.active]="scope() === 'global'"
            [attr.aria-selected]="scope() === 'global'"
            (click)="setScope('global')"
          >
            Shared Library
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="scope() === 'project'"
            [attr.aria-selected]="scope() === 'project'"
            (click)="setScope('project')"
            [disabled]="!api.currentProject()"
            [title]="api.currentProject() ? 'Project compositions' : 'Select a project first'"
          >
            Project
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="scope() === 'post'"
            [attr.aria-selected]="scope() === 'post'"
            (click)="setScope('post')"
            [disabled]="!api.currentProject()"
          >
            Post
          </button>
        </div>
      </div>

      @if (scope() === 'post') {
        <label class="cs-photomagic-post-pick">
          <span>Post</span>
          <select [ngModel]="postId()" (ngModelChange)="setPostId($event)" aria-label="Associate to post">
            <option value="">Select a post…</option>
            @for (p of api.currentProject()?.posts || []; track p.id) {
              <option [value]="p.id">{{ p.name }}</option>
            }
          </select>
        </label>
      }

      @if (scope() !== 'global' && !api.currentProject()) {
        <section class="surface-card cs-empty">
          <span class="material-symbols-outlined" style="font-size: 2rem" aria-hidden="true"
            >folder_open</span
          >
          <h2>Select a project</h2>
          <p>Project and post compositions are stored with the open project.</p>
          <div class="page-actions-inline" style="justify-content: center; margin-top: 1rem">
            <button type="button" class="primary" (click)="browser.open()">Browse projects</button>
          </div>
        </section>
      } @else if (scope() === 'post' && !postId()) {
        <section class="surface-card cs-empty">
          <span class="material-symbols-outlined" style="font-size: 2rem" aria-hidden="true"
            >dashboard</span
          >
          <h2>Select a post</h2>
          <p>Post-scoped edits stay with that post’s assets.</p>
        </section>
      } @else {
        <div class="cs-photomagic-workspace">
          <section class="surface-card cs-photomagic-docs">
            <div class="cs-photomagic-panel-head">
              <h3>Compositions</h3>
              <button type="button" class="primary" (click)="showNew.set(true)">New</button>
            </div>
            <ul class="cs-photomagic-doc-list">
              @for (item of documents(); track item.id) {
                <li>
                  <button
                    type="button"
                    class="cs-photomagic-doc-btn"
                    [class.active]="document()?.id === item.id"
                    (click)="openDocument(item.id)"
                  >
                    <strong class="truncate">{{ item.name }}</strong>
                    <span class="meta">
                      {{ item.width }}×{{ item.height }} · {{ item.layer_count }} layers
                    </span>
                  </button>
                </li>
              } @empty {
                <li class="meta cs-empty-inline">No compositions in this scope yet.</li>
              }
            </ul>
          </section>

          <section class="surface-card cs-photomagic-stage">
            @if (document(); as doc) {
              <div class="cs-photomagic-stage-head">
                <label class="cs-photomagic-name">
                  <span class="visually-hidden">Composition name</span>
                  <input
                    [ngModel]="doc.name"
                    (change)="renameDocument($any($event.target).value)"
                    aria-label="Composition name"
                  />
                </label>
                <span class="meta">{{ doc.width }} × {{ doc.height }}</span>
                @if (dirty()) {
                  <span class="cs-photomagic-unsaved">Unsaved</span>
                }
                <button type="button" class="danger" (click)="deleteDocument()">Delete</button>
              </div>
              <div class="cs-photomagic-history" role="toolbar" aria-label="Change history">
                <button
                  type="button"
                  title="Previous change"
                  (click)="undo()"
                  [disabled]="!canUndo()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">undo</span>
                  Previous
                </button>
                <span class="meta cs-photomagic-history-label">{{ historyLabel() }}</span>
                <button
                  type="button"
                  title="Next change"
                  (click)="redo()"
                  [disabled]="!canRedo()"
                >
                  Next
                  <span class="material-symbols-outlined" aria-hidden="true">redo</span>
                </button>
                <button
                  type="button"
                  class="primary"
                  (click)="saveEdits()"
                  [disabled]="!canSave() || busy()"
                  title="Write the sequential composition JSON to this scope"
                >
                  Save
                </button>
              </div>
              <div class="cs-photomagic-tools" role="toolbar" aria-label="Editor tools">
                <button
                  type="button"
                  [class.active]="tool() === 'pointer'"
                  title="Move the active layer, including partly outside the frame"
                  (click)="setTool('pointer')"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">open_with</span>
                  Move
                </button>
                <button
                  type="button"
                  [class.active]="tool() === 'box'"
                  title="Box select on the active layer"
                  (click)="setTool('box')"
                  [disabled]="!selectedLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">crop_square</span>
                  Box
                </button>
                <button
                  type="button"
                  [class.active]="tool() === 'lasso'"
                  title="Lasso select on the active layer"
                  (click)="setTool('lasso')"
                  [disabled]="!selectedLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">gesture</span>
                  Lasso
                </button>
                <button
                  type="button"
                  [class.active]="tool() === 'magic'"
                  title="Magic select similar colors on the active layer"
                  (click)="setTool('magic')"
                  [disabled]="!selectedLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">auto_fix_high</span>
                  Magic
                </button>
                <span class="cs-photomagic-tool-sep" aria-hidden="true"></span>
                <button
                  type="button"
                  [class.active]="tool() === 'brush'"
                  title="Paint brush on the active layer"
                  (click)="setTool('brush')"
                  [disabled]="!canEditLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">brush</span>
                  Brush
                </button>
                <button
                  type="button"
                  [class.active]="tool() === 'erase'"
                  title="Erase pixels on the active layer"
                  (click)="setTool('erase')"
                  [disabled]="!canEditLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">ink_eraser</span>
                  Erase
                </button>
                <button
                  type="button"
                  [class.active]="tool() === 'text'"
                  title="Place a text layer"
                  (click)="setTool('text')"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">title</span>
                  Text
                </button>
                <button
                  type="button"
                  [class.active]="tool() === 'scale'"
                  title="Scale the active layer"
                  (click)="setTool('scale')"
                  [disabled]="!canEditLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">zoom_out_map</span>
                  Scale
                </button>
                <button
                  type="button"
                  [class.active]="tool() === 'distort'"
                  title="Distort the active layer"
                  (click)="setTool('distort')"
                  [disabled]="!canEditLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">transform</span>
                  Distort
                </button>
                <button
                  type="button"
                  [class.active]="tool() === 'crop'"
                  title="Crop the composition"
                  (click)="setTool('crop')"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">crop</span>
                  Crop
                </button>
                <button
                  type="button"
                  title="Clear selection"
                  (click)="clearSelection()"
                  [disabled]="!selection()"
                >
                  Clear selection
                </button>
              </div>
              @if (tool() === 'magic') {
                <div class="cs-photomagic-tool-opts">
                  <label class="cs-photomagic-tolerance">
                    <span>Tolerance {{ magicTolerance }}</span>
                    <input
                      type="range"
                      min="0"
                      max="128"
                      [(ngModel)]="magicTolerance"
                      aria-label="Magic select tolerance"
                    />
                  </label>
                </div>
              }
              @if (tool() === 'brush') {
                <div class="cs-photomagic-tool-opts">
                  <label class="cs-photomagic-tolerance">
                    <span>Size {{ brushSize }}</span>
                    <input
                      type="range"
                      min="2"
                      max="160"
                      [(ngModel)]="brushSize"
                      aria-label="Brush size"
                    />
                  </label>
                  <label class="cs-photomagic-tolerance">
                    <span>Hardness {{ brushHardness }}</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      [(ngModel)]="brushHardness"
                      aria-label="Brush hardness"
                    />
                  </label>
                  <label class="cs-photomagic-color">
                    <span>Color</span>
                    <input type="color" [(ngModel)]="brushColor" aria-label="Brush color" />
                  </label>
                </div>
              }
              @if (tool() === 'erase') {
                <div class="cs-photomagic-tool-opts">
                  <label class="cs-photomagic-tolerance">
                    <span>Size {{ eraseSize }}</span>
                    <input
                      type="range"
                      min="2"
                      max="160"
                      [(ngModel)]="eraseSize"
                      aria-label="Eraser size"
                    />
                  </label>
                  <label class="cs-photomagic-tolerance">
                    <span>Hardness {{ eraseHardness }}</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      [(ngModel)]="eraseHardness"
                      aria-label="Eraser hardness"
                    />
                  </label>
                </div>
              }
              @if (tool() === 'text') {
                <div class="cs-photomagic-tool-opts">
                  <span class="meta">Click the canvas to place text</span>
                  <label class="cs-photomagic-tolerance">
                    <span>Size {{ textSize }}</span>
                    <input
                      type="range"
                      min="12"
                      max="240"
                      [(ngModel)]="textSize"
                      aria-label="Text size"
                    />
                  </label>
                  <label class="cs-photomagic-color">
                    <span>Color</span>
                    <input type="color" [(ngModel)]="textColor" aria-label="Text color" />
                  </label>
                  <label class="cs-photomagic-font">
                    <span>Font</span>
                    <select [(ngModel)]="textFontId" aria-label="Text font">
                      @for (font of fontPresets; track font.id) {
                        <option [value]="font.id">{{ font.label }}</option>
                      }
                    </select>
                  </label>
                </div>
              }
              @if (tool() === 'scale' || tool() === 'distort') {
                <p class="meta cs-photomagic-tool-hint">
                  Drag a corner handle on the active layer. Locked layers cannot be transformed.
                </p>
              }
              @if (tool() === 'crop') {
                <p class="meta cs-photomagic-tool-hint">
                  Drag a rectangle to crop the whole composition (all layers).
                </p>
              }
              @if (tool() === 'pointer') {
                <p class="meta cs-photomagic-tool-hint">
                  Drag to position the active layer. It can sit only halfway in the frame. Arrow
                  keys nudge; Shift+arrow nudges farther.
                </p>
              }
              @if (editingMask()) {
                <p class="meta cs-photomagic-tool-hint">
                  Editing the layer mask — Brush reveals, Erase hides.
                </p>
              }
              <div class="cs-photomagic-canvas-wrap" #stageWrap>
                <canvas
                  #stage
                  class="cs-photomagic-canvas"
                  [class.selecting]="isSelecting()"
                  [class.painting]="tool() === 'brush' || tool() === 'erase'"
                  [class.placing]="tool() === 'text'"
                  [class.cropping]="tool() === 'crop'"
                  [class.moving]="tool() === 'pointer'"
                  [class.transforming]="tool() === 'scale' || tool() === 'distort'"
                  (pointerdown)="onPointerDown($event)"
                  (pointermove)="onPointerMove($event)"
                  (pointerup)="onPointerUp($event)"
                  (pointerleave)="onPointerUp($event)"
                ></canvas>
              </div>
            } @else {
              <div class="cs-empty cs-photomagic-stage-empty">
                <span class="material-symbols-outlined" aria-hidden="true">auto_fix_high</span>
                <h2>Open or create a composition</h2>
                <p>Start blank or from a photo in this scope.</p>
                <button type="button" class="primary" (click)="showNew.set(true)">New composition</button>
              </div>
            }
          </section>

          <section class="surface-card cs-photomagic-layers">
            <div class="cs-photomagic-panel-head">
              <h3>Layers</h3>
              <span class="meta">Top = front</span>
            </div>
            @if (document(); as doc) {
              <div class="cs-photomagic-layer-tools" role="toolbar" aria-label="Layer stack">
                <button type="button" title="New transparent layer" (click)="addEmptyLayer()">
                  <span class="material-symbols-outlined" aria-hidden="true">add</span>
                </button>
                <button type="button" title="Add layer from library photo" (click)="openAddFromAsset()">
                  <span class="material-symbols-outlined" aria-hidden="true">add_photo_alternate</span>
                </button>
                <button type="button" title="Add layer from file" (click)="fileInput.click()">
                  <span class="material-symbols-outlined" aria-hidden="true">upload</span>
                </button>
                <button
                  type="button"
                  title="Duplicate selected layer"
                  (click)="duplicateSelected()"
                  [disabled]="!selectedLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">content_copy</span>
                </button>
                <button
                  type="button"
                  title="Delete selected layer"
                  (click)="deleteSelectedLayer()"
                  [disabled]="!selectedLayer() || selectedLayer()?.locked"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">delete</span>
                </button>
                <span class="cs-photomagic-tool-gap"></span>
                <button
                  type="button"
                  title="Raise layer (toward front)"
                  (click)="moveSelected('raise')"
                  [disabled]="!canRaise()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">keyboard_arrow_up</span>
                </button>
                <button
                  type="button"
                  title="Lower layer (toward background)"
                  (click)="moveSelected('lower')"
                  [disabled]="!canLower()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">keyboard_arrow_down</span>
                </button>
                <button
                  type="button"
                  title="Raise to top"
                  (click)="moveSelected('raise-to-top')"
                  [disabled]="!canRaise()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">vertical_align_top</span>
                </button>
                <button
                  type="button"
                  title="Lower to bottom"
                  (click)="moveSelected('lower-to-bottom')"
                  [disabled]="!canLower()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">vertical_align_bottom</span>
                </button>
                <span class="cs-photomagic-tool-gap"></span>
                <button
                  type="button"
                  title="Add layer mask (from selection if one exists)"
                  (click)="addLayerMask('selection')"
                  [disabled]="!selectedLayer()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">texture</span>
                </button>
                <button
                  type="button"
                  title="Invert layer mask"
                  (click)="invertLayerMask()"
                  [disabled]="!selectedLayer()?.has_mask"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">invert_colors</span>
                </button>
                <button
                  type="button"
                  title="Apply mask to pixels"
                  (click)="applyLayerMaskToPixels()"
                  [disabled]="!selectedLayer()?.has_mask"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">layers</span>
                </button>
                <button
                  type="button"
                  title="Delete layer mask"
                  (click)="deleteLayerMask()"
                  [disabled]="!selectedLayer()?.has_mask"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">hide_image</span>
                </button>
                <span class="cs-photomagic-tool-gap"></span>
                <button
                  type="button"
                  title="Edit selected layer with AI"
                  (click)="openAiEdit()"
                  [disabled]="!canEditLayer() || !imageEditServices().length || busy()"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
                </button>
              </div>
              <input
                #fileInput
                type="file"
                accept="image/*"
                hidden
                (change)="onLayerFile($event)"
              />
              <ul class="cs-photomagic-layer-list" aria-label="Layers, topmost first">
                @for (layer of doc.layers; track layer.id; let i = $index) {
                  <li
                    class="cs-photomagic-layer"
                    [class.active]="doc.selected_layer_id === layer.id"
                    [class.hidden-layer]="!layer.visible"
                    draggable="true"
                    (dragstart)="onDragStart($event, layer.id)"
                    (dragover)="onDragOver($event, layer.id)"
                    (drop)="onDrop($event, layer.id)"
                    (click)="selectLayer(layer.id)"
                  >
                    <button
                      type="button"
                      class="cs-photomagic-icon-btn"
                      [title]="layer.visible ? 'Hide' : 'Show'"
                      (click)="toggleVisible(layer, $event)"
                    >
                      <span class="material-symbols-outlined" aria-hidden="true">{{
                        layer.visible ? 'visibility' : 'visibility_off'
                      }}</span>
                    </button>
                    <img
                      class="cs-photomagic-layer-thumb"
                      [src]="layerThumb(layer)"
                      [alt]="layer.name"
                    />
                    @if (layer.has_mask) {
                      <button
                        type="button"
                        class="cs-photomagic-mask-thumb"
                        [class.active]="editingMask() && doc.selected_layer_id === layer.id"
                        [class.disabled-mask]="layer.mask_enabled === false"
                        title="Edit layer mask"
                        (click)="toggleEditMask(layer, $event)"
                      >
                        <img [src]="layerMaskThumb(layer)" alt="" />
                      </button>
                    } @else {
                      <span class="cs-photomagic-mask-placeholder" aria-hidden="true"></span>
                    }
                    <div class="cs-photomagic-layer-meta">
                      <input
                        class="cs-photomagic-layer-name"
                        [ngModel]="layer.name"
                        (click)="$event.stopPropagation()"
                        (change)="renameLayer(layer, $any($event.target).value)"
                        [attr.aria-label]="'Layer name ' + layer.name"
                      />
                      <label class="cs-photomagic-opacity" (click)="$event.stopPropagation()">
                        <span>Opacity {{ layerOpacityPct(layer) }}%</span>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          [ngModel]="layerOpacityPct(layer)"
                          (change)="setLayerOpacity(layer, $any($event.target).value)"
                          [attr.aria-label]="'Opacity ' + layer.name"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      class="cs-photomagic-icon-btn"
                      [title]="layer.has_mask ? (layer.mask_enabled === false ? 'Enable mask' : 'Disable mask') : 'No mask'"
                      (click)="toggleMaskEnabled(layer, $event)"
                      [disabled]="!layer.has_mask"
                    >
                      <span class="material-symbols-outlined" aria-hidden="true">{{
                        layer.has_mask && layer.mask_enabled !== false ? 'blur_on' : 'blur_off'
                      }}</span>
                    </button>
                    <button
                      type="button"
                      class="cs-photomagic-icon-btn"
                      [title]="layer.locked ? 'Unlock' : 'Lock'"
                      (click)="toggleLocked(layer, $event)"
                    >
                      <span class="material-symbols-outlined" aria-hidden="true">{{
                        layer.locked ? 'lock' : 'lock_open'
                      }}</span>
                    </button>
                  </li>
                } @empty {
                  <li class="meta cs-empty-inline">No layers — add one to start painting the stack.</li>
                }
              </ul>
            } @else {
              <p class="meta">Open a composition to edit its layer stack.</p>
            }
          </section>
        </div>
      }
    </div>

    <app-modal-wrapper
      [isOpen]="showNew()"
      title="New Photo Magic composition"
      subtitle="Creates a composition.json in this scope. Later edits append as sequential changes."
      icon="auto_fix_high"
      size="medium"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="showNew.set(false)"
    >
      <div class="cs-form-stack">
        <label>
          <span>Name</span>
          <input [(ngModel)]="newName" placeholder="Untitled" />
        </label>
        <label>
          <span>Canvas size</span>
          <select [(ngModel)]="newSizeId">
            @for (s of sizePresets; track s.id) {
              <option [value]="s.id">{{ s.label }}</option>
            }
          </select>
        </label>
        <label>
          <span>Start from photo (optional)</span>
          <select [(ngModel)]="newSourceAssetId">
            <option value="">Blank canvas</option>
            @for (a of libraryImages(); track a.id) {
              <option [value]="a.id">{{ a.name }}</option>
            }
          </select>
        </label>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="showNew.set(false)">Cancel</button>
        <button type="button" class="primary" (click)="createDocument()" [disabled]="busy()">
          Create
        </button>
      </ng-template>
    </app-modal-wrapper>

    <app-modal-wrapper
      [isOpen]="showAddAsset()"
      title="Add layer from photo"
      subtitle="Inserted above the selected layer — stored in the composition JSON when you Save"
      icon="add_photo_alternate"
      size="medium"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="showAddAsset.set(false)"
    >
      <div class="cs-form-stack">
        <label>
          <span>Photo</span>
          <select [(ngModel)]="addAssetId">
            <option value="">Select a photo…</option>
            @for (a of libraryImages(); track a.id) {
              <option [value]="a.id">{{ a.name }}</option>
            }
          </select>
        </label>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="showAddAsset.set(false)">Cancel</button>
        <button type="button" class="primary" (click)="addLayerFromAsset()" [disabled]="!addAssetId || busy()">
          Add layer
        </button>
      </ng-template>
    </app-modal-wrapper>

    <app-modal-wrapper
      [isOpen]="showText()"
      title="Add text layer"
      subtitle="Inserted above the selected layer — stored in the composition JSON when you Save"
      icon="title"
      size="medium"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="cancelText()"
    >
      <div class="cs-form-stack">
        <label>
          <span>Text</span>
          <textarea [(ngModel)]="textValue" rows="3" aria-label="Text content"></textarea>
        </label>
        <label>
          <span>Size {{ textSize }}</span>
          <input type="range" min="12" max="240" [(ngModel)]="textSize" />
        </label>
        <label>
          <span>Color</span>
          <input type="color" [(ngModel)]="textColor" />
        </label>
        <label>
          <span>Font</span>
          <select [(ngModel)]="textFontId">
            @for (font of fontPresets; track font.id) {
              <option [value]="font.id">{{ font.label }}</option>
            }
          </select>
        </label>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="cancelText()">Cancel</button>
        <button type="button" class="primary" (click)="commitText()" [disabled]="!textValue.trim()">
          Add text
        </button>
      </ng-template>
    </app-modal-wrapper>

    <app-modal-wrapper
      [isOpen]="showAiEdit()"
      title="AI edit layer"
      subtitle="Composes the selected layer (or full canvas) to a temporary image and sends it to the chosen AI service."
      icon="auto_awesome"
      size="medium"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      [closeDisabled]="busy()"
      [closeOnOverlayClick]="!busy()"
      (close)="showAiEdit.set(false)"
    >
      <div class="cs-form-stack">
        <label>
          <span>Instruction</span>
          <textarea
            [(ngModel)]="aiEditInstruction"
            rows="4"
            placeholder="e.g. Soften the sky, keep the subject sharp"
            aria-label="AI edit instruction"
          ></textarea>
        </label>
        @if (imageEditServices().length > 1) {
          <label>
            <span>AI service</span>
            <select [(ngModel)]="aiEditServiceId" aria-label="AI service">
              @for (svc of imageEditServices(); track svc.id) {
                <option [value]="svc.id">
                  {{ svc.name }}{{ svc.host === 'local' ? ' · local' : '' }}
                </option>
              }
            </select>
          </label>
        } @else if (imageEditServices().length === 1) {
          <p class="meta" style="margin: 0">
            Using {{ imageEditServices()[0].name }}
          </p>
        }
        <label>
          <span>Source</span>
          <select [(ngModel)]="aiEditSource">
            <option value="layer">Selected layer only</option>
            <option value="composition">Full composition</option>
          </select>
        </label>
        <label>
          <span>Apply result as</span>
          <select [(ngModel)]="aiEditApplyAs">
            <option value="new">New layer above selection</option>
            <option value="replace">Replace selected layer</option>
          </select>
        </label>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="showAiEdit.set(false)" [disabled]="busy()">Cancel</button>
        <button
          type="button"
          class="primary"
          (click)="submitAiEdit()"
          [disabled]="busy() || !aiEditInstruction.trim() || !imageEditServices().length"
        >
          {{ busy() ? 'Editing…' : 'Submit to AI' }}
        </button>
      </ng-template>
    </app-modal-wrapper>
  `,
})
export class PhotoMagicPage implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('stage') stageRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('stageWrap') stageWrapRef?: ElementRef<HTMLElement>;

  readonly sizePresets = SIZE_PRESETS;
  readonly fontPresets = FONT_PRESETS;
  readonly scope = signal<PhotoMagicScope>('global');
  readonly postId = signal('');
  readonly documents = signal<CompositionItem[]>([]);
  readonly document = signal<PhotoMagicDocument | null>(null);
  readonly selection = signal<LayerSelection | null>(null);
  readonly dirty = signal(false);
  readonly canSave = signal(false);
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);
  readonly historyLabel = signal('No edits yet');
  readonly showNew = signal(false);
  readonly showAddAsset = signal(false);
  readonly showText = signal(false);
  readonly showAiEdit = signal(false);
  readonly imageEditServices = signal<AiServiceProfile[]>([]);
  readonly busy = signal(false);
  readonly tool = signal<EditorTool>('pointer');
  readonly editingMask = signal(false);

  newName = '';
  newSizeId: string = SIZE_PRESETS[0].id;
  newSourceAssetId = '';
  addAssetId = '';
  magicTolerance = 32;
  brushSize = 24;
  brushColor = '#ffffff';
  brushHardness = 0.7;
  eraseSize = 32;
  eraseHardness = 0.85;
  textSize = 48;
  textColor = '#ffffff';
  textFontId: string = FONT_PRESETS[0].id;
  textValue = 'Text';
  aiEditInstruction = '';
  aiEditServiceId = '';
  aiEditSource: 'layer' | 'composition' = 'layer';
  aiEditApplyAs: 'new' | 'replace' = 'new';
  private pendingTextPoint: Point | null = null;
  private thumbCache = new Map<string, string>();

  private readonly draft = new PhotoMagicDraft();
  private dragLayerId: string | null = null;
  private applyingQuery = false;
  private gesture: EditorGesture | null = null;
  private ants = 0;
  private antsTimer: ReturnType<typeof setInterval> | null = null;
  private resizeObs: ResizeObserver | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  readonly scopeRef = computed<PhotoMagicScopeRef>(() => ({
    scope: this.scope(),
    projectId: this.scope() === 'global' ? null : this.api.currentProject()?.id || null,
    postId: this.scope() === 'post' ? this.postId() || null : null,
  }));

  readonly selectedLayer = computed(() => {
    const doc = this.document();
    if (!doc?.selected_layer_id) return null;
    return doc.layers.find((l) => l.id === doc.selected_layer_id) || null;
  });

  readonly libraryImages = computed(() => {
    if (this.scope() === 'global') {
      return this.api.globalAssets().filter((a) => isImageAsset(a.type) && a.status === 'ready');
    }
    return (this.api.currentProject()?.assets || []).filter(
      (a) => isImageAsset(a.type) && a.status === 'ready',
    );
  });

  readonly scopeCaption = computed(() => {
    if (this.scope() === 'global') return 'Saved in Shared Library';
    const project = this.api.currentProject()?.name || 'project';
    if (this.scope() === 'project') return `Saved with project · ${project}`;
    const post = (this.api.currentProject()?.posts || []).find((p) => p.id === this.postId());
    return `Saved with post · ${post?.name || 'select a post'} · ${project}`;
  });

  constructor(
    public api: ContentSproutApiService,
    public browser: ProjectBrowserService,
    private route: ActivatedRoute,
    private router: Router,
    private dialogs: DialogService,
    private snackbar: SnackbarService,
  ) {
    effect(() => {
      const projectId = this.api.currentProject()?.id || '';
      if (!projectId || this.scope() === 'global' || this.applyingQuery) return;
      void this.reloadList();
    });
    effect(() => {
      this.document();
      this.selection();
      this.tool();
      this.editingMask();
      queueMicrotask(() => this.drawStage());
    });
  }

  ngOnInit(): void {
    void this.api.loadGlobalAssets();
    void this.api.refreshCurrentProject();
    void this.refreshAiEditServices();
    this.route.queryParamMap.subscribe((params) => {
      void this.applyQuery(
        (params.get('scope') as PhotoMagicScope | null) || null,
        params.get('projectId'),
        params.get('postId'),
        params.get('assetId'),
        params.get('assetScope') as PhotoMagicAssetScope | null,
        params.get('docId'),
      );
    });
    this.antsTimer = setInterval(() => {
      this.ants = (this.ants + 1) % 16;
      if (this.selection()) this.drawStage();
    }, 80);
  }

  ngAfterViewInit(): void {
    const wrap = this.stageWrapRef?.nativeElement;
    if (typeof ResizeObserver !== 'undefined' && wrap) {
      this.resizeObs = new ResizeObserver(() => this.drawStage());
      this.resizeObs.observe(wrap);
    }
    this.drawStage();
  }

  ngOnDestroy(): void {
    if (this.antsTimer) clearInterval(this.antsTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.resizeObs?.disconnect();
    void this.persistDraftNow();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    const meta = event.metaKey || event.ctrlKey;
    if (meta && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undo();
    } else if (meta && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      this.redo();
    } else if (meta && key === 's') {
      event.preventDefault();
      void this.saveEdits();
    } else if (key === 'escape') {
      if (this.showText()) {
        this.cancelText();
        return;
      }
      if (this.editingMask()) {
        this.editingMask.set(false);
        this.drawStage();
        return;
      }
      if (this.gesture) {
        this.gesture = null;
        this.drawStage();
        return;
      }
      this.clearSelection();
    } else if (
      this.tool() === 'pointer' &&
      !this.isTypingTarget(event.target) &&
      (key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' || key === 'arrowright')
    ) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      this.nudgeLayer(dx, dy);
    }
  }

  setTool(tool: EditorTool): void {
    this.gesture = null;
    this.tool.set(tool);
    this.drawStage();
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  isSelecting(): boolean {
    const tool = this.tool();
    return tool === 'box' || tool === 'lasso' || tool === 'magic';
  }

  canEditLayer(): boolean {
    const layer = this.selectedLayer();
    return !!layer && !layer.locked;
  }

  async refreshAiEditServices(): Promise<void> {
    const caps = await this.api.getAiCapabilities();
    const services = (caps?.image_edit_services || []).filter((s) => s.can_edit_image !== false);
    this.imageEditServices.set(services);
    if (services.length && !services.some((s) => s.id === this.aiEditServiceId)) {
      this.aiEditServiceId = services[0].id;
    }
  }

  async openAiEdit(): Promise<void> {
    if (!this.canEditLayer()) return;
    await this.refreshAiEditServices();
    if (!this.imageEditServices().length) {
      this.snackbar.show(
        'No image AI service is ready. Add one under Settings → Image generation & editing.',
        'warning',
      );
      return;
    }
    this.aiEditInstruction = '';
    this.aiEditSource = 'layer';
    this.aiEditApplyAs = 'new';
    if (!this.aiEditServiceId) this.aiEditServiceId = this.imageEditServices()[0].id;
    this.showAiEdit.set(true);
  }

  async submitAiEdit(): Promise<void> {
    const doc = this.document();
    const layer = this.selectedLayer();
    const instruction = this.aiEditInstruction.trim();
    if (!doc || !layer || !instruction) return;
    const services = this.imageEditServices();
    if (!services.length) return;
    const serviceId =
      services.length > 1
        ? this.aiEditServiceId || services[0].id
        : services[0].id;
    this.busy.set(true);
    try {
      const composed = await this.composeTempForAiEdit(doc, layer);
      if (!composed) {
        this.snackbar.show('Could not compose the layer for AI edit', 'error');
        return;
      }
      const result = await this.api.photoMagicAiEdit(doc.id, this.scopeRef(), {
        instruction,
        serviceId,
        image: composed,
      });
      if (!result) return;
      const loaded = await this.loadRaster(URL.createObjectURL(result));
      const width = loaded.image.naturalWidth || layer.width;
      const height = loaded.image.naturalHeight || layer.height;
      if (this.aiEditApplyAs === 'replace') {
        const instrId = newLocalId();
        this.draft.setSource(instrId, loaded.image, loaded.blob);
        this.push({
          id: instrId,
          label: `AI edit “${layer.name}”`,
          kind: 'replace_layer_raster',
          layerId: layer.id,
          width,
          height,
        });
      } else {
        const next = this.newLayer(
          doc,
          nextLayerName(doc.layers.map((l) => l.name)),
          width,
          height,
        );
        this.draft.setSource(next.id, loaded.image, loaded.blob);
        this.push({
          id: newLocalId(),
          label: `AI edit → “${next.name}”`,
          kind: 'add_layer',
          layer: next,
          insertAboveId: layer.id,
        });
      }
      this.showAiEdit.set(false);
      this.snackbar.show('AI edit applied — Save to write the composition', 'success');
    } finally {
      this.busy.set(false);
    }
  }

  private async composeTempForAiEdit(
    doc: PhotoMagicDocument,
    layer: PhotoMagicLayer,
  ): Promise<Blob | null> {
    if (this.aiEditSource === 'layer') {
      const img = this.draft.rasters.get(layer.id);
      if (!img) return null;
      const src = this.layerPreviewSource(layer, img);
      return sourceToBlob(src, layer.width, layer.height);
    }
    const canvas = document.createElement('canvas');
    canvas.width = doc.width;
    canvas.height = doc.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const item = doc.layers[i];
      if (!item.visible) continue;
      const img = this.draft.rasters.get(item.id);
      if (!img) continue;
      const src = this.layerPreviewSource(item, img);
      ctx.globalAlpha = Math.max(0, Math.min(1, item.opacity ?? 1));
      ctx.drawImage(src, item.offset_x, item.offset_y, item.width, item.height);
    }
    ctx.globalAlpha = 1;
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  }

  canRaise(): boolean {
    const doc = this.document();
    const id = doc?.selected_layer_id;
    if (!doc || !id) return false;
    return doc.layers[0]?.id !== id;
  }

  canLower(): boolean {
    const doc = this.document();
    const id = doc?.selected_layer_id;
    if (!doc || !id || !doc.layers.length) return false;
    return doc.layers[doc.layers.length - 1]?.id !== id;
  }

  layerOpacityPct(layer: PhotoMagicLayer): number {
    return Math.round(Math.max(0, Math.min(1, layer.opacity ?? 1)) * 100);
  }

  layerMaskThumb(layer: PhotoMagicLayer): string {
    const img = this.draft.masks.get(layer.id);
    if (img instanceof HTMLImageElement && img.src) return img.src;
    const cached = this.thumbCache.get(`mask:${layer.id}`);
    if (cached) return cached;
    if (img instanceof HTMLCanvasElement) {
      const url = img.toDataURL('image/png');
      this.thumbCache.set(`mask:${layer.id}`, url);
      return url;
    }
    const doc = this.document();
    if (!doc || !layer.has_mask) return '';
    return this.api.photoMagicLayerMaskUrl(doc.id, layer.id, this.scopeRef(), doc.updated_at || null);
  }

  layerThumb(layer: PhotoMagicLayer): string {
    const img = this.draft.rasters.get(layer.id);
    if (img instanceof HTMLImageElement && img.src) return img.src;
    const cached = this.thumbCache.get(layer.id);
    if (cached) return cached;
    if (img instanceof HTMLCanvasElement) {
      const url = img.toDataURL('image/png');
      this.thumbCache.set(layer.id, url);
      return url;
    }
    const doc = this.document();
    if (!doc) return '';
    return this.api.photoMagicLayerRasterUrl(doc.id, layer.id, this.scopeRef(), doc.updated_at || null);
  }

  async setScope(scope: PhotoMagicScope): Promise<void> {
    if (scope === this.scope()) return;
    await this.persistDraftNow();
    if (scope !== 'global' && !this.api.currentProject()) {
      this.browser.open();
      return;
    }
    this.scope.set(scope);
    this.clearWorking();
    await this.syncQuery();
    await this.reloadList();
  }

  async setPostId(postId: string): Promise<void> {
    await this.persistDraftNow();
    this.postId.set(postId);
    this.clearWorking();
    await this.syncQuery();
    if (postId) await this.reloadList();
    else this.documents.set([]);
  }

  async openDocument(id: string): Promise<void> {
    if (this.document()?.id === id && !this.applyingQuery) return;
    await this.persistDraftNow();
    const opened = await this.api.getPhotoMagicDocument(id, this.scopeRef());
    if (!opened) return;
    await this.adoptOpened(opened);
    await this.syncQuery({ docId: id });
  }

  async createDocument(): Promise<void> {
    const ref = this.scopeRef();
    if (!this.canUseScope(ref)) return;
    await this.persistDraftNow();
    const preset = SIZE_PRESETS.find((s) => s.id === this.newSizeId) || SIZE_PRESETS[0];
    const sourceId = this.newSourceAssetId.trim();
    this.busy.set(true);
    try {
      const opened = sourceId
        ? await this.createFromAsset(sourceId)
        : await this.api.createPhotoMagicDocument({
            scope: ref.scope,
            project_id: ref.projectId,
            post_id: ref.postId,
            name: this.newName.trim() || 'Untitled',
            width: preset.width,
            height: preset.height,
          });
      if (!opened) return;
      await this.adoptOpened(opened);
      this.showNew.set(false);
      this.newName = '';
      this.newSourceAssetId = '';
      await this.reloadList();
      await this.syncQuery({ docId: this.document()?.id || null });
    } finally {
      this.busy.set(false);
    }
  }

  renameDocument(name: string): void {
    const cleaned = name.trim();
    const doc = this.document();
    if (!doc || !cleaned || cleaned === doc.name) return;
    this.push({
      id: newLocalId(),
      label: `Rename composition to “${cleaned}”`,
      kind: 'rename_doc',
      name: cleaned,
    });
  }

  async deleteDocument(): Promise<void> {
    const doc = this.document();
    if (!doc) return;
    const ok = await this.dialogs.confirm({
      title: 'Delete composition',
      message: `Delete “${doc.name}”? The composition JSON and layers in this scope will be removed.`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    const deleted = await this.api.deletePhotoMagicDocument(doc.id, this.scopeRef());
    if (!deleted) return;
    this.clearWorking();
    await this.reloadList();
    await this.syncQuery({ docId: null });
  }

  async saveEdits(opts: { quiet?: boolean } = {}): Promise<void> {
    const doc = this.document();
    if (!doc || !this.draft.canSave) return;
    this.busy.set(true);
    try {
      const { rasters, masks, sources, sourceMasks } = await this.collectPersistBlobs(doc);
      const baseline = this.draft.baseline || doc;
      const saved = await this.api.savePhotoMagicDocument(doc.id, this.scopeRef(), doc, rasters, masks, {
        composition: {
          baseline,
          instructions: serializeInstructions(this.draft.instructions),
          cursor: this.draft.cursor,
        },
        sources,
        sourceMasks,
        quiet: opts.quiet,
      });
      if (!saved) return;
      this.document.set({ ...doc, ...saved.document, layers: doc.layers });
      this.draft.markPersisted();
      this.dirty.set(false);
      this.canSave.set(false);
      this.historyLabel.set(this.draft.currentInstruction()?.label || this.draft.stepLabel);
      await this.reloadList();
    } finally {
      this.busy.set(false);
    }
  }

  undo(): void {
    if (!this.draft.canUndo) return;
    this.publish(this.draft.undo());
  }

  redo(): void {
    if (!this.draft.canRedo) return;
    this.publish(this.draft.redo());
  }

  async addEmptyLayer(): Promise<void> {
    const doc = this.document();
    if (!doc) return;
    const layer = this.newLayer(doc, nextLayerName(doc.layers.map((l) => l.name)), doc.width, doc.height);
    const blank = await this.blankRaster(doc.width, doc.height);
    this.draft.setSource(layer.id, blank.image, blank.blob);
    this.push({
      id: newLocalId(),
      label: `Add layer “${layer.name}”`,
      kind: 'add_layer',
      layer,
      insertAboveId: doc.selected_layer_id || null,
    });
  }

  openAddFromAsset(): void {
    this.addAssetId = '';
    this.showAddAsset.set(true);
  }

  async addLayerFromAsset(): Promise<void> {
    const doc = this.document();
    const assetId = this.addAssetId.trim();
    if (!doc || !assetId) return;
    const asset = this.libraryImages().find((a) => a.id === assetId);
    if (!asset) return;
    this.busy.set(true);
    try {
      const url = this.api.assetOriginalUrl(asset, this.scope() === 'global');
      if (!url) {
        this.snackbar.show('Could not open that photo', 'error');
        return;
      }
      const loaded = await this.loadRaster(url);
      const layer = this.newLayer(
        doc,
        asset.name || nextLayerName(doc.layers.map((l) => l.name)),
        loaded.image.naturalWidth || doc.width,
        loaded.image.naturalHeight || doc.height,
        assetId,
      );
      this.draft.setSource(layer.id, loaded.image, loaded.blob);
      this.push({
        id: newLocalId(),
        label: `Add layer “${layer.name}”`,
        kind: 'add_layer',
        layer,
        insertAboveId: doc.selected_layer_id || null,
      });
      this.showAddAsset.set(false);
    } catch {
      this.snackbar.show('Could not load that photo as a layer', 'error');
    } finally {
      this.busy.set(false);
    }
  }

  async onLayerFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const doc = this.document();
    if (!file || !doc) return;
    try {
      const url = URL.createObjectURL(file);
      const image = await this.loadImage(url);
      const layer = this.newLayer(
        doc,
        file.name.replace(/\.[^.]+$/, '') || nextLayerName(doc.layers.map((l) => l.name)),
        image.naturalWidth || doc.width,
        image.naturalHeight || doc.height,
      );
      this.draft.setSource(layer.id, image, file);
      this.push({
        id: newLocalId(),
        label: `Add layer “${layer.name}”`,
        kind: 'add_layer',
        layer,
        insertAboveId: doc.selected_layer_id || null,
      });
    } catch {
      this.snackbar.show('Could not open that image file', 'error');
    }
  }

  selectLayer(layerId: string): void {
    const doc = this.document();
    if (!doc || doc.selected_layer_id === layerId) return;
    const layer = doc.layers.find((item) => item.id === layerId);
    if (!layer?.has_mask) this.editingMask.set(false);
    this.document.set({ ...doc, selected_layer_id: layerId });
    this.drawStage();
  }

  setLayerOpacity(layer: PhotoMagicLayer, value: string | number): void {
    const opacity = Math.max(0, Math.min(1, Number(value) / 100));
    if (Math.abs(opacity - (layer.opacity ?? 1)) < 0.005) return;
    this.push({
      id: newLocalId(),
      label: `Set opacity of “${layer.name}” to ${Math.round(opacity * 100)}%`,
      kind: 'patch_layer',
      layerId: layer.id,
      patch: { opacity },
    });
  }

  addLayerMask(fill: 'white' | 'black' | 'selection'): void {
    const layer = this.selectedLayer();
    if (!layer) return;
    const resolved = fill === 'selection' && !this.selection() ? 'white' : fill;
    this.push({
      id: newLocalId(),
      label:
        resolved === 'selection'
          ? `Add mask from selection on “${layer.name}”`
          : `Add ${resolved} mask on “${layer.name}”`,
      kind: 'add_layer_mask',
      layerId: layer.id,
      fill: resolved,
    });
    this.editingMask.set(true);
  }

  deleteLayerMask(): void {
    const layer = this.selectedLayer();
    if (!layer?.has_mask) return;
    this.editingMask.set(false);
    this.push({
      id: newLocalId(),
      label: `Delete mask on “${layer.name}”`,
      kind: 'delete_layer_mask',
      layerId: layer.id,
    });
  }

  invertLayerMask(): void {
    const layer = this.selectedLayer();
    if (!layer?.has_mask) return;
    this.push({
      id: newLocalId(),
      label: `Invert mask on “${layer.name}”`,
      kind: 'invert_layer_mask',
      layerId: layer.id,
    });
  }

  applyLayerMaskToPixels(): void {
    const layer = this.selectedLayer();
    if (!layer?.has_mask) return;
    this.editingMask.set(false);
    this.push({
      id: newLocalId(),
      label: `Apply mask on “${layer.name}”`,
      kind: 'apply_layer_mask',
      layerId: layer.id,
    });
  }

  toggleEditMask(layer: PhotoMagicLayer, event: Event): void {
    event.stopPropagation();
    this.selectLayer(layer.id);
    this.editingMask.set(!(this.editingMask() && this.document()?.selected_layer_id === layer.id));
    this.drawStage();
  }

  toggleMaskEnabled(layer: PhotoMagicLayer, event: Event): void {
    event.stopPropagation();
    if (!layer.has_mask) return;
    this.push({
      id: newLocalId(),
      label: layer.mask_enabled === false ? `Enable mask on “${layer.name}”` : `Disable mask on “${layer.name}”`,
      kind: 'patch_layer',
      layerId: layer.id,
      patch: { mask_enabled: layer.mask_enabled === false },
    });
  }

  private nudgeLayer(dx: number, dy: number): void {
    const layer = this.selectedLayer();
    if (!layer || layer.locked) return;
    this.push({
      id: newLocalId(),
      label: `Move “${layer.name}”`,
      kind: 'move_layer_pos',
      layerId: layer.id,
      offset_x: layer.offset_x + dx,
      offset_y: layer.offset_y + dy,
    });
  }

  toggleVisible(layer: PhotoMagicLayer, event: Event): void {
    event.stopPropagation();
    this.push({
      id: newLocalId(),
      label: layer.visible ? `Hide “${layer.name}”` : `Show “${layer.name}”`,
      kind: 'patch_layer',
      layerId: layer.id,
      patch: { visible: !layer.visible },
    });
  }

  toggleLocked(layer: PhotoMagicLayer, event: Event): void {
    event.stopPropagation();
    this.push({
      id: newLocalId(),
      label: layer.locked ? `Unlock “${layer.name}”` : `Lock “${layer.name}”`,
      kind: 'patch_layer',
      layerId: layer.id,
      patch: { locked: !layer.locked },
    });
  }

  renameLayer(layer: PhotoMagicLayer, name: string): void {
    const cleaned = name.trim();
    if (!cleaned || cleaned === layer.name) return;
    this.push({
      id: newLocalId(),
      label: `Rename layer to “${cleaned}”`,
      kind: 'patch_layer',
      layerId: layer.id,
      patch: { name: cleaned },
    });
  }

  async duplicateSelected(): Promise<void> {
    const doc = this.document();
    const layer = this.selectedLayer();
    if (!doc || !layer) return;
    const copy: PhotoMagicLayer = {
      ...layer,
      id: newLocalId(),
      name: duplicateLayerName(layer.name, doc.layers.map((l) => l.name)),
      locked: false,
    };
    this.push({
      id: newLocalId(),
      label: `Duplicate “${layer.name}”`,
      kind: 'duplicate_layer',
      layerId: layer.id,
      newLayer: copy,
    });
  }

  moveSelected(action: 'raise' | 'lower' | 'raise-to-top' | 'lower-to-bottom'): void {
    const layer = this.selectedLayer();
    if (!layer) return;
    const labels = {
      raise: `Raise “${layer.name}”`,
      lower: `Lower “${layer.name}”`,
      'raise-to-top': `Raise “${layer.name}” to top`,
      'lower-to-bottom': `Lower “${layer.name}” to bottom`,
    };
    this.push({
      id: newLocalId(),
      label: labels[action],
      kind: 'move_layer',
      layerId: layer.id,
      action,
    });
  }

  async deleteSelectedLayer(): Promise<void> {
    const layer = this.selectedLayer();
    if (!layer || layer.locked) return;
    const ok = await this.dialogs.confirm({
      title: 'Delete layer',
      message: `Delete layer “${layer.name}”? This stays unsaved until you click Save.`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    this.push({
      id: newLocalId(),
      label: `Delete layer “${layer.name}”`,
      kind: 'delete_layer',
      layerId: layer.id,
    });
  }

  onDragStart(event: DragEvent, layerId: string): void {
    this.dragLayerId = layerId;
    event.dataTransfer?.setData('text/plain', layerId);
  }

  onDragOver(event: DragEvent, _layerId: string): void {
    event.preventDefault();
  }

  onDrop(event: DragEvent, targetId: string): void {
    event.preventDefault();
    const doc = this.document();
    const fromId = this.dragLayerId || event.dataTransfer?.getData('text/plain') || '';
    this.dragLayerId = null;
    if (!doc || !fromId || fromId === targetId) return;
    const ids = doc.layers.map((l) => l.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const nextIds = [...ids];
    nextIds.splice(from, 1);
    nextIds.splice(to, 0, fromId);
    this.push({
      id: newLocalId(),
      label: 'Reorder layers',
      kind: 'reorder',
      layerIds: nextIds,
    });
  }

  clearSelection(): void {
    if (!this.selection()) return;
    this.push({ id: newLocalId(), label: 'Clear selection', kind: 'clear_selection' });
  }

  onPointerDown(event: PointerEvent): void {
    const tool = this.tool();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    if (tool === 'pointer') {
      const layer = this.selectedLayer();
      const docPt = this.eventToDocument(event);
      if (!layer || layer.locked || !docPt) return;
      this.gesture = {
        kind: 'move',
        start: docPt,
        current: docPt,
        originX: layer.offset_x,
        originY: layer.offset_y,
      };
      this.drawStage();
      return;
    }
    if (tool === 'text') {
      const docPt = this.eventToDocument(event);
      if (!docPt) return;
      this.pendingTextPoint = docPt;
      if (!this.textValue.trim()) this.textValue = 'Text';
      this.showText.set(true);
      return;
    }
    if (tool === 'crop') {
      const docPt = this.eventToDocument(event);
      if (!docPt) return;
      this.gesture = { kind: 'crop', start: docPt, current: docPt };
      this.drawStage();
      return;
    }
    const layer = this.selectedLayer();
    if (tool === 'scale' || tool === 'distort') {
      if (!layer || layer.locked) return;
      const docPt = this.eventToDocument(event);
      const layout = this.stageLayout();
      if (!docPt || !layout) return;
      const corners = layerDocCorners(layer.offset_x, layer.offset_y, layer.width, layer.height);
      const handle = hitHandle(docPt, corners, Math.max(8, 12 / layout.scale));
      if (handle < 0) return;
      if (tool === 'scale') {
        this.gesture = {
          kind: 'scale',
          handle,
          current: docPt,
          origin: {
            width: layer.width,
            height: layer.height,
            offset_x: layer.offset_x,
            offset_y: layer.offset_y,
          },
        };
      } else {
        this.gesture = { kind: 'distort', handle, corners: corners.map((p) => ({ ...p })) as [Point, Point, Point, Point] };
      }
      this.drawStage();
      return;
    }
    if (tool === 'brush' || tool === 'erase') {
      if (!layer || layer.locked) return;
      const pt = this.eventToLayer(event, layer);
      if (!pt) return;
      this.gesture = { kind: 'paint', points: [pt] };
      this.drawStage();
      return;
    }
    const pt = this.eventToLayer(event, layer);
    if (!layer || !pt) return;
    this.gesture = { kind: 'select', start: pt, current: pt, points: [pt] };
    this.drawStage();
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.gesture) return;
    if (this.gesture.kind === 'move') {
      const pt = this.eventToDocument(event);
      if (!pt) return;
      this.gesture.current = pt;
      this.drawStage();
      return;
    }
    if (this.gesture.kind === 'crop') {
      const pt = this.eventToDocument(event);
      if (!pt) return;
      this.gesture.current = pt;
      this.drawStage();
      return;
    }
    if (this.gesture.kind === 'scale' || this.gesture.kind === 'distort') {
      const pt = this.eventToDocument(event);
      if (!pt) return;
      if (this.gesture.kind === 'scale') this.gesture.current = pt;
      else this.gesture.corners[this.gesture.handle] = pt;
      this.drawStage();
      return;
    }
    const layer = this.selectedLayer();
    const pt = this.eventToLayer(event, layer);
    if (!pt) return;
    if (this.gesture.kind === 'paint') {
      this.gesture.points.push(pt);
    } else {
      this.gesture.current = pt;
      if (this.tool() === 'lasso') this.gesture.points.push(pt);
    }
    this.drawStage();
  }

  onPointerUp(event: PointerEvent): void {
    if (!this.gesture) return;
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture.kind === 'move') {
      const layer = this.selectedLayer();
      const pt = this.eventToDocument(event) || gesture.current;
      if (!layer) {
        this.drawStage();
        return;
      }
      const offset_x = Math.round(gesture.originX + (pt.x - gesture.start.x));
      const offset_y = Math.round(gesture.originY + (pt.y - gesture.start.y));
      if (offset_x === layer.offset_x && offset_y === layer.offset_y) {
        this.drawStage();
        return;
      }
      this.push({
        id: newLocalId(),
        label: `Move “${layer.name}”`,
        kind: 'move_layer_pos',
        layerId: layer.id,
        offset_x,
        offset_y,
      });
      return;
    }
    if (gesture.kind === 'crop') {
      const pt = this.eventToDocument(event) || gesture.current;
      const box = normalizeBox(gesture.start.x, gesture.start.y, pt.x, pt.y);
      const doc = this.document();
      if (!doc || box.width < 8 || box.height < 8) {
        this.drawStage();
        return;
      }
      const clamped = {
        x: Math.max(0, Math.min(doc.width - 8, box.x)),
        y: Math.max(0, Math.min(doc.height - 8, box.y)),
        width: Math.min(box.width, doc.width),
        height: Math.min(box.height, doc.height),
      };
      clamped.width = Math.min(clamped.width, doc.width - clamped.x);
      clamped.height = Math.min(clamped.height, doc.height - clamped.y);
      if (clamped.width < 8 || clamped.height < 8) {
        this.drawStage();
        return;
      }
      this.push({
        id: newLocalId(),
        label: `Crop to ${Math.round(clamped.width)}×${Math.round(clamped.height)}`,
        kind: 'crop_doc',
        box: clamped,
      });
      return;
    }
    if (gesture.kind === 'scale') {
      const layer = this.selectedLayer();
      if (!layer) {
        this.drawStage();
        return;
      }
      const next = this.scaleFromHandle(layer, gesture);
      if (next.width === layer.width && next.height === layer.height) {
        this.drawStage();
        return;
      }
      this.push({
        id: newLocalId(),
        label: `Scale “${layer.name}” to ${next.width}×${next.height}`,
        kind: 'scale_layer',
        layerId: layer.id,
        ...next,
      });
      return;
    }
    if (gesture.kind === 'distort') {
      const layer = this.selectedLayer();
      if (!layer) {
        this.drawStage();
        return;
      }
      const origin = layerDocCorners(layer.offset_x, layer.offset_y, layer.width, layer.height);
      const moved = gesture.corners.some(
        (p, i) => Math.hypot(p.x - origin[i].x, p.y - origin[i].y) > 1,
      );
      if (!moved) {
        this.drawStage();
        return;
      }
      const local = gesture.corners.map((p) => ({
        x: p.x - layer.offset_x,
        y: p.y - layer.offset_y,
      })) as [Point, Point, Point, Point];
      this.push({
        id: newLocalId(),
        label: `Distort “${layer.name}”`,
        kind: 'distort_layer',
        layerId: layer.id,
        corners: local,
      });
      return;
    }
    if (gesture.kind === 'paint') {
      const layer = this.selectedLayer();
      if (!layer || gesture.points.length < 1) {
        this.drawStage();
        return;
      }
      if (this.editingMask() && layer.has_mask) {
        if (this.tool() === 'erase') {
          this.push({
            id: newLocalId(),
            label: `Hide on mask “${layer.name}”`,
            kind: 'erase_mask',
            layerId: layer.id,
            points: gesture.points,
            size: this.eraseSize,
            hardness: this.eraseHardness,
          });
          return;
        }
        this.push({
          id: newLocalId(),
          label: `Reveal on mask “${layer.name}”`,
          kind: 'paint_mask',
          layerId: layer.id,
          points: gesture.points,
          size: this.brushSize,
          color: '#ffffff',
          hardness: this.brushHardness,
        });
        return;
      }
      if (this.tool() === 'erase') {
        this.push({
          id: newLocalId(),
          label: `Erase on “${layer.name}”`,
          kind: 'erase_stroke',
          layerId: layer.id,
          points: gesture.points,
          size: this.eraseSize,
          hardness: this.eraseHardness,
        });
        return;
      }
      this.push({
        id: newLocalId(),
        label: `Paint on “${layer.name}”`,
        kind: 'paint_stroke',
        layerId: layer.id,
        points: gesture.points,
        size: this.brushSize,
        color: this.brushColor,
        hardness: this.brushHardness,
      });
      return;
    }
    const layer = this.selectedLayer();
    if (!layer) {
      this.drawStage();
      return;
    }
    const pt = this.eventToLayer(event, layer) || gesture.current;
    if (this.tool() === 'box') {
      const box = normalizeBox(gesture.start.x, gesture.start.y, pt.x, pt.y);
      if (box.width < 1 || box.height < 1) {
        this.drawStage();
        return;
      }
      this.commitSelection({
        layerId: layer.id,
        tool: 'box',
        box,
        mask: boxMask(layer.width, layer.height, box),
        maskWidth: layer.width,
        maskHeight: layer.height,
      });
      return;
    }
    if (this.tool() === 'lasso') {
      const points = [...gesture.points, pt];
      if (points.length < 3) {
        this.drawStage();
        return;
      }
      const mask = lassoMask(layer.width, layer.height, points);
      if (!maskHasPixels(mask)) {
        this.drawStage();
        return;
      }
      this.commitSelection({
        layerId: layer.id,
        tool: 'lasso',
        points,
        mask,
        maskWidth: layer.width,
        maskHeight: layer.height,
      });
      return;
    }
    if (this.tool() === 'magic') {
      const raster = this.draft.rasters.get(layer.id);
      if (!raster) return;
      const image = imageDataFromImage(raster, layer.width, layer.height);
      const mask = magicMask(image, pt.x, pt.y, this.magicTolerance);
      if (!maskHasPixels(mask)) {
        this.drawStage();
        return;
      }
      this.commitSelection({
        layerId: layer.id,
        tool: 'magic',
        magic: { x: pt.x, y: pt.y, tolerance: this.magicTolerance },
        mask,
        maskWidth: layer.width,
        maskHeight: layer.height,
      });
    }
  }

  private commitSelection(selection: LayerSelection): void {
    const labels: Record<SelectTool, string> = {
      box: 'Box select',
      lasso: 'Lasso select',
      magic: 'Magic select',
    };
    this.push({
      id: newLocalId(),
      label: `${labels[selection.tool]} on layer`,
      kind: 'set_selection',
      selection,
    });
  }

  private push(instruction: PhotoMagicInstruction): void {
    this.publish(this.draft.push(instruction));
  }

  private publish(state: ReturnType<PhotoMagicDraft['working']>): void {
    if (!state) return;
    this.thumbCache.clear();
    this.document.set(state.doc);
    this.selection.set(state.selection);
    this.dirty.set(this.draft.dirty);
    this.canSave.set(this.draft.canSave);
    this.canUndo.set(this.draft.canUndo);
    this.canRedo.set(this.draft.canRedo);
    this.historyLabel.set(this.draft.currentInstruction()?.label || this.draft.stepLabel);
    this.drawStage();
    this.schedulePersist();
  }

  private clearWorking(): void {
    this.draft.reset(null);
    this.draft.clearRasters();
    this.thumbCache.clear();
    this.gesture = null;
    this.document.set(null);
    this.selection.set(null);
    this.dirty.set(false);
    this.canSave.set(false);
    this.canUndo.set(false);
    this.canRedo.set(false);
    this.historyLabel.set('No edits yet');
    this.editingMask.set(false);
  }

  private async adoptOpened(opened: PhotoMagicOpened): Promise<void> {
    const baseline = opened.composition.baseline || opened.document;
    this.draft.reset(baseline);
    this.draft.clearRasters();
    this.thumbCache.clear();
    this.gesture = null;
    this.editingMask.set(false);
    await this.loadBaselineSources(baseline, opened.document.id, opened.document.updated_at || null);
    this.draft.instructions = deserializeInstructions(opened.composition.instructions || []);
    await this.loadInstructionSources(
      opened.document.id,
      this.draft.instructions,
      opened.document.updated_at || null,
    );
    this.draft.cursor = Math.min(
      opened.composition.cursor,
      this.draft.instructions.length - 1,
    );
    this.draft.markPersisted();
    const state = this.draft.working();
    if (state) this.publish(state);
    else {
      this.document.set(opened.document);
      this.dirty.set(false);
      this.canSave.set(false);
      this.historyLabel.set(this.draft.stepLabel);
      this.drawStage();
    }
  }

  private async loadBaselineSources(
    baseline: PhotoMagicDocument,
    docId: string,
    cacheKey: string | null,
  ): Promise<void> {
    const ref = this.scopeRef();
    await Promise.all(
      baseline.layers.map(async (layer) => {
        const url = this.api.photoMagicLayerSourceUrl(docId, layer.id, ref, cacheKey);
        try {
          const loaded = await this.loadRaster(url);
          this.draft.setSource(layer.id, loaded.image, loaded.blob);
        } catch {
          /* preview can fall back to the baked raster URL */
        }
        if (!layer.has_mask) return;
        const maskUrl = this.api.photoMagicLayerSourceMaskUrl(docId, layer.id, ref, cacheKey);
        try {
          const loadedMask = await this.loadRaster(maskUrl);
          this.draft.setMaskSource(layer.id, loadedMask.image, loadedMask.blob);
        } catch {
          /* mask is optional */
        }
      }),
    );
  }

  private async loadInstructionSources(
    docId: string,
    instructions: PhotoMagicInstruction[],
    cacheKey: string | null,
  ): Promise<void> {
    const ref = this.scopeRef();
    const ids = new Set<string>();
    for (const instr of instructions) {
      if (instr.kind === 'add_layer' || instr.kind === 'add_text_layer') ids.add(instr.layer.id);
      if (instr.kind === 'duplicate_layer') ids.add(instr.newLayer.id);
      if (instr.kind === 'replace_layer_raster') ids.add(instr.id);
    }
    await Promise.all(
      [...ids].map(async (id) => {
        if (this.draft.sources.has(id)) return;
        const url = this.api.photoMagicLayerSourceUrl(docId, id, ref, cacheKey);
        try {
          const loaded = await this.loadRaster(url);
          this.draft.setSource(id, loaded.image, loaded.blob);
        } catch {
          /* optional for older compositions */
        }
      }),
    );
  }

  private schedulePersist(): void {
    /* Compositions persist to configured storage on Save or when leaving the editor. */
  }

  private async persistDraftNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.draft.canSave || !this.document()) return;
    await this.saveEdits({ quiet: true });
  }

  private async collectPersistBlobs(doc: PhotoMagicDocument): Promise<{
    rasters: Record<string, Blob>;
    masks: Record<string, Blob>;
    sources: Record<string, Blob>;
    sourceMasks: Record<string, Blob>;
  }> {
    const rasters: Record<string, Blob> = {};
    const masks: Record<string, Blob> = {};
    const sources: Record<string, Blob> = {};
    const sourceMasks: Record<string, Blob> = {};
    const baseline = this.draft.baseline;
    for (const layer of doc.layers) {
      const src = this.draft.rasters.get(layer.id);
      if (src) rasters[layer.id] = await sourceToBlob(src, layer.width, layer.height);
      else {
        const blob = this.draft.blobs.get(layer.id);
        if (blob) rasters[layer.id] = blob;
      }
      const mask = this.draft.masks.get(layer.id);
      if (mask) {
        masks[layer.id] = await sourceToBlob(mask, layer.width, layer.height);
        layer.has_mask = true;
      }
    }
    if (baseline) {
      for (const [layerId, src] of this.draft.sources) {
        const existing = this.draft.blobs.get(layerId);
        if (existing) {
          sources[layerId] = existing;
          continue;
        }
        const size = layerSizeForSource(baseline, this.draft.instructions, layerId);
        if (!size) continue;
        sources[layerId] = await sourceToBlob(src, size.width, size.height);
      }
      for (const [layerId, src] of this.draft.maskSources) {
        const existing = this.draft.maskBlobs.get(layerId);
        if (existing) {
          sourceMasks[layerId] = existing;
          continue;
        }
        const size = layerSizeForSource(baseline, this.draft.instructions, layerId);
        if (!size) continue;
        sourceMasks[layerId] = await sourceToBlob(src, size.width, size.height);
      }
    }
    return { rasters, masks, sources, sourceMasks };
  }

  private async createFromAsset(
    assetId: string,
    assetScope?: PhotoMagicAssetScope | null,
  ): Promise<PhotoMagicOpened | null> {
    const ref = this.scopeRef();
    const asset = this.libraryImages().find((a) => a.id === assetId);
    if (!asset) {
      this.snackbar.show('Could not open that photo', 'error');
      return null;
    }
    return this.api.createPhotoMagicDocument({
      scope: ref.scope,
      project_id: ref.projectId,
      post_id: ref.postId,
      name: asset.name || 'Photo',
      source_asset_id: assetId,
      source_asset_scope: assetScope || this.libraryAssetScope(),
    });
  }

  private newLayer(
    doc: PhotoMagicDocument,
    name: string,
    width: number,
    height: number,
    sourceAssetId?: string,
  ): PhotoMagicLayer {
    return {
      id: newLocalId(),
      name,
      visible: true,
      opacity: 1,
      locked: false,
      offset_x: 0,
      offset_y: 0,
      width,
      height,
      has_mask: false,
      mask_enabled: true,
      source_asset_id: sourceAssetId || null,
    };
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
  }

  private async loadRaster(url: string): Promise<{ image: HTMLImageElement; blob: Blob }> {
    const image = await this.loadImage(url);
    const res = await fetch(url);
    const blob = await res.blob();
    return { image, blob };
  }

  private async blankRaster(
    width: number,
    height: number,
  ): Promise<{ image: HTMLImageElement; blob: Blob }> {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('blob'))), 'image/png');
    });
    const image = await this.loadImage(URL.createObjectURL(blob));
    return { image, blob };
  }

  private eventToDocument(event: PointerEvent): Point | null {
    const layout = this.stageLayout();
    if (!layout) return null;
    return {
      x: (event.clientX - layout.rect.left - layout.offsetX) / layout.scale,
      y: (event.clientY - layout.rect.top - layout.offsetY) / layout.scale,
    };
  }

  private eventToLayer(event: PointerEvent, layer: PhotoMagicLayer | null): Point | null {
    const docPt = this.eventToDocument(event);
    if (!docPt || !layer) return null;
    return { x: docPt.x - layer.offset_x, y: docPt.y - layer.offset_y };
  }

  private currentTextStyle(): TextStyle {
    const font = FONT_PRESETS.find((item) => item.id === this.textFontId) || FONT_PRESETS[0];
    return {
      text: this.textValue.trim() || 'Text',
      fontSize: this.textSize,
      color: this.textColor,
      fontFamily: font.family,
    };
  }

  cancelText(): void {
    this.showText.set(false);
    this.pendingTextPoint = null;
  }

  commitText(): void {
    const doc = this.document();
    const point = this.pendingTextPoint;
    const style = this.currentTextStyle();
    if (!doc || !point) {
      this.cancelText();
      return;
    }
    const metrics = measureTextBlock(style);
    const snippet = style.text.replace(/\s+/g, ' ').slice(0, 24);
    const layer = this.newLayer(doc, snippet || 'Text', metrics.width, metrics.height);
    layer.offset_x = Math.round(point.x);
    layer.offset_y = Math.round(point.y);
    this.showText.set(false);
    this.pendingTextPoint = null;
    this.push({
      id: newLocalId(),
      label: `Add text “${snippet}”`,
      kind: 'add_text_layer',
      layer,
      insertAboveId: doc.selected_layer_id || null,
      style,
    });
  }

  private scaleFromHandle(
    layer: PhotoMagicLayer,
    gesture: Extract<EditorGesture, { kind: 'scale' }>,
  ): { width: number; height: number; offset_x: number; offset_y: number } {
    const originCorners = layerDocCorners(
      gesture.origin.offset_x,
      gesture.origin.offset_y,
      gesture.origin.width,
      gesture.origin.height,
    );
    const fixed = originCorners[oppositeCorner(gesture.handle)];
    const width = Math.max(8, Math.round(Math.abs(gesture.current.x - fixed.x)));
    const height = Math.max(8, Math.round(Math.abs(gesture.current.y - fixed.y)));
    return {
      width,
      height,
      offset_x: Math.round(Math.min(gesture.current.x, fixed.x)),
      offset_y: Math.round(Math.min(gesture.current.y, fixed.y)),
    };
  }

  private stageLayout(): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    rect: DOMRect;
    scale: number;
    offsetX: number;
    offsetY: number;
    dpr: number;
  } | null {
    const canvas = this.stageRef?.nativeElement;
    const wrap = this.stageWrapRef?.nativeElement;
    const doc = this.document();
    if (!canvas || !wrap || !doc) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const fit = Math.min(cssW / doc.width, cssH / doc.height);
    const drawW = doc.width * fit;
    const drawH = doc.height * fit;
    return {
      canvas,
      ctx,
      rect,
      scale: fit,
      offsetX: (cssW - drawW) / 2,
      offsetY: (cssH - drawH) / 2,
      dpr,
    };
  }

  private drawStage(): void {
    const layout = this.stageLayout();
    const doc = this.document();
    if (!layout || !doc) return;
    const { canvas, ctx, scale, offsetX, offsetY, dpr } = layout;
    const cssW = layout.rect.width;
    const cssH = layout.rect.height;
    const pixelW = Math.max(1, Math.round(cssW * dpr));
    const pixelH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    this.drawChecker(ctx, doc.width, doc.height);
    const scalePreview =
      this.gesture?.kind === 'scale' && this.selectedLayer()
        ? this.scaleFromHandle(this.selectedLayer()!, this.gesture)
        : null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, doc.width, doc.height);
    ctx.clip();
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      if (!layer.visible) continue;
      const img = this.draft.rasters.get(layer.id);
      if (!img) continue;
      const pos = this.liveLayerOffset(layer);
      const src = this.layerPreviewSource(layer, img);
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1));
      if (scalePreview && layer.id === doc.selected_layer_id) {
        ctx.drawImage(src, scalePreview.offset_x, scalePreview.offset_y, scalePreview.width, scalePreview.height);
      } else {
        ctx.drawImage(src, pos.x, pos.y, layer.width, layer.height);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    this.drawSelection(ctx);
    this.drawGesture(ctx);
    this.drawTransformHandles(ctx, scalePreview);
    this.drawLayerBounds(ctx);
    ctx.restore();
  }

  private liveLayerOffset(layer: PhotoMagicLayer): { x: number; y: number } {
    if (this.gesture?.kind === 'move' && this.document()?.selected_layer_id === layer.id) {
      return {
        x: Math.round(this.gesture.originX + (this.gesture.current.x - this.gesture.start.x)),
        y: Math.round(this.gesture.originY + (this.gesture.current.y - this.gesture.start.y)),
      };
    }
    return { x: layer.offset_x, y: layer.offset_y };
  }

  private layerPreviewSource(layer: PhotoMagicLayer, img: CanvasImageSource): CanvasImageSource {
    let mask = this.draft.masks.get(layer.id);
    if (
      this.editingMask() &&
      this.gesture?.kind === 'paint' &&
      layer.id === this.document()?.selected_layer_id &&
      mask
    ) {
      mask =
        this.tool() === 'erase'
          ? paintStroke(
              mask,
              layer.width,
              layer.height,
              this.gesture.points,
              this.eraseSize,
              '#000000',
              this.eraseHardness,
            )
          : paintStroke(
              mask,
              layer.width,
              layer.height,
              this.gesture.points,
              this.brushSize,
              '#ffffff',
              this.brushHardness,
            );
    }
    if (mask && layer.has_mask && layer.mask_enabled !== false) {
      img = applyLayerMask(img, mask, layer.width, layer.height);
    }
    if (
      !this.editingMask() &&
      this.tool() === 'erase' &&
      this.gesture?.kind === 'paint' &&
      layer.id === this.document()?.selected_layer_id
    ) {
      const sel = this.selection();
      const clip =
        sel?.layerId === layer.id && sel.maskWidth === layer.width && sel.maskHeight === layer.height
          ? sel.mask
          : null;
      return eraseStroke(img, layer.width, layer.height, this.gesture.points, this.eraseSize, this.eraseHardness, clip);
    }
    return img;
  }

  private drawLayerBounds(ctx: CanvasRenderingContext2D): void {
    const layer = this.selectedLayer();
    if (!layer || (this.tool() !== 'pointer' && this.gesture?.kind !== 'move')) return;
    const pos = this.liveLayerOffset(layer);
    ctx.save();
    ctx.strokeStyle = '#5d96ea';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(pos.x + 0.5, pos.y + 0.5, layer.width, layer.height);
    ctx.restore();
  }

  private drawChecker(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const size = 16;
    ctx.fillStyle = '#6b6b6b';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#8a8a8a';
    for (let y = 0; y < height; y += size) {
      for (let x = 0; x < width; x += size) {
        if (((x + y) / size) % 2 < 1) ctx.fillRect(x, y, size, size);
      }
    }
  }

  private drawSelection(ctx: CanvasRenderingContext2D): void {
    const selection = this.selection();
    const doc = this.document();
    if (!selection || !doc) return;
    const layer = doc.layers.find((l) => l.id === selection.layerId);
    const ox = layer?.offset_x || 0;
    const oy = layer?.offset_y || 0;
    ctx.save();
    ctx.translate(ox, oy);
    if (selection.tool === 'box' && selection.box) {
      this.strokeAnts(ctx, () => {
        ctx.strokeRect(selection.box!.x + 0.5, selection.box!.y + 0.5, selection.box!.width, selection.box!.height);
      });
    } else if (selection.tool === 'lasso' && selection.points && selection.points.length > 1) {
      this.strokeAnts(ctx, () => {
        ctx.beginPath();
        ctx.moveTo(selection.points![0].x, selection.points![0].y);
        for (const p of selection.points!.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.stroke();
      });
    } else {
      this.drawMaskOverlay(ctx, selection);
    }
    ctx.restore();
  }

  private drawGesture(ctx: CanvasRenderingContext2D): void {
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === 'crop') {
      const box = normalizeBox(gesture.start.x, gesture.start.y, gesture.current.x, gesture.current.y);
      const doc = this.document();
      if (doc) {
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, 0, doc.width, box.y);
        ctx.fillRect(0, box.y, box.x, box.height);
        ctx.fillRect(box.x + box.width, box.y, Math.max(0, doc.width - box.x - box.width), box.height);
        ctx.fillRect(0, box.y + box.height, doc.width, Math.max(0, doc.height - box.y - box.height));
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = '#5d96ea';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.restore();
      return;
    }
    if (gesture.kind === 'paint') {
      if (this.tool() === 'erase' || this.editingMask()) return;
      const layer = this.selectedLayer();
      if (!layer || gesture.points.length < 1) return;
      ctx.save();
      ctx.translate(layer.offset_x, layer.offset_y);
      ctx.strokeStyle = this.brushColor;
      ctx.lineWidth = this.brushSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(gesture.points[0].x, gesture.points[0].y);
      for (const p of gesture.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (gesture.kind === 'distort') {
      ctx.save();
      ctx.strokeStyle = '#5d96ea';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(gesture.corners[0].x, gesture.corners[0].y);
      for (const p of gesture.corners.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (gesture.kind !== 'select') return;
    const layer = this.selectedLayer();
    if (!layer) return;
    ctx.save();
    ctx.translate(layer.offset_x, layer.offset_y);
    ctx.strokeStyle = '#5d96ea';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    if (this.tool() === 'box') {
      const box = normalizeBox(gesture.start.x, gesture.start.y, gesture.current.x, gesture.current.y);
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    } else if (this.tool() === 'lasso' && gesture.points.length) {
      ctx.beginPath();
      ctx.moveTo(gesture.points[0].x, gesture.points[0].y);
      for (const p of gesture.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.lineTo(gesture.current.x, gesture.current.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTransformHandles(
    ctx: CanvasRenderingContext2D,
    scalePreview: { width: number; height: number; offset_x: number; offset_y: number } | null,
  ): void {
    const tool = this.tool();
    if (tool !== 'scale' && tool !== 'distort') return;
    const layer = this.selectedLayer();
    if (!layer) return;
    const corners =
      tool === 'distort' && this.gesture?.kind === 'distort'
        ? this.gesture.corners
        : scalePreview
          ? layerDocCorners(scalePreview.offset_x, scalePreview.offset_y, scalePreview.width, scalePreview.height)
          : layerDocCorners(layer.offset_x, layer.offset_y, layer.width, layer.height);
    ctx.save();
    ctx.strokeStyle = '#5d96ea';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (const p of corners.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    const size = 8;
    for (const corner of corners) {
      ctx.fillRect(corner.x - size / 2, corner.y - size / 2, size, size);
      ctx.strokeRect(corner.x - size / 2, corner.y - size / 2, size, size);
    }
    ctx.restore();
  }

  private drawMaskOverlay(ctx: CanvasRenderingContext2D, selection: LayerSelection): void {
    const { mask, maskWidth, maskHeight } = selection;
    const image = ctx.createImageData(maskWidth, maskHeight);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const p = i * 4;
      image.data[p] = 93;
      image.data[p + 1] = 150;
      image.data[p + 2] = 234;
      image.data[p + 3] = 90;
    }
    const tmp = document.createElement('canvas');
    tmp.width = maskWidth;
    tmp.height = maskHeight;
    tmp.getContext('2d')?.putImageData(image, 0, 0);
    ctx.drawImage(tmp, 0, 0);
    this.strokeAnts(ctx, () => {
      ctx.strokeRect(0.5, 0.5, maskWidth - 1, maskHeight - 1);
    });
  }

  private strokeAnts(ctx: CanvasRenderingContext2D, path: () => void): void {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -this.ants;
    ctx.strokeStyle = '#fff';
    path();
    ctx.lineDashOffset = 4 - this.ants;
    ctx.strokeStyle = '#111';
    path();
    ctx.restore();
  }

  private libraryAssetScope(): PhotoMagicAssetScope {
    return this.scope() === 'global' ? 'global' : 'project';
  }

  private canUseScope(ref: PhotoMagicScopeRef, notify = true): boolean {
    if (ref.scope === 'global') return true;
    if (!ref.projectId) {
      if (notify) this.snackbar.show('Select a project first', 'error');
      return false;
    }
    if (ref.scope === 'post' && !ref.postId) {
      if (notify) this.snackbar.show('Select a post first', 'error');
      return false;
    }
    return true;
  }

  private async reloadList(): Promise<void> {
    const ref = this.scopeRef();
    if (!this.canUseScope(ref, false)) {
      this.documents.set([]);
      return;
    }
    const items = await this.api.listPhotoMagicDocuments(ref);
    items.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    this.documents.set(items);
  }

  private async applyQuery(
    scope: PhotoMagicScope | null,
    projectId: string | null,
    postId: string | null,
    assetId: string | null,
    assetScope: PhotoMagicAssetScope | null,
    docId: string | null,
  ): Promise<void> {
    if (this.applyingQuery) return;
    this.applyingQuery = true;
    try {
      await this.persistDraftNow();
      const nextScope: PhotoMagicScope =
        scope === 'project' || scope === 'post' || scope === 'global'
          ? scope
          : this.api.currentProject()
            ? 'project'
            : 'global';
      if (nextScope !== 'global' && projectId && this.api.currentProject()?.id !== projectId) {
        await this.api.selectProject(projectId);
      }
      this.scope.set(nextScope);
      this.postId.set(nextScope === 'post' ? postId || '' : '');
      if (!this.canUseScope(this.scopeRef(), false)) {
        this.documents.set([]);
        this.clearWorking();
        return;
      }
      await this.reloadList();
      if (docId) {
        const current = this.document();
        if (current?.id === docId) return;
        const opened = await this.api.getPhotoMagicDocument(docId, this.scopeRef());
        if (opened) await this.adoptOpened(opened);
        return;
      }
      if (assetId) {
        if (nextScope === 'global') await this.api.loadGlobalAssets();
        else await this.api.refreshCurrentProject();
        const existing = this.documents().find((d) => d.source_asset_id === assetId);
        if (existing) {
          const opened = await this.api.getPhotoMagicDocument(existing.id, this.scopeRef());
          if (opened) {
            await this.adoptOpened(opened);
            await this.syncQuery({ docId: existing.id, assetId: null });
          }
          return;
        }
        const opened = await this.createFromAsset(assetId, assetScope);
        if (opened) {
          await this.adoptOpened(opened);
          await this.reloadList();
          await this.syncQuery({ docId: this.document()?.id || null, assetId: null });
        }
      }
    } finally {
      this.applyingQuery = false;
    }
  }

  private async syncQuery(extra?: { docId?: string | null; assetId?: string | null }): Promise<void> {
    const ref = this.scopeRef();
    const queryParams: Record<string, string | null> = {
      scope: ref.scope,
      projectId: ref.projectId || null,
      postId: ref.postId || null,
      docId: extra && 'docId' in extra ? extra.docId || null : this.document()?.id || null,
      assetId: extra && 'assetId' in extra ? extra.assetId || null : null,
    };
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
