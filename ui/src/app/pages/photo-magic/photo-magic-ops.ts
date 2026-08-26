/** Pixel operations for Photo Magic edit tools (brush, erase, text, scale, distort, crop). */

import type { BoxGeom, Point } from './photo-magic-select';

export type RasterSource = CanvasImageSource;

export function blankCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function canvasFromSource(
  src: RasterSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = blankCanvas(width, height);
  canvas.getContext('2d')?.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function cloneRaster(src: RasterSource, width: number, height: number): HTMLCanvasElement {
  return canvasFromSource(src, width, height);
}

export function sourceToBlob(src: RasterSource, width: number, height: number): Promise<Blob> {
  const canvas = src instanceof HTMLCanvasElement && src.width === width && src.height === height
    ? src
    : canvasFromSource(src, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('blob'))), 'image/png');
  });
}

function hexToRgba(color: string, alpha = 1): string {
  const raw = color.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(raw);
  const full = /^#([0-9a-f]{6})$/i.exec(raw);
  let r = 255;
  let g = 255;
  let b = 255;
  if (short) {
    r = parseInt(short[1][0] + short[1][0], 16);
    g = parseInt(short[1][1] + short[1][1], 16);
    b = parseInt(short[1][2] + short[1][2], 16);
  } else if (full) {
    r = parseInt(full[1].slice(0, 2), 16);
    g = parseInt(full[1].slice(2, 4), 16);
    b = parseInt(full[1].slice(4, 6), 16);
  }
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

function densify(points: Point[], spacing: number): Point[] {
  if (points.length < 2) return points.slice();
  const out: Point[] = [{ ...points[0] }];
  const gap = Math.max(0.75, spacing);
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) continue;
    const steps = Math.max(1, Math.ceil(dist / gap));
    for (let s = 1; s <= steps; s++) {
      out.push({ x: a.x + (dx * s) / steps, y: a.y + (dy * s) / steps });
    }
  }
  return out;
}

