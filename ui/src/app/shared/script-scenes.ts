/** Client-side script scene parsing (mirrors legacy app.js helpers). */

import type { Layer, Post, Scene, ScriptBrief } from '../models/content-sprout.models';
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
  'BACKGROUND VISUAL',
  'REUSABLE POST',
  'PAUSE SCRIPT',
  'RESUME SCRIPT',
] as const;

const SCRIPT_CUE_KIND_RE =
  /\[(SCENE\s+START|SCENE\s+END|DURATION|HELPER|BACKGROUND\s+VISUAL|VISUAL|ADD\s+ASSET|REUSABLE\s+POST|PAUSE\s+SCRIPT|RESUME\s+SCRIPT|PAUSE|MARKER|SPEAK|CLIP|IMAGE|INFOGRAPHIC|ON-SCREEN\s+TEXT|SFX|MUSIC)(?:\s*:\s*([^\]@]*?))?(?:\s*@\s*([^\]\s]+))?\s*\]/gi;

const BACKGROUND_VISUAL_TAG_RE =
  /\[BACKGROUND\s+VISUAL(?:\s*:\s*[^\]@]*?)?(?:\s*@\s*[^\]\s]+)?\]\s*/gi;

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

/** True when the scene body opts in to a background / scene-visual plate. */
export function sceneAllowsBackgroundVisual(body: string | null | undefined): boolean {
  return parseScriptProductionCues(String(body || '')).some((c) => c.kind === 'BACKGROUND VISUAL');
}

/** Insert or remove the `[BACKGROUND VISUAL]` flag tag on a scene body. */
export function setSceneBackgroundVisualEnabled(body: string, enabled: boolean): string {
  let text = String(body || '')
    .replace(BACKGROUND_VISUAL_TAG_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  if (!enabled) return text.replace(/^\n+/, '');
  const tag = formatScriptCueTag('BACKGROUND VISUAL');
  if (!text.trim()) return tag;
  const dur = text.match(/(\[DURATION\s*:[^\]]*\]\s*)/i);
  if (dur && dur.index != null) {
    const at = dur.index + dur[0].length;
    return `${text.slice(0, at)}${tag}\n${text.slice(at).replace(/^\n+/, '')}`;
  }
  return `${tag}\n${text.replace(/^\n+/, '')}`;
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
    if (
      c.kind === 'SCENE START' ||
      c.kind === 'SCENE END' ||
      c.kind === 'DURATION' ||
      c.kind === 'BACKGROUND VISUAL'
    )
      continue;
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

export interface SpokenTextBlock {
  /** Full spoken string (includes list marker when kind is list). */
  text: string;
  kind: 'sentence' | 'list';
  /** `1.`, `2)`, `-`, `•`, `a.` — null for normal sentences. */
  marker: string | null;
  /** Point copy without the marker. Same as `text` for sentences. */
  body: string;
}

const LIST_LINE_RE = /^((?:\d+[.)])|(?:[A-Za-z][.)])|(?:[-*•–—]))\s+(\S[\s\S]*)$/;

function sentenceBlock(text: string): SpokenTextBlock {
  const t = text.trim();
  return { text: t, kind: 'sentence', marker: null, body: t };
}

function listBlock(marker: string, body: string): SpokenTextBlock {
  const m = String(marker || '').trim();
  const b = String(body || '').trim();
  return {
    text: b ? `${m} ${b}`.trim() : m,
    kind: 'list',
    marker: m,
    body: b || m,
  };
}

function parseListLine(line: string): SpokenTextBlock | null {
  const m = String(line || '').trim().match(LIST_LINE_RE);
  if (!m) return null;
  return listBlock(m[1], m[2]);
}

/** Split a single line that contains sequential numbered points, e.g. `1. Foo 2. Bar`. */
function trySplitInlineNumbered(line: string): SpokenTextBlock[] | null {
  const text = String(line || '').trim();
  if (!text) return null;
  const markerRe = /(?:^|\s+)(\d+)[.)]\s+\S/g;
  const nums: number[] = [];
  let hit: RegExpExecArray | null;
  while ((hit = markerRe.exec(text))) nums.push(Number(hit[1]));
  if (nums.length < 2) return null;
  let sequential = true;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) sequential = false;
  }
  if (!sequential && nums[0] !== 1) return null;

  const parts = text
    .split(/(?=(?:^|\s)(?:\d+[.)])\s+\S)/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map((part) => parseListLine(part) || sentenceBlock(part));
}

