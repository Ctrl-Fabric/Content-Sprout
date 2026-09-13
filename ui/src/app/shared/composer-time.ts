import type {
  Layer,
  LayerMask,
  Scene,
  ScaleDirection,
  ScaleEffectKind,
  TransitionDirection,
} from '../models/content-sprout.models';

export const TRANSITION_DIRECTIONS: TransitionDirection[] = [
  'N',
  'S',
  'E',
  'W',
  'NE',
  'NW',
  'SE',
  'SW',
];

export const SCALE_DIRECTIONS: ScaleDirection[] = [
  'center',
  'N',
  'S',
  'E',
  'W',
  'NE',
  'NW',
  'SE',
  'SW',
];

const DIR_VECTORS: Record<TransitionDirection, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  S: { dx: 0, dy: 1 },
  E: { dx: 1, dy: 0 },
  W: { dx: -1, dy: 0 },
  NE: { dx: 1, dy: -1 },
  NW: { dx: -1, dy: -1 },
  SE: { dx: 1, dy: 1 },
  SW: { dx: -1, dy: 1 },
};

export interface LayerVisualAt {
  opacity: number;
  /** Canvas-% offset applied during fly transitions. */
  offsetX: number;
  offsetY: number;
  /** Ken Burns scale factor (≥ 1). */
  scale: number;
  /** CSS transform-origin fractions 0–1. */
  scaleOriginX: number;
  scaleOriginY: number;
}

export function defaultTransitionDuration(layerDur: number): number {
  const dur = Math.max(0.1, Number(layerDur) || 0.1);
  return Math.min(0.5, dur / 4);
}

export function transitionInDuration(layer: Layer, layerDur: number): number {
  const custom = layer.transition_in_duration_s;
  if (custom != null && Number.isFinite(Number(custom)) && Number(custom) > 0) {
    return Math.min(layerDur, Number(custom));
  }
  return defaultTransitionDuration(layerDur);
}

export function transitionOutDuration(layer: Layer, layerDur: number): number {
  const custom = layer.transition_out_duration_s;
  if (custom != null && Number.isFinite(Number(custom)) && Number(custom) > 0) {
    return Math.min(layerDur, Number(custom));
  }
  return defaultTransitionDuration(layerDur);
}

function normalizeDirection(raw: unknown, fallback: TransitionDirection): TransitionDirection {
  const d = String(raw || '').trim().toUpperCase() as TransitionDirection;
  return TRANSITION_DIRECTIONS.includes(d) ? d : fallback;
}

function directionOffset(direction: TransitionDirection, amount: number): { offsetX: number; offsetY: number } {
  const v = DIR_VECTORS[direction];
  const mag = Math.hypot(v.dx, v.dy) || 1;
  const scale = (100 * amount) / mag;
  return { offsetX: v.dx * scale, offsetY: v.dy * scale };
}

export function transitionDirectionLabel(direction: TransitionDirection | null | undefined): string {
  switch (normalizeDirection(direction, 'S')) {
    case 'N':
      return '↑ N';
    case 'S':
      return '↓ S';
    case 'E':
      return '→ E';
    case 'W':
      return '← W';
    case 'NE':
      return '↗ NE';
    case 'NW':
      return '↖ NW';
    case 'SE':
      return '↘ SE';
    case 'SW':
      return '↙ SW';
    default:
      return '↓ S';
  }
}

export function scaleDirectionLabel(direction: ScaleDirection | null | undefined): string {
  const d = normalizeScaleDirection(direction);
  if (d === 'center') return 'Center';
  return transitionDirectionLabel(d);
}

function normalizeScaleDirection(raw: unknown): ScaleDirection {
  const d = String(raw || '')
    .trim()
    .toLowerCase();
  if (d === 'center' || d === 'middle') return 'center';
  const up = d.toUpperCase() as TransitionDirection;
  return TRANSITION_DIRECTIONS.includes(up) ? up : 'center';
}

export function scaleOriginFractions(direction: ScaleDirection | null | undefined): {
  x: number;
  y: number;
} {
  const d = normalizeScaleDirection(direction);
  if (d === 'center') return { x: 0.5, y: 0.5 };
  const v = DIR_VECTORS[d];
  return {
    x: v.dx < 0 ? 0 : v.dx > 0 ? 1 : 0.5,
    y: v.dy < 0 ? 0 : v.dy > 0 ? 1 : 0.5,
  };
}

/** Normalized source rect to keep after crop (x/y/w/h in 0–1). Null when crop is off. */
export interface LayerCropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function layerCropPercent(layer: Layer | null | undefined): number {
  const n = Number(layer?.crop_percent);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(90, n));
}

