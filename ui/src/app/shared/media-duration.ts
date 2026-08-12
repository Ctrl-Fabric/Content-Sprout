/** Compact length for video/audio cards and inspect. */
export function formatMediaDuration(seconds: number | null | undefined): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.round(s % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
  const rounded = Math.round(s * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
}

export function mediaDurationSeconds(value: number | null | undefined): number | null {
  const s = Number(value);
  return Number.isFinite(s) && s > 0 ? s : null;
}
