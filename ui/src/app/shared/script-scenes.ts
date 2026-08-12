/** Client-side script scene parsing (mirrors legacy app.js helpers). */

import type { Layer, Scene, ScriptBrief } from '../models/content-sprout.models';
import { postRuntimeSeconds } from './post-format';

export interface ScriptCue {
  kind: string;
  detail: string;
  time_s: number | null;
  index: number;
  full: string;
  length: number;
}

export interface ScriptSceneBlock {
  id: string;
  name: string;
  detail: string;
  endDetail?: string;
  body: string;
  bodyStart: number;
  bodyEnd: number;
  hasBoundaries: boolean;
  cueSummary: { kind: string; n: number }[];
  duration_s: number;
}

const SCRIPT_CUE_KINDS = [
  'SCENE START',
  'SCENE END',
  'DURATION',
  'HELPER',
  'VISUAL',
  'ADD ASSET',
  'PAUSE SCRIPT',
  'RESUME SCRIPT',
] as const;

const SCRIPT_CUE_KIND_RE =
  /\[(SCENE\s+START|SCENE\s+END|DURATION|HELPER|VISUAL|ADD\s+ASSET|PAUSE\s+SCRIPT|RESUME\s+SCRIPT|PAUSE|MARKER|SPEAK|CLIP|IMAGE|INFOGRAPHIC|ON-SCREEN\s+TEXT|SFX|MUSIC)(?:\s*:\s*([^\]@]*?))?(?:\s*@\s*([^\]\s]+))?\s*\]/gi;

function normalizeCueKind(kind: string): string {
  const k = String(kind || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  const aliases: Record<string, string> = {
    PAUSE: 'PAUSE SCRIPT',
    MARKER: 'HELPER',
    SPEAK: 'HELPER',
    CLIP: 'VISUAL',
    IMAGE: 'VISUAL',
    INFOGRAPHIC: 'VISUAL',
    'ON-SCREEN TEXT': 'VISUAL',
    SFX: 'VISUAL',
    MUSIC: 'VISUAL',
  };
  return aliases[k] || k;
}

function isCanonicalScriptCueKind(kind: string): boolean {
  return (SCRIPT_CUE_KINDS as readonly string[]).includes(normalizeCueKind(kind));
}

function parseMarkerAtTimeToken(raw: string): number | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (m) return Math.max(0, Number(m[1]));
  m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Math.max(0, Number(m[1]) * 60 + Number(m[2]));
  return null;
}

function formatMarkerAtTime(timeS: number): string {
  const t = Math.max(0, Math.round(Number(timeS) * 10) / 10);
  if (t >= 60) {
    const m = Math.floor(t / 60);
    const sec = Math.round((t - m * 60) * 10) / 10;
    const secStr = Number.isInteger(sec)
      ? String(sec).padStart(2, '0')
      : sec.toFixed(1).padStart(4, '0');
    return `@ ${m}:${secStr}`;
  }
  return `@ ${t}s`;
}

function splitDetailAndAtTime(detail: string): { detail: string; time_s: number | null } {
  const raw = String(detail || '').trim();
  const m = raw.match(/^(.*?)\s*@\s*([^\s@]+)\s*$/);
  if (!m) return { detail: raw, time_s: null };
  return { detail: String(m[1] || '').trim(), time_s: parseMarkerAtTimeToken(m[2]) };
}

export function formatScriptCueTag(kind: string, detail = '', timeS: number | null = null): string {
  const k = normalizeCueKind(kind);
  const split = splitDetailAndAtTime(detail);
  const d = split.detail;
  const t =
    timeS != null && Number.isFinite(Number(timeS)) ? Number(timeS) : split.time_s;
  const at = t != null && Number.isFinite(t) ? ` ${formatMarkerAtTime(t)}` : '';
  if (d) return `[${k}: ${d}${at}]`;
  if (at) return `[${k}${at}]`;
  return `[${k}]`;
}

export function parseScriptProductionCues(script: string): ScriptCue[] {
  const text = String(script || '');
  const cues: ScriptCue[] = [];
  const re = new RegExp(SCRIPT_CUE_KIND_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const kind = normalizeCueKind(m[1]);
    if (!isCanonicalScriptCueKind(kind)) continue;
    const fromDetail = splitDetailAndAtTime(String(m[2] || '').trim());
    const fromAt = parseMarkerAtTimeToken(m[3] || '');
    cues.push({
      kind,
      detail: fromDetail.detail,
      time_s: fromAt != null ? fromAt : fromDetail.time_s,
      index: m.index,
      full: m[0],
      length: m[0].length,
    });
  }
  return cues;
}