export function clipCanvasToMask(
  canvas: HTMLCanvasElement,
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
): void {
  if (canvas.width !== maskWidth || canvas.height !== maskHeight) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(maskWidth, maskHeight);
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    const on = mask[i] ? 255 : 0;
    image.data[p] = 255;
    image.data[p + 1] = 255;
    image.data[p + 2] = 255;
    image.data[p + 3] = on;
  }
  const tmp = blankCanvas(maskWidth, maskHeight);
  tmp.getContext('2d')?.putImageData(image, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(tmp, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}

function stampStroke(
  width: number,
  height: number,
  points: Point[],
  size: number,
  color: string,
  hardness: number,
  mask?: Uint8Array | null,
): HTMLCanvasElement {
  const stroke = blankCanvas(width, height);
  const sctx = stroke.getContext('2d');
  if (!sctx || points.length < 1) return stroke;
  const radius = Math.max(0.5, size / 2);
  const hard = Math.max(0, Math.min(1, hardness));
  const stamps = densify(points, Math.max(0.8, radius * 0.35));
  for (const pt of stamps) {
    if (hard >= 0.99) {
      sctx.fillStyle = hexToRgba(color, 1);
    } else {
      const inner = radius * hard;
      const grad = sctx.createRadialGradient(pt.x, pt.y, inner, pt.x, pt.y, radius);
      grad.addColorStop(0, hexToRgba(color, 1));
      grad.addColorStop(1, hexToRgba(color, 0));
      sctx.fillStyle = grad;
    }
    sctx.beginPath();
    sctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    sctx.fill();
  }
  if (mask) clipCanvasToMask(stroke, mask, width, height);
  return stroke;
}

export function paintStroke(
  src: RasterSource,
  width: number,
  height: number,
  points: Point[],
  size: number,
  color: string,
  hardness: number,
  mask?: Uint8Array | null,
): HTMLCanvasElement {
  const canvas = canvasFromSource(src, width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx || points.length < 1) return canvas;
  ctx.drawImage(stampStroke(width, height, points, size, color, hardness, mask), 0, 0);
  return canvas;
}

export function eraseStroke(
  src: RasterSource,
  width: number,
  height: number,
  points: Point[],
  size: number,
  hardness: number,
  mask?: Uint8Array | null,
): HTMLCanvasElement {
  const canvas = canvasFromSource(src, width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx || points.length < 1) return canvas;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(stampStroke(width, height, points, size, '#000000', hardness, mask), 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}

export interface TextStyle {
  text: string;
  fontSize: number;
  color: string;
  fontFamily: string;
}

export function textFont(style: Pick<TextStyle, 'fontSize' | 'fontFamily'>): string {
  return `${Math.max(8, Math.round(style.fontSize))}px ${style.fontFamily}`;
}

export function measureTextBlock(style: TextStyle): { width: number; height: number; lines: string[] } {
  const lines = (style.text || 'Text').split(/\r?\n/);
  const canvas = blankCanvas(8, 8);
  const ctx = canvas.getContext('2d');
  const fontSize = Math.max(8, Math.round(style.fontSize));
  const lineHeight = Math.round(fontSize * 1.25);
  if (!ctx) {
    return {
      width: Math.max(8, Math.round((lines[0] || '').length * fontSize * 0.6)),
      height: Math.max(8, lineHeight * lines.length),
      lines,
    };
  }
  ctx.font = textFont(style);
  let width = 8;
  for (const line of lines) {
    width = Math.max(width, Math.ceil(ctx.measureText(line || ' ').width));
  }
  return { width: width + 8, height: lineHeight * lines.length + 8, lines };
}

export function renderTextLayer(style: TextStyle): HTMLCanvasElement {
  const metrics = measureTextBlock(style);
  const canvas = blankCanvas(metrics.width, metrics.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const fontSize = Math.max(8, Math.round(style.fontSize));
  ctx.font = textFont(style);
  ctx.fillStyle = style.color;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const lineHeight = Math.round(fontSize * 1.25);
  metrics.lines.forEach((line, i) => {
    ctx.fillText(line, 4, 4 + i * lineHeight);
  });
  return canvas;
}

export function scaleRaster(
  src: RasterSource,
  width: number,
  height: number,
  nextWidth: number,
  nextHeight: number,
): HTMLCanvasElement {
  const canvas = blankCanvas(nextWidth, nextHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** Inverse bilinear map. a=tl, b=tr, c=br, d=bl. */
export function inverseBilinear(
  px: number,
  py: number,
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): Point | null {
  const e = { x: b.x - a.x, y: b.y - a.y };
  const f = { x: d.x - a.x, y: d.y - a.y };
  const g = { x: a.x - b.x + c.x - d.x, y: a.y - b.y + c.y - d.y };
  const h = { x: px - a.x, y: py - a.y };
  const k2 = cross(g.x, g.y, f.x, f.y);
  const k1 = cross(e.x, e.y, f.x, f.y) + cross(h.x, h.y, g.x, g.y);
  const k0 = cross(h.x, h.y, e.x, e.y);
  let v: number;
  if (Math.abs(k2) < 1e-6) {
    if (Math.abs(k1) < 1e-6) return null;
    v = -k0 / k1;
  } else {
    const disc = k1 * k1 - 4 * k2 * k0;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const v1 = (-k1 - root) / (2 * k2);
    const v2 = (-k1 + root) / (2 * k2);
    const v1ok = v1 >= -0.02 && v1 <= 1.02;
    const v2ok = v2 >= -0.02 && v2 <= 1.02;
    if (v1ok && v2ok) v = Math.abs(v1 - 0.5) < Math.abs(v2 - 0.5) ? v1 : v2;
    else if (v1ok) v = v1;
    else if (v2ok) v = v2;
    else return null;
  }
  const denomX = e.x + g.x * v;
  const denomY = e.y + g.y * v;
  const u =
    Math.abs(denomX) > Math.abs(denomY) ? (h.x - f.x * v) / denomX : (h.y - f.y * v) / denomY;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return { x: u, y: v };
}

function sampleBilinear(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const idx = (ix: number, iy: number) => (iy * width + ix) * 4;
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const i00 = idx(x0, y0);
  const i10 = idx(x1, y0);
  const i01 = idx(x0, y1);
  const i11 = idx(x1, y1);
  const r = mix(mix(data[i00], data[i10], tx), mix(data[i01], data[i11], tx), ty);
  const g = mix(mix(data[i00 + 1], data[i10 + 1], tx), mix(data[i01 + 1], data[i11 + 1], tx), ty);
  const b = mix(mix(data[i00 + 2], data[i10 + 2], tx), mix(data[i01 + 2], data[i11 + 2], tx), ty);
  const a = mix(mix(data[i00 + 3], data[i10 + 3], tx), mix(data[i01 + 3], data[i11 + 3], tx), ty);
  return [r, g, b, a];
}

export function distortRaster(
  src: RasterSource,
  width: number,
  height: number,
  corners: [Point, Point, Point, Point],
): { canvas: HTMLCanvasElement; box: BoxGeom } {
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const box: BoxGeom = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(8, Math.ceil(Math.max(...xs) - Math.min(...xs))),
    height: Math.max(8, Math.ceil(Math.max(...ys) - Math.min(...ys))),
  };
  const srcCanvas = canvasFromSource(src, width, height);
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const dest = blankCanvas(box.width, box.height);
  const destCtx = dest.getContext('2d');
  if (!srcCtx || !destCtx) return { canvas: dest, box };
  const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const out = destCtx.createImageData(dest.width, dest.height);
  const [tl, tr, br, bl] = corners;
  for (let y = 0; y < dest.height; y++) {
    for (let x = 0; x < dest.width; x++) {
      const uv = inverseBilinear(box.x + x + 0.5, box.y + y + 0.5, tl, tr, br, bl);
      if (!uv || uv.x < -0.01 || uv.y < -0.01 || uv.x > 1.01 || uv.y > 1.01) continue;
      const sx = Math.max(0, Math.min(srcCanvas.width - 1, uv.x * (srcCanvas.width - 1)));
      const sy = Math.max(0, Math.min(srcCanvas.height - 1, uv.y * (srcCanvas.height - 1)));
      const [r, g, b, a] = sampleBilinear(srcData.data, srcCanvas.width, srcCanvas.height, sx, sy);
      const i = (y * dest.width + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = a;
    }
  }
  destCtx.putImageData(out, 0, 0);
  return { canvas: dest, box };
}

export function cropRaster(
  src: RasterSource,
  width: number,
  height: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): HTMLCanvasElement {
  const canvas = blankCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function layerDocCorners(offsetX: number, offsetY: number, width: number, height: number): [Point, Point, Point, Point] {
  return [
    { x: offsetX, y: offsetY },
    { x: offsetX + width, y: offsetY },
    { x: offsetX + width, y: offsetY + height },
    { x: offsetX, y: offsetY + height },
  ];
}

export function oppositeCorner(index: number): number {
  return (index + 2) % 4;
}

export function hitHandle(point: Point, corners: Point[], threshold: number): number {
  let best = -1;
  let bestDist = threshold;
  corners.forEach((corner, i) => {
    const dist = Math.hypot(point.x - corner.x, point.y - corner.y);
    if (dist <= bestDist) {
      best = i;
      bestDist = dist;
    }
  });
  return best;
}

export function fillMask(width: number, height: number, value: number): HTMLCanvasElement {
  const canvas = blankCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const v = Math.max(0, Math.min(255, Math.round(value)));
  ctx.fillStyle = `rgb(${v},${v},${v})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

export function maskFromBits(
  bits: Uint8Array,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = fillMask(width, height, 0);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const n = Math.min(bits.length, canvas.width * canvas.height);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const v = bits[i] ? 255 : 0;
    image.data[p] = v;
    image.data[p + 1] = v;
    image.data[p + 2] = v;
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function invertMask(src: RasterSource, width: number, height: number): HTMLCanvasElement {
  const canvas = canvasFromSource(src, width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 255 - image.data[i];
    image.data[i + 1] = 255 - image.data[i + 1];
    image.data[i + 2] = 255 - image.data[i + 2];
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function applyLayerMask(
  src: RasterSource,
  mask: RasterSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = canvasFromSource(src, width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const maskCanvas = canvasFromSource(mask, width, height);
  const mctx = maskCanvas.getContext('2d');
  if (!mctx) return canvas;
  const image = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  for (let i = 0; i < image.data.length; i += 4) {
    const lum = Math.round((image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3);
    image.data[i] = 255;
    image.data[i + 1] = 255;
    image.data[i + 2] = 255;
    image.data[i + 3] = lum;
  }
  mctx.putImageData(image, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}
