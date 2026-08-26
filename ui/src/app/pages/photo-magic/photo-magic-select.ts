/** Layer selection masks for Photo Magic (box, lasso, magic wand). */

export type SelectTool = 'box' | 'lasso' | 'magic';

export interface Point {
  x: number;
  y: number;
}

export interface BoxGeom {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayerSelection {
  layerId: string;
  tool: SelectTool;
  box?: BoxGeom;
  points?: Point[];
  magic?: { x: number; y: number; tolerance: number };
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
}

export function emptyMask(width: number, height: number): Uint8Array {
  return new Uint8Array(Math.max(0, width) * Math.max(0, height));
}

export function normalizeBox(x0: number, y0: number, x1: number, y1: number): BoxGeom {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  return {
    x: left,
    y: top,
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

export function boxMask(width: number, height: number, box: BoxGeom): Uint8Array {
  const mask = emptyMask(width, height);
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) mask[row + x] = 1;
  }
  return mask;
}

/** Scanline fill of a closed polygon. */
export function lassoMask(width: number, height: number, points: Point[]): Uint8Array {
  const mask = emptyMask(width, height);
  if (points.length < 3) return mask;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  const n = points.length;
  for (let y = minY; y <= maxY; y++) {
    const nodes: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = points[i].y;
      const yj = points[j].y;
      if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
        const x = points[i].x + ((y - yi) / (yj - yi || 1)) * (points[j].x - points[i].x);
        nodes.push(x);
      }
    }
    nodes.sort((a, b) => a - b);
    for (let i = 0; i + 1 < nodes.length; i += 2) {
      const x0 = Math.max(0, Math.floor(nodes[i]));
      const x1 = Math.min(width, Math.ceil(nodes[i + 1]));
      const row = y * width;
      for (let x = x0; x < x1; x++) mask[row + x] = 1;
    }
  }
  return mask;
}

function colorDistance(
  data: Uint8ClampedArray,
  i: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
): number {
  const dr = data[i] - sr;
  const dg = data[i + 1] - sg;
  const db = data[i + 2] - sb;
  const da = data[i + 3] - sa;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
}

/** 4-connected flood fill by color similarity (magic wand). */
export function magicMask(
  image: ImageData,
  seedX: number,
  seedY: number,
  tolerance: number,
): Uint8Array {
  const width = image.width;
  const height = image.height;
  const mask = emptyMask(width, height);
  const x = Math.floor(seedX);
  const y = Math.floor(seedY);
  if (x < 0 || y < 0 || x >= width || y >= height) return mask;
  const data = image.data;
  const seed = (y * width + x) * 4;
  const sr = data[seed];
  const sg = data[seed + 1];
  const sb = data[seed + 2];
  const sa = data[seed + 3];
  const limit = Math.max(0, tolerance);
  const stack = [x, y];
  const seen = new Uint8Array(width * height);
  seen[y * width + x] = 1;
  while (stack.length) {
    const cy = stack.pop()!;
    const cx = stack.pop()!;
    const idx = cy * width + cx;
    if (colorDistance(data, idx * 4, sr, sg, sb, sa) > limit) continue;
    mask[idx] = 1;
    if (cx > 0 && !seen[idx - 1]) {
      seen[idx - 1] = 1;
      stack.push(cx - 1, cy);
    }
    if (cx + 1 < width && !seen[idx + 1]) {
      seen[idx + 1] = 1;
      stack.push(cx + 1, cy);
    }
    if (cy > 0 && !seen[idx - width]) {
      seen[idx - width] = 1;
      stack.push(cx, cy - 1);
    }
    if (cy + 1 < height && !seen[idx + width]) {
      seen[idx + width] = 1;
      stack.push(cx, cy + 1);
    }
  }
  return mask;
}

export function maskHasPixels(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) return true;
  }
  return false;
}

export function maskBounds(mask: Uint8Array, width: number, height: number): BoxGeom | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function imageDataFromImage(
  image: CanvasImageSource,
  width: number,
  height: number,
): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return new ImageData(canvas.width, canvas.height);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