export function layerCropDirection(layer: Layer | null | undefined): ScaleDirection {
  return normalizeScaleDirection(layer?.crop_direction);
}

export function layerHasCrop(layer: Layer | null | undefined): boolean {
  return layerCropPercent(layer) > 0;
}

/**
 * Keep-rect after cropping ``percent``% away from ``direction``.
 * Center removes equally from all sides; cardinal/diagonal edges remove from those sides only.
 */
export function layerCropRect(layer: Layer | null | undefined): LayerCropRect | null {
  const pct = layerCropPercent(layer) / 100;
  if (pct <= 0) return null;
  const dir = layerCropDirection(layer);
  let x = 0;
  let y = 0;
  let w = 1;
  let h = 1;
  if (dir === 'center') {
    const inset = pct / 2;
    x = inset;
    y = inset;
    w = 1 - pct;
    h = 1 - pct;
  } else {
    const v = DIR_VECTORS[dir];
    if (v.dx < 0) {
      x = pct;
      w = 1 - pct;
    } else if (v.dx > 0) {
      w = 1 - pct;
    }
    if (v.dy < 0) {
      y = pct;
      h = 1 - pct;
    } else if (v.dy > 0) {
      h = 1 - pct;
    }
  }
  w = Math.max(0.05, Math.min(1, w));
  h = Math.max(0.05, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}

export function layerScaleEffect(layer: Layer | null | undefined): ScaleEffectKind {
  const raw = String(layer?.scale_effect || 'none')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (raw === 'scale-in' || raw === 'scalein' || raw === 'in' || raw === 'zoom-in') {
    return 'scale-in';
  }
  if (raw === 'scale-out' || raw === 'scaleout' || raw === 'out' || raw === 'zoom-out') {
    return 'scale-out';
  }
  return 'none';
}

export function layerHasScaleEffect(layer: Layer | null | undefined): boolean {
  return layerScaleEffect(layer) !== 'none';
}

export function layerScaleAmount(layer: Layer | null | undefined): number {
  const n = Number(layer?.scale_amount);
  if (!Number.isFinite(n)) return 0.25;
  return Math.max(0.02, Math.min(1.5, n));
}

export function layerScaleSpeed(layer: Layer | null | undefined): number {
  const n = Number(layer?.scale_speed);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(0.25, Math.min(4, n));
}

export function layerScaleBoundsEnabled(layer: Layer | null | undefined): boolean {
  return !!layer?.scale_bounds && layerScaleEffect(layer) !== 'none';
}

/** Shared 0–1 progress for scale-in / scale-out (respects speed). */
export function layerScaleProgress(layer: Layer, t: number, sceneDur: number): number {
  const effect = layerScaleEffect(layer);
  if (effect === 'none') return 0;
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, sceneDur);
  if (t < start - 0.001 || t >= start + dur || dur <= 0) return 0;
  const rel = Math.max(0, t - start);
  const speed = layerScaleSpeed(layer);
  return Math.max(0, Math.min(1, (rel / dur) * speed));
}

/** Scale factor + origin for Ken Burns content zoom at scene time ``t``. */
export function layerScaleAt(
  layer: Layer,
  t: number,
  sceneDur: number,
): { scale: number; originX: number; originY: number } {
  const origin = scaleOriginFractions(layer.scale_direction as ScaleDirection);
  const effect = layerScaleEffect(layer);
  if (effect === 'none' || layerScaleBoundsEnabled(layer)) {
    return { scale: 1, originX: origin.x, originY: origin.y };
  }
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, sceneDur);
  if (t < start - 0.001 || t >= start + dur || dur <= 0) {
    return { scale: 1, originX: origin.x, originY: origin.y };
  }
  const p = layerScaleProgress(layer, t, sceneDur);
  const amount = layerScaleAmount(layer);
  const scale = effect === 'scale-in' ? 1 + amount * p : 1 + amount * (1 - p);
  return {
    scale: Math.max(1, scale),
    originX: origin.x,
    originY: origin.y,
  };
}

/**
 * Animated layer box when ``scale_bounds`` is on.
 * Grows toward the full scene (amount = how far: 1 = entire scene).
 * Returns null when bounds scaling is off.
 */