/** Split prose on `.?!` without breaking `1. Point` or `3.5`. */
function splitPlainSentences(text: string): SpokenTextBlock[] {
  const src = String(text || '').trim();
  if (!src) return [];
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    buf += ch;
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const prev = src[i - 1] || '';
    const next = src[i + 1] || '';
    const next2 = src[i + 2] || '';
    // Decimal: 3.5
    if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue;
    // Numbered / lettered marker: "1. Point" / "A. Item"
    if (ch === '.' && /\s/.test(next) && /\S/.test(next2)) {
      const before = buf.slice(0, -1);
      if (/(?:^|[\s])(?:\d+|[A-Za-z])$/.test(before)) continue;
    }
    while (i + 1 < src.length && /['"”’)\]]/.test(src[i + 1])) {
      i += 1;
      buf += src[i];
    }
    const piece = buf.trim();
    if (piece) parts.push(piece);
    buf = '';
  }
  const rest = buf.trim();
  if (rest) parts.push(rest);
  return (parts.length ? parts : [src]).map(sentenceBlock);
}

/**
 * Split spoken script into attachable blocks.
 * Newline list items (`1. Point`, `- bullet`) stay as one block.
 */
export function splitSpokenTextBlocks(text: string): SpokenTextBlock[] {
  const raw = String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!raw) return [];
  const blocks: SpokenTextBlock[] = [];
  for (const para of raw.split(/\n+/)) {
    const line = para.trim();
    if (!line) continue;
    const inline = trySplitInlineNumbered(line);
    if (inline?.length) {
      blocks.push(...inline);
      continue;
    }
    const asList = parseListLine(line);
    if (asList) {
      blocks.push(asList);
      continue;
    }
    blocks.push(...splitPlainSentences(line));
  }
  return blocks;
}

/** Split spoken script into display/speech sentences. */
export function splitSpokenSentences(text: string): string[] {
  return splitSpokenTextBlocks(text)
    .map((b) => b.text)
    .filter((p) => p.length > 0);
}

/** Script spoken copy as timed Text layers (one sentence per layer, speech-paced). */
export function makeScaffoldTextLayers(
  text: string,
  sceneDur: number,
  zIndex = 0,
): Layer[] {
  const sentences = splitSpokenSentences(text);
  if (!sentences.length) return [];

  const estimates = sentences.map((s) => estimateSpeechDurationS(s));
  const totalEst = estimates.reduce((sum, n) => sum + n, 0) || 1;
  const cap = Math.max(0.5, Number(sceneDur) || 0.5);
  // Fit the sentence chain into the scene window so captions track speech pacing.
  const scale = totalEst > cap ? cap / totalEst : 1;

  let t = 0;
  return sentences.map((sentence, i) => {
    const rawDur = Math.max(0.4, Math.round(estimates[i] * scale * 10) / 10);
    const start = Math.min(t, Math.max(0, cap - 0.35));
    const duration_s = Math.min(rawDur, Math.max(0.35, cap - start));
    t = start + duration_s;
    return {
      id: newUid(),
      type: 'text',
      title: sentences.length > 1 ? `Text ${i + 1}` : 'Text',
      from_script: true,
      x: 8,
      y: 70,
      width: 84,
      height: 22,
      z_index: zIndex,
      text: sentence,
      font_size: 34,
      color: '#ffffff',
      font_weight: 'bold',
      opacity: 1,
      transition_in: 'fade-in',
      transition_out: 'fade-out',
      asset_id: null,
      start_s: start,
      duration_s,
    };
  });
}

/** Single-layer helper — prefers the first sentence when splitting. */
export function makeScaffoldTextLayer(
  text: string,
  sceneDur: number,
  zIndex = 0,
): Layer | null {
  return makeScaffoldTextLayers(text, sceneDur, zIndex)[0] || null;
}

/** @deprecated Use makeScaffoldTextLayer — kept for callers that still expect the old name. */
export function makeScaffoldTtsLayer(
  text: string,
  sceneDur: number,
  zIndex = 0,
  _defaultVoice: string | null = null,
): Layer | null {
  return makeScaffoldTextLayer(text, sceneDur, zIndex);
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
    return layers.every((l) => isScaffoldScriptLayer(l));
  });
}

