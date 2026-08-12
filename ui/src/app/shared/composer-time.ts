import type { Layer, LayerMask, Scene } from '../models/content-sprout.models';

export function layerEffectiveDuration(layer: Layer, sceneDur: number): number {
  const start = Math.max(0, Number(layer.start_s) || 0);
  const scene = Math.max(0.5, Number(sceneDur) || 5);
  if (layer.duration_s == null || !Number.isFinite(Number(layer.duration_s))) {
    return Math.max(0.1, scene - start);
  }
  return Math.max(0.1, Number(layer.duration_s));
}

/** Match export timing: base opacity × fade-in / fade-out at scene time t. */
export function layerOpacityAt(layer: Layer, t: number, sceneDur: number): number {
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, sceneDur);
  if (t < start - 0.001 || t >= start + dur) return 0;
  let base = Number(layer.opacity);
  if (!Number.isFinite(base)) base = 1;
  const fadeD = Math.min(0.5, dur / 4);
  const rel = t - start;
  if (layer.transition_in === 'fade-in' && fadeD > 0 && rel < fadeD) {
    base *= rel / fadeD;
  }
  if (layer.transition_out === 'fade-out' && fadeD > 0 && rel > dur - fadeD) {
    base *= (dur - rel) / fadeD;
  }
  return Math.max(0, Math.min(1, base));
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

export function ensureSceneFitsLayer(scene: Scene, layer: Layer): Scene {
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, Number(scene.duration_s) || 5);
  const need = start + dur;
  const cur = Math.max(0.5, Number(scene.duration_s) || 5);
  if (need <= cur + 0.001) return scene;
  return { ...scene, duration_s: Math.round(need * 10) / 10 };
}

export function ganttTicks(total: number): { t: number; leftPct: number; label: string }[] {
  const dur = Math.max(0.5, Number(total) || 0.5);
  const step = dur <= 10 ? 1 : dur <= 30 ? 5 : dur <= 90 ? 10 : dur <= 180 ? 15 : 30;
  const out: { t: number; leftPct: number; label: string }[] = [];
  for (let t = 0; t <= dur + 0.001; t += step) {
    const clamped = Math.min(t, dur);
    out.push({
      t: clamped,
      leftPct: (clamped / dur) * 100,
      label: Number.isInteger(clamped) ? `${clamped}s` : `${clamped.toFixed(1)}s`,
    });
  }
  return out;
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