export function layerScaleBoxAt(
  layer: Layer,
  t: number,
  sceneDur: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!layerScaleBoundsEnabled(layer)) return null;
  const effect = layerScaleEffect(layer);
  const ax = Number(layer.x) || 0;
  const ay = Number(layer.y) || 0;
  const aw = Math.max(1, Number(layer.width) || 40);
  const ah = Math.max(1, Number(layer.height) || 40);
  const origin = scaleOriginFractions(layer.scale_direction as ScaleDirection);
  const fill = Math.max(0.05, Math.min(1, layerScaleAmount(layer) > 1 ? 1 : layerScaleAmount(layer)));
  const fx0 = ax + origin.x * aw;
  const fy0 = ay + origin.y * ah;
  const tw = aw + (100 - aw) * fill;
  const th = ah + (100 - ah) * fill;
  const fx1 = fx0 + (origin.x * 100 - fx0) * fill;
  const fy1 = fy0 + (origin.y * 100 - fy0) * fill;
  const p = layerScaleProgress(layer, t, sceneDur);
  const blend = effect === 'scale-in' ? p : 1 - p;
  const w = aw + (tw - aw) * blend;
  const h = ah + (th - ah) * blend;
  const fx = fx0 + (fx1 - fx0) * blend;
  const fy = fy0 + (fy1 - fy0) * blend;
  return {
    x: fx - origin.x * w,
    y: fy - origin.y * h,
    width: Math.max(1, w),
    height: Math.max(1, h),
  };
}

export function isVisualTransitionLayer(layer: Pick<Layer, 'type'> | null | undefined): boolean {
  const type = String(layer?.type || '');
  return type === 'image' || type === 'video' || type === 'icon' || type === 'text';
}

export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 20;

/** Clamp video playback speed to 0.5×–20×. Invalid values fall back to 1×. */
export function normalizePlaybackRate(value: unknown, fallback = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const clamped = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, n));
  return Math.round(clamped * 100) / 100;
}

export function layerPlaybackRate(layer: { playback_rate?: unknown } | null | undefined): number {
  return normalizePlaybackRate(layer?.playback_rate, 1);
}

export function layerEffectiveDuration(layer: Layer, sceneDur: number): number {
  const start = Math.max(0, Number(layer.start_s) || 0);
  const scene = Math.max(0.5, Number(sceneDur) || 5);
  if (layer.duration_s == null || !Number.isFinite(Number(layer.duration_s))) {
    return Math.max(0.1, scene - start);
  }
  return Math.max(0.1, Number(layer.duration_s));
}

/** Match export timing: base opacity × fade-in / fade-out at scene time t. */
export function layerVisualAt(layer: Layer, t: number, sceneDur: number): LayerVisualAt {
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, sceneDur);
  const scaleVis = layerScaleAt(layer, t, sceneDur);
  if (t < start - 0.001 || t >= start + dur) {
    return {
      opacity: 0,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      scaleOriginX: scaleVis.originX,
      scaleOriginY: scaleVis.originY,
    };
  }
  let base = Number(layer.opacity);
  if (!Number.isFinite(base)) base = 1;
  const rel = t - start;
  let offsetX = 0;
  let offsetY = 0;

  const transIn = String(layer.transition_in || 'none');
  const inDur = transitionInDuration(layer, dur);
  if (inDur > 0 && rel < inDur) {
    const p = rel / inDur;
    if (transIn === 'fade-in') base *= p;
    if (transIn === 'fly-in') {
      const dir = normalizeDirection(layer.transition_in_direction, 'S');
      const off = directionOffset(dir, 1 - p);
      offsetX += off.offsetX;
      offsetY += off.offsetY;
    }
  }

  const transOut = String(layer.transition_out || 'none');
  const outDur = transitionOutDuration(layer, dur);
  if (outDur > 0 && rel > dur - outDur) {
    const p = (rel - (dur - outDur)) / outDur;
    if (transOut === 'fade-out') base *= 1 - p;
    if (transOut === 'fly-out') {
      const dir = normalizeDirection(layer.transition_out_direction, 'S');
      const off = directionOffset(dir, p);
      offsetX += off.offsetX;
      offsetY += off.offsetY;
    }
  }

  return {
    opacity: Math.max(0, Math.min(1, base)),
    offsetX,
    offsetY,
    scale: scaleVis.scale,
    scaleOriginX: scaleVis.originX,
    scaleOriginY: scaleVis.originY,
  };
}

export function layerOpacityAt(layer: Layer, t: number, sceneDur: number): number {
  return layerVisualAt(layer, t, sceneDur).opacity;
}

export type SceneEffectKind = 'none' | 'fade-in' | 'fade-out' | 'darken' | 'lighten';

export interface SceneEffectAt {
  /** Multiply the composed frame opacity (fade in/out). */
  opacity: number;
  /** Color wash overlay. */
  overlay: 'none' | 'black' | 'white';
  overlayAlpha: number;
}

export function defaultSceneEffectDuration(sceneDur: number): number {
  const dur = Math.max(0.5, Number(sceneDur) || 0.5);
  return Math.min(0.8, Math.max(0.25, dur / 5));
}

