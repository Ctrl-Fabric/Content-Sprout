import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  QueryList,
  SimpleChanges,
  ViewChild,
  ViewChildren,
  computed,
  effect,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SnackbarService, ModalWrapperComponent, DialogService } from 'shared/ui';
import { ContentSproutApiService } from '../../services/content-sprout-api.service';
import { MediaThumbTileComponent } from '../../shared/media-thumb-tile';
import { AssetInspectComponent } from '../../shared/asset-inspect';
import { AssetPreviewPaneComponent } from '../../shared/asset-preview-pane';
import { formatMediaDuration } from '../../shared/media-duration';
import {
  AttachAudioDialogComponent,
  type AttachAudioResult,
} from '../../shared/attach-audio-dialog';
import {
  assetTypeIcon,
  assetTypeLabel,
  isAudioAsset,
  isImageAsset,
  isVideoAsset,
  type Asset,
  type Layer,
  type LayerMask,
  type Post,
  type Scene,
} from '../../models/content-sprout.models';
import {
  appendCueToScriptForTimelineScene,
  buildScenesFromScript,
  computePostDuration,
  formatClock,
  formatScriptCueTag,
  formatScriptDurationLabel,
  formatTypedVisualDetail,
  getSceneTimeline,
  isLayerEnabled,
  isSceneEnabled,
  isCreativeSceneLayer,
  mergeScenesPreservingCreative,
  newUid,
  normalizeVisualMediaType,
  scenesAreEmptyScaffold,
  scenesAreScriptScaffold,
  visualMediaTypeSupportsDuration,
  type VisualMediaTypeId,
} from '../../shared/script-scenes';
import {
  canvasAspectRatio,
  centeredLayerBox,
  clampLayerBox,
  clampLayerStartInScene,
  clampMaskRect,
  containedMediaBox,
  containedMediaFrame,
  ensureSceneFitsLayer,
  fitLayerInScene,
  ganttBarInScene,
  sceneVideoLayers,
  trimSceneToOccupancy,
  ganttTicks,
  sceneLayerOccupancy,
  layerBoxFromMediaAspect,
  layerBoxMatchesMedia,
  layerEffectiveDuration,
  layerOpacityAt,
  layerPlaybackRate,
  layerStartOutsideScene,
  maskActiveAt,
  maskEffectiveDuration,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  normalizeHexColor,
  normalizeOptionalHexColor,
  normalizePlaybackRate,
  remapMasksToBox,
  isTransparentBg,
  transparencyMaskCss,
} from '../../shared/composer-time';
import { exportCanvasSize, postRuntimeSeconds } from '../../shared/post-format';
import {
  ICON_SETS,
  filterIcons,
  iconAssetId,
  lucideSvgUrl,
  parseIconAssetId,
  type IconSetId,
} from '../../shared/icon-catalog';

type PaletteAsset = Asset & {
  is_global?: boolean;
  icon_set?: IconSetId | string;
  icon_name?: string;
};
type PickerFilter = 'all' | 'image' | 'video' | 'audio' | 'icon' | 'reusable';

interface PreviewClip {
  id: string;
  kind: 'video' | 'image' | 'audio' | 'text' | 'icon';
  url: string | null;
  text: string;
  iconSet?: string;
  iconName?: string;
  color?: string;
  /** Solid CSS fill (nested scene/post background). Painted behind media in the layer box. */
  fill?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  z: number;
  mediaTime: number;
  /** HTML5 video.playbackRate (0.5–20). Default 1. */
  playbackRate?: number;
  volume: number;
  muteAudio: boolean;
  active: boolean;
  sceneId: string | null;
  masks: LayerMask[];
  layerLocalT: number;
  layerDur: number;
  isBackground: boolean;
  locked?: boolean;
  /** Display aspect (width/height) of the image/video pixels. */
  mediaAspect?: number;
  /** Still frame shown while the video element loads. */
  poster?: string | null;
}

/**
 * Preview stacking matches the timeline: the scene plate (with or without a
 * background color/asset) is always the bottom-most layer. Other scene layers
 * (including reusable clips) stack by z_index / list position above it.
 *
 * Do not paint the host fill as CSS `background` on `.cs-tl-stage`, and do not
 * wrap `<video>` in a CSS `transform` / `isolation` stacking context — browsers
 * often composite the video as a transparent hole, leaving only the fill visible.
 */
const PREVIEW_STAGE_FILL_Z = 0;
const PREVIEW_STAGE_BG_Z = 1;
const PREVIEW_LAYER_Z0 = 10;
const PREVIEW_Z_BAND = 100;

interface GanttBar {
  id: string;
  kind: 'scene' | 'layer' | 'mask';
  sceneId: string;
  layerId?: string;
  maskId?: string;
  label: string;
  css: string;
  leftPct: number;
  widthPct: number;
  canMask: boolean;
  muteAudio?: boolean;
  fadeIn?: boolean;
  fadeOut?: boolean;
  locked?: boolean;
}

interface VideoCtxMenu {
  open: boolean;
  x: number;
  y: number;
  sceneId: string;
  layerId: string;
  splitHereLocal: number | null;
  splitPlayheadLocal: number | null;
  muteAudio: boolean;
  fadeIn: boolean;
  fadeOut: boolean;
}

interface SceneCtxMenu {
  open: boolean;
  x: number;
  y: number;
  sceneId: string;
  canTrimContent: boolean;
  canTrimPlayhead: boolean;
  canFitVideo: boolean;
  playheadLocal: number | null;
}

interface GanttLayerRow {
  key: string;
  kind: 'scene_header' | 'layer' | 'mask';
  label: string;
  icon: string;
  sceneId: string;
  layerId: string;
  maskId?: string;
  enabled: boolean;
  bar: GanttBar | null;
}

interface GanttSceneGroup {
  sceneId: string;
  sceneRow: GanttLayerRow;
  layers: GanttLayerRow[];
  enabled: boolean;
  locked: boolean;
}

type DragHandle = 'move' | 'left' | 'right';
type CornerHandle = 'nw' | 'ne' | 'sw' | 'se';

interface GanttDrag {
  kind: 'scene' | 'layer' | 'mask';
  handle: DragHandle;
  sceneId: string;
  layerId?: string;
  maskId?: string;
  origStart: number;
  origDuration: number;
  origSourceStart: number;
  origPlaybackRate?: number;
  /** Absolute timeline start of the layer when the drag began. */
  origAbsStart?: number;
  /** pointerAbs - origAbsStart at mousedown; 0 when the clip started off the timeline. */
  grabOffset?: number;
  ganttInner?: HTMLElement | null;
  origGap?: number;
  origLayerStarts?: { id: string; start_s: number }[];
  firstLayerStart?: number;
  lastLayerEnd?: number;
  startX: number;
  trackWidth: number;
  total: number;
  moved: boolean;
  /** Absolute time under the pointer at down — used for click-to-seek when not dragged. */
  pendingSeek: number | null;
}

interface StageDrag {
  mode: 'move' | 'resize' | 'mask-move' | 'mask-resize' | 'mask-draw';
  handle?: CornerHandle;
  layerId: string;
  sceneId: string | null;
  maskId?: string;
  startX: number;
  startY: number;
  orig: { x: number; y: number; width: number; height: number };
  /** Full layer box before a visual (contain-fitted) resize. */
  layerBox?: { x: number; y: number; width: number; height: number };
  /** When resizing layers, keep aspect unless Shift was held at pointer-down. */
  lockAspect?: boolean;
}