function parsePauseDurationS(detail: string): number {
  const m = String(detail || '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (!m) return 0.5;
  return Math.max(0.1, Math.min(30, Number(m[1])));
}

function parseDurationTagS(detail: string): number | null {
  const m = String(detail || '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (!m) return null;
  return Math.max(0.5, Math.min(600, Number(m[1])));
}

function formatDurationTagDetail(seconds: number): string {
  const s = Math.max(0.5, Math.round(Number(seconds) * 10) / 10);
  return `${s}s`;
}

function stripDurationTags(text: string): string {
  return String(text || '')
    .replace(/\[DURATION\s*:\s*[^\]]*\]\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function estimateSpeechDurationS(text: string): number {
  const words = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1.0, Math.round((words / 2.5) * 10) / 10);
}

export function estimateSceneBodyDurationS(body: string): number {
  const text = String(body || '');
  const cues = parseScriptProductionCues(text);
  let pause = 0;
  for (const c of cues) {
    if (c.kind === 'PAUSE SCRIPT') pause += parsePauseDurationS(c.detail);
  }
  return Math.max(0.5, Math.round((estimateSpeechDurationS(text) + pause) * 10) / 10);
}

export function readSceneBodyDurationS(body: string): number {
  const cues = parseScriptProductionCues(body);
  for (const c of cues) {
    if (c.kind !== 'DURATION') continue;
    const d = parseDurationTagS(c.detail);
    if (d != null) return d;
  }
  return estimateSceneBodyDurationS(body);
}

export function withSceneDurationMarker(body: string, durationS: number): string {
  const cleaned = stripDurationTags(body);
  const tag = formatScriptCueTag('DURATION', formatDurationTagDetail(durationS));
  return cleaned ? `${tag}\n${cleaned}` : tag;
}

function summarizeSceneCues(cues: ScriptCue[]): { kind: string; n: number }[] {
  const counts: Record<string, number> = {};
  for (const c of cues || []) {
    if (c.kind === 'SCENE START' || c.kind === 'SCENE END' || c.kind === 'DURATION') continue;
    counts[c.kind] = (counts[c.kind] || 0) + 1;
  }
  return Object.entries(counts).map(([kind, n]) => ({ kind, n }));
}

export function deriveScriptSceneBlocks(script: string): ScriptSceneBlock[] {
  const text = String(script || '');
  const cues = parseScriptProductionCues(text);
  const starts = cues.filter((c) => c.kind === 'SCENE START');
  if (!starts.length) {
    return [
      {
        id: 'full',
        name: 'Full script',
        detail: '',
        body: text,
        bodyStart: 0,
        bodyEnd: text.length,
        hasBoundaries: false,
        cueSummary: summarizeSceneCues(cues),
        duration_s: readSceneBodyDurationS(text),
      },
    ];
  }
  const ends = cues.filter((c) => c.kind === 'SCENE END');
  const blocks: ScriptSceneBlock[] = [];
  if (starts[0].index > 0) {
    const lead = text.slice(0, starts[0].index).replace(/\n+$/, '');
    if (lead.trim()) {
      const leadCues = cues.filter((c) => c.index < starts[0].index);
      blocks.push({
        id: 'lead',
        name: 'Cold open',
        detail: '',
        body: lead.trim(),
        bodyStart: 0,
        bodyEnd: starts[0].index,
        hasBoundaries: false,
        cueSummary: summarizeSceneCues(leadCues),
        duration_s: readSceneBodyDurationS(lead),
      });
    }
  }
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const nextStart = starts[i + 1] || null;
    const endCue = ends.find(
      (e) => e.index > start.index && (!nextStart || e.index < nextStart.index),
    );
    const bodyStart = start.index + start.length;
    const bodyEnd = endCue ? endCue.index : nextStart ? nextStart.index : text.length;
    const body = text.slice(bodyStart, bodyEnd).replace(/^\n+/, '').replace(/\n+$/, '');
    const midCues = cues.filter((c) => c.index >= bodyStart && c.index < bodyEnd);
    const detail = String(start.detail || '').trim();
    blocks.push({
      id: `scene-${i}`,
      name: detail || `Scene ${i + 1}`,
      detail,
      body,
      bodyStart,
      bodyEnd,
      hasBoundaries: true,
      endDetail: String(endCue?.detail || detail || '').trim(),
      cueSummary: summarizeSceneCues(midCues),
      duration_s: readSceneBodyDurationS(body),
    });
  }
  return blocks;
}

export function stitchScriptFromSceneBlocks(blocks: ScriptSceneBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks || []) {
    const body = String(b.body || '')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
    if (!b.hasBoundaries) {
      if (body) parts.push(body);
      continue;
    }
    const startTag = formatScriptCueTag('SCENE START', b.detail || '');
    const endLabel = b.endDetail || b.detail;
    const endTag = formatScriptCueTag('SCENE END', endLabel || '');
    parts.push([startTag, body, endTag].filter((s) => s !== '').join('\n'));
  }
  return parts.join('\n\n');
}