export function sceneEffectInDuration(scene: Scene, sceneDur: number): number {
  const custom = scene.effect_in_duration_s;
  if (custom != null && Number.isFinite(Number(custom)) && Number(custom) > 0) {
    return Math.min(sceneDur, Number(custom));
  }
  return defaultSceneEffectDuration(sceneDur);
}

export function sceneEffectOutDuration(scene: Scene, sceneDur: number): number {
  const custom = scene.effect_out_duration_s;
  if (custom != null && Number.isFinite(Number(custom)) && Number(custom) > 0) {
    return Math.min(sceneDur, Number(custom));
  }
  return defaultSceneEffectDuration(sceneDur);
}

export function sceneHasEffects(scene: Scene | null | undefined): boolean {
  if (!scene) return false;
  const inn = String(scene.effect_in || 'none').trim().toLowerCase();
  const out = String(scene.effect_out || 'none').trim().toLowerCase();
  return (!!inn && inn !== 'none') || (!!out && out !== 'none');
}

/** Whole-scene fade / darken / lighten at local time ``t``. */
export function sceneEffectAt(
  scene: Scene,
  t: number,
  sceneDurationOverride?: number,
): SceneEffectAt {
  const sceneDur = Math.max(
    0.5,
    sceneDurationOverride != null && Number.isFinite(sceneDurationOverride)
      ? Number(sceneDurationOverride)
      : Number(scene.duration_s) || 5,
  );
  const local = Math.max(0, Number(t) || 0);
  const amount = Math.max(0, Math.min(1, Number(scene.effect_amount) || 0.4));
  let opacity = 1;
  let overlay: 'none' | 'black' | 'white' = 'none';
  let overlayAlpha = 0;

  const effectIn = String(scene.effect_in || 'none').trim().toLowerCase();
  const inDur = sceneEffectInDuration(scene, sceneDur);
  if (inDur > 0 && local < inDur && effectIn && effectIn !== 'none') {
    const p = Math.max(0, Math.min(1, local / inDur));
    if (effectIn === 'fade-in') {
      opacity *= p;
    } else if (effectIn === 'darken') {
      overlay = 'black';
      overlayAlpha = Math.max(overlayAlpha, amount * (1 - p));
    } else if (effectIn === 'lighten') {
      overlay = 'white';
      overlayAlpha = Math.max(overlayAlpha, amount * (1 - p));
    }
  }

  const effectOut = String(scene.effect_out || 'none').trim().toLowerCase();
  const outDur = sceneEffectOutDuration(scene, sceneDur);
  if (outDur > 0 && local > sceneDur - outDur && effectOut && effectOut !== 'none') {
    const p = Math.max(0, Math.min(1, (local - (sceneDur - outDur)) / outDur));
    if (effectOut === 'fade-out') {
      opacity *= 1 - p;
    } else if (effectOut === 'darken') {
      overlay = overlay === 'white' ? overlay : 'black';
      overlayAlpha = Math.max(overlayAlpha, amount * p);
    } else if (effectOut === 'lighten') {
      overlay = 'white';
      overlayAlpha = Math.max(overlayAlpha, amount * p);
    }
  }

  return {
    opacity: Math.max(0, Math.min(1, opacity)),
    overlay,
    overlayAlpha: Math.max(0, Math.min(1, overlayAlpha)),
  };
}

export function maskEffectiveDuration(mask: LayerMask, layerDur: number): number {
  const start = Math.max(0, Number(mask.start_s) || 0);
  const parent = Math.max(0.1, Number(layerDur) || 0.1);
  if (mask.duration_s == null || !Number.isFinite(Number(mask.duration_s))) {
    return Math.max(0.1, parent - start);
  }
  return Math.max(0.1, Number(mask.duration_s));
}

export function maskActiveAt(mask: LayerMask, layerLocalT: number, layerDur: number): boolean {
  const start = Math.max(0, Number(mask.start_s) || 0);
  const end = start + maskEffectiveDuration(mask, layerDur);
  return layerLocalT >= start - 0.001 && layerLocalT < end;
}

export function clampMaskRect(mask: Pick<LayerMask, 'x' | 'y' | 'width' | 'height'>): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const width = Math.min(100, Math.max(1, Number(mask.width) || 40));
  const height = Math.min(100, Math.max(1, Number(mask.height) || 40));
  const x = Math.min(100 - width, Math.max(0, Number(mask.x) || 0));
  const y = Math.min(100 - height, Math.max(0, Number(mask.y) || 0));
  return { x, y, width, height };
}