@Component({
  selector: 'app-timeline-workspace',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MediaThumbTileComponent,
    AssetInspectComponent,
    AssetPreviewPaneComponent,
    ModalWrapperComponent,
    AttachAudioDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div
      class="cs-tl"
      [class.is-image]="!isVideo()"
      [class.has-props]="!!selectedLayer()"
      [class.has-drawer]="showAssetsDrawer()"
    >
      <div #audioBus class="cs-tl-audio-bus" aria-hidden="true"></div>
      <section class="cs-tl-main">
        <div class="cs-tl-toolbar">
          <h3 class="cs-tl-title">{{ isVideo() ? 'Video composer · Scene timeline' : 'Image composer' }}</h3>
          <div class="cs-tl-toolbar-actions">
            <button
              type="button"
              [class.active]="showAssetsDrawer()"
              (click)="toggleAssetsDrawer()"
              [disabled]="busy()"
              title="Browse, preview, and add assets to the timeline"
            >
              + Asset
            </button>
            <button
              type="button"
              (click)="addTextLayer()"
              [disabled]="busy() || isRefScene(activeScene())"
              [title]="isRefScene(activeScene()) ? 'Reusable clips are edited in their own post' : 'Add a text layer'"
            >
              + Text
            </button>
            @if (isVideo()) {
              <button
                type="button"
                (click)="addVoiceLayer()"
                [disabled]="busy() || isRefScene(activeScene())"
                [title]="isRefScene(activeScene()) ? 'Reusable clips are edited in their own post' : 'Add a voice layer'"
              >
                + Voice
              </button>
            }
          </div>
        </div>

        <div class="cs-tl-body">
        @if (isVideo()) {
            <div class="cs-gantt-head">
              <div class="cs-gantt-head-actions">
                <div class="cs-tl-scene-nav" role="group" aria-label="Scene navigation">
                  <button
                    type="button"
                    (click)="stepScene(-1)"
                    [disabled]="busy() || !canStepScene(-1)"
                    title="Previous scene"
                    aria-label="Previous scene"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
                  </button>
                  <span class="meta cs-tl-scene-nav-label" [title]="activeScene()?.name || 'Scene'">
                    {{ sceneNavLabel() }}
                  </span>
                  <button
                    type="button"
                    (click)="stepScene(1)"
                    [disabled]="busy() || !canStepScene(1)"
                    title="Next scene"
                    aria-label="Next scene"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
                  </button>
                </div>
                <label
                  class="cs-tl-dur-inline"
                  [title]="
                    isRefScene(activeScene())
                      ? 'Duration comes from the reusable post'
                      : 'Active scene duration (s)'
                  "
                >
                  Scene
                  <input
                    type="number"
                    min="0.5"
                    step="0.5"
                    [ngModel]="activeScene()?.duration_s"
                    (ngModelChange)="onActiveSceneDuration($event)"
                    [disabled]="busy() || isRefScene(activeScene())"
                  />
                  <span class="meta">s</span>
                </label>
                <label
                  class="cs-tl-bg cs-tl-bg--inline"
                  title="Active scene background color (default: transparent)"
                  [class.is-disabled]="isRefScene(activeScene())"
                  [class.is-transparent]="!hasActiveSceneBg()"
                >
                  Bg
                  <input
                    type="color"
                    [ngModel]="sceneBgPickerValue()"
                    (ngModelChange)="onActiveSceneBg($event)"
                    [disabled]="busy() || isRefScene(activeScene())"
                  />
                  @if (hasActiveSceneBg()) {
                    <button
                      type="button"
                      class="cs-tl-bg-clear"
                      title="Clear scene background (transparent)"
                      (click)="clearActiveSceneBg(); $event.preventDefault()"
                      [disabled]="busy() || isRefScene(activeScene())"
                    >
                      ×
                    </button>
                  }
                </label>
                <label class="cs-tl-bg cs-tl-bg--inline" title="Post background color fallback">
                  Post Bg
                  <input
                    type="color"
                    [ngModel]="hexBg(post.background_color)"
                    (ngModelChange)="onPostBgColor($event)"
                    [disabled]="busy()"
                  />
                </label>
                <span class="meta cs-tl-total">{{ totalDuration().toFixed(1) }}s total</span>
                @if (exportHint()) {
                  <span class="meta">Export ≈ {{ exportHint() }}</span>
                }
                <button
                  type="button"
                  class="primary"
                  (click)="regenerateFromScript()"
                  [disabled]="busy() || !hasActiveScript()"
                  title="Rebuild scenes from the active script’s SCENE markers (keeps matching creative layers)"
                >
                  Regenerate from script
                </button>
                <button type="button" (click)="addScene()" [disabled]="busy()">+ Scene</button>
                <button
                  type="button"
                  class="danger"
                  (click)="deleteActiveScene()"
                  [disabled]="busy() || !activeScene() || (post.scenes || []).length <= 1"
                  title="Delete the active scene completely (removes it from the timeline)"
                >
                  Delete scene
                </button>
                <div class="cs-tl-reuse-wrap">
                  <button
                    type="button"
                    (click)="toggleReusablePicker(); $event.stopPropagation()"
                    [disabled]="busy()"
                    [class.active]="showReusablePicker()"
                    title="Insert another video post marked as a reusable clip"
                  >
                    + Reusable
                  </button>
                  @if (showReusablePicker()) {
                    <div
                      class="cs-tl-reuse-menu"
                      role="menu"
                      aria-label="Reusable posts"
                      (pointerdown)="$event.stopPropagation()"
                    >
                      @for (clip of reusableCandidates(); track clip.id) {
                        <button
                          type="button"
                          role="menuitem"
                          draggable="true"
                          (dragstart)="onReusableDragStart($event, clip)"
                          (click)="insertReusable(clip)"
                        >
                          <span class="truncate">{{ clip.name || 'Reusable clip' }}</span>
                          <span class="meta">{{ formatDur(reusableDuration(clip)) }}</span>
                        </button>
                      } @empty {
                        <p class="cs-empty-inline">
                          Mark a video as “Reusable clip”, then insert it here.
                        </p>
                      }
                    </div>
                  }
                </div>
              </div>
            </div>

            <div class="cs-tl-playbar cs-tl-playbar--top" aria-label="Timeline playback">
              <button
                type="button"
                class="primary cs-tl-play"
                (click)="togglePlay()"
                [disabled]="!timeline().length"
                [title]="playing() ? 'Pause preview' : 'Play preview'"
              >
                <span class="material-symbols-outlined" aria-hidden="true">{{
                  playing() ? 'pause' : 'play_arrow'
                }}</span>
                {{ playing() ? 'Pause' : 'Play' }}
              </button>
              <span class="meta cs-tl-clock">{{ absTime().toFixed(1) }}s / {{ totalDuration().toFixed(1) }}s</span>
              <span class="meta">Preview playhead</span>
              <input
                type="range"
                min="0"
                [max]="scrubMax()"
                step="0.05"
                [ngModel]="absTime()"
                (ngModelChange)="onScrub($event)"
                [attr.aria-label]="'Timeline playhead'"
              />
            </div>

            <div class="cs-gantt" aria-label="Scene timeline">
              <div class="cs-gantt-labels">
                <div class="cs-gantt-label is-ruler">Time</div>
                @for (group of ganttSceneGroups(); track group.sceneId) {
                  <div
                    class="cs-gantt-scene-group"
                    [class.is-disabled]="!group.enabled"
                    [class.is-selected]="group.sceneId === selectedSceneId() && !selectedLayerId()"
                    [class.is-drop-target]="ganttDropSceneId() === group.sceneId"
                  >
                    <div
                      class="cs-gantt-label is-scene-header"
                      [class.is-selected]="group.sceneId === selectedSceneId() && !selectedLayerId()"
                      (click)="selectSceneLabel(group.sceneId)"
                      (contextmenu)="onSceneContextMenu($event, group.sceneId)"
                    >
                      <span
                        class="material-symbols-outlined cs-gantt-type-icon"
                        aria-hidden="true"
                        >{{ group.sceneRow.icon }}</span
                      >
                      <span class="cs-gantt-label-text truncate">{{ group.sceneRow.label }}</span>
                      <button
                        type="button"
                        class="cs-gantt-enable"
                        [class.is-off]="!group.enabled"
                        [title]="group.enabled ? 'Disable scene (skip in preview/export)' : 'Enable scene'"
                        (click)="toggleSceneEnabled(group.sceneId); $event.stopPropagation()"
                        [disabled]="busy()"
                      >
                        <span class="material-symbols-outlined" aria-hidden="true">{{
                          group.enabled ? 'visibility' : 'visibility_off'
                        }}</span>
                      </button>
                      @if (!group.locked) {
                        <button
                          type="button"
                          class="cs-gantt-add-layer"
                          title="Add layer to this scene"
                          aria-label="Add layer to this scene"
                          (click)="openAddLayerDialog(group.sceneId); $event.stopPropagation()"
                          [disabled]="busy() || !group.enabled"
                        >
                          <span class="material-symbols-outlined" aria-hidden="true">add</span>
                        </button>
                      }
                    </div>
                    @for (row of group.layers; track row.key) {
                      <div
                        class="cs-gantt-label is-in-scene"
                        [class.is-mask]="row.kind === 'mask'"
                        [class.is-disabled]="!row.enabled"
                        [class.is-selected]="
                          row.kind === 'mask'
                            ? selectedMaskId() === row.maskId
                            : selectedLayerId() === row.layerId && !selectedMaskId()
                        "
                        (click)="selectGanttLabelRow(row)"
                      >
                        @if (row.kind === 'layer' && row.layerId) {
                          <span class="cs-gantt-z">
                            <button
                              type="button"
                              title="Move forward (higher track / in front of scene)"
                              (click)="moveLayer(row.sceneId, row.layerId, 1); $event.stopPropagation()"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              title="Move back (closer to the scene plate)"
                              (click)="moveLayer(row.sceneId, row.layerId, -1); $event.stopPropagation()"
                            >
                              ↓
                            </button>
                          </span>
                        }
                        <span
                          class="material-symbols-outlined cs-gantt-type-icon"
                          [class.is-mask]="row.kind === 'mask'"
                          aria-hidden="true"
                          >{{ row.icon }}</span
                        >
                        <span class="cs-gantt-label-text truncate">
                          {{ row.label }}
                        </span>
                        @if (row.kind === 'layer' && row.layerId) {
                          <button
                            type="button"
                            class="cs-gantt-enable"
                            [class.is-off]="!row.enabled"
                            [title]="row.enabled ? 'Disable layer' : 'Enable layer'"
                            (click)="toggleLayerEnabled(row.sceneId, row.layerId); $event.stopPropagation()"
                            [disabled]="busy() || !group.enabled"
                          >
                            <span class="material-symbols-outlined" aria-hidden="true">{{
                              row.enabled ? 'visibility' : 'visibility_off'
                            }}</span>
                          </button>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
              <div
                class="cs-gantt-scroll"
                #ganttScroll
                (mousemove)="onGanttHoverMove($event)"
                (mouseleave)="clearGanttHover()"
              >
                <div
                  class="cs-gantt-inner"
                  [class.is-dragging]="!!ganttDragging()"
                  [class.is-asset-dragging]="ganttAssetDnd()"
                  [style.min-width.px]="ganttInnerPx()"
                  (dragover)="onGanttDragOver($event)"
                  (dragleave)="onGanttDragLeave($event)"
                  (drop)="onGanttDrop($event, 'layer')"
                >
                  @for (row of timeline(); track row.scene.id; let i = $index) {
                    <div
                      class="cs-gantt-scene-band"
                      [class.is-alt]="i % 2 === 1"
                      [style.left.%]="barLeft(row)"
                      [style.width.%]="barWidth(row)"
                      aria-hidden="true"
                    ></div>
                  }
                  @for (row of timeline(); track row.scene.id; let i = $index) {
                    @if (i > 0) {
                      <div
                        class="cs-gantt-scene-boundary"
                        [style.left.%]="barLeft(row)"
                        aria-hidden="true"
                      ></div>
                    }
                  }
                  @if (hoverTime() != null) {
                    <div
                      class="cs-gantt-hover"
                      [style.left.%]="hoverPct()"
                      aria-hidden="true"
                    >
                      <span class="cs-gantt-hover-label">{{ formatClock(hoverTime()!) }}</span>
                    </div>
                  }
                  <div class="cs-gantt-track is-ruler" (pointerdown)="onGanttTrackDown($event)">
                    @for (tick of ganttTickMarks(); track tick.t) {
                      <span class="cs-gantt-tick" [style.left.%]="tick.leftPct">{{ tick.label }}</span>
                    }
                    <div class="cs-gantt-playhead" [style.left.%]="playheadPct()" aria-hidden="true"></div>
                  </div>
                  @for (group of ganttSceneGroups(); track group.sceneId) {
                    <div
                      class="cs-gantt-scene-group"
                      [class.is-disabled]="!group.enabled"
                      [class.is-drop-target]="ganttDropSceneId() === group.sceneId"
                      [attr.data-scene-id]="group.sceneId"
                      (dragover)="onGanttDragOver($event)"
                      (dragleave)="onGanttDragLeave($event)"
                      (drop)="onGanttDrop($event, 'layer', group.sceneId)"
                    >
                      @let sceneBar = group.sceneRow.bar;
                      <div
                        class="cs-gantt-track is-scene-header"
                        [class.is-skipped]="!sceneBar"
                        data-gantt-track="scenes"
                        [attr.data-scene-id]="group.sceneId"
                        (dragover)="onGanttDragOver($event)"
                        (dragleave)="onGanttDragLeave($event)"
                        (drop)="onGanttDrop($event, 'scenes', group.sceneId)"
                        (pointerdown)="onGanttTrackDown($event)"
                      >
                        @if (sceneBar) {
                          <div
                            class="cs-gantt-bar is-scene"
                            [class.is-reusable-ref]="!!sceneBar.locked"
                            [class.is-selected]="group.sceneId === selectedSceneId()"
                            [style.left.%]="sceneBar.leftPct"
                            [style.width.%]="sceneBar.widthPct"
                            [title]="sceneBar.label + ' — right-click to trim'"
                            (pointerdown)="onGanttBarDown($event, sceneBar, 'move')"
                            (contextmenu)="onSceneContextMenu($event, group.sceneId)"
                          >
                            @if (!sceneBar.locked) {
                              <span
                                class="cs-gantt-handle left"
                                title="Resize scene start (not past the first layer)"
                                (pointerdown)="onGanttBarDown($event, sceneBar, 'left')"
                              ></span>
                            }
                            @if (sceneBar.locked) {
                              <span class="cs-gantt-badge is-reuse">clip</span>
                            }
                            <span class="cs-gantt-bar-label truncate">{{ sceneBar.label }}</span>
                            <button
                              type="button"
                              class="cs-gantt-del"
                              title="Delete scene"
                              (pointerdown)="$event.stopPropagation()"
                              (click)="deleteSceneById(group.sceneId); $event.stopPropagation()"
                            >
                              ×
                            </button>
                            @if (!sceneBar.locked) {
                              <span
                                class="cs-gantt-handle right"
                                title="Resize scene end (not before the last layer ends)"
                                (pointerdown)="onGanttBarDown($event, sceneBar, 'right')"
                              ></span>
                            }
                          </div>
                        } @else {
                          <span class="cs-gantt-skipped-hint">Skipped in preview / export</span>
                        }
                        <div class="cs-gantt-playhead" [style.left.%]="playheadPct()" aria-hidden="true"></div>
                      </div>
                      @for (row of group.layers; track row.key) {
                        <div
                          class="cs-gantt-track"
                          [class.is-skipped]="!row.bar"
                          data-gantt-track="layer"
                          [attr.data-scene-id]="row.sceneId"
                          (dragover)="onGanttDragOver($event)"
                          (dragleave)="onGanttDragLeave($event)"
                          (drop)="onGanttDrop($event, 'layer', row.sceneId)"
                          (pointerdown)="onGanttTrackDown($event)"
                        >
                          @if (row.bar; as bar) {
                            <div
                              class="cs-gantt-bar"
                              [ngClass]="bar.css"
                              [class.is-selected]="
                                row.kind === 'mask'
                                  ? selectedMaskId() === row.maskId
                                  : selectedLayerId() === row.layerId && !selectedMaskId()
                              "
                              [class.is-muted]="!!bar.muteAudio"
                              [style.left.%]="bar.leftPct"
                              [style.width.%]="bar.widthPct"
                              [title]="bar.label"
                              (pointerdown)="onGanttBarDown($event, bar, 'move')"
                              (contextmenu)="onVideoBarContextMenu($event, row)"
                            >
                              <span
                                class="cs-gantt-handle left"
                                (pointerdown)="onGanttBarDown($event, bar, 'left')"
                              ></span>
                              <span class="cs-gantt-bar-label truncate">{{ bar.label }}</span>
                              @if (bar.muteAudio) {
                                <span class="cs-gantt-badge is-mute" title="Audio removed">no-audio</span>
                              }
                              @if (bar.fadeIn) {
                                <span class="cs-gantt-badge is-fade" title="Fade in">FI</span>
                              }
                              @if (bar.fadeOut) {
                                <span class="cs-gantt-badge is-fade" title="Fade out">FO</span>
                              }
                              @if (bar.canMask) {
                                <button
                                  type="button"
                                  class="cs-gantt-mask-btn"
                                  title="Add transparency mask"
                                  (pointerdown)="$event.stopPropagation()"
                                  (click)="addMask(row.sceneId, row.layerId); $event.stopPropagation()"
                                >
                                  <span class="material-symbols-outlined" aria-hidden="true">crop_free</span>
                                </button>
                              }
                              <button
                                type="button"
                                class="cs-gantt-del"
                                title="Delete"
                                (pointerdown)="$event.stopPropagation()"
                                (click)="deleteGanttRow(row); $event.stopPropagation()"
                              >
                                ×
                              </button>
                              <span
                                class="cs-gantt-handle right"
                                (pointerdown)="onGanttBarDown($event, bar, 'right')"
                              ></span>
                            </div>
                          }
                          <div class="cs-gantt-playhead" [style.left.%]="playheadPct()" aria-hidden="true"></div>
                        </div>
                      }
                    </div>
                  }
                </div>
              </div>
            </div>
        } @else {
          <div class="cs-tl-image-hint">
            <p class="meta">
              Image posts use this canvas instead of a scene timeline. Open <strong>+ Asset</strong>,
              drag onto the preview, or add text with <strong>+ Text</strong>. Click a layer to edit
              properties.
            </p>
          </div>
        }
        </div>

        @if (selectedLayer()) {
          <aside class="cs-tl-props" aria-label="Layer properties">
            <div class="cs-tl-props-head">
              <strong>{{ layerTitle(selectedLayer()!) }}</strong>
              <button type="button" class="cs-tl-props-close" (click)="clearLayerSelection()" title="Close properties">✕</button>
            </div>
            <p class="meta">
              Drag to move · corner handles resize (hold Shift to stretch) · Fit to media shows the
              full clip
            </p>
            <div class="cs-tl-props-order">
              <span class="meta">Stack order</span>
              <button
                type="button"
                title="Higher track / in front of the scene plate"
                (click)="moveLayer(selectedSceneId(), selectedLayer()!.id, 1)"
              >
                Move forward
              </button>
              <button
                type="button"
                title="Lower track / closer to the scene plate"
                (click)="moveLayer(selectedSceneId(), selectedLayer()!.id, -1)"
              >
                Move back
              </button>
            </div>
            <div class="cs-tl-props-grid">
              <label>X %<input type="number" step="0.5" [ngModel]="selectedLayer()!.x" (ngModelChange)="setSelectedGeom('x', $event)" /></label>
              <label>Y %<input type="number" step="0.5" [ngModel]="selectedLayer()!.y" (ngModelChange)="setSelectedGeom('y', $event)" /></label>
              <label>W %<input type="number" min="5" step="0.5" [ngModel]="selectedLayer()!.width" (ngModelChange)="setSelectedGeom('width', $event)" /></label>
              <label>H %<input type="number" min="5" step="0.5" [ngModel]="selectedLayer()!.height" (ngModelChange)="setSelectedGeom('height', $event)" /></label>
            </div>
            @if (selectedLayer()!.type === 'image' || selectedLayer()!.type === 'video') {
              <button type="button" (click)="fitSelectedToMedia()">Fit to media</button>
            }
            @if (selectedLayer()!.type === 'icon' || selectedLayer()!.type === 'text') {
              <label class="cs-tl-props-color">
                Color
                <input
                  type="color"
                  [ngModel]="hexBg(selectedLayer()!.color)"
                  (ngModelChange)="setSelectedColor($event)"
                />
              </label>
            }
            @if (
              isVideo() &&
              (selectedLayer()!.type === 'text' || selectedLayer()!.type === 'video')
            ) {
              <div class="cs-tl-props-actions">
                @if (selectedLayer()!.type === 'text') {
                  <button
                    type="button"
                    title="Generate speech or record audio for this text"
                    (click)="openAttachAudioForSelectedText()"
                    [disabled]="busy() || isRefScene(activeScene())"
                  >
                    Attach audio
                  </button>
                }
                @if (selectedLayer()!.type === 'video') {
                  <button
                    type="button"
                    title="{{ selectedLayer()!.mute_audio ? 'Restore this clip’s embedded audio' : 'Mute this clip’s embedded audio' }}"
                    (click)="toggleSelectedVideoMute()"
                    [disabled]="busy() || isRefScene(activeScene())"
                  >
                    {{ selectedLayer()!.mute_audio ? 'Restore audio' : 'Mute audio' }}
                  </button>
                }
              </div>
            }
            @if (isVideo() && selectedLayer()!.type === 'video') {
              <div class="cs-tl-props-speed">
                <div class="cs-tl-props-speed-head">
                  <span>Speed</span>
                  <strong>{{ playbackRateLabel(selectedLayer()!) }}</strong>
                </div>
                <div class="cs-tl-props-speed-row">
                  <input
                    type="range"
                    [min]="minPlaybackRate"
                    [max]="maxPlaybackRate"
                    step="0.1"
                    [ngModel]="clipPlaybackRate(selectedLayer()!)"
                    (ngModelChange)="setSelectedPlaybackRate($event)"
                    [disabled]="busy() || isRefScene(activeScene())"
                  />
                  <input
                    type="number"
                    [min]="minPlaybackRate"
                    [max]="maxPlaybackRate"
                    step="0.1"
                    [ngModel]="clipPlaybackRate(selectedLayer()!)"
                    (ngModelChange)="setSelectedPlaybackRate($event)"
                    [disabled]="busy() || isRefScene(activeScene())"
                  />
                </div>
                <div class="cs-tl-props-speed-presets">
                  @for (p of videoSpeedPresets; track p) {
                    <button
                      type="button"
                      [class.active]="clipPlaybackRate(selectedLayer()!) === p"
                      (click)="setSelectedPlaybackRate(p)"
                      [disabled]="busy() || isRefScene(activeScene())"
                    >
                      {{ p }}×
                    </button>
                  }
                </div>
                <p class="meta">0.5× slowest · 20× fastest. Timeline length is source duration ÷ speed.</p>
              </div>
            }
            @if (canMaskSelected()) {
              <div class="cs-tl-mask-tools">
                <button type="button" (click)="addMaskForSelection()">+ Square mask</button>
                <button type="button" [class.primary]="maskDrawMode()" (click)="toggleMaskDraw()">
                  {{ maskDrawMode() ? 'Drawing…' : 'Draw mask' }}
                </button>
              </div>
              <ul class="cs-tl-mask-list">
                @for (mask of selectedLayer()!.masks || []; track mask.id) {
                  <li [class.is-selected]="selectedMaskId() === mask.id">
                    <button type="button" class="linkish" (click)="selectMask(selectedLayer()!.id, mask.id)">
                      {{ mask.title || 'Mask' }}
                    </button>
                    <button type="button" class="danger" (click)="deleteMask(selectedLayer()!.id, mask.id)">
                      Remove
                    </button>
                  </li>
                } @empty {
                  <li class="cs-empty-inline">No masks. Punch a hole so layers below show through.</li>
                }
              </ul>
            }
          </aside>
        }
      </section>

      <aside class="cs-tl-preview">
        <div class="cs-tl-preview-toolbar">
          @if (isVideo()) {
            <button
              type="button"
              class="primary cs-tl-play"
              (click)="togglePlay()"
              [disabled]="!timeline().length"
              [title]="playing() ? 'Pause preview' : 'Play preview'"
            >
              <span class="material-symbols-outlined" aria-hidden="true">{{
                playing() ? 'pause' : 'play_arrow'
              }}</span>
              {{ playing() ? 'Pause' : 'Play' }}
            </button>
          }
          <select [ngModel]="post.target_format || 'portrait'" (ngModelChange)="onFormatChange($event)">
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
            @if (!isVideo()) {
              <option value="square">Square</option>
              <option value="story">Story</option>
            }
          </select>
          @if (!isVideo()) {
            <label class="cs-tl-bg cs-tl-bg--inline" title="Canvas background color">
              Bg
              <input
                type="color"
                [ngModel]="hexBg(post.background_color)"
                (ngModelChange)="onPostBgColor($event)"
              />
            </label>
          }
          @if (isVideo()) {
            <label
              class="cs-tl-reusable"
              title="Let other video posts insert this timeline as a clip"
            >
              <input
                type="checkbox"
                [ngModel]="!!post.is_reusable"
                (ngModelChange)="onReusableChange($event)"
              />
              Reusable clip
            </label>
          }
          <div class="cs-tl-zoom" title="Zoom preview (Ctrl/⌘ + scroll)">
            <button type="button" (click)="nudgeZoom(-1)" aria-label="Zoom out">−</button>
            <button type="button" (click)="resetZoom()" [title]="'Reset zoom'">{{ zoomLabel() }}</button>
            <button type="button" (click)="nudgeZoom(1)" aria-label="Zoom in">+</button>
          </div>
          <button type="button" (click)="refreshPreview()" [disabled]="previewBusy()">
            {{ previewBusy() ? 'Rendering…' : 'Refresh' }}
          </button>
          <button
            type="button"
            class="primary cs-tl-export"
            (click)="openExport()"
            [disabled]="busy()"
          >
            Export
          </button>
        </div>
        <div class="cs-tl-preview-body">
        <div
          class="cs-tl-preview-stage"
          [style.--cs-ar-w]="exportFrame().width"
          [style.--cs-ar-h]="exportFrame().height"
          (wheel)="onPreviewWheel($event)"
        >
        <div class="cs-tl-stage-zoom">
        <div
          #tlStage
          class="cs-tl-stage"
          [class.is-draw]="maskDrawMode()"
          [style.aspect-ratio]="stageAspect()"
          [style.--cs-zoom]="previewZoom()"
          [class.is-transparent-bg]="activeBgColor() === 'transparent'"
          [class.is-empty]="!stageClips().length && !(previewUrl() && !isVideo())"
          (pointerdown)="onStageBackgroundDown($event)"
        >
          @for (clip of stageClips(); track clip.id) {
              <div
                class="cs-tl-layer"
                [class.is-selected]="!clip.isBackground && selectedLayerId() === clip.id"
                [class.is-bg]="clip.isBackground"
                [style.left.%]="clip.x"
                [style.top.%]="clip.y"
                [style.width.%]="clip.width"
                [style.height.%]="clip.height"
                [style.opacity]="
                  clip.active
                    ? clip.opacity
                    : !playing() && selectedLayerId() === clip.id
                      ? 0.28
                      : 0
                "
                [style.pointer-events]="clip.active || selectedLayerId() === clip.id ? null : 'none'"
                [style.z-index]="clip.z"
                [style.background-color]="clip.fill || null"
                (pointerdown)="onStageLayerDown($event, clip)"
              >
                @if (clip.kind === 'video' && clip.url) {
                  <video
                    #tlMedia
                    class="cs-tl-stage-clip"
                    [attr.data-clip-id]="clip.id"
                    [src]="clip.url"
                    [attr.poster]="clip.poster || null"
                    [style.mask-image]="clipMaskCss(clip)"
                    [style.webkitMaskImage]="clipMaskCss(clip)"
                    playsinline
                    preload="metadata"
                    (loadedmetadata)="onStageMediaMeta($event, clip)"
                    (waiting)="onStageMediaWait($event, true)"
                    (stalled)="onStageMediaWait($event, true)"
                    (canplay)="onStageMediaWait($event, false)"
                    (playing)="onStageMediaWait($event, false)"
                    (ended)="onStageMediaWait($event, false)"
                    (error)="onStageMediaWait($event, false)"
                  ></video>
                } @else if (clip.kind === 'image' && clip.url) {
                  <img
                    class="cs-tl-stage-clip"
                    [src]="clip.url"
                    alt=""
                    [style.mask-image]="clipMaskCss(clip)"
                    [style.webkitMaskImage]="clipMaskCss(clip)"
                    (load)="onStageImageLoad($event, clip)"
                  />
                } @else if (clip.kind === 'text') {
                  <div class="cs-tl-stage-text" [style.color]="clip.color || '#fff'">{{ clip.text }}</div>
                } @else if (clip.kind === 'icon') {
                  <div class="cs-tl-stage-icon" [style.color]="clip.color || '#fff'">
                    @if (clip.iconSet === 'lucide' && clip.url) {
                      <span
                        class="cs-tl-stage-icon-mask"
                        [style.maskImage]="'url(' + clip.url + ')'"
                        [style.webkitMaskImage]="'url(' + clip.url + ')'"
                      ></span>
                    } @else {
                      <span class="material-symbols-outlined" aria-hidden="true">{{
                        clip.iconName || clip.text
                      }}</span>
                    }
                  </div>
                }
                @if (!clip.isBackground && selectedLayerId() === clip.id) {
                  <div
                    class="cs-tl-media-frame"
                    [style.left.%]="mediaFrame(clip).left"
                    [style.top.%]="mediaFrame(clip).top"
                    [style.width.%]="mediaFrame(clip).width"
                    [style.height.%]="mediaFrame(clip).height"
                  >
                    <span class="cs-tl-resize nw" (pointerdown)="onStageResizeDown($event, clip, 'nw')"></span>
                    <span class="cs-tl-resize ne" (pointerdown)="onStageResizeDown($event, clip, 'ne')"></span>
                    <span class="cs-tl-resize sw" (pointerdown)="onStageResizeDown($event, clip, 'sw')"></span>
                    <span class="cs-tl-resize se" (pointerdown)="onStageResizeDown($event, clip, 'se')"></span>
                  </div>
                  @if (clip.kind === 'image' || clip.kind === 'video') {
                    @for (mask of clip.masks; track mask.id) {
                      <div
                        class="cs-tl-mask"
                        [class.is-selected]="selectedMaskId() === mask.id"
                        [class.is-inactive]="!maskActiveAtPlayhead(clip, mask)"
                        [style.left.%]="mask.x || 0"
                        [style.top.%]="mask.y || 0"
                        [style.width.%]="mask.width || 40"
                        [style.height.%]="mask.height || 40"
                        (pointerdown)="onStageMaskDown($event, clip, mask)"
                      >
                        @if (selectedMaskId() === mask.id) {
                          <span class="cs-tl-resize nw" (pointerdown)="onStageMaskResizeDown($event, clip, mask, 'nw')"></span>
                          <span class="cs-tl-resize ne" (pointerdown)="onStageMaskResizeDown($event, clip, mask, 'ne')"></span>
                          <span class="cs-tl-resize sw" (pointerdown)="onStageMaskResizeDown($event, clip, mask, 'sw')"></span>
                          <span class="cs-tl-resize se" (pointerdown)="onStageMaskResizeDown($event, clip, mask, 'se')"></span>
                        }
                      </div>
                    }
                  }
                }
              </div>
          }
          @if (!stageClips().length) {
            @if (!isVideo() && previewUrl()) {
              <img class="cs-tl-stage-still" [src]="previewUrl()!" alt="Post preview" />
            } @else if (!isVideo()) {
              <div class="cs-preview-placeholder">
                <span class="material-symbols-outlined" aria-hidden="true">image</span>
                <p>{{ previewBusy() ? 'Rendering…' : 'Drop an asset on the canvas' }}</p>
              </div>
            }
          }
        </div>
        </div>
        </div>
          @if (isVideo()) {
            <button
              type="button"
              class="cs-tl-preview-play"
              (click)="togglePlay(); $event.stopPropagation()"
              [disabled]="!timeline().length"
              [title]="playing() ? 'Pause preview' : 'Play preview'"
              [attr.aria-label]="playing() ? 'Pause preview' : 'Play preview'"
            >
              <span class="material-symbols-outlined" aria-hidden="true">{{
                playing() ? 'pause' : 'play_arrow'
              }}</span>
              <span class="cs-tl-preview-play-label">{{ playing() ? 'Pause' : 'Play' }}</span>
            </button>
          }
        </div>
      </aside>

      @if (showAssetsDrawer()) {
        <aside class="cs-tl-drawer" (click)="closeAssetsDrawer()" aria-label="Assets drawer">
          <div class="cs-tl-drawer-panel" (click)="$event.stopPropagation()">
            <div class="cs-tl-drawer-head">
              <h3>Add asset</h3>
              <div class="cs-tl-drawer-head-actions">
                <button type="button" (click)="goAssets.emit()">Manage library</button>
                <button type="button" (click)="closeAssetsDrawer()" title="Close">✕</button>
              </div>
            </div>
            <div class="cs-tl-drawer-filters">
              <div class="cs-tabs" role="tablist" aria-label="Asset type">
                @for (tab of pickerTabs(); track tab.id) {
                  <button
                    type="button"
                    role="tab"
                    [class.active]="pickerFilter() === tab.id"
                    (click)="pickerFilter.set(tab.id); previewReusableId.set(null)"
                  >
                    {{ tab.label }}
                  </button>
                }
              </div>
              @if (pickerFilter() === 'icon') {
                <div class="cs-tl-icon-filters">
                  <input
                    type="search"
                    placeholder="Search icons…"
                    [ngModel]="iconQuery()"
                    (ngModelChange)="iconQuery.set($event)"
                  />
                  <div class="cs-tabs cs-tabs--compact" role="tablist" aria-label="Icon pack">
                    <button
                      type="button"
                      role="tab"
                      [class.active]="iconSetFilter() === 'all'"
                      (click)="iconSetFilter.set('all')"
                    >
                      All packs
                    </button>
                    @for (set of iconSets; track set.id) {
                      <button
                        type="button"
                        role="tab"
                        [class.active]="iconSetFilter() === set.id"
                        (click)="iconSetFilter.set(set.id)"
                        [title]="set.license"
                      >
                        {{ set.label }}
                      </button>
                    }
                  </div>
                </div>
              }
            </div>
            <div
              class="cs-tl-drawer-body"
              [class.is-icons]="pickerFilter() === 'icon'"
            >
              @if (pickerFilter() === 'reusable') {
                @for (clip of reusableCandidates(); track clip.id) {
                  <button
                    type="button"
                    class="cs-tl-reuse-tile"
                    [class.selected]="previewReusableId() === clip.id"
                    draggable="true"
                    (dragstart)="onReusableDragStart($event, clip)"
                    (click)="previewReusableId.set(clip.id)"
                    (dblclick)="insertReusable(clip)"
                    [title]="clip.name || 'Reusable clip'"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">movie</span>
                    <span class="cs-tl-reuse-tile-meta">
                      <strong class="truncate">{{ clip.name || 'Reusable clip' }}</strong>
                      <span class="meta">{{ formatDur(reusableDuration(clip)) }}</span>
                    </span>
                  </button>
                } @empty {
                  <p class="cs-empty-inline">
                    Mark a video post as a Reusable clip to insert it on this timeline.
                  </p>
                }
              } @else if (pickerFilter() === 'icon') {
                @for (asset of pickerAssets(); track assetKey(asset)) {
                  <button
                    type="button"
                    class="cs-tl-icon-chip"
                    [class.selected]="assetKey(asset) === previewKey()"
                    [title]="asset.name"
                    draggable="true"
                    (dragstart)="onAssetDragStart($event, asset)"
                    (dblclick)="addAsset(asset, { closePicker: false })"
                    (click)="selectPreview(asset)"
                  >
                    @if (asset.icon_set === 'lucide') {
                      <span
                        class="cs-tl-icon-chip-mask"
                        [style.maskImage]="'url(' + lucideThumb(asset) + ')'"
                        [style.webkitMaskImage]="'url(' + lucideThumb(asset) + ')'"
                      ></span>
                    } @else {
                      <span class="material-symbols-outlined" aria-hidden="true">{{
                        asset.icon_name
                      }}</span>
                    }
                  </button>
                } @empty {
                  <p class="cs-empty-inline">No icons match that search.</p>
                }
              } @else {
                @for (asset of pickerAssets(); track assetKey(asset)) {
                  <app-media-thumb-tile
                    [name]="asset.name"
                    [thumbUrl]="thumbUrl(asset)"
                    [videoUrl]="isVideoAsset(asset.type) ? inspectUrl(asset) : null"
                    [audioUrl]="isAudioAsset(asset.type) ? inspectUrl(asset) : null"
                    [icon]="iconFor(asset)"
                    [typeLabel]="assetTypeLabel(asset.type)"
                    [durationS]="asset.duration_s ?? null"
                    [locked]="!!asset.locked"
                    [selected]="assetKey(asset) === previewKey()"
                    [draggable]="true"
                    [inspectable]="true"
                    [renameable]="true"
                    (tileDragStart)="onAssetDragStart($event, asset)"
                    (tileClick)="selectPreview(asset)"
                    (tileDblClick)="addAsset(asset, { closePicker: false })"
                    (inspectClick)="selectPreview(asset)"
                    (renameClick)="openInspect(asset)"
                  />
                } @empty {
                  <p class="cs-empty-inline">
                    Upload assets on the Assets step, then drag them here or click Add.
                  </p>
                }
              }
            </div>
            <div class="cs-tl-drawer-preview" aria-label="Asset preview">
              @if (pickerFilter() === 'reusable') {
                @if (previewReusable(); as clip) {
                  <div class="cs-tl-reuse-preview">
                    <span class="material-symbols-outlined" aria-hidden="true">movie</span>
                    <strong class="truncate">{{ clip.name || 'Reusable clip' }}</strong>
                    <span class="meta">{{ formatDur(reusableDuration(clip)) }} · added as a layer in the scene</span>
                  </div>
                  <div class="cs-tl-drawer-preview-bar">
                    <div class="cs-tl-drawer-preview-meta">
                      <strong class="truncate">{{ clip.name }}</strong>
                      <span class="meta">Reusable post</span>
                    </div>
                    <button type="button" class="primary" (click)="insertReusable(clip)">Add</button>
                  </div>
                } @else {
                  <p class="cs-empty-inline">
                    Select a reusable post, then Add or drag it onto the scene track.
                  </p>
                }
              } @else if (previewAsset(); as asset) {
                @if (asset.type === 'icon') {
                  <div class="cs-tl-icon-preview cs-tl-icon-preview--drawer">
                    @if (asset.icon_set === 'lucide') {
                      <span
                        class="cs-tl-icon-preview-mask"
                        [style.maskImage]="'url(' + lucideThumb(asset) + ')'"
                        [style.webkitMaskImage]="'url(' + lucideThumb(asset) + ')'"
                      ></span>
                    } @else {
                      <span class="material-symbols-outlined" aria-hidden="true">{{
                        asset.icon_name
                      }}</span>
                    }
                  </div>
                } @else {
                  <app-asset-preview-pane
                    compact
                    [autoplay]="false"
                    [type]="asset.type"
                    [filename]="asset.original_filename || asset.name"
                    [title]="asset.name"
                    [previewUrl]="inspectUrl(asset)"
                    [posterUrl]="thumbUrl(asset)"
                  />
                }
                <div class="cs-tl-drawer-preview-bar">
                  <div class="cs-tl-drawer-preview-meta">
                    <strong class="truncate">{{ asset.name }}</strong>
                    <span class="meta">{{ previewMeta(asset) }}</span>
                  </div>
                  <button type="button" class="primary" (click)="addAsset(asset, { closePicker: false })">
                    Add
                  </button>
                </div>
              } @else {
                <p class="cs-empty-inline">
                  Select an asset to preview. Drag onto the timeline, or click Add / double-click to
                  place it at the playhead.
                </p>
              }
            </div>
          </div>
        </aside>
      }
    </div>

    <app-asset-inspect
      [open]="!!inspectAsset()"
      [title]="inspectAsset()?.name || ''"
      [type]="inspectAsset()?.type || ''"
      [filename]="inspectAsset()?.original_filename || inspectAsset()?.name || ''"
      [previewUrl]="inspectAsset() ? inspectUrl(inspectAsset()!) : null"
      [posterUrl]="inspectAsset() ? thumbUrl(inspectAsset()!) : null"
      [meta]="inspectAsset() ? inspectMeta(inspectAsset()!) : ''"
      [durationS]="inspectAsset()?.duration_s ?? null"
      [canRename]="true"
      [canDownload]="!!inspectAsset() && !inspectAsset()!.locked"
      [busy]="api.busy()"
      (close)="inspectKey.set(null)"
      (rename)="renameInspect($event)"
      (download)="inspectAsset() && downloadInspect(inspectAsset()!)"
    />

    <app-modal-wrapper
      [isOpen]="showAddLayerDialog()"
      title="Add layer"
      [subtitle]="addLayerDialogSubtitle()"
      icon="add_box"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="closeAddLayerDialog()"
    >
      <div class="cs-tl-add-layer-options" role="list">
        <button type="button" role="listitem" (click)="chooseAddLayer('asset')" [disabled]="busy()">
          <span class="material-symbols-outlined" aria-hidden="true">perm_media</span>
          <span>
            <strong>Asset</strong>
            <span class="meta">Image, video, or audio from the library</span>
          </span>
        </button>
        <button type="button" role="listitem" (click)="chooseAddLayer('text')" [disabled]="busy()">
          <span class="material-symbols-outlined" aria-hidden="true">text_fields</span>
          <span>
            <strong>Text</strong>
            <span class="meta">On-screen caption or title</span>
          </span>
        </button>
        <button type="button" role="listitem" (click)="chooseAddLayer('voice')" [disabled]="busy()">
          <span class="material-symbols-outlined" aria-hidden="true">record_voice_over</span>
          <span>
            <strong>Voice</strong>
            <span class="meta">Spoken TTS layer for this scene</span>
          </span>
        </button>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="closeAddLayerDialog()">Cancel</button>
      </ng-template>
    </app-modal-wrapper>

    @if (videoCtx()?.open) {
      <div
        class="cs-gantt-ctx"
        role="menu"
        aria-label="Video clip actions"
        [style.left.px]="videoCtx()!.x"
        [style.top.px]="videoCtx()!.y"
        (pointerdown)="$event.stopPropagation()"
      >
        <button type="button" role="menuitem" (click)="ctxToggleMute()">
          {{ videoCtx()!.muteAudio ? 'Restore audio' : 'Remove audio' }}
        </button>
        <button
          type="button"
          role="menuitem"
          [disabled]="videoCtx()!.splitHereLocal == null"
          (click)="ctxSplitHere()"
        >
          Split here
        </button>
        <button
          type="button"
          role="menuitem"
          [disabled]="videoCtx()!.splitPlayheadLocal == null"
          (click)="ctxSplitPlayhead()"
        >
          Split at playhead
        </button>
        <button type="button" role="menuitem" (click)="ctxToggleFadeIn()">
          {{ videoCtx()!.fadeIn ? 'Remove fade in' : 'Fade in' }}
        </button>
        <button type="button" role="menuitem" (click)="ctxToggleFadeOut()">
          {{ videoCtx()!.fadeOut ? 'Remove fade out' : 'Fade out' }}
        </button>
        <button type="button" role="menuitem" class="is-danger" (click)="ctxDeleteSection()">
          Delete section
        </button>
      </div>
    }

    @if (sceneCtx()?.open) {
      <div
        class="cs-gantt-ctx"
        role="menu"
        aria-label="Scene actions"
        [style.left.px]="sceneCtx()!.x"
        [style.top.px]="sceneCtx()!.y"
        (pointerdown)="$event.stopPropagation()"
      >
        <button
          type="button"
          role="menuitem"
          [disabled]="!sceneCtx()!.canTrimContent"
          (click)="ctxTrimSceneToContent()"
        >
          Trim scene to content
        </button>
        <button
          type="button"
          role="menuitem"
          [disabled]="!sceneCtx()!.canTrimPlayhead"
          (click)="ctxTrimSceneToPlayhead()"
        >
          Trim scene to playhead
        </button>
        <button
          type="button"
          role="menuitem"
          [disabled]="!sceneCtx()!.canFitVideo"
          (click)="ctxFitSceneToVideo()"
        >
          Fit scene to video
        </button>
      </div>
    }

    <app-attach-audio-dialog
      [isOpen]="showAttachAudio()"
      title="Attach audio to text"
      [text]="attachAudioText()"
      [defaultVoice]="post.default_tts_voice || null"
      fileStem="timeline-voice"
      (close)="closeAttachAudio()"
      (attached)="onAttachAudioResult($event)"
    />
  `,
})
export class TimelineWorkspaceComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) post!: Post;
  @Output() postChange = new EventEmitter<Post>();
  @Output() goAssets = new EventEmitter<void>();
  @Output() goExport = new EventEmitter<void>();
  @ViewChild('tlStage') private stageEl?: ElementRef<HTMLElement>;
  @ViewChild('ganttScroll') private ganttScrollEl?: ElementRef<HTMLDivElement>;
  @ViewChild('audioBus') private audioBus?: ElementRef<HTMLElement>;
  @ViewChildren('tlMedia') private mediaEls?: QueryList<ElementRef<HTMLMediaElement>>;

  readonly absTime = signal(0);
  readonly selectedSceneId = signal<string | null>(null);
  readonly previewUrl = signal<string | null>(null);
  readonly previewBusy = signal(false);
  readonly busy = signal(false);
  readonly dirty = signal(false);
  readonly hasActiveScript = signal(false);
  readonly exportHint = signal('');
  readonly playing = signal(false);
  readonly showAssetsDrawer = signal(false);
  readonly showReusablePicker = signal(false);
  readonly showAddLayerDialog = signal(false);
  readonly addLayerSceneId = signal<string | null>(null);
  readonly showAttachAudio = signal(false);
  readonly attachAudioText = signal('');
  readonly inspectKey = signal<string | null>(null);
  readonly previewKey = signal<string | null>(null);
  readonly previewReusableId = signal<string | null>(null);
  readonly pickerFilter = signal<PickerFilter>('all');
  readonly iconQuery = signal('');
  readonly iconSetFilter = signal<IconSetId | 'all'>('all');
  readonly selectedLayerId = signal<string | null>(null);
  readonly selectedMaskId = signal<string | null>(null);
  readonly maskDrawMode = signal(false);
  readonly previewZoom = signal(1);
  readonly videoCtx = signal<VideoCtxMenu | null>(null);
  readonly sceneCtx = signal<SceneCtxMenu | null>(null);
  /** Absolute time under the pointer while hovering the gantt (null when not hovering). */
  readonly hoverTime = signal<number | null>(null);
  /** True while a gantt bar drag is active (for cursor styling). */
  readonly ganttDragging = signal(false);
  readonly ganttDropSceneId = signal<string | null>(null);
  /** True while dragging an asset/reusable from the drawer onto the gantt. */
  readonly ganttAssetDnd = signal(false);

  readonly pickerTabs = computed((): { id: PickerFilter; label: string }[] => {
    const tabs: { id: PickerFilter; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'image', label: 'Images' },
      { id: 'video', label: 'Video' },
      { id: 'audio', label: 'Audio' },
      { id: 'icon', label: 'Icons' },
    ];
    if (this.isVideo()) tabs.splice(4, 0, { id: 'reusable', label: 'Reusable' });
    return tabs;
  });
  readonly iconSets = ICON_SETS;

  private objectUrl: string | null = null;
  private scrubTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private previewPoll: ReturnType<typeof setInterval> | null = null;
  private bootstrappedFor = '';
  private playRaf = 0;
  private playGen = 0;
  private playAbs = 0;
  private playLastTs = 0;
  private lastMediaSyncAt = 0;
  private lastAbsUiAt = 0;
  private forceMediaSeek = false;
  private readonly mediaWaitingIds = new Set<string>();
  private readonly mediaPlayInflight = new WeakMap<HTMLMediaElement, Promise<void>>();
  private readonly mediaMetaSeek = new WeakSet<HTMLMediaElement>();
  private readonly audioPlayers = new Map<
    string,
    { el: HTMLAudioElement; url: string; startAbs: number; duration: number; volume: number; sourceStart: number }
  >();
  private pickerSceneId: string | null = null;
  private lastVideoSpeed = 1;
  private readonly mediaAspectByKey = signal<Record<string, number>>({});
  readonly minPlaybackRate = MIN_PLAYBACK_RATE;
  readonly maxPlaybackRate = MAX_PLAYBACK_RATE;
  readonly videoSpeedPresets = [0.5, 1, 2, 4, 8, 20] as const;
  private ganttDrag: GanttDrag | null = null;
  private stageDrag: StageDrag | null = null;
  private readonly layoutRev = signal(0);

  readonly isVideo = computed(() => {
    this.layoutRev();
    return this.post?.type === 'video';
  });
  readonly timeline = computed(() => {
    this.layoutRev();
    return getSceneTimeline(this.post?.scenes || [], this.api.projectPosts());
  });
  readonly activeScene = computed((): Scene | null => {
    this.layoutRev();
    const id = this.selectedSceneId();
    const scenes = this.post?.scenes || [];
    return scenes.find((s) => s.id === id) || scenes[0] || null;
  });
  readonly activeSceneIndex = computed(() => {
    const id = this.activeScene()?.id;
    if (!id) return -1;
    return (this.post?.scenes || []).findIndex((s) => s.id === id);
  });
  readonly sceneNavLabel = computed(() => {
    const rows = this.timeline();
    const idx = this.activeSceneIndex();
    if (!rows.length || idx < 0) return 'Scene';
    return `Scene ${idx + 1} / ${rows.length}`;
  });
  readonly activeBgColor = computed(() => {
    this.layoutRev();
    this.absTime();
    if (!this.isVideo()) {
      if (isTransparentBg(this.post?.background_color)) return 'transparent';
      return normalizeHexColor(this.post?.background_color);
    }
    const t = this.absTime();
    const rows = this.timeline();
    const live = this.resolveLiveHit();
    const sceneBg = live?.scene?.background_color
      ?? rows.find((r) => t >= r.start - 1e-6 && t < r.end)?.scene?.background_color
      ?? rows.find((r) => r.scene.id === this.selectedSceneId())?.scene?.background_color
      ?? rows[0]?.scene?.background_color;
    // Scene default is transparent. Fall back to post fill only when the scene has none.
    if (!isTransparentBg(sceneBg)) return normalizeHexColor(sceneBg);
    if (!isTransparentBg(this.post?.background_color)) {
      return normalizeHexColor(this.post?.background_color);
    }
    return 'transparent';
  });
  readonly totalDuration = computed(() => {
    this.layoutRev();
    return computePostDuration(this.post?.scenes || [], this.api.projectPosts());
  });
  readonly reusableCandidates = computed((): Post[] => {
    this.layoutRev();
    const hostId = this.post?.id;
    if (!hostId || this.post?.type !== 'video') return [];
    return (this.api.projectPosts() as Post[]).filter((p) => {
      if (!p.is_reusable || p.type !== 'video' || p.id === hostId) return false;
      return !this.refsReach(p.id, hostId);
    });
  });
  readonly previewReusable = computed((): Post | null => {
    const id = this.previewReusableId();
    if (!id) return null;
    return this.reusableCandidates().find((p) => p.id === id) || null;
  });
  readonly availableAssets = computed((): PaletteAsset[] => {
    this.layoutRev();
    const postId = this.post?.id;
    const project = (this.api.currentProject()?.assets || []).filter(
      (a) => !a.post_id || a.post_id === postId,
    );
    const globals = (this.api.globalAssets() || []).map((a) => ({ ...a, is_global: true }));
    const seen = new Set<string>();
    const out: PaletteAsset[] = [];
    for (const a of [...globals, ...project]) {
      if (a.type === 'model') continue;
      const key = this.assetKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  });
  readonly iconAssets = computed((): PaletteAsset[] => {
    const setFilter = this.iconSetFilter();
    return filterIcons(this.iconQuery(), setFilter).map((icon) => ({
      id: iconAssetId(icon.set, icon.name),
      name: icon.label,
      type: 'icon',
      icon_set: icon.set,
      icon_name: icon.name,
      group: icon.set === 'lucide' ? 'Lucide' : 'Material Symbols',
    }));
  });
  readonly pickerAssets = computed(() => {
    const filter = this.pickerFilter();
    if (filter === 'reusable') return [];
    if (filter === 'icon') return this.iconAssets();
    return this.availableAssets().filter((a) => {
      if (filter === 'all') return true;
      if (filter === 'image') return isImageAsset(a.type);
      if (filter === 'video') return isVideoAsset(a.type);
      return isAudioAsset(a.type);
    });
  });
  readonly liveClips = computed(() => {
    this.layoutRev();
    this.absTime();
    this.api.currentProject();
    this.api.globalAssets();
    return this.buildLiveClips();
  });
  /** Host video layers for every scene — time-independent, so play does not remount streams. */
  readonly hostVideoClips = computed((): PreviewClip[] => {
    this.layoutRev();
    this.api.currentProject();
    this.api.globalAssets();
    if (!this.isVideo()) return [];
    const out: PreviewClip[] = [];
    const seen = new Set<string>();
    for (const row of this.timeline()) {
      (row.scene.layers || []).forEach((layer, i) => {
        if (layer.type !== 'video' || !isLayerEnabled(layer)) return;
        const clip = this.clipFromLayer(layer, i, 0, row.duration, row.scene.id);
        if (!clip?.url || seen.has(clip.id)) return;
        seen.add(clip.id);
        out.push({ ...clip, active: false, opacity: 0 });
      });
    }
    return out;
  });
  /** Visual stage layers that should actually paint (active, or selected while scrubbing). */
  readonly stageClips = computed((): PreviewClip[] => {
    const selected = this.selectedLayerId();
    const playing = this.playing();
    const live = this.liveClips().filter((clip) => {
      if (clip.kind === 'audio') return false;
      if (clip.active || clip.isBackground) return true;
      if (clip.kind === 'video' && clip.url) return true;
      return !playing && !!selected && clip.id === selected;
    });
    if (!this.isVideo()) return live;
    // Keep host videos mounted while paused so a timeline click can seek the
    // exact frame without remounting (which would leave the last play frame).
    const byId = new Map(live.map((c) => [c.id, c]));
    for (const clip of this.hostVideoClips()) {
      if (!byId.has(clip.id)) byId.set(clip.id, clip);
    }
    return [...byId.values()].sort((a, b) => a.z - b.z);
  });
  readonly ganttTickMarks = computed(() => ganttTicks(this.scrubMax()));
  readonly ganttLayerRows = computed((): GanttLayerRow[] => {
    const total = Math.max(0.5, this.scrubMax());
    const rows: GanttLayerRow[] = [];
    const tlById = new Map(this.timeline().map((r) => [r.scene.id, r]));
    // Include disabled scenes so they stay editable even though they are skipped in playback.
    for (const scene of this.post?.scenes || []) {
      const locked = this.isRefScene(scene);
      const enabled = isSceneEnabled(scene);
      const tl = tlById.get(scene.id);
      const sceneDur = tl?.duration ?? Math.max(0.5, Number(scene.duration_s) || 5);
      const sceneStart = tl?.start ?? 0;
      const sceneBar: GanttBar | null =
        enabled && tl
          ? {
              id: scene.id,
              kind: 'scene',
              sceneId: scene.id,
              label: `${scene.name || (locked ? 'Reusable clip' : 'Scene')} ${this.formatDur(sceneDur)}`,
              css: locked ? 'is-scene is-reusable-ref' : 'is-scene',
              leftPct: (sceneStart / total) * 100,
              widthPct: Math.max(1.2, (sceneDur / total) * 100),
              canMask: false,
              locked,
            }
          : null;
      rows.push({
        key: `scene-header:${scene.id}`,
        kind: 'scene_header',
        label: `${scene.name || (locked ? 'Reusable clip' : 'Scene')}${
          enabled ? ` ${this.formatDur(sceneDur)}` : ' · skipped'
        }`,
        icon: locked ? 'library_books' : 'slideshow',
        sceneId: scene.id,
        layerId: '',
        enabled,
        bar: sceneBar,
      });
      const layers = [...(scene.layers || [])].sort(
        (a, b) => this.layerZ(b) - this.layerZ(a),
      );
      for (const layer of layers) {
        const layerEnabled = enabled && isLayerEnabled(layer);
        const start = Math.max(0, Number(layer.start_s) || 0);
        const layerDur = layerEffectiveDuration(layer, sceneDur);
        const geom = ganttBarInScene(sceneStart, sceneDur, start, layerDur, total);
        const abs = sceneStart + clampLayerStartInScene(start, layerDur, sceneDur);
        const bar: GanttBar | null =
          layerEnabled && tl
            ? {
                id: layer.id,
                kind: 'layer',
                sceneId: scene.id,
                layerId: layer.id,
                label: this.layerTitle(layer),
                css: `is-${String(layer.type || 'image')}`,
                leftPct: geom.leftPct,
                widthPct: geom.widthPct,
                canMask: layer.type === 'image' || layer.type === 'video',
                muteAudio: layer.type === 'video' && !!layer.mute_audio,
                fadeIn: layer.transition_in === 'fade-in',
                fadeOut: layer.transition_out === 'fade-out',
              }
            : null;
        rows.push({
          key: layer.id,
          kind: 'layer',
          label: this.layerTitle(layer),
          icon: this.layerIcon(layer),
          sceneId: scene.id,
          layerId: layer.id,
          enabled: layerEnabled,
          bar,
        });
        if (!tl) continue;
        for (const mask of layer.masks || []) {
          const mStart = Math.max(0, Number(mask.start_s) || 0);
          const mDur = Math.min(
            maskEffectiveDuration(mask, layerDur),
            Math.max(0.1, layerDur - mStart),
          );
          const mLocal = abs - sceneStart + mStart;
          const mGeom = ganttBarInScene(sceneStart, sceneDur, mLocal, mDur, total);
          const mBar: GanttBar | null = layerEnabled
            ? {
                id: mask.id,
                kind: 'mask',
                sceneId: scene.id,
                layerId: layer.id,
                maskId: mask.id,
                label: mask.title || 'Mask',
                css: 'is-mask',
                leftPct: mGeom.leftPct,
                widthPct: mGeom.widthPct,
                canMask: false,
              }
            : null;
          rows.push({
            key: mask.id,
            kind: 'mask',
            label: mask.title || 'Mask',
            icon: 'crop_free',
            sceneId: scene.id,
            layerId: layer.id,
            maskId: mask.id,
            enabled: layerEnabled,
            bar: mBar,
          });
        }
      }
    }
    return rows;
  });
  readonly ganttSceneGroups = computed((): GanttSceneGroup[] => {
    const groups: GanttSceneGroup[] = [];
    let current: GanttSceneGroup | null = null;
    for (const row of this.ganttLayerRows()) {
      if (row.kind === 'scene_header') {
        current = {
          sceneId: row.sceneId,
          sceneRow: row,
          layers: [],
          enabled: row.enabled,
          locked: !!row.bar?.locked,
        };
        groups.push(current);
      } else if (current) {
        current.layers.push(row);
      }
    }
    return groups;
  });
  readonly selectedLayer = computed((): Layer | null => {
    this.layoutRev();
    const id = this.selectedLayerId();
    if (!id) return null;
    return this.findLayer(id)?.layer || null;
  });

  constructor(
    readonly api: ContentSproutApiService,
    private snackbar: SnackbarService,
    private dialogs: DialogService,
    private cdr: ChangeDetectorRef,
  ) {
    effect(() => {
      this.playing();
      this.layoutRev();
      // While playing, the rAF clock drives media. Re-reading liveClips/absTime
      // here remounts <video> every frame and aborts Range streams.
      if (this.playing()) return;
      this.absTime();
      this.liveClips();
      requestAnimationFrame(() => this.syncAllMedia(true));
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['post'] && this.post?.id) {
      this.layoutRev.update((n) => n + 1);
      this.migrateLegacyRefScenesIfNeeded();
      const key = `${this.post.id}:${this.post.type}`;
      if (this.bootstrappedFor !== key) {
        this.bootstrappedFor = key;
        void this.bootstrap();
      } else {
        const prev = changes['post'].previousValue as Post | undefined;
        if (
          prev &&
          (prev.video_format !== this.post.video_format ||
            prev.target_format !== this.post.target_format)
        ) {
          void this.loadExportHint();
        }
      }
    }
  }

  /** One-time client migrate of legacy whole-scene reusable slots → ref layers. */
  private migrateLegacyRefScenesIfNeeded(): void {
    if (!this.isVideo() || !this.post?.scenes?.length) return;
    if (!(this.post.scenes || []).some((s) => String(s.ref_post_id || '').trim())) return;
    const scenes = (this.post.scenes || []).map((scene) => {
      const refId = String(scene.ref_post_id || '').trim();
      if (!refId) return scene;
      const already = (scene.layers || []).some(
        (l) => l.type === 'ref' && String(l.ref_post_id || '').trim() === refId,
      );
      const layers = [...(scene.layers || [])];
      if (!already) {
        layers.unshift({
          id: newUid(),
          type: 'ref',
          title: scene.name || 'Reusable clip',
          ref_post_id: refId,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z_index: 0,
          opacity: 1,
          start_s: 0,
          duration_s: Math.max(0.5, Number(scene.duration_s) || 0.5),
        });
      }
      return { ...scene, ref_post_id: null, layers };
    });
    this.emitPost({ ...this.post, scenes });
    this.dirty.set(true);
    this.scheduleSave();
  }

  ngOnDestroy(): void {
    this.stopPlay();
    this.stopPreviewPoll();
    this.disposePreviewAudio();
    this.releaseStageVideos();
    if (this.scrubTimer) clearTimeout(this.scrubTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.revokePreview();
  }

  @HostListener('document:pointerdown')
  onDocPointerDown(): void {
    if (this.videoCtx()?.open) this.closeVideoCtx();
    if (this.sceneCtx()?.open) this.closeSceneCtx();
    if (this.showReusablePicker()) this.showReusablePicker.set(false);
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    this.closeVideoCtx();
    this.closeSceneCtx();
  }

  @HostListener('document:pointermove', ['$event'])
  onDocPointerMove(event: PointerEvent): void {
    if (this.ganttDrag) this.onGanttMove(event);
    if (this.stageDrag) this.onStageMove(event);
  }

  @HostListener('document:pointerup')
  onDocPointerUp(): void {
    this.endGanttDrag();
    this.endStageDrag();
  }

  @HostListener('document:pointercancel')
  onDocPointerCancel(): void {
    this.endGanttDrag();
    this.endStageDrag();
  }

  @HostListener('document:dragend')
  onDocDragEnd(): void {
    this.ganttAssetDnd.set(false);
    this.ganttDropSceneId.set(null);
  }

  assetTypeLabel = assetTypeLabel;
  isVideoAsset = isVideoAsset;
  isAudioAsset = isAudioAsset;

  formatClock = formatClock;
  formatDur = formatScriptDurationLabel;

  scrubMax(): number {
    return Math.max(0.5, this.totalDuration());
  }

  playheadPct(): number {
    const total = this.scrubMax();
    return Math.min(100, Math.max(0, (this.absTime() / total) * 100));
  }

  hoverPct(): number {
    const t = this.hoverTime();
    if (t == null) return 0;
    const total = this.scrubMax();
    return Math.min(100, Math.max(0, (t / total) * 100));
  }

  ganttInnerPx(): number {
    return Math.max(480, Math.ceil(this.scrubMax() * 36));
  }

  barLeft(row: { start: number }): number {
    return (row.start / this.scrubMax()) * 100;
  }

  barWidth(row: { duration: number }): number {
    return Math.max(2, (row.duration / this.scrubMax()) * 100);
  }

  layerIcon(layer: Layer): string {
    const t = String(layer.type || '');
    if (t === 'tts') return 'record_voice_over';
    if (t === 'audio') return 'music_note';
    if (t === 'video') return 'movie';
    if (t === 'text') return 'text_fields';
    if (t === 'icon') return 'emoji_symbols';
    if (t === 'ref') return 'library_books';
    return 'image';
  }

  layerTitle(layer: Layer): string {
    const custom = String(layer.title || '').trim();
    let base = custom;
    if (!base) {
      if (layer.type === 'ref') {
        const refId = String(layer.ref_post_id || '').trim();
        const ref = refId
          ? (this.api.projectPosts() as Post[]).find((p) => p.id === refId)
          : null;
        base = ref?.name || 'Reusable clip';
      } else {
        const t = String(layer.type || 'layer');
        base = t.charAt(0).toUpperCase() + t.slice(1);
      }
    }
    if (layer.type === 'video' && Math.abs(layerPlaybackRate(layer) - 1) > 0.001) {
      return `${base} · ${this.playbackRateLabel(layer)}`;
    }
    return base;
  }

  clipPlaybackRate(layer: Layer): number {
    return layerPlaybackRate(layer);
  }

  playbackRateLabel(layer: Layer): string {
    const rate = layerPlaybackRate(layer);
    const text = Number.isInteger(rate) ? String(rate) : String(rate);
    return `${text}×`;
  }

  setSelectedPlaybackRate(value: number | string): void {
    const id = this.selectedLayerId();
    if (!id) return;
    const found = this.findLayer(id);
    if (!found || found.layer.type !== 'video') return;
    const oldRate = layerPlaybackRate(found.layer);
    const next = normalizePlaybackRate(value, oldRate);
    if (Math.abs(next - oldRate) < 0.001) return;
    this.lastVideoSpeed = next;
    const sceneDur =
      (found.sceneId && this.timeline().find((r) => r.scene.id === found.sceneId)?.duration) ||
      Math.max(0.5, Number((this.post.scenes || []).find((s) => s.id === found.sceneId)?.duration_s) || 5);
    const oldDur = layerEffectiveDuration(found.layer, sceneDur);
    const sourceCoverage = oldDur * oldRate;
    const newDur = Math.max(0.1, Math.round((sourceCoverage / next) * 100) / 100);
    const scale = newDur / Math.max(0.1, oldDur);
    const patch: Partial<Layer> = { playback_rate: next, duration_s: newDur };
    if (found.layer.masks?.length && Math.abs(scale - 1) > 0.001) {
      patch.masks = found.layer.masks.map((m) => {
        const start = Math.max(0, (Number(m.start_s) || 0) * scale);
        const raw = m.duration_s;
        const dur =
          raw == null || !Number.isFinite(Number(raw)) ? raw : Math.max(0.1, Number(raw) * scale);
        return { ...m, start_s: start, duration_s: dur };
      });
    }
    if (!found.sceneId || !this.isVideo()) {
      this.patchLayer(id, patch);
      return;
    }
    const scenes = (this.post.scenes || []).map((scene) => {
      if (scene.id !== found.sceneId) return scene;
      const layers = (scene.layers || []).map((l) => (l.id === id ? { ...l, ...patch } : l));
      const updated = layers.find((l) => l.id === id)!;
      let nextScene: Scene = { ...scene, layers };
      if (sceneVideoLayers(nextScene).length === 1) {
        nextScene = trimSceneToOccupancy(ensureSceneFitsLayer(nextScene, updated));
        const dur = Math.max(0.5, Number(nextScene.duration_s) || 0.5);
        this.snackbar.show(`Scene length set to ${this.formatDur(dur)} to match video`, 'info');
        return nextScene;
      }
      return ensureSceneFitsLayer(nextScene, updated);
    });
    this.emitPost({ ...this.post, scenes });
    this.dirty.set(true);
    this.scheduleSave();
  }

  layerSummary(layer: Layer): string {
    if (layer.type === 'tts' || layer.type === 'text') {
      return String(layer.text || '').trim() || 'Empty';
    }
    if (layer.type === 'icon') {
      return String(layer.icon_name || layer.text || 'Icon');
    }
    if (layer.type === 'ref') {
      const refId = String(layer.ref_post_id || '').trim();
      const ref = refId
        ? (this.api.projectPosts() as Post[]).find((p) => p.id === refId)
        : null;
      return ref?.name || 'Reusable post';
    }
    const asset = layer.asset_id ? this.resolveAsset(layer.asset_id) : null;
    return asset?.name || (layer.asset_id ? 'Linked asset' : 'No asset');
  }

  /** Pixel size of the export canvas — preview frame uses the same aspect ratio. */
  exportFrame(): { width: number; height: number } {
    this.layoutRev();
    return exportCanvasSize(
      this.post?.target_format,
      this.post?.video_format,
      this.post?.type === 'video',
    );
  }

  stageAspect(): string {
    const size = this.exportFrame();
    return `${size.width} / ${size.height}`;
  }

  assetKey(asset: PaletteAsset): string {
    if (asset.type === 'icon') {
      const set = String(asset.icon_set || 'material');
      const name = String(asset.icon_name || asset.id || '');
      return iconAssetId(set as IconSetId, name);
    }
    return asset.is_global ? `global:${asset.id}` : asset.id;
  }

  thumbUrl(asset: PaletteAsset): string | null {
    if (asset.type === 'icon') return null;
    return this.api.assetThumbUrl(asset, !!asset.is_global);
  }

  lucideThumb(asset: PaletteAsset): string {
    return lucideSvgUrl(String(asset.icon_name || ''));
  }

  iconPackLabel(asset: PaletteAsset): string {
    const set = String(asset.icon_set || 'material');
    return ICON_SETS.find((s) => s.id === set)?.label || set;
  }

  iconFor(asset: PaletteAsset): string {
    if (asset.type === 'icon') return String(asset.icon_name || 'emoji_symbols');
    return assetTypeIcon(asset.type);
  }

  private findPaletteAsset(key: string): PaletteAsset | null {
    if (!key) return null;
    const parsed = parseIconAssetId(key);
    if (parsed) {
      return (
        this.iconAssets().find((a) => this.assetKey(a) === key) || {
          id: key,
          name: parsed.name,
          type: 'icon',
          icon_set: parsed.set,
          icon_name: parsed.name,
        }
      );
    }
    return this.availableAssets().find((a) => this.assetKey(a) === key) ?? null;
  }

  readonly inspectAsset = computed((): PaletteAsset | null => {
    const key = this.inspectKey();
    if (!key) return null;
    return (
      this.availableAssets().find((a) => this.assetKey(a) === key) ||
      this.iconAssets().find((a) => this.assetKey(a) === key) ||
      null
    );
  });

  readonly previewAsset = computed((): PaletteAsset | null => {
    const key = this.previewKey();
    if (!key) return null;
    return (
      this.availableAssets().find((a) => this.assetKey(a) === key) ||
      this.iconAssets().find((a) => this.assetKey(a) === key) ||
      null
    );
  });

  selectPreview(asset: PaletteAsset): void {
    this.previewReusableId.set(null);
    this.previewKey.set(this.assetKey(asset));
  }

  previewMeta(asset: PaletteAsset): string {
    if (asset.type === 'icon') {
      return [this.iconPackLabel(asset), asset.group].filter(Boolean).join(' · ');
    }
    const dur = formatMediaDuration(asset.duration_s);
    return [assetTypeLabel(asset.type), dur, asset.is_global ? 'Resources' : 'Project']
      .filter(Boolean)
      .join(' · ');
  }

  openInspect(asset: PaletteAsset): void {
    this.inspectKey.set(this.assetKey(asset));
  }

  toggleAssetsDrawer(): void {
    if (this.showAssetsDrawer()) {
      this.closeAssetsDrawer();
      return;
    }
    this.openAssetsDrawer();
  }

  openAssetsDrawer(sceneId?: string | null): void {
    this.pickerSceneId = sceneId ?? this.selectedSceneId();
    if (sceneId) this.selectedSceneId.set(sceneId);
    this.previewKey.set(null);
    this.previewReusableId.set(null);
    this.showAssetsDrawer.set(true);
    void this.api.loadGlobalAssets();
  }

  closeAssetsDrawer(): void {
    this.showAssetsDrawer.set(false);
    this.previewKey.set(null);
    this.previewReusableId.set(null);
  }

  openAddLayerDialog(sceneId: string): void {
    const scene = (this.post.scenes || []).find((s) => s.id === sceneId) || null;
    if (this.isRefScene(scene)) {
      this.snackbar.show('Reusable clips are edited in their own post — add a new scene instead', 'info');
      return;
    }
    this.addLayerSceneId.set(sceneId);
    this.selectedSceneId.set(sceneId);
    this.showAddLayerDialog.set(true);
  }

  closeAddLayerDialog(): void {
    this.showAddLayerDialog.set(false);
    this.addLayerSceneId.set(null);
  }

  addLayerDialogSubtitle(): string {
    const id = this.addLayerSceneId();
    const scene = (this.post.scenes || []).find((s) => s.id === id);
    return scene?.name ? `Into “${scene.name}”` : 'Choose what to add to this scene';
  }

  chooseAddLayer(kind: 'asset' | 'text' | 'voice'): void {
    const sceneId = this.addLayerSceneId();
    this.closeAddLayerDialog();
    if (!sceneId) return;
    this.selectedSceneId.set(sceneId);
    if (kind === 'asset') {
      this.openAssetsDrawer(sceneId);
      return;
    }
    if (kind === 'text') {
      this.addTextLayer(sceneId);
      return;
    }
    this.addVoiceLayer(sceneId);
  }

  inspectUrl(asset: PaletteAsset): string | null {
    return this.api.assetOriginalUrl(asset, !!asset.is_global);
  }

  inspectMeta(asset: PaletteAsset): string {
    return [assetTypeLabel(asset.type), asset.is_global ? 'Resources' : 'Project'].join(' · ');
  }

  async renameInspect(name: string): Promise<void> {
    const asset = this.inspectAsset();
    const next = name.trim();
    if (!asset || !next || next === asset.name) return;
    if (asset.is_global) await this.api.renameGlobalAsset(asset.id, next);
    else await this.api.renameProjectAsset(asset.id, next);
  }

  downloadInspect(asset: PaletteAsset): void {
    if (asset.locked) return;
    const url = asset.is_global
      ? this.api.globalDownloadUrl(asset.id)
      : this.api.assetDownloadUrl(asset.id);
    if (url) window.open(url, '_blank', 'noopener');
  }

  private async bootstrap(): Promise<void> {
    this.dirty.set(false);
    this.setAbsTime(0);
    this.stopPlay();
    void this.api.loadGlobalAssets();
    void this.loadExportHint();
    if (this.isVideo()) {
      await this.prepareFromScript();
      if (!this.timeline().length) this.seedBlankScene();
      const first = this.timeline()[0];
      this.selectedSceneId.set(first?.scene.id || null);
    } else {
      this.selectedSceneId.set(null);
    }
    await this.refreshPreview();
    void this.ensureTimelineVideoPreviews();
  }

  private timelineVideoAssets(): PaletteAsset[] {
    const seen = new Set<string>();
    const out: PaletteAsset[] = [];
    const add = (asset: PaletteAsset | null | undefined) => {
      if (!asset || !isVideoAsset(asset.type)) return;
      const key = this.assetKey(asset);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(asset);
    };
    for (const asset of this.availableAssets()) add(asset);
    for (const scene of this.post?.scenes || []) {
      for (const layer of scene.layers || []) {
        if (String(layer.type || '') === 'video') add(this.resolveAsset(layer.asset_id));
      }
    }
    return out;
  }

  private async ensureTimelineVideoPreviews(): Promise<void> {
    if (!this.isVideo()) return;
    const missing = this.timelineVideoAssets().filter((a) => !a.processed_formats?.['preview']);
    if (!missing.length) return;
    await Promise.all(
      missing.map((asset) => this.api.ensureVideoPreview(asset, { global: !!asset.is_global })),
    );
    if (this.timelineVideoAssets().some((a) => !a.processed_formats?.['preview'])) {
      this.startPreviewPoll();
    }
  }

  private startPreviewPoll(): void {
    if (this.previewPoll) return;
    let tries = 0;
    this.previewPoll = setInterval(() => {
      tries += 1;
      const missing = this.timelineVideoAssets().filter((a) => !a.processed_formats?.['preview']);
      if (!missing.length || tries > 48) {
        this.stopPreviewPoll();
        return;
      }
      void Promise.all(
        missing.map((asset) => this.api.ensureVideoPreview(asset, { global: !!asset.is_global })),
      );
    }, 2500);
  }

  private stopPreviewPoll(): void {
    if (!this.previewPoll) return;
    clearInterval(this.previewPoll);
    this.previewPoll = null;
  }

  private async loadExportHint(): Promise<void> {
    const size = await this.api.getExportSize(this.post.id);
    this.exportHint.set(size ? `${size.width}×${size.height}` : '');
  }

  private async prepareFromScript(): Promise<void> {
    const activeId = this.post.active_script_id;
    if (!activeId) {
      this.hasActiveScript.set(false);
      return;
    }
    this.hasActiveScript.set(true);
    if (!scenesAreEmptyScaffold(this.post.scenes) && !scenesAreScriptScaffold(this.post.scenes)) {
      return;
    }
    const doc = await this.api.getScript(this.post.id, activeId);
    const script = doc?.script?.script || '';
    if (!script.trim()) return;
    const scenes = buildScenesFromScript(script, {
      targetFormat: this.post.target_format || 'portrait',
      defaultVoice: this.post.default_tts_voice || null,
    });
    if (!scenes.length) return;
    this.emitPost({ ...this.post, scenes });
    this.dirty.set(true);
    await this.persist(true);
    this.snackbar.show(
      `Built ${scenes.length} scene${scenes.length === 1 ? '' : 's'} from script`,
      'success',
    );
  }

  async regenerateFromScript(): Promise<void> {
    const activeId = this.post.active_script_id;
    if (!activeId) {
      this.snackbar.show('Set an active script first', 'error');
      return;
    }
    const scaffoldOnly =
      scenesAreEmptyScaffold(this.post.scenes) || scenesAreScriptScaffold(this.post.scenes);
    if (!scaffoldOnly) {
      const ok = await this.dialogs.confirm({
        title: 'Rebuild from script',
        message:
          'Rebuild scenes from the active script? Matching scenes keep placed assets, voice, backgrounds, and other creative layers; script Text updates from the script.',
        confirmText: 'Rebuild',
        type: 'warning',
      });
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      const doc = await this.api.getScript(this.post.id, activeId);
      const script = doc?.script?.script || '';
      if (!script.trim()) {
        this.snackbar.show('Active script is empty', 'error');
        return;
      }
      const built = buildScenesFromScript(script, {
        targetFormat: this.post.target_format || 'portrait',
        defaultVoice: this.post.default_tts_voice || null,
      });
      const scenes = mergeScenesPreservingCreative(built, this.post.scenes || []);
      this.stopPlay();
      this.emitPost({ ...this.post, scenes });
      this.selectedSceneId.set(scenes[0]?.id || null);
      this.setAbsTime(0);
      this.dirty.set(true);
      await this.persist(false);
      await this.refreshPreview();
      const kept = scenes.reduce(
        (n, s) => n + (s.layers || []).filter((l) => isCreativeSceneLayer(l)).length,
        0,
      );
      this.snackbar.show(
        kept
          ? `Rebuilt ${scenes.length} scene${scenes.length === 1 ? '' : 's'} · kept creative layers`
          : `Rebuilt ${scenes.length} scene${scenes.length === 1 ? '' : 's'} from script`,
        'success',
      );
    } finally {
      this.busy.set(false);
    }
  }

  selectScene(id: string, start: number): void {
    this.selectedSceneId.set(id);
    this.selectedLayerId.set(null);
    this.selectedMaskId.set(null);
    this.setAbsTime(Math.max(0, start));
    this.scrollGanttToAbs(start);
    this.schedulePreview();
  }

  selectSceneLabel(sceneId: string): void {
    this.selectedSceneId.set(sceneId);
    this.selectedLayerId.set(null);
    this.selectedMaskId.set(null);
    const row = this.timeline().find((r) => r.scene.id === sceneId);
    if (row) {
      this.seekTimeline(row.start);
      this.scrollGanttToAbs(row.start);
    }
  }

  selectGanttLabelRow(row: GanttLayerRow): void {
    if (row.kind === 'mask' && row.maskId) {
      this.selectMask(row.layerId, row.maskId);
      return;
    }
    if (row.kind === 'layer' && row.layerId) {
      this.selectLayer(row.sceneId, row.layerId);
      return;
    }
    this.selectSceneLabel(row.sceneId);
  }

  toggleSceneEnabled(sceneId: string): void {
    const scene = (this.post.scenes || []).find((s) => s.id === sceneId);
    if (!scene) return;
    const next = !isSceneEnabled(scene);
    this.patchScene(sceneId, { enabled: next });
    if (!next) {
      // Just disabled — keep playhead on the remaining enabled timeline.
      const t = Math.min(this.scrubMax(), Math.max(0, this.absTime()));
      this.setAbsTime(t);
      this.syncSelectedSceneFromTime();
      this.forceMediaSeek = true;
      this.schedulePreview();
    }
    this.snackbar.show(next ? 'Scene enabled' : 'Scene disabled — skipped in preview/export', 'info');
  }

  toggleLayerEnabled(sceneId: string, layerId: string): void {
    const found = this.findLayer(layerId);
    if (!found) return;
    const next = !isLayerEnabled(found.layer);
    this.patchLayer(layerId, { enabled: next });
    this.snackbar.show(next ? 'Layer enabled' : 'Layer disabled', 'info');
  }

  onScrub(value: number | string): void {
    this.setAbsTime(Math.max(0, Number(value) || 0));
    this.forceMediaSeek = true;
    this.syncSelectedSceneFromTime();
    if (this.isVideo()) {
      this.revokePreview();
      this.previewUrl.set(null);
    }
    if (!this.playing()) this.schedulePreview();
  }

  togglePlay(): void {
    if (!this.isVideo() || !this.timeline().length) return;
    if (this.playing()) {
      this.stopPlay();
      return;
    }
    if (this.absTime() >= this.scrubMax() - 0.05) this.setAbsTime(0);
    this.snapPlayheadToSceneVideo();
    if (this.playRaf) cancelAnimationFrame(this.playRaf);
    const gen = ++this.playGen;
    this.playAbs = this.absTime();
    this.playing.set(true);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.playLastTs = performance.now();
    this.lastMediaSyncAt = 0;
    this.lastAbsUiAt = 0;
    this.forceMediaSeek = true;
    // Play() must run in the click gesture or the browser blocks audio.
    this.syncAllMedia(true, true);
    const tick = (now: number) => {
      if (!this.playing() || gen !== this.playGen) return;
      const syncDue = now - this.lastMediaSyncAt > 80;
      if (syncDue) {
        this.lastMediaSyncAt = now;
        this.syncAllMedia(false);
      }
      if (this.previewMediaBlocked()) {
        this.playLastTs = now;
        this.playRaf = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.1, (now - this.playLastTs) / 1000);
      this.playLastTs = now;
      const next = this.playAbs + dt;
      const dur = this.scrubMax();
      if (next >= dur) {
        this.setAbsTime(dur);
        this.syncSelectedSceneFromTime();
        this.stopPlay();
        return;
      }
      this.playAbs = next;
      const prevScene = this.selectedSceneId();
      this.syncSelectedSceneFromTime();
      // Keep Angular off the 60fps clock. Rebuilding liveClips / gantt every
      // frame remounts <video> and stacks play() promises until the tab freezes.
      const sceneChanged = prevScene !== this.selectedSceneId();
      if (sceneChanged || now - this.lastAbsUiAt > 80) {
        this.lastAbsUiAt = now;
        this.absTime.set(next);
      }
      this.playRaf = requestAnimationFrame(tick);
    };
    this.playRaf = requestAnimationFrame(tick);
  }

  private stopPlay(opts: { sync?: boolean } = {}): void {
    const wasPlaying = this.playing();
    this.playGen++;
    const t = wasPlaying ? this.playAbs : this.absTime();
    this.playing.set(false);
    if (this.playRaf) cancelAnimationFrame(this.playRaf);
    this.playRaf = 0;
    this.mediaWaitingIds.clear();
    if (wasPlaying) this.setAbsTime(t);
    this.pauseAllStageMedia();
    if (opts.sync !== false) this.syncAllMedia(true);
  }

  private nowAbs(): number {
    return this.playing() ? this.playAbs : this.absTime();
  }

  private setAbsTime(t: number): void {
    const next = Math.max(0, Number(t) || 0);
    this.playAbs = next;
    this.absTime.set(next);
  }

  onStageMediaWait(event: Event, waiting: boolean): void {
    const el = event.target as HTMLMediaElement | null;
    const id = el?.dataset?.['clipId'] || '';
    if (!id) return;
    if (waiting) this.mediaWaitingIds.add(id);
    else this.mediaWaitingIds.delete(id);
  }

  private previewMediaBlocked(): boolean {
    if (!this.mediaWaitingIds.size) return false;
    const active = new Set(
      this.buildLiveClips()
        .filter((c) => c.active && c.kind === 'video' && !!c.url)
        .map((c) => c.id),
    );
    const root = this.stageEl?.nativeElement;
    for (const id of [...this.mediaWaitingIds]) {
      if (!active.has(id)) {
        this.mediaWaitingIds.delete(id);
        continue;
      }
      const el = root
        ? Array.from(root.querySelectorAll<HTMLVideoElement>('video[data-clip-id]')).find(
            (v) => v.dataset['clipId'] === id,
          )
        : undefined;
      if (!el || el.readyState >= 3) {
        this.mediaWaitingIds.delete(id);
        continue;
      }
      if (el.seeking || el.readyState < 2) return true;
    }
    return false;
  }

  private releaseStageVideos(): void {
    const root = this.stageEl?.nativeElement;
    const els = root ? root.querySelectorAll<HTMLVideoElement>('video') : [];
    for (const el of Array.from(els)) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* ignore */
      }
    }
    this.mediaWaitingIds.clear();
  }

  /**
   * If the playhead is sitting on empty scene plate (common after speed-up on a
   * long scene), jump to the selected / sole video so preview actually shows it.
   */
  private snapPlayheadToSceneVideo(): void {
    if (this.liveClips().some((c) => c.kind === 'video' && !!c.url && c.active)) return;
    const hit = this.resolveLiveHit();
    if (!hit || hit.locked) return;
    const videos = (hit.scene.layers || []).filter(
      (l) => l.type === 'video' && isLayerEnabled(l),
    );
    if (!videos.length) return;
    const selected = this.selectedLayerId();
    const pick = videos.find((l) => l.id === selected) || (videos.length === 1 ? videos[0] : null);
    if (!pick) return;
    const row = this.timeline().find((r) => r.scene.id === hit.hostSceneId);
    if (!row) return;
    this.setAbsTime(row.start + Math.max(0, Number(pick.start_s) || 0));
    this.syncSelectedSceneFromTime();
    this.forceMediaSeek = true;
  }

  private syncSelectedSceneFromTime(): void {
    const abs = this.nowAbs();
    const rows = this.timeline();
    const row =
      rows.find((r) => abs >= r.start && abs < r.end) || rows[rows.length - 1] || null;
    if (row) this.selectedSceneId.set(row.scene.id);
  }

  canMaskSelected(): boolean {
    const layer = this.selectedLayer();
    return !!layer && (layer.type === 'image' || layer.type === 'video');
  }

  selectLayer(sceneId: string | null, layerId: string): void {
    if (sceneId) this.selectedSceneId.set(sceneId);
    this.selectedLayerId.set(layerId);
    this.selectedMaskId.set(null);
    this.maskDrawMode.set(false);
    const found = this.findLayer(layerId);
    if (found?.sceneId) {
      const row = this.timeline().find((r) => r.scene.id === found.sceneId);
      if (row) this.setAbsTime(row.start + Math.max(0, Number(found.layer.start_s) || 0));
    }
    this.forceMediaSeek = true;
    this.schedulePreview();
    void this.syncSelectedMediaBounds();
  }

  selectMask(layerId: string, maskId: string): void {
    this.selectedLayerId.set(layerId);
    this.selectedMaskId.set(maskId);
    this.maskDrawMode.set(false);
  }

  onAssetDragStart(event: DragEvent, asset: PaletteAsset): void {
    event.dataTransfer?.setData('text/plain', this.assetKey(asset));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    this.ganttAssetDnd.set(true);
  }

  onReusableDragStart(event: DragEvent, clip: Post): void {
    event.dataTransfer?.setData('text/plain', `reusable:${clip.id}`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    this.ganttAssetDnd.set(true);
  }

  onGanttDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.ganttAssetDnd.set(true);
    const host = event.currentTarget as HTMLElement | null;
    host?.classList.add('is-drop');
    const sceneId =
      host?.dataset['sceneId'] ||
      this.sceneIdFromPoint(event.clientX, event.clientY);
    if (sceneId) this.ganttDropSceneId.set(sceneId);
  }

  onGanttDragLeave(event: DragEvent): void {
    (event.currentTarget as HTMLElement | null)?.classList.remove('is-drop');
  }

  onGanttDrop(event: DragEvent, track: 'scenes' | 'layer', sceneId?: string): void {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement | null)?.classList.remove('is-drop');
    this.ganttAssetDnd.set(false);
    this.ganttDropSceneId.set(null);
    const key = event.dataTransfer?.getData('text/plain') || '';
    const inner =
      (event.currentTarget as HTMLElement).closest('.cs-gantt-inner') as HTMLElement | null ||
      (event.currentTarget as HTMLElement);
    const abs = this.absTimeFromClientX(event.clientX, inner);
    const hoverSceneId = sceneId || this.sceneIdFromPoint(event.clientX, event.clientY);
    if (key.startsWith('reusable:')) {
      this.insertReusableId(key.slice('reusable:'.length), { afterAbs: abs });
      return;
    }
    const asset = this.findPaletteAsset(key);
    if (!asset) return;
    const hoverScene = hoverSceneId
      ? (this.post.scenes || []).find((s) => s.id === hoverSceneId)
      : null;
    if (hoverScene && !isSceneEnabled(hoverScene)) {
      this.snackbar.show('Enable the scene before adding layers', 'info');
      return;
    }
    if (hoverScene && this.isRefScene(hoverScene)) {
      this.snackbar.show('Reusable clips are edited in their own post — add a new scene instead', 'info');
      return;
    }
    const drop = this.resolveLayerDrop(abs, 0.1, hoverSceneId);
    if (!drop) {
      this.snackbar.show('Drop assets onto a scene', 'info');
      return;
    }
    if (this.isRefScene(drop.row.scene)) {
      this.snackbar.show('Reusable clips are edited in their own post — add a new scene instead', 'info');
      return;
    }
    const droppedOnSceneHeader =
      track === 'scenes' ||
      !!(event.currentTarget as HTMLElement).closest?.('.cs-gantt-track.is-scene-header');
    this.addAsset(asset, {
      sceneId: drop.row.scene.id,
      localStart: droppedOnSceneHeader ? 0 : drop.local,
      asBottom: droppedOnSceneHeader,
      closePicker: false,
    });
  }

  onGanttTrackDown(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest('.cs-gantt-bar, .cs-gantt-handle, .cs-gantt-del, .cs-gantt-mask-btn')) {
      return;
    }
    const track =
      (event.currentTarget as HTMLElement).closest('.cs-gantt-inner') as HTMLElement | null ||
      (event.currentTarget as HTMLElement);
    this.seekTimeline(this.absTimeFromClientX(event.clientX, track));
  }

  onGanttHoverMove(event: MouseEvent): void {
    if (this.ganttDrag) {
      this.hoverTime.set(null);
      return;
    }
    const inner = (event.currentTarget as HTMLElement).querySelector(
      '.cs-gantt-inner',
    ) as HTMLElement | null;
    if (!inner) return;
    this.hoverTime.set(this.absTimeFromClientX(event.clientX, inner));
  }

  clearGanttHover(): void {
    this.hoverTime.set(null);
  }

  /** Seek playhead + refresh preview (used by track click and click-to-seek on clips). */
  private seekTimeline(abs: number): void {
    this.stopPlay({ sync: false });
    this.setAbsTime(Math.min(this.scrubMax(), Math.max(0, abs)));
    this.syncSelectedSceneFromTime();
    this.forceMediaSeek = true;
    // Drop any stale server still so a prior scene's frame can't linger on empty visuals.
    if (this.isVideo()) {
      this.revokePreview();
      this.previewUrl.set(null);
    }
    this.schedulePreview();
  }

  onGanttBarDown(event: PointerEvent, bar: GanttBar, handle: DragHandle): void {
    event.stopPropagation();
    event.preventDefault();
    this.stopPlay({ sync: false });
    const track = (event.currentTarget as HTMLElement).closest('.cs-gantt-track') as HTMLElement | null;
    const inner = (event.currentTarget as HTMLElement).closest('.cs-gantt-inner') as HTMLElement | null;
    const total = this.scrubMax();
    const pendingSeek = this.absTimeFromClientX(event.clientX, inner || track);
    this.ganttDragging.set(true);
    if (bar.kind === 'scene') {
      this.selectedSceneId.set(bar.sceneId);
      this.selectedLayerId.set(null);
      this.selectedMaskId.set(null);
      const row = this.timeline().find((r) => r.scene.id === bar.sceneId);
      const scene = (this.post.scenes || []).find((s) => s.id === bar.sceneId);
      const occ = sceneLayerOccupancy(scene);
      this.ganttDrag = {
        kind: 'scene',
        handle,
        sceneId: bar.sceneId,
        origStart: row?.start || 0,
        origDuration: row?.duration || 5,
        origSourceStart: 0,
        origGap: Math.max(0, Number(scene?.gap_before_s) || 0),
        origLayerStarts: (scene?.layers || []).map((l) => ({
          id: l.id,
          start_s: Math.max(0, Number(l.start_s) || 0),
        })),
        firstLayerStart: occ?.firstStart ?? 0,
        lastLayerEnd: occ?.lastEnd ?? 0.5,
        startX: event.clientX,
        trackWidth: inner?.clientWidth || track?.clientWidth || 1,
        total,
        moved: false,
        pendingSeek: handle === 'move' ? pendingSeek : null,
      };
      return;
    }
    if (bar.kind === 'mask' && bar.layerId && bar.maskId) {
      this.selectMask(bar.layerId, bar.maskId);
      const found = this.findLayer(bar.layerId);
      const mask = (found?.layer.masks || []).find((m) => m.id === bar.maskId);
      const sceneDur = this.timeline().find((r) => r.scene.id === bar.sceneId)?.duration || 5;
      const layerDur = found ? layerEffectiveDuration(found.layer, sceneDur) : 5;
      this.ganttDrag = {
        kind: 'mask',
        handle,
        sceneId: bar.sceneId,
        layerId: bar.layerId,
        maskId: bar.maskId,
        origStart: Math.max(0, Number(mask?.start_s) || 0),
        origDuration: mask ? maskEffectiveDuration(mask, layerDur) : 1,
        origSourceStart: 0,
        startX: event.clientX,
        trackWidth: track?.clientWidth || 1,
        total,
        moved: false,
        pendingSeek: handle === 'move' ? pendingSeek : null,
      };
      return;
    }
    if (bar.layerId) {
      this.selectLayer(bar.sceneId, bar.layerId);
      const found = this.findLayer(bar.layerId);
      const row = this.timeline().find((r) => r.scene.id === bar.sceneId);
      const sceneDur = row?.duration || 5;
      let origStart = Math.max(0, Number(found?.layer.start_s) || 0);
      const origDuration = found ? layerEffectiveDuration(found.layer, sceneDur) : 1;
      if (found?.layer && layerStartOutsideScene(found.layer, sceneDur)) {
        origStart = 0;
        this.patchLayer(bar.layerId, { start_s: 0 });
      }
      const origAbsStart = (row?.start || 0) + origStart;
      const inTimeline = origAbsStart >= -1e-3 && origAbsStart <= total + 1e-3;
      this.ganttDrag = {
        kind: 'layer',
        handle,
        sceneId: bar.sceneId,
        layerId: bar.layerId,
        origStart,
        origDuration,
        origSourceStart: Math.max(0, Number(found?.layer.source_start_s) || 0),
        origPlaybackRate: found ? layerPlaybackRate(found.layer) : 1,
        origAbsStart,
        grabOffset: inTimeline ? pendingSeek - origAbsStart : 0,
        ganttInner: inner,
        startX: event.clientX,
        trackWidth: inner?.clientWidth || track?.clientWidth || 1,
        total,
        moved: false,
        pendingSeek: handle === 'move' ? pendingSeek : null,
      };
    }
  }

  private absTimeFromClientX(clientX: number, trackEl: HTMLElement | null): number {
    if (!trackEl) return this.absTime();
    const rect = trackEl.getBoundingClientRect();
    const pct = rect.width ? (clientX - rect.left) / rect.width : 0;
    return Math.min(this.scrubMax(), Math.max(0, pct * this.scrubMax()));
  }

  private sceneIdFromPoint(clientX: number, clientY: number): string | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const host = el?.closest('[data-scene-id]') as HTMLElement | null;
    return host?.dataset['sceneId'] || null;
  }

  /**
   * Map an absolute time (and optional hovered scene row) onto a scene.
   * The hovered scene row always wins so drops land in the scene under the pointer.
   * Gaps between scenes snap to the nearer scene — layers never live outside a scene.
   */
  private resolveLayerDrop(
    abs: number,
    duration: number,
    hoverSceneId?: string | null,
    _currentSceneId?: string | null,
  ): { row: { scene: Scene; start: number; duration: number; end: number }; local: number } | null {
    const rows = this.timeline();
    if (!rows.length) return null;
    const dur = Math.max(0.1, Number(duration) || 0.1);
    // Vertical: pointer is over a scene track — place into that scene.
    if (hoverSceneId) {
      const hover = rows.find((r) => r.scene.id === hoverSceneId);
      if (hover && isSceneEnabled(hover.scene) && !this.isRefScene(hover.scene)) {
        const local = Math.max(0, abs - hover.start);
        return { row: hover, local };
      }
    }
    const hit = rows.find((r) => abs >= r.start - 1e-4 && abs < r.end - 1e-4);
    if (hit) {
      return { row: hit, local: Math.max(0, abs - hit.start) };
    }
    if (abs < rows[0].start) {
      return { row: rows[0], local: 0 };
    }
    const last = rows[rows.length - 1];
    if (abs >= last.end - 1e-4) {
      return { row: last, local: Math.max(0, abs - last.start) };
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      if (abs >= a.end - 1e-4 && abs < b.start + 1e-4) {
        const mid = (a.end + b.start) / 2;
        if (abs < mid) {
          return { row: a, local: Math.max(0, a.duration - Math.min(dur, Math.max(0.1, a.duration - 0.1))) };
        }
        return { row: b, local: 0 };
      }
    }
    return { row: last, local: Math.max(0, abs - last.start) };
  }

  private relocateLayerToScene(
    layerId: string,
    fromSceneId: string,
    toSceneId: string,
    localStart: number,
    duration: number,
    sourceStart: number,
  ): void {
    if (!this.post || fromSceneId === toSceneId) return;
    const from = (this.post.scenes || []).find((s) => s.id === fromSceneId);
    const to = (this.post.scenes || []).find((s) => s.id === toSceneId);
    if (!from || !to || this.isRefScene(from) || this.isRefScene(to)) return;
    if (!isSceneEnabled(to)) return;
    const layer = (from.layers || []).find((l) => l.id === layerId);
    if (!layer) return;
    const maxZ = (to.layers || []).reduce((m, l) => Math.max(m, this.layerZ(l)), -1);
    const toDur = Math.max(0.5, Number(to.duration_s) || 5);
    const placed = fitLayerInScene(localStart, duration, toDur, { growScene: true });
    const moved: Layer = {
      ...layer,
      start_s: placed.start_s,
      duration_s: placed.duration_s,
      source_start_s: Math.max(0, sourceStart),
      z_index: maxZ + 1,
    };
    const fromLayers = (from.layers || []).filter((l) => l.id !== layerId);
    let nextTo: Scene = { ...to, layers: [...(to.layers || []), moved], duration_s: placed.sceneDur };
    nextTo = ensureSceneFitsLayer(nextTo, moved);
    const scenes = (this.post.scenes || []).map((s) => {
      if (s.id === fromSceneId) return { ...s, layers: fromLayers };
      if (s.id === toSceneId) return nextTo;
      return s;
    });
    this.emitPost({ ...this.post, scenes });
    this.dirty.set(true);
    this.selectedSceneId.set(toSceneId);
    this.selectedLayerId.set(layerId);
    this.scheduleSave();
  }

  private onGanttMove(event: PointerEvent): void {
    const drag = this.ganttDrag;
    if (!drag) return;
    this.hoverTime.set(null);
    const dxSec = ((event.clientX - drag.startX) / Math.max(1, drag.trackWidth)) * drag.total;
    if (Math.abs(dxSec) > 0.02) drag.moved = true;
    if (drag.kind === 'scene') {
      if (drag.handle === 'move') return;
      const scene = (this.post.scenes || []).find((s) => s.id === drag.sceneId);
      if (!scene || this.isRefScene(scene)) return;
      this.resizeSceneFromDrag(scene, drag, dxSec);
      return;
    }
    if (drag.kind === 'layer' && drag.layerId) {
      let start = drag.origStart;
      let duration = drag.origDuration;
      let source = drag.origSourceStart;
      if (drag.handle === 'move') {
        const pointerAbs = this.absTimeFromClientX(event.clientX, drag.ganttInner || null);
        const abs = Math.max(0, pointerAbs - (drag.grabOffset || 0));
        const hoverSceneId = this.sceneIdFromPoint(event.clientX, event.clientY);
        const drop = this.resolveLayerDrop(abs, drag.origDuration, hoverSceneId, drag.sceneId);
        if (!drop) {
          this.ganttDropSceneId.set(null);
          return;
        }
        const target = drop.row.scene;
        if (!isSceneEnabled(target) || this.isRefScene(target)) {
          this.ganttDropSceneId.set(drag.sceneId);
          return;
        }
        this.ganttDropSceneId.set(target.id);
        start = Math.round(drop.local * 10) / 10;
        if (target.id !== drag.sceneId) {
          this.relocateLayerToScene(
            drag.layerId,
            drag.sceneId,
            target.id,
            start,
            duration,
            drag.origSourceStart,
          );
          drag.sceneId = target.id;
          return;
        }
      } else if (drag.handle === 'left') {
        const maxStart = drag.origStart + drag.origDuration - 0.1;
        start = Math.min(maxStart, Math.max(0, drag.origStart + dxSec));
        duration = Math.max(0.1, drag.origDuration - (start - drag.origStart));
        source = Math.max(
          0,
          drag.origSourceStart + (start - drag.origStart) * (drag.origPlaybackRate || 1),
        );
      } else {
        duration = Math.max(0.1, drag.origDuration + dxSec);
      }
      this.patchLayer(drag.layerId, {
        start_s: start,
        duration_s: duration,
        source_start_s: source,
      });
      return;
    }
    if (drag.kind === 'mask' && drag.layerId && drag.maskId) {
      const found = this.findLayer(drag.layerId);
      const sceneDur = this.timeline().find((r) => r.scene.id === drag.sceneId)?.duration || 5;
      const layerDur = found ? layerEffectiveDuration(found.layer, sceneDur) : 5;
      let start = drag.origStart;
      let duration = drag.origDuration;
      if (drag.handle === 'move') {
        start = Math.min(Math.max(0, drag.origStart + dxSec), Math.max(0, layerDur - 0.1));
        if (drag.origDuration != null) {
          duration = Math.min(duration, Math.max(0.1, layerDur - start));
        }
      } else if (drag.handle === 'left') {
        const maxStart = drag.origStart + drag.origDuration - 0.1;
        start = Math.min(maxStart, Math.max(0, drag.origStart + dxSec));
        duration = Math.max(0.1, drag.origDuration - (start - drag.origStart));
      } else {
        duration = Math.min(Math.max(0.1, drag.origDuration + dxSec), Math.max(0.1, layerDur - drag.origStart));
      }
      this.patchMask(drag.layerId, drag.maskId, { start_s: start, duration_s: duration });
    }
  }

  /**
   * Right handle: grow/shrink scene end, not before the last layer ends.
   * Left handle: move scene start (gap + duration + layer starts), not past the first layer
   * and not into negative gap.
   */
  private resizeSceneFromDrag(scene: Scene, drag: GanttDrag, dxSec: number): void {
    const lastEnd = Math.max(0.5, drag.lastLayerEnd ?? 0.5);
    const firstStart = Math.max(0, drag.firstLayerStart ?? 0);
    const origGap = Math.max(0, drag.origGap ?? 0);
    if (drag.handle === 'right') {
      const next = Math.max(lastEnd, drag.origDuration + dxSec);
      this.patchScene(drag.sceneId, { duration_s: Math.round(next * 10) / 10 });
      return;
    }
    if (drag.handle !== 'left') return;
    const minDelta = -origGap;
    const maxDelta = Math.min(firstStart, Math.max(0, drag.origDuration - 0.5));
    const delta = Math.round(Math.min(maxDelta, Math.max(minDelta, dxSec)) * 10) / 10;
    const newGap = Math.round((origGap + delta) * 10) / 10;
    const newDur = Math.round((drag.origDuration - delta) * 10) / 10;
    const starts = drag.origLayerStarts || [];
    const layers = (scene.layers || []).map((l) => {
      const orig = starts.find((s) => s.id === l.id);
      if (!orig) return l;
      return { ...l, start_s: Math.max(0, Math.round((orig.start_s - delta) * 10) / 10) };
    });
    this.patchScene(drag.sceneId, {
      gap_before_s: Math.max(0, newGap),
      duration_s: Math.max(0.5, newDur),
      layers,
    });
  }

  private endGanttDrag(): void {
    const drag = this.ganttDrag;
    if (!drag) return;
    this.ganttDrag = null;
    this.ganttDragging.set(false);
    this.ganttDropSceneId.set(null);
    // Click (no drag) on a clip/scene body seeks the playhead and refreshes preview.
    if (!drag.moved && drag.handle === 'move' && drag.pendingSeek != null) {
      this.seekTimeline(drag.pendingSeek);
      return;
    }
    this.scheduleSave();
  }

  onStageBackgroundDown(event: PointerEvent): void {
    if (event.target !== this.stageEl?.nativeElement) return;
    this.selectedLayerId.set(null);
    this.selectedMaskId.set(null);
    this.maskDrawMode.set(false);
  }

  onStageLayerDown(event: PointerEvent, clip: PreviewClip): void {
    event.stopPropagation();
    if (clip.locked) {
      if (clip.sceneId) this.selectedSceneId.set(clip.sceneId);
      this.selectedLayerId.set(null);
      this.selectedMaskId.set(null);
      return;
    }
    if (clip.isBackground || clip.kind === 'audio') return;
    if (this.maskDrawMode() && (clip.kind === 'image' || clip.kind === 'video')) {
      const pt = this.stagePoint(event);
      const local = this.stagePointToLayer(pt, clip);
      this.stageDrag = {
        mode: 'mask-draw',
        layerId: clip.id,
        sceneId: clip.sceneId,
        startX: local.x,
        startY: local.y,
        orig: { x: local.x, y: local.y, width: 2, height: 2 },
      };
      try {
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }
    this.selectLayer(clip.sceneId, clip.id);
    const pt = this.stagePoint(event);
    this.stageDrag = {
      mode: 'move',
      layerId: clip.id,
      sceneId: clip.sceneId,
      startX: pt.x,
      startY: pt.y,
      orig: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
    };
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
  }

  onStageResizeDown(event: PointerEvent, clip: PreviewClip, handle: CornerHandle): void {
    event.stopPropagation();
    event.preventDefault();
    if (clip.locked) return;
    this.selectLayer(clip.sceneId, clip.id);
    this.selectedMaskId.set(null);
    const pt = this.stagePoint(event);
    const visual = this.clipVisualCanvasBox(clip);
    this.stageDrag = {
      mode: 'resize',
      handle,
      layerId: clip.id,
      sceneId: clip.sceneId,
      startX: pt.x,
      startY: pt.y,
      orig: visual,
      layerBox: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
      lockAspect: !event.shiftKey,
    };
    try {
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
  }

  onStageMaskDown(event: PointerEvent, clip: PreviewClip, mask: LayerMask): void {
    event.stopPropagation();
    this.selectMask(clip.id, mask.id);
    const pt = this.stagePoint(event);
    const local = this.stagePointToLayer(pt, clip);
    this.stageDrag = {
      mode: 'mask-move',
      layerId: clip.id,
      sceneId: clip.sceneId,
      maskId: mask.id,
      startX: local.x,
      startY: local.y,
      orig: {
        x: Number(mask.x) || 0,
        y: Number(mask.y) || 0,
        width: Number(mask.width) || 40,
        height: Number(mask.height) || 40,
      },
    };
  }

  onStageMaskResizeDown(
    event: PointerEvent,
    clip: PreviewClip,
    mask: LayerMask,
    handle: CornerHandle,
  ): void {
    event.stopPropagation();
    event.preventDefault();
    this.selectMask(clip.id, mask.id);
    const pt = this.stagePoint(event);
    const local = this.stagePointToLayer(pt, clip);
    this.stageDrag = {
      mode: 'mask-resize',
      handle,
      layerId: clip.id,
      sceneId: clip.sceneId,
      maskId: mask.id,
      startX: local.x,
      startY: local.y,
      orig: {
        x: Number(mask.x) || 0,
        y: Number(mask.y) || 0,
        width: Number(mask.width) || 40,
        height: Number(mask.height) || 40,
      },
    };
  }

  private stagePoint(event: PointerEvent): { x: number; y: number } {
    const el = this.stageEl?.nativeElement;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100,
    };
  }

  private stagePointToLayer(pt: { x: number; y: number }, clip: PreviewClip): { x: number; y: number } {
    return {
      x: ((pt.x - clip.x) / Math.max(1, clip.width)) * 100,
      y: ((pt.y - clip.y) / Math.max(1, clip.height)) * 100,
    };
  }

  private onStageMove(event: PointerEvent): void {
    const drag = this.stageDrag;
    if (!drag) return;
    const pt = this.stagePoint(event);
    if (drag.mode === 'move') {
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      this.patchLayer(drag.layerId, {
        x: drag.orig.x + dx,
        y: drag.orig.y + dy,
      });
      return;
    }
    if (drag.mode === 'resize' && drag.handle) {
      const box = clampLayerBox(
        this.resizeBox(
          drag.orig,
          drag.handle,
          pt.x - drag.startX,
          pt.y - drag.startY,
          drag.lockAspect !== false,
        ),
      );
      const fromBox = drag.layerBox || drag.orig;
      const found = this.findLayer(drag.layerId);
      const patch: Partial<Layer> = { ...box };
      if (found?.layer.masks?.length) {
        patch.masks = remapMasksToBox(found.layer.masks, fromBox, box);
      }
      this.patchLayer(drag.layerId, patch);
      return;
    }
    const clip = this.liveClips().find((c) => c.id === drag.layerId);
    if (!clip) return;
    const local = this.stagePointToLayer(pt, clip);
    if (drag.mode === 'mask-draw') {
      const x = Math.min(drag.startX, local.x);
      const y = Math.min(drag.startY, local.y);
      const width = Math.abs(local.x - drag.startX);
      const height = Math.abs(local.y - drag.startY);
      if (!drag.maskId && (width > 2 || height > 2)) {
        const mask = this.addMask(drag.sceneId, drag.layerId, clampMaskRect({ x, y, width, height }));
        drag.maskId = mask?.id;
      } else if (drag.maskId) {
        this.patchMask(drag.layerId, drag.maskId, clampMaskRect({ x, y, width: Math.max(2, width), height: Math.max(2, height) }));
      }
      return;
    }
    if (drag.mode === 'mask-move' && drag.maskId) {
      this.patchMask(
        drag.layerId,
        drag.maskId,
        clampMaskRect({
          x: drag.orig.x + (local.x - drag.startX),
          y: drag.orig.y + (local.y - drag.startY),
          width: drag.orig.width,
          height: drag.orig.height,
        }),
      );
      return;
    }
    if (drag.mode === 'mask-resize' && drag.handle && drag.maskId) {
      const box = this.resizeBox(drag.orig, drag.handle, local.x - drag.startX, local.y - drag.startY, false);
      this.patchMask(drag.layerId, drag.maskId, clampMaskRect(box));
    }
  }

  private resizeBox(
    orig: { x: number; y: number; width: number; height: number },
    handle: CornerHandle,
    dx: number,
    dy: number,
    lockAspect: boolean,
  ): { x: number; y: number; width: number; height: number } {
    let { x, y, width, height } = orig;
    const aspect = orig.width / Math.max(0.01, orig.height);
    if (handle.includes('e')) width = orig.width + dx;
    if (handle.includes('w')) {
      width = orig.width - dx;
      x = orig.x + dx;
    }
    if (handle.includes('s')) height = orig.height + dy;
    if (handle.includes('n')) {
      height = orig.height - dy;
      y = orig.y + dy;
    }
    if (lockAspect) {
      if (Math.abs(dx) > Math.abs(dy)) height = width / aspect;
      else width = height * aspect;
      if (handle.includes('w')) x = orig.x + orig.width - width;
      if (handle.includes('n')) y = orig.y + orig.height - height;
    }
    return { x, y, width, height };
  }

  private endStageDrag(): void {
    if (!this.stageDrag) return;
    if (this.stageDrag.mode === 'mask-draw') this.maskDrawMode.set(false);
    this.stageDrag = null;
    this.scheduleSave();
  }

  toggleMaskDraw(): void {
    this.maskDrawMode.update((v) => !v);
  }

  addMaskForSelection(): void {
    const found = this.findLayer(this.selectedLayerId());
    if (!found) return;
    this.addMask(found.sceneId, found.layer.id);
  }

  addMask(
    sceneId: string | null | undefined,
    layerId: string,
    rect?: { x: number; y: number; width: number; height: number },
  ): LayerMask | null {
    const found = this.findLayer(layerId);
    if (!found) return null;
    if (found.layer.type !== 'image' && found.layer.type !== 'video') return null;
    const box = clampMaskRect(rect || { x: 30, y: 30, width: 40, height: 40 });
    const mask: LayerMask = {
      id: newUid(),
      type: 'rect',
      kind: 'transparency',
      title: `Mask ${(found.layer.masks || []).length + 1}`,
      ...box,
      start_s: 0,
      duration_s: null,
    };
    this.patchLayer(layerId, { masks: [...(found.layer.masks || []), mask] });
    this.selectedLayerId.set(layerId);
    this.selectedMaskId.set(mask.id);
    if (sceneId) this.selectedSceneId.set(sceneId);
    return mask;
  }

  deleteMask(layerId: string, maskId: string): void {
    const found = this.findLayer(layerId);
    if (!found) return;
    this.patchLayer(layerId, {
      masks: (found.layer.masks || []).filter((m) => m.id !== maskId),
    });
    if (this.selectedMaskId() === maskId) this.selectedMaskId.set(null);
  }

  setSelectedGeom(field: 'x' | 'y' | 'width' | 'height', value: number | string): void {
    const id = this.selectedLayerId();
    if (!id) return;
    const layer = this.findLayer(id)?.layer;
    if (!layer) return;
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const next = clampLayerBox({
      x: Number(layer.x) || 0,
      y: Number(layer.y) || 0,
      width: Math.max(5, Number(layer.width) || 40),
      height: Math.max(5, Number(layer.height) || 40),
      [field]: n,
    });
    this.patchLayer(id, {
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height,
    });
  }

  setSelectedColor(value: string): void {
    const id = this.selectedLayerId();
    if (!id) return;
    this.patchLayer(id, { color: normalizeHexColor(value) });
  }

  fitSelectedToMedia(): void {
    const id = this.selectedLayerId();
    if (!id) return;
    const layer = this.findLayer(id)?.layer;
    const maxPct = Math.min(100, Math.max(Number(layer?.width) || 40, Number(layer?.height) || 40, 40));
    void this.refitLayerToMedia(id, maxPct, true);
  }

  private mediaLayerBox(
    asset: PaletteAsset,
    maxPct: number,
  ): { x: number; y: number; width: number; height: number } {
    const ar = this.rememberedMediaAspect(asset) ?? this.assetMediaAspect(asset) ?? 1;
    return centeredLayerBox(
      layerBoxFromMediaAspect(
        ar,
        canvasAspectRatio(this.post?.target_format, this.isVideo()),
        maxPct,
      ),
    );
  }

  private assetMediaAspect(asset: PaletteAsset | null | undefined): number | null {
    if (!asset) return null;
    const w = Number(asset.width);
    const h = Number(asset.height);
    if (w > 0 && h > 0) return w / h;
    return null;
  }

  private rememberedMediaAspect(asset: PaletteAsset | null | undefined): number | null {
    this.mediaAspectByKey();
    if (!asset) return null;
    const key = this.assetKey(asset);
    const cached = this.mediaAspectByKey()[key];
    return cached && cached > 0 ? cached : null;
  }

  private rememberMediaAspect(asset: PaletteAsset | string | null | undefined, aspect: number): void {
    const key = typeof asset === 'string' ? asset : asset ? this.assetKey(asset) : '';
    if (!key || !Number.isFinite(aspect) || aspect <= 0) return;
    const cur = this.mediaAspectByKey()[key];
    if (cur && Math.abs(cur - aspect) < 0.001) return;
    this.mediaAspectByKey.update((m) => ({ ...m, [key]: aspect }));
  }

  mediaFrame(clip: PreviewClip): { left: number; top: number; width: number; height: number } {
    if ((clip.kind !== 'image' && clip.kind !== 'video') || !clip.mediaAspect) {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
    return containedMediaFrame(
      clip.mediaAspect,
      clip.width,
      clip.height,
      canvasAspectRatio(this.post?.target_format, this.isVideo()),
    );
  }

  private clipVisualCanvasBox(clip: PreviewClip): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    if ((clip.kind !== 'image' && clip.kind !== 'video') || !clip.mediaAspect) {
      return { x: clip.x, y: clip.y, width: clip.width, height: clip.height };
    }
    return containedMediaBox(
      clip,
      clip.mediaAspect,
      canvasAspectRatio(this.post?.target_format, this.isVideo()),
    );
  }

  onStageMediaMeta(event: Event, clip: PreviewClip): void {
    const el = event.target as HTMLVideoElement;
    const ar = (el.videoWidth || 1) / Math.max(1, el.videoHeight || 1);
    const found = this.findLayer(clip.id);
    const asset = found ? this.resolveAsset(found.layer.asset_id) : null;
    this.rememberMediaAspect(asset || clip.url, ar);
    if (this.selectedLayerId() === clip.id) void this.syncSelectedMediaBounds(ar);
    if (!this.playing()) {
      this.forceMediaSeek = true;
      this.syncAllMedia(true);
    }
  }

  onStageImageLoad(event: Event, clip: PreviewClip): void {
    const el = event.target as HTMLImageElement;
    const ar = (el.naturalWidth || 1) / Math.max(1, el.naturalHeight || 1);
    const found = this.findLayer(clip.id);
    const asset = found ? this.resolveAsset(found.layer.asset_id) : null;
    this.rememberMediaAspect(asset || clip.url, ar);
    if (this.selectedLayerId() === clip.id) void this.syncSelectedMediaBounds(ar);
  }

  private async syncSelectedMediaBounds(knownAspect?: number): Promise<void> {
    const id = this.selectedLayerId();
    if (!id) return;
    const found = this.findLayer(id);
    if (!found || (found.layer.type !== 'image' && found.layer.type !== 'video')) return;
    const asset = this.resolveAsset(found.layer.asset_id);
    const aspect =
      knownAspect && knownAspect > 0
        ? knownAspect
        : asset
          ? await this.measureMediaAspect(asset)
          : this.rememberedMediaAspect(asset);
    if (!aspect || aspect <= 0) return;
    if (asset) this.rememberMediaAspect(asset, aspect);
    const canvasAR = canvasAspectRatio(this.post?.target_format, this.isVideo());
    if (layerBoxMatchesMedia(found.layer, aspect, canvasAR)) return;
    const next = containedMediaBox(found.layer, aspect, canvasAR);
    const fromBox = {
      x: Number(found.layer.x) || 0,
      y: Number(found.layer.y) || 0,
      width: Math.max(0.1, Number(found.layer.width) || 40),
      height: Math.max(0.1, Number(found.layer.height) || 40),
    };
    const patch: Partial<Layer> = { ...next };
    if (found.layer.masks?.length) {
      patch.masks = remapMasksToBox(found.layer.masks, fromBox, next);
    }
    this.patchLayer(id, patch);
  }

  private measureMediaAspect(asset: PaletteAsset): Promise<number> {
    const cached = this.rememberedMediaAspect(asset);
    if (cached) return Promise.resolve(cached);
    const url = this.api.assetPlaybackUrl(asset, !!asset.is_global);
    if (!url) return Promise.resolve(this.assetMediaAspect(asset) ?? 1);
    if (isVideoAsset(asset.type)) {
      return new Promise((resolve) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        let done = false;
        const finish = (ar: number) => {
          if (done) return;
          done = true;
          try {
            v.removeAttribute('src');
            v.load();
          } catch {
            /* ignore */
          }
          const next = ar > 0 ? ar : this.assetMediaAspect(asset) ?? 1;
          this.rememberMediaAspect(asset, next);
          resolve(next);
        };
        v.onloadedmetadata = () =>
          finish((v.videoWidth || 1) / Math.max(1, v.videoHeight || 1));
        v.onerror = () => finish(this.assetMediaAspect(asset) ?? 1);
        setTimeout(() => finish(this.assetMediaAspect(asset) ?? 1), 4000);
        v.src = url;
      });
    }
    const stored = this.assetMediaAspect(asset);
    if (stored) return Promise.resolve(stored);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const ar = (img.naturalWidth || 1) / Math.max(1, img.naturalHeight || 1);
        this.rememberMediaAspect(asset, ar);
        resolve(ar);
      };
      img.onerror = () => resolve(1);
      img.src = url;
    });
  }

  private async refitLayerToMedia(
    layerId: string,
    maxPct: number,
    preserveCenter = true,
  ): Promise<void> {
    const found = this.findLayer(layerId);
    if (!found) return;
    const asset = this.resolveAsset(found.layer.asset_id);
    if (!asset || (found.layer.type !== 'image' && found.layer.type !== 'video')) return;
    const aspect = await this.measureMediaAspect(asset);
    const size = layerBoxFromMediaAspect(
      aspect,
      canvasAspectRatio(this.post?.target_format, this.isVideo()),
      maxPct,
    );
    let x: number;
    let y: number;
    if (preserveCenter) {
      const cx = (Number(found.layer.x) || 0) + (Number(found.layer.width) || 0) / 2;
      const cy = (Number(found.layer.y) || 0) + (Number(found.layer.height) || 0) / 2;
      x = cx - size.width / 2;
      y = cy - size.height / 2;
    } else {
      const centered = centeredLayerBox(size);
      x = centered.x;
      y = centered.y;
    }
    this.patchLayer(layerId, { x, y, width: size.width, height: size.height });
  }

  clipMaskCss(clip: PreviewClip): string | null {
    const active = (clip.masks || []).filter((m) =>
      maskActiveAt(m, clip.layerLocalT, clip.layerDur),
    );
    return transparencyMaskCss(active);
  }

  maskActiveAtPlayhead(clip: PreviewClip, mask: LayerMask): boolean {
    return maskActiveAt(mask, clip.layerLocalT, clip.layerDur);
  }

  private findLayer(layerId: string | null | undefined): {
    sceneId: string | null;
    layer: Layer;
  } | null {
    if (!layerId || !this.post) return null;
    if (this.isVideo()) {
      for (const scene of this.post.scenes || []) {
        const layer = (scene.layers || []).find((l) => l.id === layerId);
        if (layer) return { sceneId: scene.id, layer };
      }
      return null;
    }
    const layer = (this.post.layers || []).find((l) => l.id === layerId);
    return layer ? { sceneId: null, layer } : null;
  }

  private patchLayer(layerId: string, patch: Partial<Layer>): void {
    if (this.isVideo()) {
      const scenes = (this.post.scenes || []).map((scene) => {
        const layers = (scene.layers || []).map((l) => (l.id === layerId ? { ...l, ...patch } : l));
        const layer = layers.find((l) => l.id === layerId);
        const next = { ...scene, layers };
        return layer ? ensureSceneFitsLayer(next, layer) : next;
      });
      this.emitPost({ ...this.post, scenes });
      this.dirty.set(true);
      this.scheduleSave();
      return;
    }
    this.emitPost({
      ...this.post,
      layers: (this.post.layers || []).map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
    });
    this.dirty.set(true);
    this.scheduleSave();
  }

  private patchMask(layerId: string, maskId: string, patch: Partial<LayerMask>): void {
    const found = this.findLayer(layerId);
    if (!found) return;
    const masks = (found.layer.masks || []).map((m) => (m.id === maskId ? { ...m, ...patch } : m));
    this.patchLayer(layerId, { masks });
  }

  private schedulePreview(): void {
    if (this.playing()) return;
    // Live HTML5 preview already follows the playhead. Server stills (ffmpeg)
    // on every scrub open file handles until the API hits EMFILE.
    if (this.isVideo()) {
      this.forceMediaSeek = true;
      this.cdr.detectChanges();
      this.syncAllMedia(true);
      requestAnimationFrame(() => this.syncAllMedia(true));
      return;
    }
    if (this.scrubTimer) clearTimeout(this.scrubTimer);
    this.scrubTimer = setTimeout(() => void this.refreshPreview(), 180);
  }

  hexBg(color: string | null | undefined): string {
    return normalizeHexColor(color);
  }

  hasActiveSceneBg(): boolean {
    return !isTransparentBg(this.activeScene()?.background_color);
  }

  /** Color-input value only; transparent scenes use a neutral placeholder until the user picks. */
  sceneBgPickerValue(): string {
    const raw = this.activeScene()?.background_color;
    if (isTransparentBg(raw)) return '#000000';
    return normalizeHexColor(raw, '#000000');
  }

  clearActiveSceneBg(): void {
    this.onActiveSceneBg(null);
  }

  onSceneDuration(index: number, value: number | string): void {
    const scenes = [...(this.post.scenes || [])];
    const scene = scenes[index];
    if (!scene || this.isRefScene(scene)) return;
    scenes[index] = {
      ...scene,
      duration_s: Math.max(0.5, Number(value) || 0.5),
    };
    this.emitPost({ ...this.post, scenes });
    this.dirty.set(true);
    this.scheduleSave();
  }

  onSceneBgColor(index: number, value: string | null): void {
    const scenes = [...(this.post.scenes || [])];
    const scene = scenes[index];
    if (!scene || this.isRefScene(scene)) return;
    scenes[index] = { ...scene, background_color: normalizeOptionalHexColor(value) };
    this.emitPost({ ...this.post, scenes });
    this.dirty.set(true);
    this.scheduleSave();
  }

  onPostBgColor(value: string): void {
    this.emitPost({ ...this.post, background_color: normalizeOptionalHexColor(value) });
    this.dirty.set(true);
    this.scheduleSave();
  }

  onActiveSceneBg(value: string | null): void {
    this.onSceneBgColor(this.activeSceneIndex(), value);
  }

  onActiveBgColor(value: string): void {
    if (!this.isVideo()) {
      this.onPostBgColor(value);
      return;
    }
    const t = this.absTime();
    const rows = this.timeline();
    const hit =
      rows.find((r) => t >= r.start - 1e-6 && t < r.end) ||
      rows.find((r) => r.scene.id === this.selectedSceneId()) ||
      rows[0];
    if (!hit) return;
    const index = (this.post.scenes || []).findIndex((s) => s.id === hit.scene.id);
    if (index < 0) return;
    this.onSceneBgColor(index, value);
  }

  canStepScene(dir: -1 | 1): boolean {
    const idx = this.activeSceneIndex();
    const count = this.timeline().length;
    if (idx < 0 || count < 2) return false;
    const next = idx + dir;
    return next >= 0 && next < count;
  }

  private scrollGanttToAbs(abs: number): void {
    const el = this.ganttScrollEl?.nativeElement;
    if (!el) return;

    const total = this.scrubMax();
    if (total <= 0) return;

    const innerPx = this.ganttInnerPx();
    const max = Math.max(0, innerPx - el.clientWidth);

    // Center the desired time under the viewport.
    const px = Math.max(0, Math.min(innerPx, (abs / total) * innerPx));
    const nextLeft = px - el.clientWidth * 0.5;
    el.scrollLeft = Math.max(0, Math.min(max, nextLeft));
  }

  stepScene(dir: -1 | 1): void {
    if (!this.canStepScene(dir)) return;
    const rows = this.timeline();
    const next = rows[this.activeSceneIndex() + dir];
    if (!next) return;
    this.selectedSceneId.set(next.scene.id);
    this.selectedLayerId.set(null);
    this.selectedMaskId.set(null);
    this.seekTimeline(next.start);
    // Ensure the new scene is visible in the horizontal Gantt viewport.
    this.scrollGanttToAbs(next.start);
  }

  onActiveSceneDuration(value: number | string): void {
    this.onSceneDuration(this.activeSceneIndex(), value);
  }

  onReusableChange(value: boolean): void {
    this.emitPost({ ...this.post, is_reusable: !!value });
    this.dirty.set(true);
    this.scheduleSave();
  }

  clearLayerSelection(): void {
    this.selectedLayerId.set(null);
    this.selectedMaskId.set(null);
    this.maskDrawMode.set(false);
  }

  deleteSceneById(sceneId: string): void {
    const index = (this.post.scenes || []).findIndex((s) => s.id === sceneId);
    if (index >= 0) this.deleteScene(index);
  }

  deleteActiveScene(): void {
    const id = this.activeScene()?.id;
    if (id) this.deleteSceneById(id);
  }

  deleteGanttRow(row: GanttLayerRow): void {
    if (row.kind === 'mask' && row.maskId) {
      this.deleteMask(row.layerId, row.maskId);
      return;
    }
    const index = (this.post.scenes || []).findIndex((s) => s.id === row.sceneId);
    if (index >= 0) this.deleteLayer(index, row.layerId);
    if (this.selectedLayerId() === row.layerId) this.clearLayerSelection();
  }

  zoomLabel(): string {
    return `${Math.round(this.previewZoom() * 100)}%`;
  }

  nudgeZoom(dir: number): void {
    const step = 0.25;
    const next = Math.min(3, Math.max(0.5, Math.round((this.previewZoom() + dir * step) * 100) / 100));
    this.previewZoom.set(next);
  }

  resetZoom(): void {
    this.previewZoom.set(1);
  }

  onPreviewWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.nudgeZoom(event.deltaY > 0 ? -1 : 1);
  }

  addScene(): void {
    this.seedBlankScene();
  }

  isRefScene(scene: Scene | null | undefined): boolean {
    return !!String(scene?.ref_post_id || '').trim();
  }

  toggleReusablePicker(): void {
    this.showReusablePicker.update((open) => !open);
  }

  reusableDuration(clip: Post): number {
    return postRuntimeSeconds(clip, this.api.projectPosts());
  }

  insertReusable(clip: Post): void {
    this.insertReusableId(clip.id);
  }

  private insertReusableId(
    refId: string,
    opts: { afterAbs?: number } = {},
  ): void {
    this.showReusablePicker.set(false);
    if (!this.isVideo()) return;
    const id = String(refId || '').trim();
    if (!id || id === this.post.id) return;
    const all = this.api.projectPosts() as Post[];
    const src = all.find((p) => p.id === id);
    if (!src || src.type !== 'video') {
      this.snackbar.show('Reusable post not found', 'error');
      return;
    }
    if (this.refsReach(id, this.post.id)) {
      this.snackbar.show('That clip already references this post', 'error');
      return;
    }
    const duration = postRuntimeSeconds(src, all);
    const scenes = [...(this.post.scenes || [])];
    let target: Scene | null = null;
    let localStart = 0;

    if (opts.afterAbs != null) {
      const row = this.timeline().find((r) => opts.afterAbs! >= r.start && opts.afterAbs! < r.end);
      if (row) {
        target = scenes.find((s) => s.id === row.scene.id) || null;
        localStart = Math.max(0, opts.afterAbs - row.start);
      }
    }
    if (!target) {
      const sel = this.selectedSceneId();
      target = (sel ? scenes.find((s) => s.id === sel) : null) || scenes[scenes.length - 1] || null;
      if (target) {
        const row = this.timeline().find((r) => r.scene.id === target!.id);
        if (row) localStart = Math.max(0, this.absTime() - row.start);
      }
    }
    if (!target) {
      this.seedBlankScene();
      const refreshed = [...(this.post.scenes || [])];
      target = refreshed[refreshed.length - 1] || null;
      if (!target) return;
      localStart = 0;
      const layer: Layer = {
        id: newUid(),
        type: 'ref',
        title: src.name || 'Reusable clip',
        ref_post_id: src.id,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        z_index: 0,
        opacity: 1,
        start_s: 0,
        duration_s: duration,
      };
      refreshed[refreshed.length - 1] = {
        ...target,
        duration_s: Math.max(0.5, duration),
        ref_post_id: null,
        layers: [layer],
      };
      this.emitPost({ ...this.post, scenes: refreshed });
      this.selectedSceneId.set(target.id);
      this.selectedLayerId.set(layer.id);
      this.selectedMaskId.set(null);
      this.dirty.set(true);
      this.scheduleSave();
      this.snackbar.show(`Added “${src.name}” as a layer`, 'success');
      void this.syncScriptForInsertedReusable(target.id, src, duration);
      return;
    }
    if (this.isRefScene(target)) {
      // Migrate legacy whole-scene refs first so we can attach alongside other layers.
      this.migrateLegacyRefScene(target.id);
      target = scenes.find((s) => s.id === target!.id) || target;
    }

    const layer: Layer = {
      id: newUid(),
      type: 'ref',
      title: src.name || 'Reusable clip',
      ref_post_id: src.id,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      z_index: (target.layers || []).length,
      opacity: 1,
      start_s: localStart,
      duration_s: duration,
    };
    const sceneDur = Math.max(
      0.5,
      Number(target.duration_s) || 5,
      localStart + duration,
    );
    const nextLayers = [...(target.layers || []), layer];
    const idx = scenes.findIndex((s) => s.id === target!.id);
    if (idx < 0) return;
    scenes[idx] = {
      ...target,
      duration_s: sceneDur,
      ref_post_id: null,
      layers: nextLayers,
    };
    this.emitPost({ ...this.post, scenes });
    this.selectedSceneId.set(target.id);
    this.selectedLayerId.set(layer.id);
    this.selectedMaskId.set(null);
    this.dirty.set(true);
    this.scheduleSave();
    this.snackbar.show(`Added “${src.name}” as a layer`, 'success');
    void this.syncScriptForInsertedReusable(target.id, src, duration);
  }

  /** Convert a legacy scene-level reusable slot into a full-bleed ref layer. */
  private migrateLegacyRefScene(sceneId: string): void {
    const scenes = [...(this.post.scenes || [])];
    const idx = scenes.findIndex((s) => s.id === sceneId);
    if (idx < 0) return;
    const scene = scenes[idx];
    const refId = String(scene.ref_post_id || '').trim();
    if (!refId) return;
    const already = (scene.layers || []).some(
      (l) => l.type === 'ref' && String(l.ref_post_id || '').trim() === refId,
    );
    const layers = [...(scene.layers || [])];
    if (!already) {
      layers.unshift({
        id: newUid(),
        type: 'ref',
        title: scene.name || 'Reusable clip',
        ref_post_id: refId,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        z_index: 0,
        opacity: 1,
        start_s: 0,
        duration_s: Math.max(0.5, Number(scene.duration_s) || 0.5),
      });
    }
    scenes[idx] = { ...scene, ref_post_id: null, layers };
    this.emitPost({ ...this.post, scenes });
  }

  private refsReach(fromId: string, targetId: string, seen?: Set<string>): boolean {
    if (!fromId || fromId === targetId) return fromId === targetId;
    const stack = seen || new Set<string>();
    if (stack.has(fromId)) return false;
    stack.add(fromId);
    const post = (this.api.projectPosts() as Post[]).find((p) => p.id === fromId);
    for (const scene of post?.scenes || []) {
      const rid = String(scene.ref_post_id || '').trim();
      if (rid && this.refsReach(rid, targetId, stack)) return true;
      for (const layer of scene.layers || []) {
        if (layer.type !== 'ref') continue;
        const lid = String(layer.ref_post_id || '').trim();
        if (lid && this.refsReach(lid, targetId, stack)) return true;
      }
    }
    return false;
  }

  private seedBlankScene(): void {
    const scenes = [...(this.post.scenes || [])];
    const scene: Scene = {
      id: newUid(),
      name: `Scene ${scenes.length + 1}`,
      duration_s: 5,
      gap_before_s: 0,
      background_asset_id: null,
      background_format: this.post.target_format || 'portrait',
      background_color: null,
      layers: [],
      ref_post_id: null,
    };
    scenes.push(scene);
    this.emitPost({ ...this.post, scenes });
    this.selectedSceneId.set(scene.id);
    this.dirty.set(true);
    this.scheduleSave();
  }

  async deleteScene(index: number): Promise<void> {
    const scenes = [...(this.post.scenes || [])];
    const removed = scenes[index];
    if (!removed) return;
    if (scenes.length <= 1) {
      this.snackbar.show('A video needs at least one scene', 'error');
      return;
    }
    const ok = await this.dialogs.confirm({
      title: 'Delete scene',
      message: `Delete scene “${removed.name}”?`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    scenes.splice(index, 1);
    this.emitPost({ ...this.post, scenes });
    if (this.selectedSceneId() === removed.id) {
      this.selectedSceneId.set(scenes[0]?.id || null);
    }
    this.dirty.set(true);
    this.scheduleSave();
  }

  deleteLayer(sceneIndex: number, layerId: string): void {
    const scenes = [...(this.post.scenes || [])];
    const scene = scenes[sceneIndex];
    if (!scene) return;
    scenes[sceneIndex] = {
      ...scene,
      layers: (scene.layers || []).filter((l) => l.id !== layerId),
    };
    this.emitPost({ ...this.post, scenes });
    if (this.selectedLayerId() === layerId) {
      this.selectedLayerId.set(null);
      this.selectedMaskId.set(null);
    }
    this.dirty.set(true);
    this.scheduleSave();
  }

  closeVideoCtx(): void {
    this.videoCtx.set(null);
  }

  closeSceneCtx(): void {
    this.sceneCtx.set(null);
  }

  onSceneContextMenu(event: MouseEvent, sceneId: string): void {
    event.preventDefault();
    event.stopPropagation();
    const scene = (this.post.scenes || []).find((s) => s.id === sceneId);
    if (!scene || this.isRefScene(scene) || !isSceneEnabled(scene)) return;
    this.ganttDrag = null;
    this.ganttDragging.set(false);
    this.closeVideoCtx();
    this.selectedSceneId.set(sceneId);
    this.selectedLayerId.set(null);
    this.selectedMaskId.set(null);
    const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
    const occ = sceneLayerOccupancy(scene);
    const rowTl = this.timeline().find((r) => r.scene.id === sceneId);
    const local = rowTl ? this.absTime() - rowTl.start : -1;
    const minDur = Math.max(0.5, occ?.lastEnd ?? 0.5);
    const canTrimContent = !!occ && sceneDur - occ.lastEnd > 0.08;
    const canTrimPlayhead = local > 0.45 && local < sceneDur - 0.05 && local + 1e-3 >= minDur - 0.05;
    const canFitVideo = sceneVideoLayers(scene).length === 1;
    const pad = 8;
    const mw = 220;
    const mh = 160;
    let left = event.clientX;
    let top = event.clientY;
    if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
    if (top + mh > window.innerHeight - pad) top = window.innerHeight - mh - pad;
    this.sceneCtx.set({
      open: true,
      x: Math.max(pad, left),
      y: Math.max(pad, top),
      sceneId,
      canTrimContent: canTrimContent || canFitVideo,
      canTrimPlayhead,
      canFitVideo,
      playheadLocal: canTrimPlayhead ? local : null,
    });
  }

  ctxTrimSceneToContent(): void {
    const ctx = this.sceneCtx();
    this.closeSceneCtx();
    if (!ctx) return;
    this.trimSceneToContent(ctx.sceneId);
  }

  ctxTrimSceneToPlayhead(): void {
    const ctx = this.sceneCtx();
    this.closeSceneCtx();
    if (!ctx || ctx.playheadLocal == null) return;
    const scene = (this.post.scenes || []).find((s) => s.id === ctx.sceneId);
    if (!scene || this.isRefScene(scene)) return;
    const occ = sceneLayerOccupancy(scene);
    const minDur = Math.max(0.5, occ?.lastEnd ?? 0.5);
    const next = Math.max(minDur, Math.round(ctx.playheadLocal * 10) / 10);
    this.patchScene(ctx.sceneId, { duration_s: next });
    this.snackbar.show(`Scene trimmed to ${this.formatDur(next)}`, 'info');
  }

  ctxFitSceneToVideo(): void {
    const ctx = this.sceneCtx();
    this.closeSceneCtx();
    if (!ctx) return;
    this.fitSceneToSoleVideo(ctx.sceneId);
  }

  private trimSceneToContent(sceneId: string): void {
    const scene = (this.post.scenes || []).find((s) => s.id === sceneId);
    if (!scene || this.isRefScene(scene)) return;
    const next = trimSceneToOccupancy(scene);
    if (Math.abs(Number(next.duration_s) - Number(scene.duration_s)) < 0.05) {
      this.snackbar.show('Scene is already fitted to its layers', 'info');
      return;
    }
    this.patchScene(sceneId, { duration_s: next.duration_s });
    this.snackbar.show(`Scene trimmed to ${this.formatDur(Number(next.duration_s))}`, 'info');
  }

  private fitSceneToSoleVideo(sceneId: string): void {
    const scene = (this.post.scenes || []).find((s) => s.id === sceneId);
    if (!scene || this.isRefScene(scene)) return;
    const videos = sceneVideoLayers(scene);
    if (videos.length !== 1) {
      this.snackbar.show('Fit to video needs exactly one video in the scene', 'info');
      return;
    }
    const video = videos[0];
    const start = Math.max(0, Number(video.start_s) || 0);
    const dur = layerEffectiveDuration(video, Number(scene.duration_s) || 5);
    const occ = sceneLayerOccupancy(scene);
    const need = Math.max(0.5, start + dur, occ?.lastEnd ?? 0);
    this.patchScene(sceneId, { duration_s: Math.round(need * 10) / 10 });
    this.snackbar.show(`Scene length set to ${this.formatDur(need)} to match video`, 'info');
  }

  onVideoBarContextMenu(event: MouseEvent, row: GanttLayerRow): void {
    if (row.kind !== 'layer' || !row.layerId) return;
    const found = this.findLayer(row.layerId);
    if (!found || found.layer.type !== 'video') return;
    event.preventDefault();
    event.stopPropagation();
    this.ganttDrag = null;
    this.ganttDragging.set(false);
    this.ganttDropSceneId.set(null);
    this.selectLayer(row.sceneId, row.layerId);
    const scene = found.sceneId
      ? (this.post.scenes || []).find((s) => s.id === found.sceneId)
      : null;
    const sceneDur = Math.max(0.5, Number(scene?.duration_s) || 5);
    const start = Math.max(0, Number(found.layer.start_s) || 0);
    const dur = layerEffectiveDuration(found.layer, sceneDur);
    const end = start + dur;
    const rowTl = this.timeline().find((r) => r.scene.id === row.sceneId);
    const track = (event.currentTarget as HTMLElement).closest('.cs-gantt-inner') as HTMLElement | null
      || ((event.currentTarget as HTMLElement).closest('.cs-gantt-track') as HTMLElement | null);
    const clickAbs = this.absTimeFromClientX(event.clientX, track);
    // Seek so preview + “Split at playhead” match the clicked point.
    this.seekTimeline(clickAbs);
    const clickLocal = rowTl ? clickAbs - rowTl.start : start + dur / 2;
    const playheadLocal = clickLocal;
    const canSplitHere = clickLocal > start + 0.1 && clickLocal < end - 0.1;
    const canSplitPlayhead = canSplitHere;
    const pad = 8;
    const mw = 200;
    const mh = 220;
    let left = event.clientX;
    let top = event.clientY;
    if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
    if (top + mh > window.innerHeight - pad) top = window.innerHeight - mh - pad;
    this.videoCtx.set({
      open: true,
      x: Math.max(pad, left),
      y: Math.max(pad, top),
      sceneId: row.sceneId,
      layerId: row.layerId,
      splitHereLocal: canSplitHere ? clickLocal : null,
      splitPlayheadLocal: canSplitPlayhead ? playheadLocal : null,
      muteAudio: !!found.layer.mute_audio,
      fadeIn: found.layer.transition_in === 'fade-in',
      fadeOut: found.layer.transition_out === 'fade-out',
    });
  }

  ctxToggleMute(): void {
    const ctx = this.videoCtx();
    if (!ctx) return;
    this.setLayerMute(ctx.layerId, !ctx.muteAudio);
    this.closeVideoCtx();
  }

  toggleSelectedVideoMute(): void {
    const layer = this.selectedLayer();
    if (!layer || layer.type !== 'video') return;
    this.setLayerMute(layer.id, !layer.mute_audio);
  }

  private setLayerMute(layerId: string, mute: boolean): void {
    this.patchLayer(layerId, { mute_audio: mute });
    this.snackbar.show(mute ? 'Audio removed' : 'Audio restored', 'info');
  }

  ctxToggleFadeIn(): void {
    const ctx = this.videoCtx();
    if (!ctx) return;
    this.patchLayer(ctx.layerId, {
      transition_in: ctx.fadeIn ? 'none' : 'fade-in',
    });
    this.closeVideoCtx();
  }

  ctxToggleFadeOut(): void {
    const ctx = this.videoCtx();
    if (!ctx) return;
    this.patchLayer(ctx.layerId, {
      transition_out: ctx.fadeOut ? 'none' : 'fade-out',
    });
    this.closeVideoCtx();
  }

  ctxSplitHere(): void {
    const ctx = this.videoCtx();
    this.closeVideoCtx();
    if (!ctx || ctx.splitHereLocal == null) return;
    this.splitVideoLayerAt(ctx.sceneId, ctx.layerId, ctx.splitHereLocal);
  }

  ctxSplitPlayhead(): void {
    const ctx = this.videoCtx();
    this.closeVideoCtx();
    if (!ctx || ctx.splitPlayheadLocal == null) return;
    this.splitVideoLayerAt(ctx.sceneId, ctx.layerId, ctx.splitPlayheadLocal);
  }

  ctxDeleteSection(): void {
    const ctx = this.videoCtx();
    this.closeVideoCtx();
    if (!ctx) return;
    const index = (this.post.scenes || []).findIndex((s) => s.id === ctx.sceneId);
    if (index < 0) return;
    this.deleteLayer(index, ctx.layerId);
    this.snackbar.show('Clip section deleted', 'info');
  }

  /** Split a video layer at scene-local time — JSON only; source file unchanged. */
  splitVideoLayerAt(sceneId: string, layerId: string, splitLocalS: number): boolean {
    const scene = (this.post.scenes || []).find((s) => s.id === sceneId);
    if (!scene) return false;
    const layer = (scene.layers || []).find((l) => l.id === layerId);
    if (!layer || layer.type !== 'video') return false;
    const sceneDur = Math.max(0.5, Number(scene.duration_s) || 0.5);
    const start = Math.max(0, Number(layer.start_s) || 0);
    const dur = layerEffectiveDuration(layer, sceneDur);
    const end = start + dur;
    const t = Number(splitLocalS);
    if (!Number.isFinite(t) || t <= start + 0.1 || t >= end - 0.1) {
      this.snackbar.show('Move closer to the middle of the clip to split', 'info');
      return false;
    }
    const leftDur = t - start;
    const rightDur = end - t;
    const srcStart = Math.max(0, Number(layer.source_start_s) || 0);
    const rate = layerPlaybackRate(layer);
    const groupId = String(layer.clip_group_id || '').trim() || newUid();
    const left: Layer = {
      ...layer,
      duration_s: leftDur,
      clip_group_id: groupId,
      source_start_s: srcStart,
      playback_rate: rate,
    };
    const right: Layer = {
      ...JSON.parse(JSON.stringify(layer)),
      id: newUid(),
      start_s: t,
      duration_s: rightDur,
      source_start_s: srcStart + leftDur * rate,
      clip_group_id: groupId,
      playback_rate: rate,
    };
    const layers = [...(scene.layers || [])];
    const idx = layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return false;
    layers.splice(idx, 1, left, right);
    let nextScene: Scene = ensureSceneFitsLayer({ ...scene, layers }, left);
    nextScene = ensureSceneFitsLayer(nextScene, right);
    this.patchScene(sceneId, {
      layers: nextScene.layers || layers,
      duration_s: nextScene.duration_s,
    });
    this.selectedLayerId.set(right.id);
    this.snackbar.show('Clip split', 'success');
    return true;
  }

  async addTextLayer(sceneId?: string | null): Promise<void> {
    const targetId = sceneId ?? this.selectedSceneId();
    if (this.isVideo()) {
      const target = this.ensureScene(targetId);
      if (this.isRefScene(target)) {
        this.snackbar.show('Reusable clips are edited in their own post — add a new scene instead', 'info');
        return;
      }
    }
    const text = await this.dialogs.prompt({
      title: 'Text layer',
      message: 'Enter the text shown on this layer.',
      label: 'Text',
      placeholder: 'Text',
      confirmText: 'Add',
      required: false,
    });
    if (text == null) return;
    const layer: Layer = {
      id: newUid(),
      type: 'text',
      title: 'Text',
      text: text.trim() || 'Text',
      x: 10,
      y: 72,
      width: 80,
      height: 18,
      z_index: 8,
      font_size: 36,
      color: '#ffffff',
      font_weight: 'bold',
      opacity: 1,
      start_s: 0,
    };
    if (this.isVideo()) {
      const scene = this.ensureScene(targetId);
      if (!scene) return;
      this.patchScene(scene.id, {
        layers: [...(scene.layers || []), { ...layer, z_index: (scene.layers || []).length }],
      });
      this.selectedSceneId.set(scene.id);
      this.selectedLayerId.set(layer.id);
      return;
    }
    this.emitPost({ ...this.post, layers: [...(this.post.layers || []), layer] });
    this.dirty.set(true);
    this.selectedLayerId.set(layer.id);
    this.scheduleSave();
  }

  async addVoiceLayer(sceneId?: string | null): Promise<void> {
    if (!this.isVideo()) return;
    const targetId = sceneId ?? this.selectedSceneId();
    const target = this.ensureScene(targetId);
    if (this.isRefScene(target)) {
      this.snackbar.show('Reusable clips are edited in their own post — add a new scene instead', 'info');
      return;
    }
    const text = await this.dialogs.prompt({
      title: 'Voice layer',
      message: 'Enter the spoken script for this voice layer.',
      label: 'Script',
      placeholder: 'Spoken text…',
      confirmText: 'Add',
      required: true,
    });
    if (text == null) return;
    const spoken = text.trim();
    if (!spoken) return;
    this.insertVoiceLayer(targetId, spoken);
  }

  /** Open attach-audio dialog for the selected text layer. */
  openAttachAudioForSelectedText(): void {
    if (!this.isVideo()) return;
    const layer = this.selectedLayer();
    const sceneId = this.selectedSceneId();
    if (!layer || layer.type !== 'text' || !sceneId) return;
    if (this.isRefScene(this.activeScene())) {
      this.snackbar.show('Reusable clips are edited in their own post', 'info');
      return;
    }
    const spoken = String(layer.text || '').trim();
    if (!spoken) {
      this.snackbar.show('Text layer has no content', 'error');
      return;
    }
    this.attachAudioText.set(spoken);
    this.showAttachAudio.set(true);
  }

  closeAttachAudio(): void {
    this.showAttachAudio.set(false);
    this.attachAudioText.set('');
  }

  async onAttachAudioResult(result: AttachAudioResult): Promise<void> {
    const layer = this.selectedLayer();
    const sceneId = this.selectedSceneId();
    const text = String(result.text || '').trim();
    if (!layer || layer.type !== 'text' || !sceneId || !text) {
      this.closeAttachAudio();
      return;
    }
    this.busy.set(true);
    try {
      if (result.mode === 'generate') {
        const voiceId = this.insertVoiceLayer(sceneId, text, {
          start_s: Math.max(0, Number(layer.start_s) || 0),
          duration_s: layer.duration_s ?? null,
        });
        if (!voiceId) return;
        // Persist voice layer first so synthesize can find it.
        await this.persist(true);
        const updated = await this.api.synthesizePostTts(this.post.id, {
          scene_id: sceneId,
          layer_id: voiceId,
          text,
          voice: result.voice,
          mood: result.mood,
          pacing: result.pacing,
        });
        if (updated) {
          this.emitPost(updated);
          this.dirty.set(false);
          this.selectedSceneId.set(sceneId);
          this.selectedLayerId.set(voiceId);
        }
        this.closeAttachAudio();
        return;
      }

      const file = result.file;
      if (!file) {
        this.snackbar.show('No recording to attach', 'error');
        return;
      }
      const asset = await this.api.uploadProjectAsset(file, {
        post_id: this.post.id,
        asset_type: 'sound',
        group: 'Script voice',
      });
      if (!asset) return;
      const voiceId = this.insertVoiceLayer(sceneId, text, {
        start_s: Math.max(0, Number(layer.start_s) || 0),
        duration_s: asset.duration_s ?? layer.duration_s ?? null,
      });
      if (!voiceId) return;
      const scene = this.ensureScene(sceneId);
      if (!scene) return;
      const layers = (scene.layers || []).map((l) =>
        l.id === voiceId
          ? {
              ...l,
              asset_id: asset.id,
              duration_s:
                asset.duration_s != null
                  ? Math.max(0.5, Number(asset.duration_s))
                  : l.duration_s,
            }
          : l,
      );
      this.patchScene(sceneId, { layers });
      this.selectedLayerId.set(voiceId);
      this.snackbar.show('Recording attached as a voice layer', 'success');
      this.closeAttachAudio();
    } finally {
      this.busy.set(false);
    }
  }

  private insertVoiceLayer(
    sceneId: string | null,
    spoken: string,
    timing?: { start_s?: number; duration_s?: number | null },
  ): string | null {
    const scene = this.ensureScene(sceneId);
    if (!scene || this.isRefScene(scene)) return null;
    const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
    const row = this.timeline().find((r) => r.scene.id === scene.id);
    const start =
      timing?.start_s != null
        ? Math.max(0, Number(timing.start_s) || 0)
        : row
          ? Math.max(0, this.absTime() - row.start)
          : 0;
    const duration =
      timing?.duration_s != null && Number.isFinite(Number(timing.duration_s))
        ? Math.max(0.5, Number(timing.duration_s))
        : Math.max(0.5, sceneDur - start);
    const layer: Layer = {
      id: newUid(),
      type: 'tts',
      title: 'Voice',
      text: spoken,
      x: 8,
      y: 78,
      width: 84,
      height: 16,
      z_index: (scene.layers || []).length + 1,
      opacity: 1,
      start_s: start,
      duration_s: duration,
      tts_volume: 1,
      show_caption: false,
      tts_voice: this.post.default_tts_voice || null,
    };
    this.patchScene(scene.id, { layers: [...(scene.layers || []), layer] });
    this.selectedSceneId.set(scene.id);
    this.selectedLayerId.set(layer.id);
    return layer.id;
  }

  /** Ask for 0.5×–20× when placing a video. Cancel returns null (do not add). */
  private async promptVideoSpeed(): Promise<number | null> {
    const raw = await this.dialogs.prompt({
      title: 'Video speed',
      message:
        'Playback speed for this clip. 0.5× is the slowest; speed-up is allowed up to 20×. Timeline length is source duration ÷ speed.',
      label: 'Speed (0.5–20×)',
      defaultValue: String(this.lastVideoSpeed || 1),
      placeholder: '1',
      confirmText: 'Add clip',
      required: true,
    });
    if (raw == null) return null;
    const cleaned = String(raw).trim().replace(/[×xX]\s*$/, '').replace(/,/g, '.');
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.snackbar.show('Enter a speed between 0.5× and 20×', 'error');
      return null;
    }
    const rate = normalizePlaybackRate(parsed, 1);
    if (Math.abs(rate - parsed) > 0.001) {
      this.snackbar.show(`Speed clamped to ${rate}× (0.5–20)`, 'info');
    }
    this.lastVideoSpeed = rate;
    return rate;
  }

  async addAsset(
    asset: PaletteAsset,
    opts: {
      sceneId?: string;
      localStart?: number;
      asBottom?: boolean;
      closePicker?: boolean;
    } = {},
  ): Promise<void> {
    if (asset.type === 'model') {
      this.snackbar.show('3D models can’t be placed on the timeline yet', 'info');
      return;
    }
    if (asset.type === 'icon') {
      this.addIconLayer(asset, opts);
      return;
    }
    if (isVideoAsset(asset.type)) {
      void this.api.ensureVideoPreview(asset, { global: !!asset.is_global });
      this.startPreviewPoll();
    }
    const ref = this.assetKey(asset);
    if (this.isVideo()) {
      let scene =
        this.ensureScene(opts.sceneId || this.pickerSceneId || this.selectedSceneId()) ||
        this.ensureScene(null);
      if (!scene) {
        this.snackbar.show('Add a scene first', 'error');
        return;
      }
      if (this.isRefScene(scene)) {
        this.snackbar.show('Reusable clips are edited in their own post — add a new scene instead', 'info');
        return;
      }
      const sceneId = scene.id;
      const row = this.timeline().find((r) => r.scene.id === sceneId);
      const sceneDur0 = Math.max(0.5, Number(scene.duration_s) || row?.duration || 5);
      const abs = this.absTime();
      const playheadInScene = !!row && abs >= row.start - 1e-4 && abs < row.end - 1e-4;
      const local =
        opts.localStart != null
          ? Math.max(0, opts.localStart)
          : playheadInScene && row
            ? Math.max(0, abs - row.start)
            : 0;
      const mediaDur = Number(asset.duration_s);
      const visuals = (scene.layers || []).filter((l) => l.type === 'image' || l.type === 'video');
      const asBottom =
        opts.asBottom ??
        (!visuals.length && (isImageAsset(asset.type) || isVideoAsset(asset.type)));
      const mediaBox = this.mediaLayerBox(asset, asBottom ? 100 : 80);
      let layer: Layer;
      let nextSceneDur = sceneDur0;
      if (isVideoAsset(asset.type)) {
        const rate = await this.promptVideoSpeed();
        if (rate == null) return;
        scene = (this.post.scenes || []).find((s) => s.id === sceneId) || scene;
        const sceneDur = Math.max(0.5, Number(scene.duration_s) || sceneDur0);
        const remain = Math.max(0.5, sceneDur - Math.min(local, sceneDur - 0.1));
        const sourceDur = Number.isFinite(mediaDur) && mediaDur > 0 ? mediaDur : remain;
        const timelineDur = Math.max(0.1, Math.round((sourceDur / rate) * 100) / 100);
        const placed = fitLayerInScene(asBottom ? 0 : local, timelineDur, sceneDur, {
          growScene: true,
        });
        nextSceneDur = placed.sceneDur;
        layer = {
          id: newUid(),
          type: 'video',
          title: (asset.name || 'Video').slice(0, 40),
          asset_id: ref,
          ...mediaBox,
          z_index: asBottom ? 0 : (scene.layers || []).length,
          opacity: 1,
          start_s: placed.start_s,
          duration_s: placed.duration_s,
          source_start_s: 0,
          playback_rate: rate,
        };
      } else if (isAudioAsset(asset.type)) {
        const placed = fitLayerInScene(
          local,
          Number.isFinite(mediaDur) && mediaDur > 0 ? mediaDur : Math.max(0.5, sceneDur0 - local),
          sceneDur0,
        );
        layer = {
          id: newUid(),
          type: 'audio',
          title: (asset.name || 'Audio').slice(0, 40),
          asset_id: ref,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          z_index: (scene.layers || []).length,
          opacity: 1,
          tts_volume: 0.8,
          start_s: placed.start_s,
          duration_s: placed.duration_s,
        };
      } else {
        const placed = fitLayerInScene(
          asBottom ? 0 : local,
          asBottom
            ? sceneDur0
            : Number.isFinite(mediaDur) && mediaDur > 0
              ? mediaDur
              : Math.max(0.5, sceneDur0 - local),
          sceneDur0,
          { growScene: asBottom },
        );
        nextSceneDur = placed.sceneDur;
        layer = {
          id: newUid(),
          type: 'image',
          title: (asset.name || 'Image').slice(0, 40),
          asset_id: ref,
          ...mediaBox,
          z_index: asBottom ? 0 : (scene.layers || []).length,
          opacity: 1,
          start_s: placed.start_s,
          duration_s: placed.duration_s,
        };
      }
      const layers = asBottom
        ? [layer, ...(scene.layers || []).map((l, i) => ({ ...l, z_index: i + 1 }))]
        : [...(scene.layers || []), layer];
      let nextScene: Scene = { ...scene, layers, duration_s: nextSceneDur };
      nextScene = ensureSceneFitsLayer(nextScene, layer);
      this.patchScene(sceneId, {
        layers: nextScene.layers || layers,
        duration_s: nextScene.duration_s,
      });
      this.selectLayer(sceneId, layer.id);
      this.snackbar.show(`Added ${asset.name} to ${scene.name || 'scene'}`, 'success');
      void this.syncScriptForAddedAsset(sceneId, asset, layer);
      if (isImageAsset(asset.type) || isVideoAsset(asset.type)) {
        void this.refitLayerToMedia(layer.id, asBottom ? 100 : 80);
      }
      return;
    }
    if (!isImageAsset(asset.type)) {
      this.snackbar.show('Image posts can only take image assets', 'error');
      return;
    }
    const layer: Layer = {
      id: newUid(),
      type: 'image',
      title: (asset.name || 'Image').slice(0, 40),
      asset_id: ref,
      ...this.mediaLayerBox(asset, 80),
      z_index: (this.post.layers || []).length,
      opacity: 1,
    };
    this.emitPost({ ...this.post, layers: [...(this.post.layers || []), layer] });
    this.dirty.set(true);
    this.selectedLayerId.set(layer.id);
    this.scheduleSave();
    void this.refitLayerToMedia(layer.id, 80);
  }

  private addIconLayer(
    asset: PaletteAsset,
    opts: {
      sceneId?: string;
      localStart?: number;
      closePicker?: boolean;
    } = {},
  ): void {
    const set = String(asset.icon_set || 'material');
    const name = String(asset.icon_name || '').trim();
    if (!name) {
      this.snackbar.show('Unknown icon', 'error');
      return;
    }
    const layer: Layer = {
      id: newUid(),
      type: 'icon',
      title: (asset.name || name).slice(0, 40),
      icon_set: set,
      icon_name: name,
      text: name,
      x: 40,
      y: 40,
      width: 20,
      height: 20,
      z_index: 8,
      opacity: 1,
      color: '#ffffff',
      start_s: 0,
    };
    if (this.isVideo()) {
      const scene =
        this.ensureScene(opts.sceneId || this.pickerSceneId || this.selectedSceneId()) ||
        this.ensureScene(null);
      if (!scene) {
        this.snackbar.show('Add a scene first', 'error');
        return;
      }
      if (this.isRefScene(scene)) {
        this.snackbar.show('Reusable clips are edited in their own post — add a new scene instead', 'info');
        return;
      }
      const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
      const row = this.timeline().find((r) => r.scene.id === scene.id);
      const abs = this.absTime();
      const playheadInScene = !!row && abs >= row.start - 1e-4 && abs < row.end - 1e-4;
      const local =
        opts.localStart != null
          ? Math.max(0, opts.localStart)
          : playheadInScene && row
            ? Math.max(0, abs - row.start)
            : 0;
      const start = clampLayerStartInScene(local, 0.1, sceneDur);
      const placed = {
        ...layer,
        z_index: (scene.layers || []).length,
        start_s: start,
        duration_s: Math.max(0.5, sceneDur - start),
      };
      this.patchScene(scene.id, { layers: [...(scene.layers || []), placed] });
      this.selectedSceneId.set(scene.id);
      this.selectedLayerId.set(placed.id);
      this.snackbar.show(`Added ${asset.name} icon`, 'success');
      void this.syncScriptForAddedAsset(scene.id, asset, placed);
      return;
    }
    const placed = { ...layer, z_index: (this.post.layers || []).length };
    this.emitPost({ ...this.post, layers: [...(this.post.layers || []), placed] });
    this.dirty.set(true);
    this.selectedLayerId.set(placed.id);
    this.scheduleSave();
    this.snackbar.show(`Added ${asset.name} icon`, 'success');
  }

  private ensureScene(sceneId: string | null): Scene | null {
    const scenes = this.post?.scenes || [];
    if (sceneId) {
      const found = scenes.find((s) => s.id === sceneId);
      if (found) return found;
    }
    if (scenes[0]) return scenes[0];
    this.addScene();
    return this.post.scenes?.[this.post.scenes.length - 1] || null;
  }

  private patchScene(sceneId: string, patch: Partial<Scene>): void {
    const scenes = (this.post.scenes || []).map((s) =>
      s.id === sceneId ? { ...s, ...patch } : s,
    );
    this.emitPost({ ...this.post, scenes });
    this.dirty.set(true);
    this.scheduleSave();
  }

  private visualMediaTypeForAsset(asset: PaletteAsset): VisualMediaTypeId {
    if (asset.type === 'icon') return 'illustration';
    if (isVideoAsset(asset.type)) return 'video';
    if (isAudioAsset(asset.type)) {
      const t = String(asset.type || '').toLowerCase();
      return t === 'sound' || t === 'sfx' ? 'sound' : 'music';
    }
    return normalizeVisualMediaType(asset.type) || 'photo';
  }

  private buildAddAssetScriptTag(asset: PaletteAsset, layer: Layer): string {
    const mediaType = this.visualMediaTypeForAsset(asset);
    const name = String(asset.name || layer.title || 'Asset').trim() || 'Asset';
    const assetKey = this.assetKey(asset);
    const desc = `${name} · #${assetKey}`;
    const durRaw = Number(layer.duration_s);
    const dur =
      visualMediaTypeSupportsDuration(mediaType) && Number.isFinite(durRaw) && durRaw > 0
        ? durRaw
        : null;
    const detail = formatTypedVisualDetail(mediaType, desc, dur);
    const start = Math.max(0, Number(layer.start_s) || 0);
    return formatScriptCueTag('ADD ASSET', detail, start > 0.05 ? start : null);
  }

  /** Keep the active script in sync when timeline assets are placed on a scene. */
  private async syncScriptForAddedAsset(
    sceneId: string,
    asset: PaletteAsset,
    layer: Layer,
  ): Promise<void> {
    const activeId = this.post.active_script_id;
    if (!activeId || !this.isVideo()) return;
    try {
      const doc = await this.api.getScript(this.post.id, activeId);
      const scriptDoc = doc?.script;
      if (!scriptDoc || scriptDoc.frozen) return;
      const current = String(scriptDoc.script || '');
      if (!current.trim()) return;
      const tag = this.buildAddAssetScriptTag(asset, layer);
      const next = appendCueToScriptForTimelineScene(
        current,
        this.post.scenes || [],
        sceneId,
        tag,
      );
      if (!next || next === current) return;
      await this.api.updateScript(
        this.post.id,
        activeId,
        { script: next, source: 'edited' },
        undefined,
        { quiet: true },
      );
    } catch {
      /* script sync is best-effort */
    }
  }

  private async syncScriptForInsertedReusable(
    sceneId: string | null,
    clip: Post,
    _duration: number,
  ): Promise<void> {
    const activeId = this.post.active_script_id;
    if (!activeId || !this.isVideo() || !sceneId) return;
    try {
      const doc = await this.api.getScript(this.post.id, activeId);
      const scriptDoc = doc?.script;
      if (!scriptDoc || scriptDoc.frozen) return;
      const current = String(scriptDoc.script || '');
      const tag = formatScriptCueTag('REUSABLE POST', clip.id);
      const next = appendCueToScriptForTimelineScene(
        current,
        this.post.scenes || [],
        sceneId,
        tag,
      );
      if (!next || next === current) return;
      await this.api.updateScript(
        this.post.id,
        activeId,
        { script: next, source: 'edited' },
        undefined,
        { quiet: true },
      );
    } catch {
      /* script sync is best-effort */
    }
  }

  private layerZ(layer: Layer, fallback = 0): number {
    const z = Number(layer.z_index);
    return Number.isFinite(z) ? z : fallback;
  }

  /** Integer preview z-band for a host layer (and its expanded ref composite). */
  private previewZBand(layer: Layer, sortIndex: number): number {
    const z = Math.max(0, Math.round(this.layerZ(layer, sortIndex)));
    return PREVIEW_LAYER_Z0 + z * PREVIEW_Z_BAND;
  }

  /** Host scene/post color plate — sibling under media, never CSS background. */
  private hostFillClip(sceneId: string | null): PreviewClip | null {
    const color = this.activeBgColor();
    if (!color || color === 'transparent') return null;
    return {
      id: 'host-fill',
      kind: 'image',
      url: null,
      text: '',
      fill: color,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      opacity: 1,
      z: PREVIEW_STAGE_FILL_Z,
      mediaTime: 0,
      volume: 0,
      muteAudio: true,
      active: true,
      sceneId,
      masks: [],
      layerLocalT: 0,
      layerDur: 1,
      isBackground: true,
      locked: true,
    };
  }

  /** dir > 0 = forward (higher z / higher on timeline list); dir < 0 = back. */
  moveLayer(sceneId: string | null | undefined, layerId: string, dir: 1 | -1): void {
    if (!layerId || !this.post) return;
    if (this.isVideo()) {
      if (!sceneId) return;
      const scene = (this.post.scenes || []).find((s) => s.id === sceneId);
      if (!scene) return;
      const layers = [...(scene.layers || [])].sort((a, b) => this.layerZ(a) - this.layerZ(b));
      const idx = layers.findIndex((l) => l.id === layerId);
      if (idx < 0) return;
      const swap = idx + dir;
      if (swap < 0 || swap >= layers.length) return;
      const a = layers[idx];
      const b = layers[swap];
      const za = this.layerZ(a, idx);
      const zb = this.layerZ(b, swap);
      layers[idx] = { ...a, z_index: zb };
      layers[swap] = { ...b, z_index: za };
      this.patchScene(sceneId, { layers });
      return;
    }
    const layers = [...(this.post.layers || [])].sort((a, b) => this.layerZ(a) - this.layerZ(b));
    const idx = layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= layers.length) return;
    const a = layers[idx];
    const b = layers[swap];
    const za = this.layerZ(a, idx);
    const zb = this.layerZ(b, swap);
    layers[idx] = { ...a, z_index: zb };
    layers[swap] = { ...b, z_index: za };
    this.emitPost({ ...this.post, layers });
    this.dirty.set(true);
    this.scheduleSave();
  }

  private resolveAsset(rawId: string | null | undefined): PaletteAsset | null {
    const s = String(rawId || '');
    if (!s) return null;
    const global = s.startsWith('global:');
    const id = global ? s.slice(7) : s;
    if (global) {
      const g = this.api.globalAssets().find((a) => a.id === id);
      return g ? { ...g, is_global: true } : null;
    }
    const local = (this.api.currentProject()?.assets || []).find((a) => a.id === id);
    if (local) return local;
    const fallback = this.api.globalAssets().find((a) => a.id === id);
    return fallback ? { ...fallback, is_global: true } : null;
  }

  private buildLiveClips(): PreviewClip[] {
    if (!this.post) return [];
    if (!this.isVideo()) {
      const fill = this.hostFillClip(null);
      const bg = this.backgroundClip(this.post.background_asset_id, true);
      const layers = [...(this.post.layers || [])]
        .sort((a, b) => this.layerZ(a) - this.layerZ(b))
        .map((layer, i) => {
          const clip = this.clipFromLayer(layer, i, 0, 1e9, null);
          return clip ? { ...clip, z: this.previewZBand(layer, i) } : null;
        })
        .filter((c): c is PreviewClip => !!c);
      return [...(fill ? [fill] : []), ...(bg ? [bg] : []), ...layers].sort((a, b) => a.z - b.z);
    }
    const hit = this.resolveLiveHit();
    if (!hit) return [];
    const fill = this.hostFillClip(hit.hostSceneId);
    // Host scene (not locked nested view): compose local layers including ref embeds.
    if (!hit.locked) {
      const bg = this.backgroundClip(hit.scene.background_asset_id, true, false);
      const out: PreviewClip[] = [...(fill ? [fill] : []), ...(bg ? [bg] : [])];
      const sorted = [...(hit.scene.layers || [])].sort(
        (a, b) => this.layerZ(a) - this.layerZ(b),
      );
      sorted.forEach((layer, i) => {
        const zBand = this.previewZBand(layer, i);
        if (layer.type === 'ref') {
          out.push(
            ...this.clipsFromRefLayer(layer, i, hit.local, hit.duration, hit.hostSceneId, zBand),
          );
          return;
        }
        const clip = this.clipFromLayer(layer, i, hit.local, hit.duration, hit.hostSceneId);
        if (clip) out.push({ ...clip, z: zBand });
      });
      return out.sort((a, b) => a.z - b.z);
    }
    const bg = this.backgroundClip(hit.scene.background_asset_id, true, hit.locked);
    const layers = [...(hit.scene.layers || [])]
      .sort((a, b) => this.layerZ(a) - this.layerZ(b))
      .map((layer, i) => {
        const clip = this.clipFromLayer(
          layer,
          i,
          hit.local,
          hit.duration,
          hit.hostSceneId,
          hit.locked,
        );
        return clip ? { ...clip, z: this.previewZBand(layer, i) } : null;
      })
      .filter((c): c is PreviewClip => !!c);
    return [...(fill ? [fill] : []), ...(bg ? [bg] : []), ...layers].sort((a, b) => a.z - b.z);
  }

  /** Expand a reusable-post layer into remapped preview clips inside its box. */
  private clipsFromRefLayer(
    layer: Layer,
    index: number,
    local: number,
    sceneDur: number,
    hostSceneId: string,
    zBand: number,
  ): PreviewClip[] {
    if (!isLayerEnabled(layer)) return [];
    const start = Math.max(0, Number(layer.start_s) || 0);
    const rawDur = layer.duration_s == null ? sceneDur - start : Number(layer.duration_s);
    const dur = Math.max(0.05, Number.isFinite(rawDur) ? rawDur : sceneDur - start);
    const active = local >= start - 1e-6 && local < start + dur - 1e-6;
    const displayOpacity = active
      ? layerOpacityAt(layer, local, sceneDur)
      : Math.min(1, Math.max(0, Number(layer.opacity) ?? 1)) * 0.35;
    const lx = Number(layer.x) || 0;
    const ly = Number(layer.y) || 0;
    const lw = Number(layer.width) || 100;
    const lh = Number(layer.height) || 100;
    const mapBox = (nx: number, ny: number, nw: number, nh: number) => ({
      x: lx + (nx * lw) / 100,
      y: ly + (ny * lh) / 100,
      width: (nw * lw) / 100,
      height: (nh * lh) / 100,
    });

    const refId = String(layer.ref_post_id || '').trim();
    const all = this.api.projectPosts() as Post[];
    const ref = refId ? all.find((p) => p.id === refId) : null;
    if (!ref) {
      return [
        {
          id: `ref-missing:${layer.id}`,
          kind: 'text',
          url: null,
          text: 'Missing reusable',
          color: '#f87171',
          ...mapBox(8, 40, 84, 20),
          opacity: displayOpacity,
          z: zBand,
          mediaTime: 0,
          volume: 0,
          muteAudio: true,
          active,
          sceneId: hostSceneId,
          masks: [],
          layerLocalT: Math.max(0, local - start),
          layerDur: dur,
          isBackground: false,
        },
      ];
    }

    const nestedLocal = Math.max(0, local - start);
    const nestedHit = this.hitSceneInPost(
      ref,
      nestedLocal,
      all,
      new Set([String(this.post.id || ''), refId]),
    );
    if (!nestedHit) return [];

    const out: PreviewClip[] = [];
    const nestedFillRaw = !isTransparentBg(nestedHit.scene.background_color)
      ? nestedHit.scene.background_color
      : ref.background_color;
    if (!isTransparentBg(nestedFillRaw)) {
      out.push({
        id: `ref-fill:${layer.id}`,
        kind: 'image',
        url: null,
        text: '',
        fill: normalizeHexColor(nestedFillRaw),
        ...mapBox(0, 0, 100, 100),
        opacity: displayOpacity,
        z: zBand,
        mediaTime: 0,
        volume: 0,
        muteAudio: true,
        active,
        sceneId: hostSceneId,
        masks: [],
        layerLocalT: Math.max(0, local - start),
        layerDur: dur,
        isBackground: true,
        locked: true,
      });
    }
    const nestedBgId =
      String(nestedHit.scene.background_asset_id || '').trim() ||
      String(ref.background_asset_id || '').trim() ||
      null;
    const bg = this.backgroundClip(nestedBgId, active, false);
    if (bg) {
      out.push({
        ...bg,
        id: `ref-bg:${layer.id}:${bg.id}`,
        ...mapBox(0, 0, 100, 100),
        opacity: displayOpacity * (bg.opacity || 1),
        z: zBand + 1,
        mediaTime: bg.kind === 'video' ? nestedHit.local : 0,
        active,
        sceneId: hostSceneId,
        isBackground: true,
        locked: true,
      });
    }
    const nestedLayers = [...(nestedHit.scene.layers || [])].sort(
      (a, b) => this.layerZ(a) - this.layerZ(b),
    );
    nestedLayers.forEach((nested, i) => {
      if (nested.type === 'ref') return; // nested ref layers: export/render handles; preview skips one level
      const clip = this.clipFromLayer(
        nested,
        i,
        nestedHit.local,
        nestedHit.duration,
        hostSceneId,
        false,
      );
      if (!clip) return;
      out.push({
        ...clip,
        id: `ref:${layer.id}:${clip.id}`,
        ...mapBox(clip.x, clip.y, clip.width, clip.height),
        opacity: clip.opacity * (active ? Math.min(1, Math.max(0, Number(layer.opacity) ?? 1)) : 0.35),
        z: zBand + 2 + i,
        active: active && clip.active,
        volume: active ? clip.volume : 0,
      });
    });
    return out;
  }

  private resolveLiveHit(): {
    scene: Scene;
    local: number;
    duration: number;
    hostSceneId: string;
    locked: boolean;
  } | null {
    const abs = this.nowAbs();
    const rows = this.timeline();
    const row =
      rows.find((r) => abs >= r.start && abs < r.end - 0.0001) ||
      (abs >= this.scrubMax() - 0.05 ? rows[rows.length - 1] : null);
    if (!row) return null;
    const local = Math.max(0, abs - row.start);
    const refId = String(row.scene.ref_post_id || '').trim();
    if (!refId) {
      return {
        scene: row.scene,
        local,
        duration: row.duration,
        hostSceneId: row.scene.id,
        locked: false,
      };
    }
    const all = this.api.projectPosts() as Post[];
    const ref = all.find((p) => p.id === refId);
    if (!ref) {
      return {
        scene: row.scene,
        local,
        duration: row.duration,
        hostSceneId: row.scene.id,
        locked: true,
      };
    }
    const inner = this.hitSceneInPost(ref, local, all, new Set([String(this.post.id || '')]));
    if (!inner) {
      return {
        scene: row.scene,
        local,
        duration: row.duration,
        hostSceneId: row.scene.id,
        locked: true,
      };
    }
    return { ...inner, hostSceneId: row.scene.id, locked: true };
  }

  private hitSceneInPost(
    post: Post,
    abs: number,
    all: Post[],
    stack: Set<string>,
  ): { scene: Scene; local: number; duration: number } | null {
    const id = String(post.id || '');
    if (id && stack.has(id)) return null;
    if (id) stack.add(id);
    let t = 0;
    const scenes = (post.scenes || []).filter(isSceneEnabled);
    for (const scene of scenes) {
      t += Math.max(0, Number(scene.gap_before_s) || 0);
      const duration = this.slotDuration(scene, all, stack);
      const start = t;
      const end = t + duration;
      if (abs + 1e-6 >= start && abs < end - 1e-4) {
        const local = Math.max(0, abs - start);
        const nestedId = String(scene.ref_post_id || '').trim();
        if (nestedId) {
          const nested = all.find((p) => p.id === nestedId);
          if (nested) {
            const inner = this.hitSceneInPost(nested, local, all, stack);
            if (inner) return inner;
          }
        }
        return { scene, local, duration };
      }
      t = end;
    }
    const last = scenes[scenes.length - 1];
    if (!last) return null;
    return { scene: last, local: 0, duration: this.slotDuration(last, all, stack) };
  }

  private slotDuration(scene: Scene, all: Post[], stack: Set<string>): number {
    if (!isSceneEnabled(scene)) return 0;
    const refId = String(scene.ref_post_id || '').trim();
    if (refId) {
      const ref = all.find((p) => p.id === refId);
      return ref
        ? postRuntimeSeconds(ref, all, new Set(stack))
        : Math.max(0.5, Number(scene.duration_s) || 0.5);
    }
    return Math.max(0.5, Number(scene.duration_s) || 5);
  }

  private backgroundClip(
    rawId: string | null | undefined,
    active: boolean,
    locked = false,
  ): PreviewClip | null {
    if (!rawId) return null;
    const asset = this.resolveAsset(rawId);
    if (!asset) return null;
    const url = isVideoAsset(asset.type)
      ? this.api.assetPlaybackUrl(asset, !!asset.is_global)
      : this.api.assetThumbUrl(asset, !!asset.is_global) ||
        this.api.assetPlaybackUrl(asset, !!asset.is_global);
    if (!url) return null;
    return {
      id: locked ? `ref-bg:${rawId}` : `bg:${rawId}`,
      kind: isVideoAsset(asset.type) ? 'video' : 'image',
      url,
      text: '',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      opacity: 1,
      z: PREVIEW_STAGE_BG_Z,
      mediaTime: 0,
      volume: 0,
      muteAudio: true,
      active,
      sceneId: null,
      masks: [],
      layerLocalT: 0,
      layerDur: 1,
      isBackground: true,
      locked,
    };
  }

  private clipFromLayer(
    layer: Layer,
    index: number,
    local: number,
    sceneDur: number,
    sceneId: string | null,
    locked = false,
  ): PreviewClip | null {
    if (!isLayerEnabled(layer)) return null;
    const start = Math.max(0, Number(layer.start_s) || 0);
    const rawDur = layer.duration_s == null ? sceneDur - start : Number(layer.duration_s);
    const dur = Math.max(0.05, Number.isFinite(rawDur) ? rawDur : sceneDur - start);
    // Active only within [start, end). Avoid trailing-frame bleed after layer end.
    const active = local >= start - 1e-6 && local < start + dur - 1e-6;
    const rate = layerPlaybackRate(layer);
    const mediaTime =
      Math.max(0, Number(layer.source_start_s) || 0) + Math.max(0, local - start) * rate;
    // When inactive we still want a ghost preview of the layer box.
    const displayOpacity = active
      ? layerOpacityAt(layer, local, sceneDur)
      : Math.min(1, Math.max(0, Number(layer.opacity) ?? 1));
    const z = this.layerZ(layer, index);
    const type = String(layer.type || '');
    const muteAudio = type === 'video' && !!layer.mute_audio;
    const extra = {
      sceneId,
      masks: layer.masks || [],
      layerLocalT: Math.max(0, local - start),
      layerDur: dur,
      isBackground: false,
      locked,
    };
    const clipId = locked ? `ref:${sceneId || 'x'}:${layer.id}` : layer.id;
    if (type === 'text' || (type === 'tts' && layer.show_caption)) {
      return {
        id: clipId,
        kind: 'text',
        url: null,
        text: String(layer.text || '').trim(),
        color: layer.color ? normalizeHexColor(layer.color) : '#ffffff',
        x: Number(layer.x) || 0,
        y: Number(layer.y) || 0,
        width: Number(layer.width) || 80,
        height: Number(layer.height) || 16,
        opacity: displayOpacity,
        z,
        mediaTime: 0,
        volume: 0,
        muteAudio: false,
        active,
        ...extra,
      };
    }
    if (type === 'icon') {
      const iconName = String(layer.icon_name || layer.text || '').trim();
      if (!iconName) return null;
      const iconSet = String(layer.icon_set || 'material');
      return {
        id: clipId,
        kind: 'icon',
        url: iconSet === 'lucide' ? lucideSvgUrl(iconName) : null,
        text: iconName,
        iconSet,
        iconName,
        color: layer.color ? normalizeHexColor(layer.color) : '#ffffff',
        x: Number(layer.x) || 0,
        y: Number(layer.y) || 0,
        width: Number(layer.width) || 20,
        height: Number(layer.height) || 20,
        opacity: displayOpacity,
        z,
        mediaTime: 0,
        volume: 0,
        muteAudio: false,
        active,
        ...extra,
      };
    }
    const asset = this.resolveAsset(layer.asset_id);
    const url = asset ? this.api.assetPlaybackUrl(asset, !!asset.is_global) : null;
    const mediaAspect = this.rememberedMediaAspect(asset) ?? this.assetMediaAspect(asset) ?? undefined;
    if (type === 'audio' || type === 'tts') {
      if (!url) return null;
      const vol = Number(layer.tts_volume);
      return {
        id: clipId,
        kind: 'audio',
        url,
        text: '',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        opacity: 0,
        z,
        mediaTime,
        volume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1,
        muteAudio: false,
        active,
        ...extra,
      };
    }
    if (type === 'video') {
      const poster = asset ? this.api.assetThumbUrl(asset, !!asset.is_global) : null;
      if (!url && poster) {
        return {
          id: clipId,
          kind: 'image',
          url: poster,
          text: '',
          x: Number(layer.x) || 0,
          y: Number(layer.y) || 0,
          width: Number(layer.width) || 100,
          height: Number(layer.height) || 100,
          opacity: displayOpacity,
          z,
          mediaTime: 0,
          volume: 0,
          muteAudio: true,
          active,
          mediaAspect,
          poster,
          ...extra,
        };
      }
      if (!url) return null;
      return {
        id: clipId,
        kind: 'video',
        url,
        text: '',
        x: Number(layer.x) || 0,
        y: Number(layer.y) || 0,
        width: Number(layer.width) || 100,
        height: Number(layer.height) || 100,
        opacity: displayOpacity,
        z,
        mediaTime,
        playbackRate: rate,
        volume: muteAudio ? 0 : 1,
        muteAudio,
        active,
        mediaAspect,
        poster,
        ...extra,
      };
    }
    if (type === 'image' || isImageAsset(type)) {
      const still = asset ? this.api.assetThumbUrl(asset, !!asset.is_global) || url : url;
      if (!still) return null;
      return {
        id: clipId,
        kind: 'image',
        url: still,
        text: '',
        x: Number(layer.x) || 0,
        y: Number(layer.y) || 0,
        width: Number(layer.width) || 40,
        height: Number(layer.height) || 40,
        opacity: displayOpacity,
        z,
        mediaTime: 0,
        volume: 0,
        muteAudio: false,
        active,
        mediaAspect,
        ...extra,
      };
    }
    return null;
  }

  private collectAudioClips(): {
    key: string;
    url: string;
    startAbs: number;
    duration: number;
    volume: number;
    sourceStart: number;
  }[] {
    if (!this.isVideo()) return [];
    const clips: {
      key: string;
      url: string;
      startAbs: number;
      duration: number;
      volume: number;
      sourceStart: number;
    }[] = [];
    this.collectAudioFromPost(
      this.post,
      0,
      this.api.projectPosts() as Post[],
      new Set<string>(),
      clips,
    );
    const musicId = this.post?.music_asset_id;
    if (musicId) {
      const asset = this.resolveAsset(musicId);
      const url = asset ? this.api.assetPlaybackUrl(asset, !!asset.is_global) : null;
      if (url) {
        const volRaw = Number(this.post.music_volume);
        clips.push({
          key: `legacy-music:${musicId}`,
          url,
          startAbs: 0,
          duration: Math.max(0.5, this.scrubMax()),
          volume: Number.isFinite(volRaw) ? Math.min(1, Math.max(0, volRaw)) : 0.8,
          sourceStart: 0,
        });
      }
    }
    return clips;
  }

  private collectAudioFromPost(
    post: Post,
    offsetAbs: number,
    all: Post[],
    stack: Set<string>,
    clips: {
      key: string;
      url: string;
      startAbs: number;
      duration: number;
      volume: number;
      sourceStart: number;
    }[],
  ): void {
    const id = String(post.id || '');
    if (id && stack.has(id)) return;
    if (id) stack.add(id);
    let t = offsetAbs;
    for (const scene of post.scenes || []) {
      if (!isSceneEnabled(scene)) continue;
      t += Math.max(0, Number(scene.gap_before_s) || 0);
      const duration = this.slotDuration(scene, all, stack);
      const refId = String(scene.ref_post_id || '').trim();
      if (refId) {
        const ref = all.find((p) => p.id === refId);
        if (ref) this.collectAudioFromPost(ref, t, all, new Set(stack), clips);
      } else {
        for (const layer of scene.layers || []) {
          if (!isLayerEnabled(layer)) continue;
          const type = String(layer.type || '');
          if (type === 'ref') {
            const lid = String(layer.ref_post_id || '').trim();
            const ref = lid ? all.find((p) => p.id === lid) : null;
            if (ref) {
              const start = Math.max(0, Number(layer.start_s) || 0);
              this.collectAudioFromPost(ref, t + start, all, new Set(stack), clips);
            }
            continue;
          }
          if (type !== 'audio' && type !== 'tts') continue;
          const asset = this.resolveAsset(layer.asset_id);
          const url = asset ? this.api.assetPlaybackUrl(asset, !!asset.is_global) : null;
          if (!url) continue;
          const start = Math.max(0, Number(layer.start_s) || 0);
          const dur = layerEffectiveDuration(layer, duration);
          const vol = Number(layer.tts_volume);
          clips.push({
            key: `${post.id}:${layer.id}:${url}`,
            url,
            startAbs: t + start,
            duration: Math.max(0.05, dur),
            volume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1,
            sourceStart: Math.max(0, Number(layer.source_start_s) || 0),
          });
        }
      }
      t += duration;
    }
  }

  private releaseAudioEl(el: HTMLAudioElement): void {
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
      el.remove();
    } catch {
      /* ignore */
    }
  }

  private ensureAudioPlayer(clip: {
    key: string;
    url: string;
    startAbs: number;
    duration: number;
    volume: number;
    sourceStart: number;
  }): HTMLAudioElement {
    let entry = this.audioPlayers.get(clip.key);
    if (entry && entry.url === clip.url) {
      entry.startAbs = clip.startAbs;
      entry.duration = clip.duration;
      entry.volume = clip.volume;
      entry.sourceStart = clip.sourceStart;
      return entry.el;
    }
    if (entry) {
      this.releaseAudioEl(entry.el);
      this.audioPlayers.delete(clip.key);
    }
    const el = new Audio();
    el.preload = 'metadata';
    el.setAttribute('playsinline', '');
    el.src = clip.url;
    this.audioBus?.nativeElement.appendChild(el);
    this.audioPlayers.set(clip.key, {
      el,
      url: clip.url,
      startAbs: clip.startAbs,
      duration: clip.duration,
      volume: clip.volume,
      sourceStart: clip.sourceStart,
    });
    return el;
  }

  private disposePreviewAudio(): void {
    for (const entry of this.audioPlayers.values()) this.releaseAudioEl(entry.el);
    this.audioPlayers.clear();
  }

  private syncPreviewAudio(opts: { forceSeek?: boolean; unlock?: boolean } = {}): void {
    if (!this.isVideo()) {
      this.disposePreviewAudio();
      return;
    }
    const playing = this.playing();
    const abs = this.nowAbs();
    const clips = this.collectAudioClips();
    const nearbyPad = 2.5;
    const nearbyKeys = new Set<string>();
    for (const clip of clips) {
      const local = abs - clip.startAbs;
      if (local >= -nearbyPad && local < clip.duration + nearbyPad) nearbyKeys.add(clip.key);
    }
    for (const [key, entry] of [...this.audioPlayers.entries()]) {
      if (nearbyKeys.has(key)) continue;
      this.releaseAudioEl(entry.el);
      this.audioPlayers.delete(key);
    }
    for (const clip of clips) {
      if (!nearbyKeys.has(clip.key)) continue;
      const el = this.ensureAudioPlayer(clip);
      const local = abs - clip.startAbs;
      const active = local >= -0.02 && local < clip.duration;
      try {
        el.volume = clip.volume;
      } catch {
        /* ignore */
      }
      const mediaTime = clip.sourceStart + Math.max(0, local);
      if (opts.unlock && el.paused && !active) {
        // Unlock later-starting clips during the Play click gesture.
        el.muted = true;
        void el
          .play()
          .then(() => {
            el.pause();
            el.muted = false;
          })
          .catch(() => {
            el.muted = false;
          });
        continue;
      }
      if (!active || !playing) {
        if (!el.paused) el.pause();
        continue;
      }
      el.muted = false;
      const drift = Math.abs((el.currentTime || 0) - mediaTime);
      if (opts.forceSeek || el.paused || drift > 0.4) {
        try {
          el.currentTime = mediaTime;
        } catch {
          /* ignore until metadata */
        }
      }
      if (el.paused) this.safePlay(el);
    }
  }

  private syncAllMedia(forceSeek = false, unlock = false): void {
    const force = forceSeek || this.forceMediaSeek;
    this.forceMediaSeek = false;
    this.syncPreviewAudio({ forceSeek: force, unlock });
    this.syncMediaElements(force);
  }

  private pauseAllStageMedia(): void {
    const root = this.stageEl?.nativeElement;
    if (!root) return;
    for (const el of Array.from(root.querySelectorAll<HTMLMediaElement>('video, audio'))) {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
    }
    for (const entry of this.audioPlayers.values()) {
      try {
        entry.el.pause();
      } catch {
        /* ignore */
      }
    }
  }

  private safePlay(el: HTMLMediaElement, unmuteAfter = false): void {
    if (!this.playing()) return;
    if (!el || (!el.paused && !el.ended)) return;
    if (this.mediaPlayInflight.has(el)) return;
    const gen = this.playGen;
    const run = (async () => {
      try {
        await el.play();
      } catch {
        if (!this.playing() || gen !== this.playGen) return;
        try {
          el.muted = true;
          await el.play();
          if (unmuteAfter && this.playing() && gen === this.playGen) el.muted = false;
        } catch {
          /* autoplay blocked */
        }
      } finally {
        if (!this.playing() || gen !== this.playGen) {
          try {
            el.pause();
          } catch {
            /* ignore */
          }
        }
      }
    })();
    this.mediaPlayInflight.set(el, run);
    void run.finally(() => {
      if (this.mediaPlayInflight.get(el) === run) this.mediaPlayInflight.delete(el);
    });
  }

  /** Pause + set currentTime so a timeline click paints that exact source frame. */
  private seekPausedMediaEl(el: HTMLMediaElement, mediaTime: number): void {
    if (!Number.isFinite(mediaTime) || mediaTime < 0) return;
    try {
      el.pause();
    } catch {
      /* ignore */
    }
    const apply = (t: number) => {
      try {
        el.currentTime = Math.max(0, t);
      } catch {
        /* ignore until metadata */
      }
    };
    if (el.readyState < 1) {
      if (this.mediaMetaSeek.has(el)) return;
      this.mediaMetaSeek.add(el);
      el.addEventListener(
        'loadedmetadata',
        () => {
          this.mediaMetaSeek.delete(el);
          if (!this.playing()) this.syncAllMedia(true);
        },
        { once: true },
      );
      return;
    }
    const cur = el.currentTime || 0;
    if (Math.abs(cur - mediaTime) < 0.04) {
      // Same timestamp as last play/pause — nudge so the decoder actually presents.
      const nudge = mediaTime < 0.05 ? mediaTime + 0.05 : mediaTime - 0.04;
      const onNudge = () => {
        el.removeEventListener('seeked', onNudge);
        apply(mediaTime);
      };
      el.addEventListener('seeked', onNudge);
      apply(nudge);
      return;
    }
    apply(mediaTime);
  }

  private syncMediaElements(forceSeek = false): void {
    const playing = this.playing();
    const byId = new Map(this.buildLiveClips().map((c) => [c.id, c]));
    const fromQuery = this.mediaEls?.toArray().map((r) => r.nativeElement) || [];
    const fromDom = this.stageEl?.nativeElement
      ? Array.from(
          this.stageEl.nativeElement.querySelectorAll<HTMLVideoElement>('video[data-clip-id]'),
        )
      : [];
    const seen = new Set<HTMLMediaElement>();
    const els: HTMLMediaElement[] = [];
    for (const el of [...fromQuery, ...fromDom]) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      els.push(el);
    }
    for (const el of els) {
      const clip = byId.get(el.dataset['clipId'] || '');
      if (!clip || !clip.active || clip.kind !== 'video' || !clip.url) {
        if (!el.paused) el.pause();
        continue;
      }
      try {
        el.muted = !!clip.muteAudio;
        el.volume = clip.muteAudio ? 0 : Math.min(1, Math.max(0, clip.volume));
      } catch {
        /* ignore */
      }
      const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
      let appliedRate = 1;
      for (const candidate of [rate, Math.min(rate, 8), Math.min(rate, 4), Math.min(rate, 2), 1]) {
        try {
          el.playbackRate = candidate;
          appliedRate = el.playbackRate || candidate;
          break;
        } catch {
          /* try a slower rate */
        }
      }
      const drift = Math.abs((el.currentTime || 0) - clip.mediaTime);
      // While playing, trust playbackRate. Seeking on small drift (especially at
      // 10×) fires a new Range request every frame and exhausts server FDs.
      const driftLimit = playing ? Math.max(1.5, 0.45 * appliedRate) : 0.04;
      const buffering = playing && (el.seeking || el.readyState < 2);
      if (!playing && (forceSeek || drift > driftLimit)) {
        this.seekPausedMediaEl(el, clip.mediaTime);
        continue;
      }
      if (!buffering && (forceSeek || drift > driftLimit)) {
        if (el.readyState >= 1) {
          try {
            if (Number.isFinite(clip.mediaTime)) el.currentTime = clip.mediaTime;
          } catch {
            /* ignore until metadata */
          }
        } else if (!this.mediaMetaSeek.has(el)) {
          this.mediaMetaSeek.add(el);
          el.addEventListener(
            'loadedmetadata',
            () => {
              this.mediaMetaSeek.delete(el);
              this.syncAllMedia(true);
            },
            { once: true },
          );
        }
      }
      if (playing) this.safePlay(el, !clip.muteAudio);
      else if (!el.paused) el.pause();
    }
  }

  deleteImageLayer(layerId: string): void {
    this.emitPost({
      ...this.post,
      layers: (this.post.layers || []).filter((l) => l.id !== layerId),
    });
    this.dirty.set(true);
    this.scheduleSave();
  }

  onFormatChange(format: string): void {
    this.emitPost({ ...this.post, target_format: format });
    this.dirty.set(true);
    this.scheduleSave();
    void this.loadExportHint();
  }

  private emitPost(post: Post): void {
    this.post = post;
    this.layoutRev.update((n) => n + 1);
    this.postChange.emit(post);
  }

  private scheduleSave(): void {
    if (this.ganttDrag || this.stageDrag || this.playing()) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(true), 700);
  }

  async save(): Promise<void> {
    await this.persist(false);
    await this.refreshPreview();
  }

  private async persist(quiet: boolean): Promise<void> {
    if (quiet && this.playing()) return;
    this.busy.set(true);
    try {
      const saved = await this.api.updatePost(this.post, undefined, { quiet });
      if (saved) {
        this.emitPost(saved);
        this.dirty.set(false);
      }
    } finally {
      this.busy.set(false);
    }
  }

  async refreshPreview(): Promise<void> {
    if (this.playing()) return;
    if (this.isVideo()) {
      this.forceMediaSeek = true;
      this.syncAllMedia(true);
      return;
    }
    this.previewBusy.set(true);
    try {
      const url = await this.api.renderPostPreview(this.post.id, {
        abs_time_s: undefined,
      });
      this.revokePreview();
      this.objectUrl = url;
      this.previewUrl.set(url);
    } finally {
      this.previewBusy.set(false);
    }
  }

  async openExport(): Promise<void> {
    if (this.dirty()) await this.persist(true);
    this.goExport.emit();
  }

  private revokePreview(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
