/** Unsaved Photo Magic edits as a sequential instruction list until Save. */

import type { PhotoMagicDocument, PhotoMagicLayer } from '../../models/content-sprout.models';
import type { BoxGeom, LayerSelection, Point } from './photo-magic-select';
import {
  applyLayerMask,
  blankCanvas,
  cloneRaster,
  cropRaster,
  distortRaster,
  eraseStroke,
  fillMask,
  invertMask,
  maskFromBits,
  paintStroke,
  renderTextLayer,
  scaleRaster,
  type RasterSource,
  type TextStyle,
} from './photo-magic-ops';

export type LayerMove = 'raise' | 'lower' | 'raise-to-top' | 'lower-to-bottom';
export type RasterMap = Map<string, RasterSource>;

export type PhotoMagicInstruction =
  | {
      id: string;
      label: string;
      kind: 'add_layer';
      layer: PhotoMagicLayer;
      insertAboveId: string | null;
    }
  | { id: string; label: string; kind: 'delete_layer'; layerId: string }
  | {
      id: string;
      label: string;
      kind: 'duplicate_layer';
      layerId: string;
      newLayer: PhotoMagicLayer;
    }
  | { id: string; label: string; kind: 'move_layer'; layerId: string; action: LayerMove }
  | { id: string; label: string; kind: 'reorder'; layerIds: string[] }
  | {
      id: string;
      label: string;
      kind: 'patch_layer';
      layerId: string;
      patch: Partial<Pick<PhotoMagicLayer, 'name' | 'visible' | 'opacity' | 'locked' | 'mask_enabled'>>;
    }
  | { id: string; label: string; kind: 'rename_doc'; name: string }
  | { id: string; label: string; kind: 'set_selection'; selection: LayerSelection }
  | { id: string; label: string; kind: 'clear_selection' }
  | {
      id: string;
      label: string;
      kind: 'paint_stroke';
      layerId: string;
      points: Point[];
      size: number;
      color: string;
      hardness: number;
    }
  | {
      id: string;
      label: string;
      kind: 'erase_stroke';
      layerId: string;
      points: Point[];
      size: number;
      hardness: number;
    }
  | {
      id: string;
      label: string;
      kind: 'add_text_layer';
      layer: PhotoMagicLayer;
      insertAboveId: string | null;
      style: TextStyle;
    }
  | {
      id: string;
      label: string;
      kind: 'scale_layer';
      layerId: string;
      width: number;
      height: number;
      offset_x: number;
      offset_y: number;
    }
  | {
      id: string;
      label: string;
      kind: 'distort_layer';
      layerId: string;
      corners: [Point, Point, Point, Point];
    }
  | { id: string; label: string; kind: 'crop_doc'; box: BoxGeom }
  | { id: string; label: string; kind: 'move_layer_pos'; layerId: string; offset_x: number; offset_y: number }
  | {
      id: string;
      label: string;
      kind: 'replace_layer_raster';
      layerId: string;
      width: number;
      height: number;
    }
  | {
      id: string;
      label: string;
      kind: 'add_layer_mask';
      layerId: string;
      fill: 'white' | 'black' | 'selection';
    }
  | { id: string; label: string; kind: 'delete_layer_mask'; layerId: string }
  | { id: string; label: string; kind: 'invert_layer_mask'; layerId: string }
  | { id: string; label: string; kind: 'apply_layer_mask'; layerId: string }
  | {
      id: string;
      label: string;
      kind: 'paint_mask';
      layerId: string;
      points: Point[];
      size: number;
      color: string;
      hardness: number;
    }
  | {
      id: string;
      label: string;
      kind: 'erase_mask';
      layerId: string;
      points: Point[];
      size: number;
      hardness: number;
    };

export interface WorkingState {
  doc: PhotoMagicDocument;
  selection: LayerSelection | null;
  rasters: RasterMap;
  masks: RasterMap;
}

export function newLocalId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function cloneDoc(doc: PhotoMagicDocument): PhotoMagicDocument {
  return {
    ...doc,
    layers: doc.layers.map((layer) => ({ ...layer })),
  };
}

export function nextLayerName(existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim()));
  if (!taken.has('Layer')) return 'Layer';
  let n = 2;
  while (taken.has(`Layer ${n}`)) n += 1;
  return `Layer ${n}`;
}