/** Occupied scene-local window: first layer start → last explicit layer end. */
export function sceneLayerOccupancy(scene: Scene | null | undefined): {
  firstStart: number;
  lastEnd: number;
} | null {
  const layers = scene?.layers || [];
  if (!layers.length) return null;
  let firstStart = Number.POSITIVE_INFINITY;
  let lastEnd = 0;
  let anyExplicit = false;
  for (const layer of layers) {
    const start = Math.max(0, Number(layer.start_s) || 0);
    firstStart = Math.min(firstStart, start);
    const raw = layer.duration_s;
    if (raw != null && Number.isFinite(Number(raw))) {
      lastEnd = Math.max(lastEnd, start + Math.max(0.1, Number(raw)));
      anyExplicit = true;
    } else {
      lastEnd = Math.max(lastEnd, start + 0.1);
    }
  }
  if (!Number.isFinite(firstStart)) return null;
  if (!anyExplicit) lastEnd = Math.max(lastEnd, firstStart + 0.5);
  return { firstStart, lastEnd: Math.max(lastEnd, firstStart + 0.1) };
}

export function ensureSceneFitsLayer(scene: Scene, layer: Layer): Scene {
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, Number(scene.duration_s) || 5);
  const need = start + dur;
  const cur = Math.max(0.5, Number(scene.duration_s) || 5);
  if (need <= cur + 0.001) return scene;
  return { ...scene, duration_s: Math.round(need * 10) / 10 };
}

/** Shrink (or keep) scene duration to the last layer end. Never below 0.5s. */
export function trimSceneToOccupancy(scene: Scene): Scene {
  const occ = sceneLayerOccupancy(scene);
  const next = Math.max(0.5, occ?.lastEnd ?? 0.5);
  const cur = Math.max(0.5, Number(scene.duration_s) || 5);
  if (Math.abs(next - cur) < 0.05) return scene;
  return { ...scene, duration_s: Math.round(next * 10) / 10 };
}

export function sceneVideoLayers(scene: Scene | null | undefined): Layer[] {
  return (scene?.layers || []).filter((l) => String(l.type || '') === 'video');
}

/** Scene-local start so a clip stays inside the scene slot. */
export function clampLayerStartInScene(start: number, duration: number, sceneDur: number): number {
  const scene = Math.max(0.5, Number(sceneDur) || 5);
  const dur = Math.max(0.1, Number(duration) || 0.1);
  // A clip as long as the scene (or longer) must start at 0 — not 0.1s before the end.
  if (dur >= scene - 1e-6) return 0;
  const maxStart = Math.max(0, Math.round((scene - dur) * 10) / 10);
  return Math.round(Math.min(Math.max(0, Number(start) || 0), maxStart) * 10) / 10;
}

/** Place a layer fully inside a scene. Optionally grow the scene to fit `duration`. */
export function fitLayerInScene(
  start: number,
  duration: number,
  sceneDur: number,
  opts?: { growScene?: boolean },
): { start_s: number; duration_s: number; sceneDur: number } {
  const scene0 = Math.max(0.5, Number(sceneDur) || 5);
  const dur0 = Math.max(0.1, Number(duration) || 0.1);
  let start_s = Math.max(0, Number(start) || 0);
  if (start_s >= scene0 - 1e-6) start_s = 0;
  if (opts?.growScene && start_s + dur0 > scene0 + 1e-6) {
    start_s = clampLayerStartInScene(start_s, Math.min(dur0, scene0), scene0);
    const nextScene = Math.round(Math.max(scene0, start_s + dur0) * 10) / 10;
    return { start_s, duration_s: Math.round(dur0 * 100) / 100, sceneDur: nextScene };
  }
  start_s = clampLayerStartInScene(start_s, dur0, scene0);
  const duration_s = Math.round(Math.min(dur0, Math.max(0.1, scene0 - start_s)) * 100) / 100;
  return { start_s, duration_s, sceneDur: scene0 };
}

export function layerStartOutsideScene(layer: Layer, sceneDur: number): boolean {
  const start = Math.max(0, Number(layer.start_s) || 0);
  const scene = Math.max(0.5, Number(sceneDur) || 5);
  return start >= scene - 1e-6;
}

/**
 * Gantt bar geometry in absolute timeline %, always clipped to the host scene band
 * so a clip cannot paint in a gap or neighboring scene.
 */