export function ensureScriptDurationMarkers(script: string, reestimate = true): string {
  const text = String(script || '');
  if (!text.trim()) return text;
  const blocks = deriveScriptSceneBlocks(text).map((b) => {
    const duration_s = reestimate ? estimateSceneBodyDurationS(b.body) : readSceneBodyDurationS(b.body);
    return {
      ...b,
      duration_s,
      body: withSceneDurationMarker(b.body, duration_s),
    };
  });
  return stitchScriptFromSceneBlocks(blocks);
}

export function scriptSpokenWordCount(text: string): number {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function getScriptEstimatedDurationS(script: string): number {
  const plan = getScriptSceneTimingPlan(script);
  if (plan.length) return plan[plan.length - 1].end_s;
  return estimateSceneBodyDurationS(script);
}

export interface ScriptSceneTimingRow extends ScriptSceneBlock {
  start_s: number;
  end_s: number;
}

export function getScriptSceneTimingPlan(script: string): ScriptSceneTimingRow[] {
  const blocks = deriveScriptSceneBlocks(script);
  let t = 0;
  return blocks.map((b) => {
    const duration_s = readSceneBodyDurationS(b.body);
    const row = {
      ...b,
      duration_s,
      start_s: t,
      end_s: t + duration_s,
    };
    t += duration_s;
    return row;
  });
}

export function scriptSliceSpoken(script: string, fromIdx: number, toIdx: number): string {
  return String(script || '')
    .slice(Math.max(0, fromIdx), Math.max(fromIdx, toIdx))
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function sceneBodySpokenText(body: string): string {
  return String(body || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function newUid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveSceneRangesFromScript(script: string): {
  name: string;
  start_s: number;
  end_s: number;
  startIdx: number;
  endIdx: number;
  duration_s: number;
}[] {
  const text = String(script || '');
  const plan = getScriptSceneTimingPlan(text);
  if (!plan.length) {
    const dur = Math.max(0.5, getScriptEstimatedDurationS(text) || 0.5);
    return [
      {
        name: 'Scene 1',
        start_s: 0,
        end_s: dur,
        startIdx: 0,
        endIdx: text.length,
        duration_s: dur,
      },
    ];
  }
  return plan.map((row) => ({
    name: row.name || 'Scene',
    start_s: row.start_s,
    end_s: row.end_s,
    startIdx: row.bodyStart,
    endIdx: row.bodyEnd,
    duration_s: row.duration_s,
  }));
}

export function makeScaffoldTtsLayer(
  text: string,
  sceneDur: number,
  zIndex = 0,
  defaultVoice: string | null = null,
): Layer | null {
  const spoken = String(text || '').trim();
  if (!spoken) return null;
  const est = estimateSpeechDurationS(spoken);
  return {
    id: newUid(),
    type: 'tts',
    title: 'Voice',
    x: 8,
    y: 78,
    width: 84,
    height: 14,
    z_index: zIndex,
    text: spoken,
    font_size: 28,
    color: '#ffffff',
    font_weight: 'bold',
    opacity: 1,
    transition_in: 'none',
    transition_out: 'none',
    tts_voice: defaultVoice,
    tts_volume: 1,
    tts_mood: 'neutral',
    tts_pacing: 'natural',
    show_caption: false,
    asset_id: null,
    start_s: 0,
    duration_s: Math.min(Math.max(0.5, sceneDur), Math.max(0.5, est)),
  };
}

export function scenesAreEmptyScaffold(scenes: Scene[] | undefined): boolean {
  const list = scenes || [];
  if (!list.length) return true;
  return list.every((s) => {
    if (s?.ref_post_id) return false;
    if (s?.background_asset_id) return false;
    return !(s?.layers || []).length;
  });
}

export function scenesAreScriptScaffold(scenes: Scene[] | undefined): boolean {
  const list = scenes || [];
  if (!list.length) return true;
  return list.every((s) => {
    if (s?.ref_post_id) return false;
    if (s?.background_asset_id) return false;
    const layers = s?.layers || [];
    if (!layers.length) return true;
    return layers.every((l) => l?.type === 'tts' && !l.asset_id);
  });
}

export function buildScenesFromScript(
  script: string,
  opts: { targetFormat?: string; defaultVoice?: string | null } = {},
): Scene[] {
  const stamped = ensureScriptDurationMarkers(script, true);
  const ranges = deriveSceneRangesFromScript(stamped);
  const fmt = opts.targetFormat || 'portrait';
  return ranges.map((r, i) => {
    const dur = Math.max(
      0.5,
      Number(r.duration_s) || Math.round((r.end_s - r.start_s) * 10) / 10,
    );
    const spoken = scriptSliceSpoken(stamped, r.startIdx, r.endIdx);
    const layer = makeScaffoldTtsLayer(spoken, dur, 0, opts.defaultVoice ?? null);
    return {
      id: newUid(),
      name: r.name || `Scene ${i + 1}`,
      duration_s: dur,
      gap_before_s: 0,
      background_asset_id: null,
      background_format: fmt,
      layers: layer ? [layer] : [],
      ref_post_id: null,
    };
  });
}

type TimelinePost = {
  id?: string;
  type?: string;
  scenes?: { gap_before_s?: number; duration_s?: number; ref_post_id?: string | null }[];
};

function sceneSlotDuration(scene: Scene, allPosts?: TimelinePost[]): number {
  const refId = String(scene.ref_post_id || '').trim();
  if (refId && allPosts?.length) {
    const ref = allPosts.find((p) => p.id === refId);
    if (ref) return postRuntimeSeconds(ref, allPosts);
  }
  return Math.max(0.5, Number(scene.duration_s) || 5);
}

export function getSceneTimeline(
  scenes: Scene[],
  allPosts?: TimelinePost[],
): {
  scene: Scene;
  start: number;
  duration: number;
  end: number;
  gap: number;
}[] {
  let t = 0;
  return (scenes || []).map((s) => {
    const gap = Math.max(0, Number(s.gap_before_s) || 0);
    t += gap;
    const duration = sceneSlotDuration(s, allPosts);
    const start = t;
    t += duration;
    return { scene: s, start, duration, end: t, gap };
  });
}

export function computePostDuration(scenes: Scene[], allPosts?: TimelinePost[]): number {
  const plan = getSceneTimeline(scenes, allPosts);
  if (!plan.length) return 0.5;
  return Math.max(0.5, plan[plan.length - 1].end);
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const rem = Math.round((s - m * 60) * 10) / 10;
  const remStr = Number.isInteger(rem)
    ? String(rem).padStart(2, '0')
    : rem.toFixed(1).padStart(4, '0');
  return `${m}:${remStr}`;
}

export function formatScriptDurationLabel(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `~${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `~${m}:${String(rem).padStart(2, '0')}`;
}

/** Media types that can be declared on VISUAL / ADD ASSET markers. */
export const VISUAL_MEDIA_TYPES = [
  { id: 'video', label: 'Video' },
  { id: 'photo', label: 'Photo' },
  { id: 'illustration', label: 'Illustration' },
  { id: 'vector', label: 'Vector' },
  { id: 'model', label: '3D' },
  { id: 'music', label: 'Music' },
  { id: 'sound', label: 'SFX' },
  { id: 'any', label: 'Any / unspecified' },
] as const;

export type VisualMediaTypeId = (typeof VISUAL_MEDIA_TYPES)[number]['id'];

const VISUAL_TYPE_IDS = new Set(VISUAL_MEDIA_TYPES.map((t) => t.id));

/** Normalize aliases (image→photo, 3d→model, sfx→sound, audio→music). */
export function normalizeVisualMediaType(raw: string | null | undefined): VisualMediaTypeId | null {
  const key = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!key) return null;
  const aliases: Record<string, VisualMediaTypeId> = {
    image: 'photo',
    images: 'photo',
    photo: 'photo',
    photos: 'photo',
    still: 'photo',
    illustration: 'illustration',
    illustrations: 'illustration',
    vector: 'vector',
    vectors: 'vector',
    svg: 'vector',
    video: 'video',
    videos: 'video',
    clip: 'video',
    broll: 'video',
    'b-roll': 'video',
    music: 'music',
    audio: 'music',
    soundtrack: 'music',
    sound: 'sound',
    sfx: 'sound',
    'sound effect': 'sound',
    model: 'model',
    '3d': 'model',
    '3d model': 'model',
    any: 'any',
    unspecified: 'any',
    other: 'any',
  };
  if (aliases[key]) return aliases[key];
  if (VISUAL_TYPE_IDS.has(key as VisualMediaTypeId)) return key as VisualMediaTypeId;
  return null;
}

export function visualMediaTypeLabel(id: string | null | undefined): string {
  const n = normalizeVisualMediaType(id);
  if (!n) return '';
  return VISUAL_MEDIA_TYPES.find((t) => t.id === n)?.label || n;
}

/**
 * Build VISUAL / ADD ASSET detail text:
 * `video · description` or `video · 3.5s · description` when duration is set.
 * Plain description (no type) is still valid for older scripts.
 */
export function formatTypedVisualDetail(
  mediaType: string | null | undefined,
  description: string,
  durationS: number | string | null | undefined = null,
): string {
  const parsedIn = parseTypedVisualDetail(String(description || '').trim());
  const type =
    normalizeVisualMediaType(mediaType) ||
    parsedIn.mediaType ||
    null;
  const desc = parsedIn.mediaType
    ? parsedIn.description
    : String(description || '').trim();
  const fromArg = parseVisualDurationToken(durationS);
  const dur =
    fromArg != null
      ? fromArg
      : parsedIn.duration_s != null
        ? parsedIn.duration_s
        : null;
  const durLabel = dur != null ? formatVisualDurationToken(dur) : '';

  if (type && type !== 'any') {
    if (durLabel && desc) return `${type} · ${durLabel} · ${desc}`;
    if (durLabel) return `${type} · ${durLabel}`;
    if (desc) return `${type} · ${desc}`;
    return type;
  }
  if (durLabel && desc) return `${durLabel} · ${desc}`;
  if (durLabel) return durLabel;
  return desc;
}

/** True for media kinds where clip/track length is meaningful. */
export function visualMediaTypeSupportsDuration(
  mediaType: string | null | undefined,
): boolean {
  const t = normalizeVisualMediaType(mediaType);
  return t === 'video' || t === 'music' || t === 'sound';
}

/** Parse `3.5s`, `3.5`, or `1:05` into seconds. */
export function parseVisualDurationToken(
  raw: string | number | null | undefined,
): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 10) / 10 : null;
  }
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*s$/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
  }
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
  }
  m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) {
    const n = Number(m[1]) * 60 + Number(m[2]);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
  }
  return null;
}

export function formatVisualDurationToken(seconds: number): string {
  const t = Math.max(0, Math.round(Number(seconds) * 10) / 10);
  if (!Number.isFinite(t) || t <= 0) return '';
  return Number.isInteger(t) ? `${t}s` : `${t}s`;
}

/**
 * Parse `video · description`, `video · 3.5s · description`,
 * or freeform trailing `, 3s` / `(3s)`.
 */
export function parseTypedVisualDetail(detail: string): {
  mediaType: VisualMediaTypeId | null;
  duration_s: number | null;
  description: string;
} {
  const raw = String(detail || '').trim();
  if (!raw) return { mediaType: null, duration_s: null, description: '' };

  const takeTrailingDuration = (text: string): { duration_s: number | null; description: string } => {
    let t = String(text || '').trim();
    let m = t.match(/^(.*?)\s*[·\-—|:]\s*(\d+(?:\.\d+)?\s*s?|\d+:\d{1,2}(?:\.\d+)?)\s*$/i);
    if (m) {
      const dur = parseVisualDurationToken(m[2]);
      if (dur != null) return { duration_s: dur, description: String(m[1] || '').trim() };
    }
    m = t.match(/^(.*?)(?:,\s*|\s+)\((\d+(?:\.\d+)?\s*s?)\)\s*$/i);
    if (m) {
      const dur = parseVisualDurationToken(m[2]);
      if (dur != null) return { duration_s: dur, description: String(m[1] || '').trim() };
    }
    m = t.match(/^(.*?),\s*(\d+(?:\.\d+)?)\s*s\s*$/i);
    if (m) {
      const dur = parseVisualDurationToken(`${m[2]}s`);
      if (dur != null) return { duration_s: dur, description: String(m[1] || '').trim() };
    }
    return { duration_s: null, description: t };
  };

  const typed = raw.match(/^([a-z0-9][a-z0-9 \-]{0,24}?)\s*(?:·|-|:|—)\s*(.+)$/i);
  if (typed) {
    const type = normalizeVisualMediaType(typed[1]);
    if (type) {
      const rest = String(typed[2] || '').trim();
      // `video · 3.5s · description` or `video · 3.5s`
      const durFirst = rest.match(
        /^(\d+(?:\.\d+)?\s*s?|\d+:\d{1,2}(?:\.\d+)?)\s*(?:(?:·|-|:|—)\s*(.+))?$/i,
      );
      if (durFirst) {
        const dur = parseVisualDurationToken(durFirst[1]);
        if (dur != null) {
          return {
            mediaType: type,
            duration_s: dur,
            description: String(durFirst[2] || '').trim(),
          };
        }
      }
      const trailing = takeTrailingDuration(rest);
      return { mediaType: type, duration_s: trailing.duration_s, description: trailing.description };
    }
  }

  const only = normalizeVisualMediaType(raw);
  if (only) return { mediaType: only, duration_s: null, description: '' };

  const bareDur = parseVisualDurationToken(raw);
  if (bareDur != null) return { mediaType: null, duration_s: bareDur, description: '' };

  const trailing = takeTrailingDuration(raw);
  return { mediaType: null, duration_s: trailing.duration_s, description: trailing.description };
}

export function uniqueNewSceneDetail(blocks: ScriptSceneBlock[], base = 'New scene'): string {
  const stem = String(base || 'New scene').trim() || 'New scene';
  const used = new Set(
    (blocks || [])
      .map((b) => String(b.detail || b.name || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (!used.has(stem.toLowerCase())) return stem;
  let n = 2;
  while (used.has(`${stem} ${n}`.toLowerCase())) n += 1;
  return `${stem} ${n}`;
}

export function makeBlankScriptSceneBlock(detail: string, duration_s = 8): ScriptSceneBlock {
  const d = String(detail || 'New scene').trim() || 'New scene';
  const dur = Number(duration_s) > 0 ? Number(duration_s) : 8;
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: d,
    detail: d,
    endDetail: d,
    hasBoundaries: true,
    body: withSceneDurationMarker('', dur),
    bodyStart: 0,
    bodyEnd: 0,
    duration_s: dur,
    cueSummary: [],
  };
}

export function promoteUnboundBlocksForInsert(blocks: ScriptSceneBlock[]): ScriptSceneBlock[] {
  return (blocks || []).map((b) => {
    if (b.hasBoundaries || b.id === 'lead') return b;
    let detail = String(b.detail || '').trim();
    if (!detail || /^full script$/i.test(b.name || '')) detail = 'Scene 1';
    else detail = String(b.name || detail).trim() || 'Scene 1';
    const duration_s = Number(b.duration_s) > 0 ? Number(b.duration_s) : readSceneBodyDurationS(b.body);
    return {
      ...b,
      hasBoundaries: true,
      detail,
      endDetail: detail,
      name: detail,
      duration_s,
      body: withSceneDurationMarker(b.body, duration_s),
    };
  });
}

export function defaultScriptBrief(): ScriptBrief {
  return {
    topic: '',
    tone: 'conversational',
    length: 'medium',
    duration_s: 60,
    audience: '',
    language: 'English',
    notes: '',
  };
}
