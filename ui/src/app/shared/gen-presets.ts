/** Fixed size / scale presets for ComfyUI generation (mirrors backend gen_presets). */

export interface SizePreset {
  width: number;
  height: number;
  label: string;
}

export const IMAGE_SIZE_PRESETS: SizePreset[] = [
  { width: 512, height: 512, label: '512×512' },
  { width: 512, height: 768, label: '512×768' },
  { width: 768, height: 512, label: '768×512' },
  { width: 640, height: 360, label: '640×360' },
  { width: 360, height: 640, label: '360×640' },
];

export const VIDEO_SIZE_PRESETS: SizePreset[] = [
  { width: 512, height: 288, label: '512×288' },
  { width: 640, height: 360, label: '640×360' },
  { width: 480, height: 480, label: '480×480' },
  { width: 768, height: 432, label: '768×432' },
];

export const IMAGE_UPSCALE_SCALES = [1.5, 2] as const;
export const VIDEO_UPSCALE_SCALES = [1.25, 1.5, 2] as const;

export const DEFAULT_IMAGE_SIZE = IMAGE_SIZE_PRESETS[0];
export const DEFAULT_VIDEO_SIZE = VIDEO_SIZE_PRESETS[1];

export function sizeKey(width: number, height: number): string {
  return `${width}x${height}`;
}