export function duplicateLayerName(name: string, existing: string[]): string {
  const base = name.trim() || 'Layer';
  const candidate = `${base} copy`;
  if (!existing.includes(candidate)) return candidate;
  let n = 2;
  while (existing.includes(`${candidate} ${n}`)) n += 1;
  return `${candidate} ${n}`;
}

function layerIndex(layers: PhotoMagicLayer[], layerId: string): number {
  return layers.findIndex((layer) => layer.id === layerId);
}

function insertAbove(
  layers: PhotoMagicLayer[],
  layer: PhotoMagicLayer,
  selectedId: string | null,
): PhotoMagicLayer[] {
  const out = layers.slice();
  let idx = 0;
  if (selectedId) {
    const found = layerIndex(out, selectedId);
    idx = found >= 0 ? found : 0;
  }
  out.splice(idx, 0, layer);
  return out;
}

function moveLayer(layers: PhotoMagicLayer[], layerId: string, action: LayerMove): PhotoMagicLayer[] {
  const out = layers.slice();
  const idx = layerIndex(out, layerId);
  if (idx < 0) return out;
  if (action === 'raise' && idx > 0) {
    [out[idx - 1], out[idx]] = [out[idx], out[idx - 1]];
  } else if (action === 'lower' && idx < out.length - 1) {
    [out[idx + 1], out[idx]] = [out[idx], out[idx + 1]];
  } else if (action === 'raise-to-top' && idx > 0) {
    const [layer] = out.splice(idx, 1);
    out.unshift(layer);
  } else if (action === 'lower-to-bottom' && idx < out.length - 1) {
    const [layer] = out.splice(idx, 1);
    out.push(layer);
  }
  return out;
}

function selectionAfterDelete(layers: PhotoMagicLayer[], deletedIndex: number): string | null {
  if (!layers.length) return null;
  if (deletedIndex < layers.length) return layers[deletedIndex].id;
  return layers[layers.length - 1].id;
}

function paintMask(selection: LayerSelection | null, layerId: string, width: number, height: number): Uint8Array | null {
  if (!selection || selection.layerId !== layerId) return null;
  if (selection.maskWidth !== width || selection.maskHeight !== height) return null;
  return selection.mask;
}

function cropLayers(
  doc: PhotoMagicDocument,
  rasters: RasterMap,
  masks: RasterMap,
  box: BoxGeom,
): void {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const width = Math.max(8, Math.round(box.width));
  const height = Math.max(8, Math.round(box.height));
  for (const layer of doc.layers) {
    const src = rasters.get(layer.id);
    const ix = Math.max(layer.offset_x, x);
    const iy = Math.max(layer.offset_y, y);
    const ix2 = Math.min(layer.offset_x + layer.width, x + width);
    const iy2 = Math.min(layer.offset_y + layer.height, y + height);
    if (!src || ix2 <= ix || iy2 <= iy) {
      layer.width = 8;
      layer.height = 8;
      layer.offset_x = 0;
      layer.offset_y = 0;
      rasters.set(layer.id, blankCanvas(8, 8));
      if (masks.has(layer.id)) masks.set(layer.id, fillMask(8, 8, 0));
      continue;
    }
    const sx = ix - layer.offset_x;
    const sy = iy - layer.offset_y;
    const sw = ix2 - ix;
    const sh = iy2 - iy;
    rasters.set(layer.id, cropRaster(src, layer.width, layer.height, sx, sy, sw, sh));
    const mask = masks.get(layer.id);
    if (mask) masks.set(layer.id, cropRaster(mask, layer.width, layer.height, sx, sy, sw, sh));
    layer.width = sw;
    layer.height = sh;
    layer.offset_x = ix - x;
    layer.offset_y = iy - y;
  }
  doc.width = width;
  doc.height = height;
}