export function buildScenesFromScript(
  script: string,
  opts: { targetFormat?: string; defaultVoice?: string | null } = {},
): Scene[] {
  // Preserve explicit [DURATION: ...] markers when present.
  // This matters for UI-driven scene insertion where duration is user-provided.
  // If a duration marker is missing, readSceneBodyDurationS falls back to estimating.
  const stamped = ensureScriptDurationMarkers(script, false);
  const reusableCues = parseScriptProductionCues(stamped).filter(
    (c) => c.kind === 'REUSABLE POST' && String(c.detail || '').trim(),
  );
  const ranges = deriveSceneRangesFromScript(stamped);
  const fmt = opts.targetFormat || 'portrait';
  return ranges.map((r, i) => {
    const dur = Math.max(
      0.5,
      Number(r.duration_s) || Math.round((r.end_s - r.start_s) * 10) / 10,
    );
    const reusable = reusableCues.find((c) => c.index >= r.startIdx && c.index < r.endIdx);
    const refPostId = reusable ? String(reusable.detail || '').trim() : null;

    const spoken = scriptSliceSpoken(stamped, r.startIdx, r.endIdx);
    const layers: Layer[] = [];
    if (!refPostId) {
      layers.push(...makeScaffoldTextLayers(spoken, dur, 0));
    } else {
      layers.push({
        id: newUid(),
        type: 'ref',
        title: 'Reusable clip',
        ref_post_id: refPostId,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        z_index: 0,
        opacity: 1,
        start_s: 0,
        duration_s: dur,
      });
      layers.push(...makeScaffoldTextLayers(spoken, dur, 1));
    }
    return {
      id: newUid(),
      name: r.name || `Scene ${i + 1}`,
      duration_s: dur,
      gap_before_s: 0,
      background_asset_id: null,
      background_format: fmt,
      background_color: null,
      allow_background_visual: sceneAllowsBackgroundVisual(stamped.slice(r.startIdx, r.endIdx)),
      layers,
      ref_post_id: null,
    };
  });
}

type TimelinePost = {
  id?: string;
  type?: string;
  scenes?: {
    gap_before_s?: number;
    duration_s?: number;
    ref_post_id?: string | null;
    enabled?: boolean;
  }[];
};

export function isSceneEnabled(scene: { enabled?: boolean } | null | undefined): boolean {
  return !scene || scene.enabled !== false;
}

export function isLayerEnabled(layer: { enabled?: boolean } | null | undefined): boolean {
  return !layer || layer.enabled !== false;
}

function sceneSlotDuration(scene: Scene, allPosts?: TimelinePost[]): number {
  if (!isSceneEnabled(scene)) return 0;
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
  const out: {
    scene: Scene;
    start: number;
    duration: number;
    end: number;
    gap: number;
  }[] = [];
  for (const s of scenes || []) {
    if (!isSceneEnabled(s)) continue;
    const gap = Math.max(0, Number(s.gap_before_s) || 0);
    t += gap;
    const duration = sceneSlotDuration(s, allPosts);
    if (duration <= 0) continue;
    const start = t;
    t += duration;
    out.push({ scene: s, start, duration, end: t, gap });
  }
  return out;
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

/** VISUAL / ADD ASSET cues surfaced as actionable blocks in the script panel. */
export interface ScriptVisualBlock {
  kind: 'VISUAL' | 'ADD ASSET';
  full: string;
  detail: string;
  mediaType: VisualMediaTypeId | null;
  duration_s: number | null;
  description: string;
  /** AI generate family — null when music/sfx/model (not image/video gen). */
  genKind: 'image' | 'video' | null;
  /** Primary attach family for the block (image/video/music/sound). */
  attachKind: 'image' | 'video' | 'music' | 'sound' | null;
  /** True when marker lacks an explicit image/video family type. */
  needsGenKind: boolean;
  /** Linked asset id from trailing `#…` in the cue, if any. */
  assetRef: string | null;
}

/** Map marker media type → image or video generation (or none). */
export function visualBlockGenKind(
  mediaType: string | null | undefined,
): 'image' | 'video' | null {
  const t = normalizeVisualMediaType(mediaType);
  if (t === 'video') return 'video';
  if (t === 'photo' || t === 'illustration' || t === 'vector') return 'image';
  return null;
}

/** Map marker media type → attach picker lock. */
export function visualBlockAttachKind(
  mediaType: string | null | undefined,
): 'image' | 'video' | 'music' | 'sound' | null {
  const t = normalizeVisualMediaType(mediaType);
  if (t === 'video') return 'video';
  if (t === 'photo' || t === 'illustration' || t === 'vector') return 'image';
  if (t === 'music') return 'music';
  if (t === 'sound') return 'sound';
  return null;
}

export function extractSceneVisualBlocks(body: string): ScriptVisualBlock[] {
  return parseScriptProductionCues(body)
    .filter((c): c is ScriptCue & { kind: 'VISUAL' | 'ADD ASSET' } =>
      c.kind === 'VISUAL' || c.kind === 'ADD ASSET',
    )
    .map((c) => {
      const parsed = parseTypedVisualDetail(c.detail);
      const genKind = visualBlockGenKind(parsed.mediaType);
      const attachKind = visualBlockAttachKind(parsed.mediaType);
      const description = parsed.description || c.detail;
      return {
        kind: c.kind,
        full: c.full,
        detail: c.detail,
        mediaType: parsed.mediaType,
        duration_s: parsed.duration_s,
        description,
        genKind,
        attachKind,
        needsGenKind: genKind == null && (parsed.mediaType == null || parsed.mediaType === 'any'),
        assetRef: parseVisualAssetRef(description) || parseVisualAssetRef(c.detail),
      };
    })
    .filter((b) => {
      if (b.mediaType === 'model') return false;
      return !!(b.description || b.mediaType);
    });
}

/**
 * Rewrite a VISUAL / ADD ASSET tag so it carries an explicit media type
 * (and optional duration) for the chosen image/video generation kind.
 */
export function rewriteVisualCueWithGenKind(
  fullTag: string,
  genKind: 'image' | 'video',
  description: string,
  durationS: number | null = null,
): string {
  const m = String(fullTag || '').match(
    /^\[(VISUAL|ADD\s+ASSET)(?:\s*:\s*([^\]@]*?))?((?:\s*@\s*[^\]]*)?)\s*\]$/i,
  );
  if (!m) return fullTag;
  const kind = normalizeCueKind(m[1]);
  const at = String(m[3] || '').trim();
  const mediaType = genKind === 'video' ? 'video' : 'photo';
  const detail = formatTypedVisualDetail(mediaType, description, durationS);
  const inner = detail ? `${kind}: ${detail}` : kind;
  return at ? `[${inner} ${at}]` : `[${inner}]`;
}