export function ganttBarInScene(
  sceneStart: number,
  sceneDur: number,
  layerStart: number,
  layerDur: number,
  total: number,
): { leftPct: number; widthPct: number } {
  const tot = Math.max(0.5, Number(total) || 0.5);
  const s0 = Math.max(0, Number(sceneStart) || 0);
  const sDur = Math.max(0.5, Number(sceneDur) || 5);
  const start = clampLayerStartInScene(layerStart, layerDur, sDur);
  const dur = Math.min(Math.max(0.1, Number(layerDur) || 0.1), Math.max(0.1, sDur - start));
  const sceneLeft = (s0 / tot) * 100;
  const sceneRight = ((s0 + sDur) / tot) * 100;
  const leftPct = Math.min(
    Math.max(sceneLeft, ((s0 + start) / tot) * 100),
    Math.max(sceneLeft, sceneRight - 0.35),
  );
  const widthPct = Math.max(0.35, Math.min((dur / tot) * 100, sceneRight - leftPct));
  return { leftPct, widthPct };
}

export type GanttTickMark = {
  t: number;
  leftPct: number;
  label: string;
  major: boolean;
};

/** Nice major/minor time ticks sized to the rendered gantt width. */
export function ganttTicks(total: number, widthPx = 480): GanttTickMark[] {
  const dur = Math.max(0.5, Number(total) || 0.5);
  const px = Math.max(200, Number(widthPx) || 480);
  const targetMajorPx = 88;
  const rough = dur / Math.max(1, px / targetMajorPx);
  const majors = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const majorStep = majors.find((s) => s >= rough) ?? majors[majors.length - 1];
  const minorDiv =
    majorStep >= 60 ? 6 : majorStep >= 10 ? 5 : majorStep >= 2 ? 4 : majorStep >= 1 ? 2 : 1;
  const minorStep = majorStep / minorDiv;
  const out: GanttTickMark[] = [];
  const last = Math.floor(dur / minorStep + 1e-9);
  for (let i = 0; i <= last; i++) {
    const t = Math.min(i * minorStep, dur);
    const major = Math.abs(t / majorStep - Math.round(t / majorStep)) < 1e-6 || i === 0;
    // Skip a near-duplicate final tick when duration lands between minors.
    if (out.length && Math.abs(out[out.length - 1].t - t) < 1e-6) continue;
    out.push({
      t,
      leftPct: (t / dur) * 100,
      label: major ? formatGanttTick(t) : '',
      major,
    });
  }
  const end = out[out.length - 1];
  if (!end || Math.abs(end.t - dur) > 1e-3) {
    out.push({
      t: dur,
      leftPct: 100,
      label: formatGanttTick(dur),
      major: true,
    });
  } else if (!end.major) {
    end.major = true;
    end.label = formatGanttTick(end.t);
  }
  return out;
}

function formatGanttTick(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) {
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  }
  const m = Math.floor(s / 60);
  const rem = Math.round((s - m * 60) * 10) / 10;
  if (Number.isInteger(rem)) {
    return `${m}:${String(rem).padStart(2, '0')}`;
  }
  return `${m}:${rem.toFixed(1).padStart(4, '0')}`;
}