export function applyInstructions(
  baseline: PhotoMagicDocument,
  instructions: PhotoMagicInstruction[],
  sources: RasterMap = new Map(),
  maskSources: RasterMap = new Map(),
): WorkingState {
  const doc = cloneDoc(baseline);
  let selection: LayerSelection | null = null;
  const rasters: RasterMap = new Map();
  const masks: RasterMap = new Map();
  for (const layer of doc.layers) {
    const src = sources.get(layer.id);
    if (src) rasters.set(layer.id, src);
    const mask = maskSources.get(layer.id);
    if (mask) {
      masks.set(layer.id, mask);
      layer.has_mask = true;
    }
  }
  for (const instr of instructions) {
    switch (instr.kind) {
      case 'add_layer': {
        doc.layers = insertAbove(doc.layers, { ...instr.layer }, instr.insertAboveId);
        doc.selected_layer_id = instr.layer.id;
        const src = sources.get(instr.layer.id);
        if (src) rasters.set(instr.layer.id, src);
        if (selection && selection.layerId === instr.layer.id) selection = null;
        break;
      }
      case 'delete_layer': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        doc.layers.splice(idx, 1);
        rasters.delete(instr.layerId);
        masks.delete(instr.layerId);
        doc.selected_layer_id = selectionAfterDelete(doc.layers, idx);
        if (selection?.layerId === instr.layerId) selection = null;
        break;
      }
      case 'duplicate_layer': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        doc.layers.splice(idx, 0, { ...instr.newLayer });
        doc.selected_layer_id = instr.newLayer.id;
        const src = rasters.get(instr.layerId);
        if (src) {
          rasters.set(
            instr.newLayer.id,
            cloneRaster(src, instr.newLayer.width, instr.newLayer.height),
          );
        }
        const mask = masks.get(instr.layerId);
        if (mask) {
          masks.set(instr.newLayer.id, cloneRaster(mask, instr.newLayer.width, instr.newLayer.height));
          instr.newLayer.has_mask = true;
        }
        break;
      }
      case 'move_layer': {
        doc.layers = moveLayer(doc.layers, instr.layerId, instr.action);
        doc.selected_layer_id = instr.layerId;
        break;
      }
      case 'reorder': {
        const byId = new Map(doc.layers.map((layer) => [layer.id, layer]));
        if (
          instr.layerIds.length === doc.layers.length &&
          instr.layerIds.every((id) => byId.has(id))
        ) {
          doc.layers = instr.layerIds.map((id) => byId.get(id)!);
        }
        break;
      }
      case 'patch_layer': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        doc.layers[idx] = { ...doc.layers[idx], ...instr.patch };
        break;
      }
      case 'rename_doc': {
        doc.name = instr.name;
        break;
      }
      case 'set_selection': {
        selection = instr.selection;
        doc.selected_layer_id = instr.selection.layerId;
        break;
      }
      case 'clear_selection': {
        selection = null;
        break;
      }
      case 'paint_stroke': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const src = rasters.get(layer.id);
        if (!src) break;
        rasters.set(
          layer.id,
          paintStroke(
            src,
            layer.width,
            layer.height,
            instr.points,
            instr.size,
            instr.color,
            instr.hardness,
            paintMask(selection, layer.id, layer.width, layer.height),
          ),
        );
        doc.selected_layer_id = layer.id;
        break;
      }
      case 'erase_stroke': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const src = rasters.get(layer.id);
        if (!src) break;
        rasters.set(
          layer.id,
          eraseStroke(
            src,
            layer.width,
            layer.height,
            instr.points,
            instr.size,
            instr.hardness,
            paintMask(selection, layer.id, layer.width, layer.height),
          ),
        );
        doc.selected_layer_id = layer.id;
        break;
      }
      case 'add_text_layer': {
        const raster = renderTextLayer(instr.style);
        const layer = {
          ...instr.layer,
          width: raster.width,
          height: raster.height,
        };
        doc.layers = insertAbove(doc.layers, layer, instr.insertAboveId);
        doc.selected_layer_id = layer.id;
        rasters.set(layer.id, raster);
        selection = null;
        break;
      }
      case 'scale_layer': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const src = rasters.get(layer.id);
        if (src) {
          rasters.set(
            layer.id,
            scaleRaster(src, layer.width, layer.height, instr.width, instr.height),
          );
        }
        const mask = masks.get(layer.id);
        if (mask) {
          masks.set(layer.id, scaleRaster(mask, layer.width, layer.height, instr.width, instr.height));
        }
        layer.width = instr.width;
        layer.height = instr.height;
        layer.offset_x = instr.offset_x;
        layer.offset_y = instr.offset_y;
        doc.selected_layer_id = layer.id;
        if (selection?.layerId === layer.id) selection = null;
        break;
      }
      case 'distort_layer': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const src = rasters.get(layer.id);
        if (src) {
          const warped = distortRaster(src, layer.width, layer.height, instr.corners);
          rasters.set(layer.id, warped.canvas);
          const mask = masks.get(layer.id);
          if (mask) {
            masks.set(layer.id, distortRaster(mask, layer.width, layer.height, instr.corners).canvas);
          }
          layer.width = warped.canvas.width;
          layer.height = warped.canvas.height;
          layer.offset_x = Math.round(layer.offset_x + warped.box.x);
          layer.offset_y = Math.round(layer.offset_y + warped.box.y);
        }
        doc.selected_layer_id = layer.id;
        if (selection?.layerId === layer.id) selection = null;
        break;
      }
      case 'crop_doc': {
        cropLayers(doc, rasters, masks, instr.box);
        selection = null;
        break;
      }
      case 'move_layer_pos': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        doc.layers[idx].offset_x = instr.offset_x;
        doc.layers[idx].offset_y = instr.offset_y;
        doc.selected_layer_id = instr.layerId;
        break;
      }
      case 'replace_layer_raster': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const src = sources.get(instr.id);
        if (src) {
          rasters.set(layer.id, src);
          layer.width = instr.width;
          layer.height = instr.height;
        }
        doc.selected_layer_id = layer.id;
        if (selection?.layerId === layer.id) selection = null;
        break;
      }
      case 'add_layer_mask': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        let mask = fillMask(layer.width, layer.height, instr.fill === 'black' ? 0 : 255);
        if (instr.fill === 'selection' && selection?.layerId === layer.id) {
          mask = maskFromBits(selection.mask, selection.maskWidth, selection.maskHeight);
          if (selection.maskWidth !== layer.width || selection.maskHeight !== layer.height) {
            mask = scaleRaster(mask, selection.maskWidth, selection.maskHeight, layer.width, layer.height);
          }
        }
        masks.set(layer.id, mask);
        layer.has_mask = true;
        layer.mask_enabled = true;
        doc.selected_layer_id = layer.id;
        break;
      }
      case 'delete_layer_mask': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        masks.delete(instr.layerId);
        doc.layers[idx].has_mask = false;
        doc.layers[idx].mask_enabled = true;
        break;
      }
      case 'invert_layer_mask': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const mask = masks.get(layer.id);
        if (!mask) break;
        masks.set(layer.id, invertMask(mask, layer.width, layer.height));
        break;
      }
      case 'apply_layer_mask': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const src = rasters.get(layer.id);
        const mask = masks.get(layer.id);
        if (src && mask) {
          rasters.set(layer.id, applyLayerMask(src, mask, layer.width, layer.height));
        }
        masks.delete(layer.id);
        layer.has_mask = false;
        layer.mask_enabled = true;
        break;
      }
      case 'paint_mask': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const mask = masks.get(layer.id) || fillMask(layer.width, layer.height, 255);
        masks.set(
          layer.id,
          paintStroke(mask, layer.width, layer.height, instr.points, instr.size, instr.color, instr.hardness),
        );
        layer.has_mask = true;
        break;
      }
      case 'erase_mask': {
        const idx = layerIndex(doc.layers, instr.layerId);
        if (idx < 0) break;
        const layer = doc.layers[idx];
        const mask = masks.get(layer.id) || fillMask(layer.width, layer.height, 255);
        masks.set(
          layer.id,
          paintStroke(mask, layer.width, layer.height, instr.points, instr.size, '#000000', instr.hardness),
        );
        layer.has_mask = true;
        break;
      }
    }
  }
  return { doc, selection, rasters, masks };
}