/** Pull a trailing `#assetId` (or `global:…`) from a visual detail string. */
export function parseVisualAssetRef(detailOrDescription: string): string | null {
  const m = String(detailOrDescription || '').match(/#([a-zA-Z0-9_.:-]+)\s*$/);
  return m ? m[1] : null;
}

/** Strip a trailing `#assetId` from description copy. */
export function stripVisualAssetRef(description: string): string {
  return String(description || '')
    .replace(/\s*·\s*#[a-zA-Z0-9_.:-]+\s*$/i, '')
    .replace(/\s*#[a-zA-Z0-9_.:-]+\s*$/i, '')
    .trim();
}

/**
 * Rewrite a visual cue to link a concrete asset id while keeping type + description.
 */
export function rewriteVisualCueWithAsset(
  fullTag: string,
  mediaType: VisualMediaTypeId | 'image' | 'video',
  description: string,
  assetRef: string,
  durationS: number | null = null,
): string {
  const m = String(fullTag || '').match(
    /^\[(VISUAL|ADD\s+ASSET)(?:\s*:\s*([^\]@]*?))?((?:\s*@\s*[^\]]*)?)\s*\]$/i,
  );
  if (!m) return fullTag;
  const kind = normalizeCueKind(m[1]);
  const at = String(m[3] || '').trim();
  const resolved =
    mediaType === 'image'
      ? 'photo'
      : mediaType === 'video'
        ? 'video'
        : normalizeVisualMediaType(mediaType) || 'photo';
  const ref = String(assetRef || '').trim().replace(/^#/, '');
  const base = stripVisualAssetRef(description) || 'Asset';
  const withRef = ref ? `${base} · #${ref}` : base;
  const detail = formatTypedVisualDetail(resolved, withRef, durationS);
  const inner = detail ? `${kind}: ${detail}` : kind;
  return at ? `[${inner} ${at}]` : `[${inner}]`;
}

/** Build a new ADD ASSET cue for an attached library asset. */
export function buildAddAssetCueForAsset(
  mediaType: VisualMediaTypeId,
  name: string,
  assetRef: string,
  durationS: number | null = null,
): string {
  const ref = String(assetRef || '').trim().replace(/^#/, '');
  const base = String(name || 'Asset').trim() || 'Asset';
  const withRef = ref ? `${base} · #${ref}` : base;
  const detail = formatTypedVisualDetail(mediaType, withRef, durationS);
  return formatScriptCueTag('ADD ASSET', detail);
}

/** Append a cue tag to a scene body (before trailing SCENE END if present). */
export function appendCueToSceneBody(body: string, tag: string): string {
  const cue = String(tag || '').trim();
  if (!cue) return String(body || '');
  const text = String(body || '').trimEnd();
  if (!text) return cue;
  if (text.includes(cue)) return text;
  const endRe = /\n?\s*\[SCENE\s+END[^\]]*\]\s*$/i;
  if (endRe.test(text)) {
    return text.replace(endRe, `\n${cue}\n$&`).replace(/\n{3,}/g, '\n\n');
  }
  return `${text}\n${cue}`;
}

/**
 * Place an image / video / audio layer for a script-attached asset on a scene.
 * Always adds a new layer (does not replace), so extras stack on the scene.
 */
export function attachAssetLayerToScene(
  post: Post,
  sceneIndex: number,
  assetRef: string,
  layerKind: 'image' | 'video' | 'audio',
  opts?: {
    title?: string;
    duration_s?: number | null;
    replaceSameRef?: boolean;
  },
): Post | null {
  if (post.type !== 'video') return null;
  const ref = String(assetRef || '').trim();
  if (!ref) return null;
  const scenes = [...(post.scenes || [])];
  if (sceneIndex < 0 || sceneIndex >= scenes.length) return null;
  const scene = { ...scenes[sceneIndex] };
  const layers = [...(scene.layers || [])];
  const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
  const mediaDur = opts?.duration_s != null ? Number(opts.duration_s) : null;
  const duration =
    mediaDur != null && Number.isFinite(mediaDur) && mediaDur > 0
      ? Math.min(Math.max(0.5, mediaDur), sceneDur)
      : sceneDur;

  if (opts?.replaceSameRef) {
    const existingIdx = layers.findIndex((l) => String(l.asset_id || '') === ref);
    if (existingIdx >= 0) {
      const prev = layers[existingIdx];
      layers[existingIdx] = {
        ...prev,
        type: layerKind,
        title: (opts?.title || prev.title || layerKind).slice(0, 40),
        asset_id: ref,
        duration_s: duration,
      };
      scene.layers = layers;
      scenes[sceneIndex] = scene;
      return { ...post, scenes };
    }
  }

  if (layerKind === 'audio') {
    layers.push({
      id: newUid(),
      type: 'audio',
      title: (opts?.title || 'Audio').slice(0, 40),
      asset_id: ref,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      z_index: layers.length + 1,
      opacity: 1,
      tts_volume: 0.8,
      start_s: 0,
      duration_s: duration,
    });
  } else {
    const visuals = layers.filter((l) => l.type === 'image' || l.type === 'video');
    const asBottom = !visuals.length && opts?.replaceSameRef;
    layers.push({
      id: newUid(),
      type: layerKind,
      title: (opts?.title || layerKind).slice(0, 40),
      asset_id: ref,
      x: asBottom ? 0 : 10 + (visuals.length % 3) * 4,
      y: asBottom ? 0 : 10 + (visuals.length % 3) * 4,
      width: asBottom ? 100 : 80,
      height: asBottom ? 100 : 80,
      z_index: asBottom ? 0 : layers.length + 1,
      opacity: 1,
      start_s: 0,
      duration_s: asBottom ? sceneDur : duration,
      source_start_s: 0,
    });
  }

  scene.layers = layers;
  scenes[sceneIndex] = scene;
  return { ...post, scenes };
}

/**
 * Set the scene’s primary visual (lowest-z image/video, else background asset).
 * Replaces an existing plate; otherwise inserts a full-bleed layer.
 */
export function attachScenePrimaryVisual(
  post: Post,
  sceneIndex: number,
  assetRef: string,
  layerKind: 'image' | 'video',
  opts?: { title?: string; duration_s?: number | null },
): Post | null {
  if (post.type !== 'video') return null;
  const ref = String(assetRef || '').trim();
  if (!ref) return null;
  const scenes = [...(post.scenes || [])];
  if (sceneIndex < 0 || sceneIndex >= scenes.length) return null;
  const scene = { ...scenes[sceneIndex] };
  const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
  const mediaDur = opts?.duration_s != null ? Number(opts.duration_s) : null;
  const duration =
    mediaDur != null && Number.isFinite(mediaDur) && mediaDur > 0
      ? Math.min(Math.max(0.5, mediaDur), sceneDur)
      : sceneDur;
  const layers = [...(scene.layers || [])];
  let targetIdx = -1;
  let bestZ = Infinity;
  layers.forEach((layer, i) => {
    if (layer.type !== 'image' && layer.type !== 'video') return;
    const z = Number(layer.z_index);
    const zz = Number.isFinite(z) ? z : i;
    if (zz < bestZ) {
      bestZ = zz;
      targetIdx = i;
    }
  });
  const bgId = String(scene.background_asset_id || '').trim();
  const hasRef = layers.some((l) => l.type === 'ref');
  const title = (opts?.title || layerKind).slice(0, 40);

  if (targetIdx >= 0) {
    const prev = layers[targetIdx];
    layers[targetIdx] = {
      ...prev,
      type: layerKind,
      title,
      asset_id: ref,
      duration_s: prev.duration_s ?? duration,
    };
    scene.layers = layers;
    if (bgId && bgId === String(prev.asset_id || '').trim()) {
      scene.background_asset_id = layerKind === 'image' ? ref : null;
    }
  } else if (bgId && layerKind === 'image' && !hasRef) {
    scene.background_asset_id = ref;
  } else {
    const z = hasRef
      ? Math.max(0, ...layers.map((l, i) => {
          const n = Number(l.z_index);
          return Number.isFinite(n) ? n : i;
        })) + 1
      : 0;
    const layer: Layer = {
      id: newUid(),
      type: layerKind,
      title,
      asset_id: ref,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      z_index: z,
      opacity: 1,
      start_s: 0,
      duration_s: sceneDur,
      source_start_s: 0,
    };
    if (layerKind === 'image' && !hasRef) scene.background_asset_id = ref;
    scene.layers =
      z === 0
        ? [layer, ...layers.map((l, i) => ({ ...l, z_index: (Number(l.z_index) || i) + 1 }))]
        : [...layers, layer];
  }
  scenes[sceneIndex] = scene;
  return { ...post, scenes };
}

/**
 * Place (or replace) an image/video layer for a script visual block on a scene.
 * @deprecated Prefer attachAssetLayerToScene.
 */
export function attachVisualMediaToScene(
  post: Post,
  sceneIndex: number,
  assetRef: string,
  kind: 'image' | 'video',
  opts?: {
    title?: string;
    duration_s?: number | null;
  },
): Post | null {
  return attachAssetLayerToScene(post, sceneIndex, assetRef, kind, {
    ...opts,
    replaceSameRef: true,
  });
}

/** Infer VISUAL media type id from a library asset. */
export function visualMediaTypeForLibraryAsset(asset: {
  type?: string;
  name?: string;
  original_filename?: string;
}): VisualMediaTypeId {
  const t = String(asset.type || '').toLowerCase();
  if (t === 'video') return 'video';
  if (t === 'sound' || t === 'sfx') return 'sound';
  if (t === 'music' || t === 'audio') return 'music';
  if (t === 'illustration') return 'illustration';
  if (t === 'vector') return 'vector';
  const hay = `${asset.original_filename || ''} ${asset.name || ''}`.toLowerCase();
  if (/\.gif(\b|$)/i.test(hay)) return 'photo';
  return normalizeVisualMediaType(asset.type) || 'photo';
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

function normalizeSceneName(name: string | null | undefined): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Script-driven scaffold layer: Text marked from_script, or legacy Voice without
 * generated audio (older script → timeline builds).
 */
export function isScaffoldScriptLayer(layer: Layer | null | undefined): boolean {
  if (!layer) return false;
  if (layer.type === 'text' && layer['from_script'] === true) return true;
  // Legacy scaffold: unsynthesized TTS was the script voice layer.
  return layer.type === 'tts' && !String(layer.asset_id || '').trim();
}

/** @deprecated Use isScaffoldScriptLayer. */
export function isScaffoldTtsLayer(layer: Layer | null | undefined): boolean {
  return isScaffoldScriptLayer(layer);
}

/** Layers the user (or tooling) placed beyond the script Text scaffold. */
export function isCreativeSceneLayer(layer: Layer | null | undefined): boolean {
  if (!layer) return false;
  return !isScaffoldScriptLayer(layer);
}

function clampLayerToSceneDuration(layer: Layer, sceneDur: number): Layer {
  const durCap = Math.max(0.5, Number(sceneDur) || 0.5);
  const start = Math.max(0, Number(layer.start_s) || 0);
  const clampedStart = Math.min(start, Math.max(0, durCap - 0.1));
  if (layer.duration_s == null || !Number.isFinite(Number(layer.duration_s))) {
    return { ...layer, start_s: clampedStart };
  }
  const d = Math.max(0.1, Number(layer.duration_s));
  return {
    ...layer,
    start_s: clampedStart,
    duration_s: Math.min(d, Math.max(0.1, durCap - clampedStart)),
  };
}

function mergeScaffoldScriptLayer(neu: Layer, prev: Layer | undefined): Layer {
  if (!prev) return neu;
  return {
    ...neu,
    id: prev.id || neu.id,
    type: 'text',
    title: neu.title || (prev.type === 'text' && prev.title ? prev.title : 'Text'),
    from_script: true,
    x: prev.x ?? neu.x,
    y: prev.y ?? neu.y,
    width: prev.width ?? neu.width,
    height: prev.height ?? neu.height,
    z_index: prev.z_index ?? neu.z_index,
    color: prev.color ?? neu.color,
    font_size: prev.font_size ?? neu.font_size,
    font_weight: prev.font_weight ?? neu.font_weight,
    opacity: prev.opacity ?? neu.opacity,
    enabled: prev.enabled ?? neu.enabled,
    transition_in: prev.transition_in ?? neu.transition_in,
    transition_out: prev.transition_out ?? neu.transition_out,
    // Sentence copy + timed window come from the rebuilt script.
    text: neu.text,
    start_s: neu.start_s,
    duration_s: neu.duration_s,
  };
}

/**
 * Match rebuilt script scenes to existing timeline scenes and retain creative
 * layers, backgrounds, and Text styling when scenes still correspond.
 */
export function mergeScenesPreservingCreative(built: Scene[], existing: Scene[]): Scene[] {
  const prev = existing || [];
  const used = new Set<number>();

  const claim = (idx: number): Scene | null => {
    if (idx < 0 || idx >= prev.length || used.has(idx)) return null;
    used.add(idx);
    return prev[idx];
  };

  const findMatch = (neu: Scene, neuIndex: number): Scene | null => {
    const neuRef = String(neu.ref_post_id || '').trim();
    if (neuRef) {
      const byRef = prev.findIndex(
        (e, i) => !used.has(i) && String(e.ref_post_id || '').trim() === neuRef,
      );
      const hit = claim(byRef);
      if (hit) return hit;
    }

    const neuName = normalizeSceneName(neu.name);
    if (neuName && !neuRef) {
      const byName = prev.findIndex(
        (e, i) =>
          !used.has(i) &&
          !String(e.ref_post_id || '').trim() &&
          normalizeSceneName(e.name) === neuName,
      );
      const hit = claim(byName);
      if (hit) return hit;
    }

    // Same slot when kinds align (ref ↔ ref, normal ↔ normal).
    const slot = prev[neuIndex];
    if (
      slot &&
      !used.has(neuIndex) &&
      !!String(slot.ref_post_id || '').trim() === !!neuRef
    ) {
      return claim(neuIndex);
    }

    const byKind = prev.findIndex(
      (e, i) => !used.has(i) && !!String(e.ref_post_id || '').trim() === !!neuRef,
    );
    return claim(byKind);
  };

  return (built || []).map((neu, i) => {
    const old = findMatch(neu, i);
    if (!old) return neu;

    if (String(neu.ref_post_id || '').trim()) {
      return {
        ...neu,
        id: old.id || neu.id,
        gap_before_s: old.gap_before_s ?? neu.gap_before_s,
        background_color: old.background_color ?? neu.background_color,
        name: neu.name || old.name,
      };
    }

    const creative = (old.layers || [])
      .filter(isCreativeSceneLayer)
      .map((layer) => clampLayerToSceneDuration(layer, neu.duration_s || 5));
    const oldScaffold = (old.layers || []).filter(isScaffoldScriptLayer);
    const newScaffold = (neu.layers || []).filter(isScaffoldScriptLayer);
    const mergedScript = newScaffold.map((layer, ti) =>
      mergeScaffoldScriptLayer(
        layer,
        oldScaffold[ti] || (ti === 0 ? oldScaffold[0] : undefined),
      ),
    );

    // Prefer previous z-order for creative layers; script Text stays from merged scaffold.
    const layers = [...creative, ...mergedScript];

    return {
      ...neu,
      id: old.id || neu.id,
      gap_before_s: old.gap_before_s ?? neu.gap_before_s,
      background_asset_id: old.background_asset_id ?? neu.background_asset_id,
      background_color: old.background_color ?? neu.background_color,
      background_format: old.background_format || neu.background_format,
      allow_background_visual: neu.allow_background_visual ?? old.allow_background_visual,
      layers,
    };
  });
}

/** Timeline-aligned script blocks (bounded scenes, or the single unbound draft). */
export function timelineAlignedScriptBlockIndexes(blocks: ScriptSceneBlock[]): number[] {
  const list = blocks || [];
  if (!list.length) return [];
  const bounded = list.map((b, i) => (b.hasBoundaries ? i : -1)).filter((i) => i >= 0);
  if (bounded.length) return bounded;
  return list.length === 1 ? [0] : [];
}

export function findScriptBlockIndexForTimelineScene(
  blocks: ScriptSceneBlock[],
  scenes: Scene[],
  sceneId: string,
): number {
  const list = blocks || [];
  const sceneList = scenes || [];
  const sceneIndex = sceneList.findIndex((s) => s.id === sceneId);
  if (sceneIndex < 0) return -1;
  const scene = sceneList[sceneIndex];
  const name = normalizeSceneName(scene?.name);
  if (name) {
    const byName = list.findIndex(
      (b) => normalizeSceneName(b.name || b.detail) === name,
    );
    if (byName >= 0) return byName;
  }
  const aligned = timelineAlignedScriptBlockIndexes(list);
  if (aligned[sceneIndex] != null) return aligned[sceneIndex];
  if (list[sceneIndex]) return sceneIndex;
  return aligned.length ? aligned[aligned.length - 1] : -1;
}

/**
 * Append a production cue into the script scene that matches a timeline scene.
 * Returns null when the script cannot be updated (empty / no matching block).
 */
export function appendCueToScriptForTimelineScene(
  script: string,
  scenes: Scene[],
  sceneId: string,
  tag: string,
): string | null {
  const text = String(script || '');
  const cue = String(tag || '').trim();
  if (!text.trim() || !cue) return null;
  const blocks = deriveScriptSceneBlocks(text);
  const idx = findScriptBlockIndexForTimelineScene(blocks, scenes, sceneId);
  if (idx < 0 || !blocks[idx]) return null;
  const scene = blocks[idx];
  const body = String(scene.body || '').trimEnd();
  // Skip exact duplicates (re-adding the same marker line).
  if (body.split(/\n/).some((line) => line.trim() === cue)) return text;
  blocks[idx] = {
    ...scene,
    body: body ? `${body}\n${cue}` : cue,
  };
  return stitchScriptFromSceneBlocks(blocks);
}

/**
 * Insert a reusable-post scene block into the script after the given timeline scene.
 */
export function insertReusableSceneIntoScript(
  script: string,
  scenes: Scene[],
  afterSceneId: string | null,
  opts: { postId: string; postName: string; duration_s: number },
): string | null {
  const postId = String(opts.postId || '').trim();
  if (!postId) return null;
  const dur = Math.max(0.5, Number(opts.duration_s) || 0.5);
  const name = String(opts.postName || 'Reusable clip').trim() || 'Reusable clip';
  const neu = makeBlankScriptSceneBlock(name, dur);
  neu.body = withSceneDurationMarker(formatScriptCueTag('REUSABLE POST', postId), dur);

  if (!String(script || '').trim()) {
    return stitchScriptFromSceneBlocks([neu]);
  }

  let blocks = promoteUnboundBlocksForInsert(deriveScriptSceneBlocks(String(script || '')));
  if (!blocks.length) {
    return stitchScriptFromSceneBlocks([neu]);
  }

  let insertAt = blocks.length;
  if (afterSceneId) {
    const afterIdx = findScriptBlockIndexForTimelineScene(blocks, scenes, afterSceneId);
    if (afterIdx >= 0) insertAt = afterIdx + 1;
  }
  blocks.splice(insertAt, 0, neu);
  return stitchScriptFromSceneBlocks(blocks);
}

/**
 * Attach a spoken audio asset to a video post scene as a Voice (tts) layer.
 * Reuses an existing matching voice layer when possible; otherwise creates one
 * aligned to a matching script text layer timing.
 */
export function attachVoiceAssetToScene(
  post: Post,
  sceneIndex: number,
  text: string,
  assetId: string,
  opts?: {
    duration_s?: number | null;
    voice?: string | null;
  },
): Post | null {
  if (post.type !== 'video') return null;
  const spoken = String(text || '').trim();
  const aid = String(assetId || '').trim();
  if (!spoken || !aid) return null;
  const scenes = [...(post.scenes || [])];
  if (sceneIndex < 0 || sceneIndex >= scenes.length) return null;
  const scene = { ...scenes[sceneIndex] };
  const layers = [...(scene.layers || [])];
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(spoken);

  let idx = layers.findIndex(
    (l) => l.type === 'tts' && norm(String(l.text || '')) === target,
  );
  if (idx < 0) {
    idx = layers.findIndex(
      (l) => l.type === 'tts' && !String(l.asset_id || '').trim() && norm(String(l.text || '')) === target,
    );
  }

  const textLayer = layers.find(
    (l) => l.type === 'text' && norm(String(l.text || '')) === target,
  );
  const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
  const start =
    textLayer != null ? Math.max(0, Number(textLayer.start_s) || 0) : 0;
  const duration =
    opts?.duration_s != null && Number.isFinite(Number(opts.duration_s))
      ? Math.max(0.5, Number(opts.duration_s))
      : textLayer?.duration_s != null && Number.isFinite(Number(textLayer.duration_s))
        ? Math.max(0.5, Number(textLayer.duration_s))
        : Math.max(0.5, sceneDur - start);

  if (idx >= 0) {
    const prev = layers[idx];
    layers[idx] = {
      ...prev,
      text: spoken,
      asset_id: aid,
      duration_s: duration,
      start_s: Number(prev.start_s) || start,
      tts_voice: opts?.voice ?? (prev['tts_voice'] as string | null | undefined) ?? post.default_tts_voice ?? null,
    };
  } else {
    layers.push({
      id: newUid(),
      type: 'tts',
      title: 'Voice',
      text: spoken,
      asset_id: aid,
      x: 8,
      y: 78,
      width: 84,
      height: 16,
      z_index: layers.length + 1,
      opacity: 1,
      start_s: start,
      duration_s: duration,
      tts_volume: 1,
      show_caption: false,
      tts_voice: opts?.voice ?? post.default_tts_voice ?? null,
    });
  }

  scene.layers = layers;
  scenes[sceneIndex] = scene;
  return {
    ...post,
    scenes,
    default_tts_voice: opts?.voice || post.default_tts_voice || null,
  };
}