export function transparencyMaskCss(masks: LayerMask[]): string | null {
  if (!masks.length) return null;
  const holes = masks
    .map((m) => {
      const r = clampMaskRect(m);
      return `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="black"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="100" height="100" fill="white"/>${holes}</svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

/** Normalized unique hex colors from a layer's chroma key list. */
export function layerChromaKeyColors(layer: Layer | null | undefined): string[] {
  const raw = layer?.chroma_key_colors;
  if (!Array.isArray(raw) || !raw.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const hex = normalizeHexColor(String(item || ''), '');
    if (!hex || !/^#[0-9a-f]{6}$/.test(hex) || seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

export function layerHasChromaKey(layer: Layer | null | undefined): boolean {
  return layerChromaKeyColors(layer).length > 0;
}

export function layerChromaKeyTolerance(layer: Layer | null | undefined): number {
  const n = Number(layer?.chroma_key_tolerance);
  if (!Number.isFinite(n)) return 0.18;
  return Math.max(0, Math.min(1, n));
}

export function layerChromaKeySoftness(layer: Layer | null | undefined): number {
  const n = Number(layer?.chroma_key_softness);
  if (!Number.isFinite(n)) return 0.08;
  return Math.max(0, Math.min(1, n));
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const h = normalizeHexColor(hex, '');
  if (!/^#[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** Dominant RGB channel index for a key color (0=R, 1=G, 2=B). */
function chromaPrimaryChannel(r: number, g: number, b: number): 0 | 1 | 2 {
  if (g >= r && g >= b) return 1;
  if (b >= r && b >= g) return 2;
  return 0;
}

/**
 * How strongly a pixel matches a blue/green(/red) screen: primary channel
 * excess over the other two, normalized to 0–1.
 */
function chromaScreenAmount(
  r: number,
  g: number,
  b: number,
  channel: 0 | 1 | 2,
): number {
  const v = [r, g, b];
  const primary = v[channel];
  const other = Math.max(v[(channel + 1) % 3], v[(channel + 2) % 3]);
  return Math.max(0, (primary - other) / 255);
}

/** Snap muddy mid-alphas so keyed subjects stay solid over busy backgrounds. */
function hardenChromaFactor(factor: number): number {
  if (factor <= 0.04) return 0;
  if (factor >= 0.92) return 1;
  return factor;
}

/**
 * Punch chroma-key transparency into an RGBA ImageData buffer (mutates in place).
 *
 * Uses a screen-style color-difference key for saturated R/G/B keys (typical
 * blue/green screens) so foreground clothing/skin stay opaque. Falls back to
 * RGB distance for muted custom colors.
 */
export function applyChromaKeyToImageData(
  data: ImageData,
  colors: string[],
  tolerance = 0.18,
  softness = 0.08,
): void {
  const keys = colors
    .map(parseHexRgb)
    .filter((k): k is [number, number, number] => !!k);
  if (!keys.length) return;
  const tol = Math.max(0, Math.min(1, tolerance));
  const soft = Math.max(0, Math.min(1, softness));
  const rgbLo = Math.max(0, tol - soft);
  const rgbHi = Math.min(1, tol + soft);
  const rgbDenom = 255 * Math.sqrt(3);
  // Color-diff thresholds: higher UI tolerance → remove weaker screen spill.
  const screenLo = Math.max(0, 0.28 - tol);
  const screenHi = Math.min(1, screenLo + Math.max(0.04, soft + 0.06));
  const keyMeta = keys.map(([kr, kg, kb]) => {
    const channel = chromaPrimaryChannel(kr, kg, kb);
    const keyAmount = chromaScreenAmount(kr, kg, kb, channel);
    return {
      rgb: [kr, kg, kb] as [number, number, number],
      channel,
      // Saturated screen key → color-difference; muted swatch → RGB distance.
      useScreen: keyAmount >= 0.12,
    };
  });
  const buf = data.data;
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    let factor = 1;
    for (const key of keyMeta) {
      let f = 1;
      if (key.useScreen) {
        const amount = chromaScreenAmount(r, g, b, key.channel);
        if (screenHi <= screenLo + 1e-6) {
          f = amount >= screenLo ? 0 : 1;
        } else if (amount <= screenLo) {
          f = 1;
        } else if (amount >= screenHi) {
          f = 0;
        } else {
          f = 1 - (amount - screenLo) / (screenHi - screenLo);
        }
      } else {
        const [kr, kg, kb] = key.rgb;
        const dist =
          Math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) / rgbDenom;
        if (rgbHi <= rgbLo + 1e-6) {
          f = dist >= tol ? 1 : 0;
        } else {
          f = Math.max(0, Math.min(1, (dist - rgbLo) / (rgbHi - rgbLo)));
        }
      }
      if (f < factor) factor = f;
    }
    factor = hardenChromaFactor(factor);
    const nextA = Math.round(buf[i + 3] * factor);
    buf[i + 3] = nextA;
    // Avoid fringe glow from leftover RGB in fully keyed holes.
    if (nextA === 0) {
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
    }
  }
}

export const DEFAULT_SCENE_BG = '#1e1e28';

/** True when no solid fill is set (scene/post background is transparent). */
export function isTransparentBg(color: string | null | undefined): boolean {
  const raw = String(color || '').trim().toLowerCase();
  return !raw || raw === 'transparent' || raw === 'none';
}

export function normalizeHexColor(
  color: string | null | undefined,
  fallback = DEFAULT_SCENE_BG,
): string {
  const raw = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const a = raw[1];
    const b = raw[2];
    const c = raw[3];
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
  }
  return fallback;
}

/** Keep null/empty as transparent; only normalize real hex values. */
export function normalizeOptionalHexColor(
  color: string | null | undefined,
): string | null {
  if (isTransparentBg(color)) return null;
  return normalizeHexColor(color, '#000000');
}

export function clampLayerBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  const width = Math.min(400, Math.max(5, box.width));
  const height = Math.min(400, Math.max(5, box.height));
  return { x: box.x, y: box.y, width, height };
}

/** Canvas width/height. Layer x/y/w/h are % of these axes, so equal % is not square on landscape. */
export function canvasAspectRatio(
  format: string | undefined,
  isVideo = false,
): number {
  const fmt = String(format || 'portrait');
  if (isVideo) {
    if (fmt === 'landscape') return 16 / 9;
    if (fmt === 'square') return 1;
    return 9 / 16;
  }
  if (fmt === 'landscape') return 1.91;
  if (fmt === 'square') return 1;
  if (fmt === 'story') return 9 / 16;
  return 4 / 5;
}

/**
 * Layer box in canvas % that matches `mediaAR` (width/height) without cropping,
 * capped so both axes stay within `maxPct` of the frame.
 */
export function layerBoxFromMediaAspect(
  mediaAR: number,
  canvasAR: number,
  maxPct = 100,
): { width: number; height: number } {
  const ar = Math.max(0.05, Number(mediaAR) || 1);
  const cAR = Math.max(0.05, Number(canvasAR) || 1);
  const cap = Math.min(100, Math.max(5, Number(maxPct) || 100));
  let heightPct = Math.min(cap, (cap * cAR) / ar);
  let widthPct = (heightPct * ar) / cAR;
  if (widthPct > cap + 0.001) {
    widthPct = cap;
    heightPct = (widthPct * cAR) / ar;
  }
  return {
    width: Math.round(widthPct * 10) / 10,
    height: Math.round(heightPct * 10) / 10,
  };
}

/**
 * ``object-fit: contain`` rect of ``mediaAR`` (width/height) inside a layer box.
 * Returned left/top/width/height are % of the layer box.
 */
export function containedMediaFrame(
  mediaAR: number,
  boxWidthPct: number,
  boxHeightPct: number,
  canvasAR: number,
): { left: number; top: number; width: number; height: number } {
  const ar = Math.max(0.05, Number(mediaAR) || 1);
  const cAR = Math.max(0.05, Number(canvasAR) || 1);
  const w = Math.max(0.1, Number(boxWidthPct) || 1);
  const h = Math.max(0.1, Number(boxHeightPct) || 1);
  const boxAR = (w / h) * cAR;
  if (ar > boxAR + 1e-4) {
    const height = Math.min(100, (boxAR / ar) * 100);
    return { left: 0, top: (100 - height) / 2, width: 100, height };
  }
  if (ar < boxAR - 1e-4) {
    const width = Math.min(100, (ar / boxAR) * 100);
    return { left: (100 - width) / 2, top: 0, width, height: 100 };
  }
  return { left: 0, top: 0, width: 100, height: 100 };
}

/** Canvas-% box that hugs the visible media inside a layer (object-fit contain). */
export function containedMediaBox(
  layer: { x?: number; y?: number; width?: number; height?: number },
  mediaAR: number,
  canvasAR: number,
): { x: number; y: number; width: number; height: number } {
  const x = Number(layer.x) || 0;
  const y = Number(layer.y) || 0;
  const w = Math.max(0.1, Number(layer.width) || 40);
  const h = Math.max(0.1, Number(layer.height) || 40);
  const frame = containedMediaFrame(mediaAR, w, h, canvasAR);
  return clampLayerBox({
    x: x + (frame.left / 100) * w,
    y: y + (frame.top / 100) * h,
    width: (frame.width / 100) * w,
    height: (frame.height / 100) * h,
  });
}

export function layerBoxMatchesMedia(
  layer: { width?: number; height?: number },
  mediaAR: number,
  canvasAR: number,
  epsilon = 0.03,
): boolean {
  const w = Math.max(0.1, Number(layer.width) || 40);
  const h = Math.max(0.1, Number(layer.height) || 40);
  const boxAR = (w / h) * Math.max(0.05, canvasAR);
  const ar = Math.max(0.05, Number(mediaAR) || 1);
  return Math.abs(boxAR - ar) / ar <= epsilon;
}

export function remapMasksToBox(
  masks: LayerMask[] | undefined,
  fromBox: { x: number; y: number; width: number; height: number },
  toBox: { x: number; y: number; width: number; height: number },
): LayerMask[] {
  if (!masks?.length) return masks || [];
  const fw = Math.max(0.1, fromBox.width);
  const fh = Math.max(0.1, fromBox.height);
  const tw = Math.max(0.1, toBox.width);
  const th = Math.max(0.1, toBox.height);
  return masks.map((m) => {
    const mx = Number(m.x) || 0;
    const my = Number(m.y) || 0;
    const mw = Number(m.width) || 40;
    const mh = Number(m.height) || 40;
    const cx = fromBox.x + (mx / 100) * fw;
    const cy = fromBox.y + (my / 100) * fh;
    const cw = (mw / 100) * fw;
    const ch = (mh / 100) * fh;
    return {
      ...m,
      ...clampMaskRect({
        x: ((cx - toBox.x) / tw) * 100,
        y: ((cy - toBox.y) / th) * 100,
        width: (cw / tw) * 100,
        height: (ch / th) * 100,
      }),
    };
  });
}

export function centeredLayerBox(size: { width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.round(((100 - size.width) / 2) * 10) / 10,
    y: Math.round(((100 - size.height) / 2) * 10) / 10,
    width: size.width,
    height: size.height,
  };
}