export class PhotoMagicDraft {
  baseline: PhotoMagicDocument | null = null;
  sources: RasterMap = new Map();
  rasters: RasterMap = new Map();
  maskSources: RasterMap = new Map();
  masks: RasterMap = new Map();
  blobs = new Map<string, Blob>();
  maskBlobs = new Map<string, Blob>();
  instructions: PhotoMagicInstruction[] = [];
  cursor = -1;
  private persistedKey = '';

  reset(baseline: PhotoMagicDocument | null): void {
    this.baseline = baseline ? cloneDoc(baseline) : null;
    this.instructions = [];
    this.cursor = -1;
    this.markPersisted();
  }

  setSource(layerId: string, image: RasterSource, blob?: Blob): void {
    this.sources.set(layerId, image);
    this.rasters.set(layerId, image);
    if (blob) this.blobs.set(layerId, blob);
  }

  setMaskSource(layerId: string, image: RasterSource, blob?: Blob): void {
    this.maskSources.set(layerId, image);
    this.masks.set(layerId, image);
    if (blob) this.maskBlobs.set(layerId, blob);
  }

  clearRasters(): void {
    this.sources.clear();
    this.rasters.clear();
    this.maskSources.clear();
    this.masks.clear();
    this.blobs.clear();
    this.maskBlobs.clear();
  }

