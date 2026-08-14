import type { Layer, LayerMask, Scene, TransitionDirection } from '../models/content-sprout.models';

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
  if (t < start - 0.001 || t >= start + dur) {
    return { opacity: 0, offsetX: 0, offsetY: 0 };
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
  };
}

export function layerOpacityAt(layer: Layer, t: number, sceneDur: number): number {
  return layerVisualAt(layer, t, sceneDur).opacity;
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
