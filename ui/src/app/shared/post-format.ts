/** Instagram still sizes — matches `formats.FORMAT_DIMENSIONS`. */
const FORMAT_DIMENSIONS: Record<string, readonly [number, number]> = {
  square: [1080, 1080],
  portrait: [1080, 1350],
  landscape: [1080, 566],
  story: [1080, 1920],
};

const VIDEO_FORMAT_HEIGHT: Record<string, number> = {
  '4k': 2160,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  standard: 480,
};

const VIDEO_FORMAT_ALIASES: Record<string, string> = {
  uhd: '4k',
  '2160p': '4k',
  qhd: '1440p',
  '2k': '1440p',
  fhd: '1080p',
  fullhd: '1080p',
  hd1080: '1080p',
  hd: '720p',
  sd: 'standard',
  '480p': 'standard',
  generic: 'standard',
};

export type PostOrientation = 'portrait' | 'landscape' | 'square';

export const FORMAT_DISPLAY: Record<string, { title: string; ratio: string }> = {
  square: { title: 'Square', ratio: '1:1' },
  portrait: { title: 'Portrait', ratio: '4:5' },
  landscape: { title: 'Landscape', ratio: '1.91:1' },
  story: { title: 'Story', ratio: '9:16' },
};

export const FORMAT_ORDER = ['square', 'portrait', 'landscape', 'story'];

export function normalizeTargetFormat(raw: string | undefined | null): string {
  const key = String(raw || 'portrait').trim().toLowerCase();
  return key in FORMAT_DIMENSIONS ? key : 'portrait';
}

export function normalizeVideoFormatKey(raw: string | undefined | null): string {
  const key = String(raw || '1080p')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const aliased = VIDEO_FORMAT_ALIASES[key] || key;
  return aliased in VIDEO_FORMAT_HEIGHT ? aliased : '1080p';
}

/** Portrait = taller (incl. story). Landscape = wider. Square = 1:1. */
export function postOrientation(format: string | undefined | null): PostOrientation {
  const fmt = normalizeTargetFormat(format);
  if (fmt === 'landscape') return 'landscape';
  if (fmt === 'square') return 'square';
  return 'portrait';
}

export function formatLabel(format: string | undefined | null): string {
  const key = normalizeTargetFormat(format);
  const raw = String(format || key).trim().toLowerCase();
  return FORMAT_DISPLAY[raw]?.title || FORMAT_DISPLAY[key].title;
}

/** e.g. Portrait · 4:5 */
export function formatDisplayLabel(format: string | undefined | null): string {
  const key = normalizeTargetFormat(format);
  const raw = String(format || key).trim().toLowerCase();
  const meta = FORMAT_DISPLAY[raw] || FORMAT_DISPLAY[key];
  return `${meta.title} · ${meta.ratio}`;
}

function even(n: number): number {
  const v = Math.max(2, Math.round(n));
  return v + (v % 2);
}

/** Pixel size chosen at post create — same as backend `export_canvas_size`. */
export function exportCanvasSize(
  targetFormat: string | undefined | null,
  videoFormat: string | undefined | null,
  isVideo: boolean,
): { width: number; height: number } {
  const fmt = normalizeTargetFormat(targetFormat);
  if (!isVideo) {
    const [w, h] = FORMAT_DIMENSIONS[fmt] || FORMAT_DIMENSIONS['portrait'];
    return { width: even(w), height: even(h) };
  }
  const height = VIDEO_FORMAT_HEIGHT[normalizeVideoFormatKey(videoFormat)];
  if (fmt === 'landscape') {
    return { width: even(Math.round((height * 16) / 9)), height: even(height) };
  }
  if (fmt === 'square') {
    const edge = even(height);
    return { width: edge, height: edge };
  }
  return { width: even(height), height: even(Math.round((height * 16) / 9)) };
}

export function formatPixelSize(size: { width: number; height: number }): string {
  return `${size.width}×${size.height}`;
}

/** Timeline length in seconds, including reusable-clip scene refs. */
export function postRuntimeSeconds(
  post: {
    id?: string;
    type?: string;
    scenes?: {
      gap_before_s?: number;
      duration_s?: number;
      ref_post_id?: string | null;
      enabled?: boolean;
    }[];
  },
  all: {
    id?: string;
    type?: string;
    scenes?: {
      gap_before_s?: number;
      duration_s?: number;
      ref_post_id?: string | null;
      enabled?: boolean;
    }[];
  }[],
  seen?: Set<string>,
): number {
  if (!post || post.type !== 'video') return 0;
  const stack = seen || new Set<string>();
  const id = String(post.id || '');
  if (id && stack.has(id)) return 0.5;
  if (id) stack.add(id);
  const scenes = post.scenes || [];
  if (!scenes.length) return 0.5;
  let t = 0;
  let any = false;
  for (const scene of scenes) {
    if (scene.enabled === false) continue;
    any = true;
    t += Math.max(0, Number(scene.gap_before_s) || 0);
    const refId = String(scene.ref_post_id || '').trim();
    if (refId) {
      const ref = all.find((p) => p.id === refId);
      t += ref
        ? postRuntimeSeconds(ref, all, stack)
        : Math.max(0.5, Number(scene.duration_s) || 0.5);
    } else {
      t += Math.max(0.5, Number(scene.duration_s) || 0.5);
    }
  }
  return any ? Math.max(0.5, t) : 0.5;
}