  working(): WorkingState | null {
    if (!this.baseline) return null;
    const state = applyInstructions(
      this.baseline,
      this.instructions.slice(0, this.cursor + 1),
      this.sources,
      this.maskSources,
    );
    this.rasters = state.rasters;
    this.masks = state.masks;
    return state;
  }

  get dirty(): boolean {
    return this.revisionKey() !== this.persistedKey;
  }

  get canSave(): boolean {
    return this.dirty;
  }

  get canUndo(): boolean {
    return this.cursor >= 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.instructions.length - 1;
  }

  get stepLabel(): string {
    if (!this.instructions.length) return 'No edits yet';
    if (this.cursor < 0) return `Ready to replay ${this.instructions.length} change(s)`;
    return `Change ${this.cursor + 1} of ${this.instructions.length}`;
  }

  revisionKey(): string {
    return `${this.cursor}|${this.instructions.map((item) => item.id).join(',')}`;
  }

  markPersisted(): void {
    this.persistedKey = this.revisionKey();
  }

  currentInstruction(): PhotoMagicInstruction | null {
    if (this.cursor < 0) return null;
    return this.instructions[this.cursor] || null;
  }

  push(instruction: PhotoMagicInstruction): WorkingState | null {
    if (!this.baseline) return null;
    this.instructions = this.instructions.slice(0, this.cursor + 1);
    this.instructions.push(instruction);
    this.cursor = this.instructions.length - 1;
    return this.working();
  }

  undo(): WorkingState | null {
    if (!this.canUndo) return this.working();
    this.cursor -= 1;
    return this.working();
  }

  redo(): WorkingState | null {
    if (!this.canRedo) return this.working();
    this.cursor += 1;
    return this.working();
  }

  markSaved(doc: PhotoMagicDocument): void {
    this.baseline = cloneDoc(doc);
    this.instructions = [];
    this.cursor = -1;
    this.markPersisted();
  }
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToBytes(value: string, length: number): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(length);
  const n = Math.min(bin.length, length);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function serializeInstructions(instructions: PhotoMagicInstruction[]): unknown[] {
  return instructions.map((instr) => {
    if (instr.kind !== 'set_selection') return instr;
    return {
      ...instr,
      selection: {
        ...instr.selection,
        mask: bytesToB64(instr.selection.mask),
      },
    };
  });
}

export function deserializeInstructions(raw: unknown[]): PhotoMagicInstruction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const instr = item as PhotoMagicInstruction;
    if (instr.kind !== 'set_selection') return instr;
    const selection = instr.selection as LayerSelection & { mask: string | Uint8Array };
    const length = selection.maskWidth * selection.maskHeight;
    const mask =
      typeof selection.mask === 'string' ? b64ToBytes(selection.mask, length) : selection.mask;
    return { ...instr, selection: { ...selection, mask } };
  });
}

export function layerSizeForSource(
  baseline: PhotoMagicDocument,
  instructions: PhotoMagicInstruction[],
  layerId: string,
): { width: number; height: number } | null {
  const fromBaseline = baseline.layers.find((layer) => layer.id === layerId);
  let size = fromBaseline
    ? { width: fromBaseline.width, height: fromBaseline.height }
    : null;
  for (const instr of instructions) {
    if (instr.kind === 'add_layer' && instr.layer.id === layerId) {
      size = { width: instr.layer.width, height: instr.layer.height };
    }
    if (instr.kind === 'add_text_layer' && instr.layer.id === layerId) {
      size = { width: instr.layer.width, height: instr.layer.height };
    }
    if (instr.kind === 'duplicate_layer' && instr.newLayer.id === layerId) {
      size = { width: instr.newLayer.width, height: instr.newLayer.height };
    }
    if (instr.kind === 'replace_layer_raster' && instr.layerId === layerId) {
      size = { width: instr.width, height: instr.height };
    }
    if (instr.kind === 'scale_layer' && instr.layerId === layerId) {
      size = { width: instr.width, height: instr.height };
    }
  }
  return size;
}
