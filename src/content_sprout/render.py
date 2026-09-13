"""Render post compositions to images (and video when ffmpeg is available)."""

from __future__ import annotations

import contextlib
import contextvars
import logging
import math
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Iterator

from PIL import Image, ImageDraw, ImageFont, ImageOps
import numpy as np

from .formats import FORMAT_DIMENSIONS, export_canvas_size
from .global_assets import GlobalAssetStore, parse_global_source
from .icons import render_icon_image
from .io import load, save
from .models import Asset, Layer, LayerMask, Post, Project, ProjectType, Scene, is_image_asset, is_video_asset
from .projects import ProjectStore

_EXPORT_FPS = 24
_MIN_PLAYBACK_RATE = 0.5
_MAX_PLAYBACK_RATE = 20.0
logger = logging.getLogger(__name__)
_global_store_var: contextvars.ContextVar[GlobalAssetStore | None] = contextvars.ContextVar(
    "render_global_store",
    default=None,
)


@contextlib.contextmanager
def using_global_assets(global_store: GlobalAssetStore | None) -> Iterator[None]:
    """Bind a global asset library for the duration of a render/export."""
    token = _global_store_var.set(global_store)
    try:
        yield
    finally:
        _global_store_var.reset(token)


def resolve_referenced_asset(
    store: ProjectStore,
    project: Project,
    asset_id: str,
    *,
    rel_path: str | None = None,
) -> tuple[Asset, Path]:
    """Resolve a project or ``global:<id>`` asset reference to a readable file path."""
    gid = parse_global_source(asset_id)
    if gid is not None:
        gstore = _global_store_var.get()
        if gstore is None:
            raise FileNotFoundError(f"Global asset store unavailable for: {gid}")
        asset = gstore.get_asset(gid)
        path = gstore.resolve_path(asset, rel=rel_path)
        return asset, path
    asset = store.get_asset(project.id, asset_id)
    path = store.materialize_asset(project.id, asset, rel_path=rel_path)
    return asset, path


def _get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _hex_to_rgb(color: str) -> tuple[int, int, int]:
    color = color.lstrip("#")
    if len(color) == 3:
        color = "".join(c * 2 for c in color)
    return tuple(int(color[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _background_rgb(color: str | None) -> tuple[int, int, int]:
    """Parse a CSS hex fill.

    Empty/missing color means transparent underlay → matte to black for opaque
    export frames (scenes default to transparent, not the historic dark fill).
    """
    raw = str(color or "").strip()
    if not raw or raw.lower() in {"transparent", "none"}:
        return (0, 0, 0)
    try:
        rgb = _hex_to_rgb(raw)
    except (ValueError, TypeError):
        return (0, 0, 0)
    if len(rgb) != 3 or any(c < 0 or c > 255 for c in rgb):
        return (0, 0, 0)
    return rgb


def layer_effective_duration(layer: Layer, scene_duration: float) -> float:
    if layer.duration_s is not None:
        return max(0.1, float(layer.duration_s))
    return max(0.1, scene_duration - max(0.0, layer.start_s))


def _audio_atempo_chain(factor: float) -> str:
    """atempo stages must stay in 0.5–2.0; chain them for 0.5×–20×."""
    if abs(factor - 1.0) < 1e-6:
        return ""
    parts: list[str] = []
    remaining = float(factor)
    while remaining > 2.0 + 1e-9:
        parts.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5 - 1e-9:
        parts.append("atempo=0.5")
        remaining /= 0.5
    parts.append(f"atempo={remaining:.6f}")
    return ",".join(parts)


def layer_playback_rate(layer: Layer) -> float:
    """Video speed multiplier, clamped to 0.5×–20× (default 1×)."""
    try:
        n = float(getattr(layer, "playback_rate", 1.0) or 1.0)
    except (TypeError, ValueError):
        n = 1.0
    if not math.isfinite(n) or n <= 0:
        return 1.0
    return max(_MIN_PLAYBACK_RATE, min(_MAX_PLAYBACK_RATE, n))


def layer_source_time(layer: Layer, scene_time_s: float) -> float:
    """Map scene-local time to source media time for a video layer.

    ``source_t = source_start_s + (scene_time - layer.start_s) * playback_rate``.
    """
    local_t = max(0.0, float(scene_time_s) - max(0.0, float(layer.start_s or 0.0)))
    rate = layer_playback_rate(layer)
    return max(0.0, float(getattr(layer, "source_start_s", 0.0) or 0.0) + local_t * rate)


def mask_effective_duration(mask: LayerMask, layer_duration: float) -> float:
    """Mask length in parent-layer local seconds."""
    start = max(0.0, float(getattr(mask, "start_s", 0.0) or 0.0))
    raw = getattr(mask, "duration_s", None)
    if raw is not None:
        try:
            return max(0.1, float(raw))
        except (TypeError, ValueError):
            pass
    return max(0.1, float(layer_duration) - start)


def mask_active_at(mask: LayerMask, layer_local_t: float, layer_duration: float) -> bool:
    """True when the hole should be applied at parent-layer local time."""
    start = max(0.0, float(getattr(mask, "start_s", 0.0) or 0.0))
    end = start + mask_effective_duration(mask, layer_duration)
    return start <= float(layer_local_t) < end


def apply_speech_duration(scene: Scene, layer: Layer, duration_s: float) -> None:
    """Set TTS/audio layer length from real speech; grow the scene if needed."""
    speech_s = max(0.1, float(duration_s))
    layer.duration_s = speech_s
    ensure_scene_fits_layer(scene, layer)


def ensure_scene_fits_layer(scene: Scene, layer: Layer) -> float:
    """Grow ``scene.duration_s`` so the layer fits. Returns seconds added (0 if none).

    Following scenes shift later on the absolute timeline by the same amount because
    scenes are laid out sequentially (with optional ``gap_before_s`` between them).
    """
    if layer.duration_s is None:
        return 0.0
    needed = max(0.0, float(layer.start_s or 0.0)) + max(0.1, float(layer.duration_s))
    current = max(0.5, float(scene.duration_s))
    if needed <= current:
        return 0.0
    delta = needed - current
    scene.duration_s = needed
    return delta


def scene_timeline(post: Post) -> list[tuple[Scene, float, float, float]]:
    """Return (scene, abs_start, duration, abs_end) for sequential scenes with gaps.

    Disabled scenes are omitted. Does not expand reusable-post refs — use
    ``expanded_scene_timeline`` for export.
    """
    t = 0.0
    rows: list[tuple[Scene, float, float, float]] = []
    for scene in post.scenes:
        if getattr(scene, "enabled", True) is False:
            continue
        gap = max(0.0, float(scene.gap_before_s or 0.0))
        t += gap
        start = t
        dur = max(0.5, float(scene.duration_s))
        t += dur
        rows.append((scene, start, dur, t))
    return rows


def referenced_post_duration(
    store: ProjectStore,
    project_id: str,
    ref_post_id: str,
    *,
    _stack: frozenset[str] | None = None,
) -> float:
    """Total duration of a referenced video post (recursively expands nested refs)."""
    stack = _stack or frozenset()
    if ref_post_id in stack:
        return 0.5
    try:
        ref = store.get_post(project_id, ref_post_id)
    except FileNotFoundError:
        return 0.5
    if ref.type != ProjectType.VIDEO:
        return 0.5
    return post_total_duration(store, project_id, ref, _stack=stack)


def post_total_duration(
    store: ProjectStore,
    project_id: str,
    post: Post,
    *,
    _stack: frozenset[str] | None = None,
) -> float:
    """Absolute timeline length, expanding reusable-post scene refs."""
    stack = _stack or frozenset()
    if post.id in stack:
        return 0.5
    nested = stack | {post.id}
    t = 0.0
    any_scene = False
    for scene in post.scenes or []:
        if getattr(scene, "enabled", True) is False:
            continue
        any_scene = True
        t += max(0.0, float(scene.gap_before_s or 0.0))
        ref_id = (scene.ref_post_id or "").strip() or None
        if ref_id:
            t += referenced_post_duration(store, project_id, ref_id, _stack=nested)
        else:
            t += max(0.5, float(scene.duration_s))
    return max(0.5, t) if any_scene else 0.5


def migrate_scene_refs_to_layers(post: Post) -> bool:
    """Convert legacy scene.ref_post_id slots into full-bleed ref layers.

    Returns True when the post was modified.
    """
    if post.type != ProjectType.VIDEO:
        return False
    changed = False
    for scene in post.scenes or []:
        ref_id = (scene.ref_post_id or "").strip() or None
        if not ref_id:
            continue
        scene.ref_post_id = None
        already = any(
            (getattr(layer, "type", None) == "ref")
            and ((layer.ref_post_id or "").strip() == ref_id)
            for layer in scene.layers or []
        )
        if not already:
            scene.layers = list(scene.layers or [])
            scene.layers.insert(
                0,
                Layer(
                    type="ref",
                    title=scene.name or "Reusable clip",
                    ref_post_id=ref_id,
                    x=0.0,
                    y=0.0,
                    width=100.0,
                    height=100.0,
                    z_index=0,
                    start_s=0.0,
                    duration_s=max(0.5, float(scene.duration_s or 0.5)),
                    opacity=1.0,
                ),
            )
        changed = True
    return changed


def sync_ref_scene_metadata(store: ProjectStore, project_id: str, post: Post) -> None:
    """Keep ref-layer titles/durations in sync with source posts; migrate legacy scene refs."""
    if post.type != ProjectType.VIDEO:
        post.is_reusable = False
        return
    migrate_scene_refs_to_layers(post)
    for scene in post.scenes or []:
        scene.ref_post_id = (scene.ref_post_id or "").strip() or None
        for layer in scene.layers or []:
            if getattr(layer, "type", None) != "ref":
                continue
            ref_id = (layer.ref_post_id or "").strip() or None
            layer.ref_post_id = ref_id
            if not ref_id:
                continue
            try:
                src = store.get_post(project_id, ref_id)
            except FileNotFoundError:
                layer.title = layer.title or "Missing reusable post"
                if layer.duration_s is None:
                    layer.duration_s = 0.5
                continue
            layer.title = layer.title or src.name or "Reusable clip"
            # Refresh length from source when the layer still spans a full reusable slot.
            layer.duration_s = referenced_post_duration(
                store, project_id, ref_id, _stack=frozenset({post.id})
            )


def expand_scenes_for_export(
    store: ProjectStore,
    project_id: str,
    post: Post,
    *,
    _stack: frozenset[str] | None = None,
) -> list[Scene]:
    """Flatten reusable-post refs into concrete scenes for render/export/audio."""
    stack = _stack or frozenset()
    if post.id in stack:
        return []
    nested = stack | {post.id}
    out: list[Scene] = []
    for scene in post.scenes or []:
        if getattr(scene, "enabled", True) is False:
            continue
        ref_id = (scene.ref_post_id or "").strip() or None
        if not ref_id:
            out.append(scene)
            continue
        try:
            src = store.get_post(project_id, ref_id)
        except FileNotFoundError:
            # Keep a black placeholder so timeline length stays roughly correct.
            placeholder = Scene(
                id=scene.id,
                name=scene.name or "Missing reusable post",
                duration_s=max(0.5, float(scene.duration_s or 0.5)),
                gap_before_s=max(0.0, float(scene.gap_before_s or 0.0)),
                background_format=scene.background_format or post.target_format,
                layers=[],
            )
            out.append(placeholder)
            continue
        if src.type != ProjectType.VIDEO:
            continue
        expanded = expand_scenes_for_export(store, project_id, src, _stack=nested)
        if not expanded:
            placeholder = Scene(
                id=scene.id,
                name=src.name or scene.name,
                duration_s=0.5,
                gap_before_s=max(0.0, float(scene.gap_before_s or 0.0)),
                background_format=src.target_format or post.target_format,
                layers=[],
            )
            out.append(placeholder)
            continue
        first = expanded[0].model_copy(deep=True)
        first.gap_before_s = max(0.0, float(scene.gap_before_s or 0.0))
        out.append(first)
        for rest in expanded[1:]:
            out.append(rest.model_copy(deep=True))
    return out


def expanded_scene_timeline(
    store: ProjectStore,
    project_id: str,
    post: Post,
) -> list[tuple[Scene, float, float, float]]:
    flat = Post(
        id=post.id,
        name=post.name,
        type=post.type,
        target_format=post.target_format,
        scenes=expand_scenes_for_export(store, project_id, post),
    )
    return scene_timeline(flat)


def resolve_frame_at_abs_time(
    store: ProjectStore,
    project: Project,
    post: Post,
    abs_time_s: float,
    *,
    canvas_size: tuple[int, int] | None = None,
    ref_stack: frozenset[str] | None = None,
) -> Image.Image:
    """Render the frame at an absolute timeline time (expands reusable refs)."""
    rows = expanded_scene_timeline(store, project.id, post)
    if not rows:
        w, h = canvas_size or FORMAT_DIMENSIONS.get(post.target_format, FORMAT_DIMENSIONS["portrait"])
        return Image.new("RGB", (w, h), _background_rgb(post.background_color))
    t = max(0.0, float(abs_time_s))
    scene, start, dur, end = rows[0]
    for cand_scene, cand_start, cand_dur, cand_end in rows:
        if t < cand_end - 1e-9:
            scene, start, dur, end = cand_scene, cand_start, cand_dur, cand_end
            break
        scene, start, dur, end = cand_scene, cand_start, cand_dur, cand_end
    local = min(max(0.0, t - start), max(0.0, dur - 1e-3))
    return render_scene(
        store,
        project,
        scene,
        time_s=local,
        canvas_size=canvas_size,
        post_background_color=post.background_color,
        post_background_asset_id=post.background_asset_id,
        ref_stack=ref_stack,
    )


def layer_visible_at(layer: Layer, t: float, scene_duration: float) -> bool:
    if getattr(layer, "enabled", True) is False:
        return False
    start = max(0.0, layer.start_s)
    end = start + layer_effective_duration(layer, scene_duration)
    return start <= t < end


def _default_transition_duration(layer_dur: float) -> float:
    dur = max(0.1, float(layer_dur))
    return min(0.5, dur / 4.0)


def _transition_in_duration(layer: Layer, layer_dur: float) -> float:
    custom = getattr(layer, "transition_in_duration_s", None)
    if custom is not None:
        try:
            val = float(custom)
            if val > 0:
                return min(layer_dur, val)
        except (TypeError, ValueError):
            pass
    return _default_transition_duration(layer_dur)


def _transition_out_duration(layer: Layer, layer_dur: float) -> float:
    custom = getattr(layer, "transition_out_duration_s", None)
    if custom is not None:
        try:
            val = float(custom)
            if val > 0:
                return min(layer_dur, val)
        except (TypeError, ValueError):
            pass
    return _default_transition_duration(layer_dur)


_DIR_VECTORS: dict[str, tuple[float, float]] = {
    "N": (0.0, -1.0),
    "S": (0.0, 1.0),
    "E": (1.0, 0.0),
    "W": (-1.0, 0.0),
    "NE": (1.0, -1.0),
    "NW": (-1.0, -1.0),
    "SE": (1.0, 1.0),
    "SW": (-1.0, 1.0),
}


def _normalize_direction(raw: object, fallback: str = "S") -> str:
    d = str(raw or "").strip().upper()
    return d if d in _DIR_VECTORS else fallback


def _direction_offset(direction: str, amount: float) -> tuple[float, float]:
    dx, dy = _DIR_VECTORS.get(direction, _DIR_VECTORS["S"])
    mag = math.hypot(dx, dy) or 1.0
    scale = (100.0 * amount) / mag
    return dx * scale, dy * scale


def layer_visual_at(layer: Layer, t: float, scene_duration: float) -> tuple[float, float, float]:
    """Return (opacity, offset_x_pct, offset_y_pct) for scene time ``t``."""
    if not layer_visible_at(layer, t, scene_duration):
        return 0.0, 0.0, 0.0
    base = float(layer.opacity)
    start = max(0.0, layer.start_s)
    dur = layer_effective_duration(layer, scene_duration)
    rel = t - start
    offset_x = 0.0
    offset_y = 0.0

    trans_in = str(getattr(layer, "transition_in", "none") or "none").strip().lower()
    in_dur = _transition_in_duration(layer, dur)
    if in_dur > 0 and rel < in_dur:
        p = rel / in_dur
        if trans_in == "fade-in":
            base *= p
        elif trans_in == "fly-in":
            dx, dy = _direction_offset(
                _normalize_direction(getattr(layer, "transition_in_direction", None), "S"),
                1.0 - p,
            )
            offset_x += dx
            offset_y += dy

    trans_out = str(getattr(layer, "transition_out", "none") or "none").strip().lower()
    out_dur = _transition_out_duration(layer, dur)
    if out_dur > 0 and rel > dur - out_dur:
        p = (rel - (dur - out_dur)) / out_dur
        if trans_out == "fade-out":
            base *= 1.0 - p
        elif trans_out == "fly-out":
            dx, dy = _direction_offset(
                _normalize_direction(getattr(layer, "transition_out_direction", None), "S"),
                p,
            )
            offset_x += dx
            offset_y += dy

    return max(0.0, min(1.0, base)), offset_x, offset_y


def _normalize_scale_direction(raw: object) -> str:
    d = str(raw or "").strip().lower()
    if d in {"center", "middle", ""}:
        return "center"
    up = d.upper()
    return up if up in _DIR_VECTORS else "center"


def _scale_origin_fractions(direction: str) -> tuple[float, float]:
    d = _normalize_scale_direction(direction)
    if d == "center":
        return 0.5, 0.5
    dx, dy = _DIR_VECTORS.get(d, (0.0, 0.0))
    ox = 0.0 if dx < 0 else 1.0 if dx > 0 else 0.5
    oy = 0.0 if dy < 0 else 1.0 if dy > 0 else 0.5
    return ox, oy


def layer_scale_effect(layer: Layer | None) -> str:
    raw = str(getattr(layer, "scale_effect", "none") or "none").strip().lower().replace(" ", "-")
    if raw in {"scale-in", "scalein", "in", "zoom-in"}:
        return "scale-in"
    if raw in {"scale-out", "scaleout", "out", "zoom-out"}:
        return "scale-out"
    return "none"


def layer_has_scale_effect(layer: Layer | None) -> bool:
    return layer_scale_effect(layer) != "none"


def layer_scale_amount(layer: Layer | None) -> float:
    try:
        n = float(getattr(layer, "scale_amount", 0.25) or 0.25)
    except (TypeError, ValueError):
        n = 0.25
    return max(0.02, min(1.5, n))


def layer_scale_speed(layer: Layer | None) -> float:
    try:
        n = float(getattr(layer, "scale_speed", 1.0) or 1.0)
    except (TypeError, ValueError):
        n = 1.0
    if n <= 0:
        return 1.0
    return max(0.25, min(4.0, n))


def layer_scale_bounds_enabled(layer: Layer | None) -> bool:
    return bool(getattr(layer, "scale_bounds", False)) and layer_scale_effect(layer) != "none"


def layer_crop_percent(layer: Layer | None) -> float:
    try:
        n = float(getattr(layer, "crop_percent", 0.0) or 0.0)
    except (TypeError, ValueError):
        n = 0.0
    if n <= 0:
        return 0.0
    return max(0.0, min(90.0, n))


def layer_crop_direction(layer: Layer | None) -> str:
    raw = str(getattr(layer, "crop_direction", "center") or "center").strip().lower()
    if raw in {"center", "middle"}:
        return "center"
    up = raw.upper()
    if up in _DIR_VECTORS:
        return up
    return "center"


def layer_has_crop(layer: Layer | None) -> bool:
    return layer_crop_percent(layer) > 0.0


def layer_crop_rect(layer: Layer | None) -> tuple[float, float, float, float] | None:
    """Return normalized keep-rect (x, y, w, h) in 0–1, or None when crop is off."""
    pct = layer_crop_percent(layer) / 100.0
    if pct <= 0:
        return None
    direction = layer_crop_direction(layer)
    x = y = 0.0
    w = h = 1.0
    if direction == "center":
        inset = pct / 2.0
        x = inset
        y = inset
        w = 1.0 - pct
        h = 1.0 - pct
    else:
        dx, dy = _DIR_VECTORS.get(direction, (0.0, 0.0))
        if dx < 0:
            x = pct
            w = 1.0 - pct
        elif dx > 0:
            w = 1.0 - pct
        if dy < 0:
            y = pct
            h = 1.0 - pct
        elif dy > 0:
            h = 1.0 - pct
    w = max(0.05, min(1.0, w))
    h = max(0.05, min(1.0, h))
    x = max(0.0, min(1.0 - w, x))
    y = max(0.0, min(1.0 - h, y))
    return x, y, w, h


def _apply_layer_crop(img: Image.Image, layer: Layer | None) -> Image.Image:
    """Crop source pixels per layer crop settings (before contain-fit)."""
    rect = layer_crop_rect(layer)
    if rect is None:
        return img
    x, y, w, h = rect
    iw, ih = img.size
    if iw < 2 or ih < 2:
        return img
    left = int(round(x * iw))
    top = int(round(y * ih))
    right = int(round((x + w) * iw))
    bottom = int(round((y + h) * ih))
    left = max(0, min(iw - 1, left))
    top = max(0, min(ih - 1, top))
    right = max(left + 1, min(iw, right))
    bottom = max(top + 1, min(ih, bottom))
    return img.crop((left, top, right, bottom))


def layer_flip_horizontal(layer: Layer | None) -> bool:
    return bool(getattr(layer, "flip_horizontal", False))


def _apply_layer_flip(img: Image.Image, layer: Layer | None) -> Image.Image:
    """Mirror source left↔right when ``flip_horizontal`` is set (after crop, before fit)."""
    if not layer_flip_horizontal(layer):
        return img
    return ImageOps.mirror(img)


def layer_scale_progress(layer: Layer, t: float, scene_duration: float) -> float:
    effect = layer_scale_effect(layer)
    if effect == "none":
        return 0.0
    if not layer_visible_at(layer, t, scene_duration):
        return 0.0
    start = max(0.0, float(layer.start_s or 0.0))
    dur = layer_effective_duration(layer, scene_duration)
    if dur <= 0:
        return 0.0
    rel = max(0.0, float(t) - start)
    speed = layer_scale_speed(layer)
    return max(0.0, min(1.0, (rel / dur) * speed))


def layer_scale_at(layer: Layer, t: float, scene_duration: float) -> tuple[float, float, float]:
    """Return (scale, origin_x, origin_y) for Ken Burns content zoom at scene time ``t``."""
    ox, oy = _scale_origin_fractions(getattr(layer, "scale_direction", "center"))
    effect = layer_scale_effect(layer)
    if effect == "none" or layer_scale_bounds_enabled(layer):
        return 1.0, ox, oy
    if not layer_visible_at(layer, t, scene_duration):
        return 1.0, ox, oy
    amount = layer_scale_amount(layer)
    p = layer_scale_progress(layer, t, scene_duration)
    if effect == "scale-in":
        scale = 1.0 + amount * p
    else:
        scale = 1.0 + amount * (1.0 - p)
    return max(1.0, scale), ox, oy


def layer_scale_box_at(
    layer: Layer, t: float, scene_duration: float
) -> tuple[float, float, float, float] | None:
    """Animated (x, y, width, height) in scene % when ``scale_bounds`` is on."""
    if not layer_scale_bounds_enabled(layer):
        return None
    effect = layer_scale_effect(layer)
    ax = float(getattr(layer, "x", 0.0) or 0.0)
    ay = float(getattr(layer, "y", 0.0) or 0.0)
    aw = max(1.0, float(getattr(layer, "width", 40.0) or 40.0))
    ah = max(1.0, float(getattr(layer, "height", 40.0) or 40.0))
    ox, oy = _scale_origin_fractions(getattr(layer, "scale_direction", "center"))
    amount = layer_scale_amount(layer)
    fill = max(0.05, min(1.0, amount if amount <= 1.0 else 1.0))
    fx0 = ax + ox * aw
    fy0 = ay + oy * ah
    tw = aw + (100.0 - aw) * fill
    th = ah + (100.0 - ah) * fill
    fx1 = fx0 + (ox * 100.0 - fx0) * fill
    fy1 = fy0 + (oy * 100.0 - fy0) * fill
    p = layer_scale_progress(layer, t, scene_duration)
    blend = p if effect == "scale-in" else 1.0 - p
    w = aw + (tw - aw) * blend
    h = ah + (th - ah) * blend
    fx = fx0 + (fx1 - fx0) * blend
    fy = fy0 + (fy1 - fy0) * blend
    return fx - ox * w, fy - oy * h, max(1.0, w), max(1.0, h)


def _apply_layer_scale(
    img: Image.Image,
    scale: float,
    origin_x: float,
    origin_y: float,
) -> Image.Image:
    """Zoom ``img`` by ``scale`` around origin fractions, cropped back to original size.

    Uses a sub-pixel EXTENT sample so Ken Burns progress does not stair-step on
    integer resize/crop boundaries (which looked patchy in export).
    """
    if scale <= 1.001:
        return img
    bw, bh = img.size
    if bw < 1 or bh < 1:
        return img
    ox = max(0.0, min(1.0, float(origin_x)))
    oy = max(0.0, min(1.0, float(origin_y)))
    # Window in source space shrinks as scale grows (same framing as enlarge+crop).
    vw = bw / float(scale)
    vh = bh / float(scale)
    left = ox * (bw - vw)
    top = oy * (bh - vh)
    left = max(0.0, min(max(0.0, bw - vw), left))
    top = max(0.0, min(max(0.0, bh - vh), top))
    return img.transform(
        (bw, bh),
        Image.Transform.EXTENT,
        (left, top, left + vw, top + vh),
        resample=Image.Resampling.BICUBIC,
    ).convert("RGBA")


def layer_opacity_at(layer: Layer, t: float, scene_duration: float) -> float:
    opacity, _, _ = layer_visual_at(layer, t, scene_duration)
    return opacity


def _default_scene_effect_duration(scene_duration: float) -> float:
    dur = max(0.5, float(scene_duration or 0.5))
    return min(0.8, max(0.25, dur / 5.0))


def _scene_effect_in_duration(scene: Scene, scene_duration: float) -> float:
    custom = getattr(scene, "effect_in_duration_s", None)
    try:
        if custom is not None and float(custom) > 0:
            return min(scene_duration, float(custom))
    except (TypeError, ValueError):
        pass
    return _default_scene_effect_duration(scene_duration)


def _scene_effect_out_duration(scene: Scene, scene_duration: float) -> float:
    custom = getattr(scene, "effect_out_duration_s", None)
    try:
        if custom is not None and float(custom) > 0:
            return min(scene_duration, float(custom))
    except (TypeError, ValueError):
        pass
    return _default_scene_effect_duration(scene_duration)


def scene_has_effects(scene: Scene) -> bool:
    inn = str(getattr(scene, "effect_in", "none") or "none").strip().lower()
    out = str(getattr(scene, "effect_out", "none") or "none").strip().lower()
    return (inn and inn != "none") or (out and out != "none")


def scene_effect_at(scene: Scene, t: float) -> tuple[float, tuple[int, int, int] | None, float]:
    """Return (opacity, overlay_rgb_or_none, overlay_alpha) for scene-local time ``t``."""
    scene_duration = max(0.5, float(getattr(scene, "duration_s", 5.0) or 5.0))
    local = max(0.0, float(t or 0.0))
    try:
        amount = max(0.0, min(1.0, float(getattr(scene, "effect_amount", 0.4) or 0.4)))
    except (TypeError, ValueError):
        amount = 0.4
    opacity = 1.0
    overlay_rgb: tuple[int, int, int] | None = None
    overlay_alpha = 0.0

    effect_in = str(getattr(scene, "effect_in", "none") or "none").strip().lower()
    in_dur = _scene_effect_in_duration(scene, scene_duration)
    if in_dur > 0 and local < in_dur and effect_in not in {"", "none"}:
        p = max(0.0, min(1.0, local / in_dur))
        if effect_in == "fade-in":
            opacity *= p
        elif effect_in == "darken":
            overlay_rgb = (0, 0, 0)
            overlay_alpha = max(overlay_alpha, amount * (1.0 - p))
        elif effect_in == "lighten":
            overlay_rgb = (255, 255, 255)
            overlay_alpha = max(overlay_alpha, amount * (1.0 - p))

    effect_out = str(getattr(scene, "effect_out", "none") or "none").strip().lower()
    out_dur = _scene_effect_out_duration(scene, scene_duration)
    if out_dur > 0 and local > scene_duration - out_dur and effect_out not in {"", "none"}:
        p = max(0.0, min(1.0, (local - (scene_duration - out_dur)) / out_dur))
        if effect_out == "fade-out":
            opacity *= 1.0 - p
        elif effect_out == "darken":
            overlay_rgb = (0, 0, 0) if overlay_rgb is None else overlay_rgb
            if overlay_rgb == (255, 255, 255):
                pass
            else:
                overlay_rgb = (0, 0, 0)
            overlay_alpha = max(overlay_alpha, amount * p)
        elif effect_out == "lighten":
            overlay_rgb = (255, 255, 255)
            overlay_alpha = max(overlay_alpha, amount * p)

    return max(0.0, min(1.0, opacity)), overlay_rgb, max(0.0, min(1.0, overlay_alpha))


def apply_scene_effect(frame: Image.Image, scene: Scene, time_s: float) -> Image.Image:
    """Apply whole-scene fade / darken / lighten onto a composed frame."""
    if not scene_has_effects(scene):
        return frame
    opacity, overlay_rgb, overlay_alpha = scene_effect_at(scene, time_s)
    out = frame.convert("RGBA")
    if overlay_rgb is not None and overlay_alpha > 0.001:
        wash = Image.new("RGBA", out.size, (*overlay_rgb, int(round(overlay_alpha * 255))))
        out = Image.alpha_composite(out, wash)
    if opacity < 0.999:
        # Fade toward black (matches video fade-to-black export expectation).
        black = Image.new("RGBA", out.size, (0, 0, 0, 255))
        out = Image.blend(black, out, opacity)
    return out.convert("RGB") if frame.mode != "RGBA" else out


def _probe_media_size(path: Path) -> tuple[int, int] | None:
    if not path.exists():
        return None
    # Images via Pillow
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}:
        try:
            with Image.open(path) as img:
                return img.size
        except OSError:
            return None
    if not shutil.which("ffprobe"):
        return None
    try:
        raw = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=s=x:p=0",
                str(path),
            ],
            text=True,
            timeout=30,
        ).strip()
        if "x" not in raw:
            return None
        w_s, h_s = raw.split("x", 1)
        return int(w_s), int(h_s)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, OSError):
        return None


def _collect_post_media_asset_ids(post: Post) -> tuple[set[str], set[str]]:
    """Return (video_asset_ids, image_asset_ids) referenced by the post."""
    videos: set[str] = set()
    images: set[str] = set()

    def absorb(asset_id: str | None, *, as_layer_type: str | None = None) -> None:
        if not asset_id:
            return
        if as_layer_type == "image":
            images.add(asset_id)
        else:
            # Unknown until we look up; caller classifies.
            images.add(asset_id)

    if post.type == ProjectType.IMAGE:
        if post.background_asset_id:
            images.add(post.background_asset_id)
        for layer in post.layers:
            if layer.type in {"image", "video"} and layer.asset_id:
                images.add(layer.asset_id)
        return videos, images

    for scene in post.scenes:
        if scene.background_asset_id:
            images.add(scene.background_asset_id)
        for layer in scene.layers:
            if layer.type in {"image", "video"} and layer.asset_id:
                images.add(layer.asset_id)
    return videos, images


def resolve_export_size(
    store: ProjectStore,
    project: Project,
    post: Post,
) -> tuple[int, int]:
    """Export canvas size is the format chosen on the post, never clip pixels."""
    return export_canvas_size(
        post.target_format,
        getattr(post, "video_format", None),
        is_video=post.type == ProjectType.VIDEO,
    )


def _resolve_background(
    store: ProjectStore,
    project: Project,
    asset_id: str | None,
    fmt: str,
    *,
    canvas_size: tuple[int, int] | None = None,
    time_s: float | None = None,
    background_color: str | None = None,
) -> Image.Image:
    w, h = canvas_size or FORMAT_DIMENSIONS.get(fmt, FORMAT_DIMENSIONS["portrait"])
    fill = _background_rgb(background_color)
    base = Image.new("RGBA", (w, h), (*fill, 255))
    if not asset_id:
        return base.convert("RGB")

    try:
        asset, _ = resolve_referenced_asset(store, project, asset_id)
    except (FileNotFoundError, ValueError, OSError):
        return base.convert("RGB")

    plate: Image.Image | None = None
    if is_image_asset(asset.type):
        rel = asset.original_path or (asset.processed_formats or {}).get(fmt)
        try:
            _, path = resolve_referenced_asset(store, project, asset_id, rel_path=rel)
        except (FileNotFoundError, ValueError, OSError):
            return base.convert("RGB")
        plate = _fit_image_contain(load(path).convert("RGBA"), w, h)
    else:
        try:
            _, path = resolve_referenced_asset(store, project, asset_id)
        except (FileNotFoundError, ValueError, OSError):
            return base.convert("RGB")
        frame = _extract_video_frame(path, time_s=max(0.0, float(time_s or 0.0)))
        if frame:
            plate = _fit_image_contain(frame.convert("RGBA"), w, h)

    if plate is None:
        return base.convert("RGB")
    # Letterbox shows the solid fill (post/scene color) behind the plate.
    return Image.alpha_composite(base, plate).convert("RGB")


def _extract_video_frame(path: Path, time_s: float = 0.0) -> Image.Image | None:
    if not shutil.which("ffmpeg"):
        return None
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        out = Path(tmp.name)
    try:
        seek = max(0.0, float(time_s or 0.0))
        cmd = ["ffmpeg", "-y"]
        if seek > 0.001:
            # Seek before -i for speed; fine for export preview frames.
            cmd.extend(["-ss", f"{seek:.3f}"])
        cmd.extend(["-i", str(path), "-vframes", "1", "-q:v", "2", str(out)])
        subprocess.run(
            cmd,
            capture_output=True,
            check=True,
            timeout=30,
        )
        return load(out)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return None
    finally:
        out.unlink(missing_ok=True)


def _paste_clipped(
    canvas: Image.Image,
    src: Image.Image,
    x: int,
    y: int,
) -> None:
    """Paste ``src`` at (x, y), cropping anything that falls outside the canvas.

    Matches the editor preview (``overflow: hidden`` on the stage): layers may
    hang off-screen, but exports only keep the intersection with the frame.
    """
    if src.width <= 0 or src.height <= 0:
        return
    cw, ch = canvas.size
    # Intersection of src rect with canvas in canvas coordinates.
    left = max(0, int(x))
    top = max(0, int(y))
    right = min(cw, int(x) + src.width)
    bottom = min(ch, int(y) + src.height)
    if right <= left or bottom <= top:
        return
    src_left = left - int(x)
    src_top = top - int(y)
    cropped = src.crop((src_left, src_top, src_left + (right - left), src_top + (bottom - top)))
    if cropped.mode == "RGBA":
        canvas.paste(cropped, (left, top), cropped)
    else:
        canvas.paste(cropped, (left, top))


def _paste_rgba_rect(
    canvas: Image.Image,
    src: Image.Image,
    x: float,
    y: float,
    w: float,
    h: float,
) -> None:
    """Paste ``src`` stretched into a float-sized rect (sub-pixel position/size)."""
    if w <= 0.5 or h <= 0.5 or src.width < 1 or src.height < 1:
        return
    cw, ch = canvas.size
    x0, y0 = float(x), float(y)
    x1, y1 = x0 + float(w), y0 + float(h)
    ix0 = max(0, int(math.floor(x0)))
    iy0 = max(0, int(math.floor(y0)))
    ix1 = min(cw, int(math.ceil(x1)))
    iy1 = min(ch, int(math.ceil(y1)))
    if ix1 <= ix0 or iy1 <= iy0:
        return
    iw, ih = src.size
    # Map destination pixels → source: src = ((px - x) / w) * iw
    a = iw / float(w)
    e = ih / float(h)
    c = (ix0 - x0) / float(w) * iw
    f = (iy0 - y0) / float(h) * ih
    piece = src.convert("RGBA").transform(
        (ix1 - ix0, iy1 - iy0),
        Image.Transform.AFFINE,
        (a, 0.0, c, 0.0, e, f),
        resample=Image.Resampling.BICUBIC,
    )
    canvas.paste(piece, (ix0, iy0), piece)


def layer_chroma_key_colors(layer: Layer) -> list[str]:
    """Normalized hex key colors on a layer (empty ⇒ chroma key off)."""
    raw = getattr(layer, "chroma_key_colors", None) or []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        try:
            rgb = _hex_to_rgb(str(item or ""))
        except (ValueError, TypeError):
            continue
        hex_c = f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"
        if hex_c in seen:
            continue
        seen.add(hex_c)
        out.append(hex_c)
    return out


def layer_has_chroma_key(layer: Layer | None) -> bool:
    if layer is None:
        return False
    return bool(layer_chroma_key_colors(layer))


def _chroma_primary_channel(r: float, g: float, b: float) -> int:
    """Dominant RGB channel for a key (0=R, 1=G, 2=B)."""
    if g >= r and g >= b:
        return 1
    if b >= r and b >= g:
        return 2
    return 0


def _chroma_screen_amount(
    rgb: np.ndarray, channel: int
) -> np.ndarray:
    """Primary-channel excess over the other two (0–1), screen-style key."""
    primary = rgb[:, :, channel]
    other = np.maximum(rgb[:, :, (channel + 1) % 3], rgb[:, :, (channel + 2) % 3])
    return np.maximum(0.0, (primary - other) / 255.0)


def _harden_chroma_factor(factor: np.ndarray) -> np.ndarray:
    """Snap muddy mid-alphas so keyed subjects stay solid over busy backgrounds."""
    out = factor.astype(np.float32, copy=True)
    out[out <= 0.04] = 0.0
    out[out >= 0.92] = 1.0
    return out


def _apply_chroma_key(
    img: Image.Image,
    colors: list[str] | None,
    *,
    tolerance: float = 0.18,
    softness: float = 0.08,
) -> Image.Image:
    """Make screen / key-color pixels transparent (soft edge).

    Saturated R/G/B keys (typical blue/green screens) use a color-difference
    key so clothing and skin stay opaque. Muted custom colors fall back to RGB
    distance.
    """
    keys: list[tuple[int, int, int]] = []
    for c in colors or []:
        try:
            keys.append(_hex_to_rgb(str(c)))
        except (ValueError, TypeError):
            continue
    if not keys:
        return img
    tol = max(0.0, min(1.0, float(tolerance)))
    soft = max(0.0, min(1.0, float(softness)))
    out = img.convert("RGBA")
    arr = np.asarray(out, dtype=np.float32)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3].copy()
    factor = np.ones(alpha.shape, dtype=np.float32)
    rgb_lo = max(0.0, tol - soft)
    rgb_hi = min(1.0, tol + soft)
    rgb_denom = 255.0 * math.sqrt(3.0)
    screen_lo = max(0.0, 0.28 - tol)
    screen_hi = min(1.0, screen_lo + max(0.04, soft + 0.06))
    for kr, kg, kb in keys:
        channel = _chroma_primary_channel(kr, kg, kb)
        key_vals = (float(kr), float(kg), float(kb))
        key_primary = key_vals[channel]
        key_other = max(key_vals[(channel + 1) % 3], key_vals[(channel + 2) % 3])
        key_amount = max(0.0, (key_primary - key_other) / 255.0)
        if key_amount >= 0.12:
            amount = _chroma_screen_amount(rgb, channel)
            if screen_hi <= screen_lo + 1e-6:
                f = np.where(amount >= screen_lo, 0.0, 1.0).astype(np.float32)
            else:
                f = 1.0 - np.clip(
                    (amount - screen_lo) / (screen_hi - screen_lo), 0.0, 1.0
                )
        else:
            key = np.array([kr, kg, kb], dtype=np.float32)
            dist = np.sqrt(np.sum((rgb - key) ** 2, axis=2)) / rgb_denom
            if rgb_hi <= rgb_lo + 1e-6:
                f = (dist >= tol).astype(np.float32)
            else:
                f = np.clip((dist - rgb_lo) / (rgb_hi - rgb_lo), 0.0, 1.0)
        factor = np.minimum(factor, f.astype(np.float32))
    factor = _harden_chroma_factor(factor)
    alpha = alpha * factor
    arr[:, :, 3] = alpha
    # Clear RGB only in fully keyed holes (soft-edge pixels keep color).
    hole = alpha < 1e-3
    arr[:, :, 0] = np.where(hole, 0.0, arr[:, :, 0])
    arr[:, :, 1] = np.where(hole, 0.0, arr[:, :, 1])
    arr[:, :, 2] = np.where(hole, 0.0, arr[:, :, 2])
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")


def _apply_transparency_masks(
    img: Image.Image,
    masks: list[LayerMask] | None,
    *,
    box_w: int,
    box_h: int,
    layer_local_t: float | None = None,
    layer_duration: float | None = None,
) -> Image.Image:
    """Punch rectangular transparency holes through ``img`` (layer-local %).

    When ``layer_local_t`` / ``layer_duration`` are set, only masks active at that
    parent-layer local time are applied.
    """
    rects = []
    for m in masks or []:
        if getattr(m, "type", "rect") != "rect":
            continue
        if getattr(m, "kind", "transparency") != "transparency":
            continue
        if float(getattr(m, "width", 0) or 0) <= 0 or float(getattr(m, "height", 0) or 0) <= 0:
            continue
        if layer_local_t is not None and layer_duration is not None:
            if not mask_active_at(m, layer_local_t, layer_duration):
                continue
        rects.append(m)
    if not rects:
        return img
    out = img.convert("RGBA")
    alpha = out.getchannel("A")
    draw = ImageDraw.Draw(alpha)
    bw = max(1, int(box_w))
    bh = max(1, int(box_h))
    for m in rects:
        x0 = int(round(float(m.x) / 100.0 * bw))
        y0 = int(round(float(m.y) / 100.0 * bh))
        x1 = int(round((float(m.x) + float(m.width)) / 100.0 * bw))
        y1 = int(round((float(m.y) + float(m.height)) / 100.0 * bh))
        if x1 <= x0 or y1 <= y0:
            continue
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=0)
    out.putalpha(alpha)
    return out


def _render_layer(
    canvas: Image.Image,
    layer: Layer,
    store: ProjectStore,
    project: Project,
    *,
    opacity_override: float | None = None,
    time_s: float | None = None,
    scene_duration: float | None = None,
    ref_stack: frozenset[str] | None = None,
) -> None:
    w, h = canvas.size
    offset_x_pct = 0.0
    offset_y_pct = 0.0
    opacity = layer.opacity if opacity_override is None else opacity_override
    if time_s is not None and scene_duration is not None:
        vis_opacity, offset_x_pct, offset_y_pct = layer_visual_at(layer, time_s, scene_duration)
        opacity = opacity_override if opacity_override is not None else vis_opacity
        if opacity <= 0:
            return
    layer_x = float(layer.x)
    layer_y = float(layer.y)
    layer_w = float(layer.width)
    layer_h = float(layer.height)
    if time_s is not None and scene_duration is not None:
        box = layer_scale_box_at(layer, float(time_s), float(scene_duration))
        if box is not None:
            layer_x, layer_y, layer_w, layer_h = box
    fx = layer_x / 100.0 * w + offset_x_pct / 100.0 * w
    fy = layer_y / 100.0 * h + offset_y_pct / 100.0 * h
    flw = max(1.0, layer_w / 100.0 * w)
    flh = max(1.0, layer_h / 100.0 * h)
    # Animated bounds use sub-pixel paste; static layers keep integer placement.
    smooth_box = bool(
        time_s is not None
        and scene_duration is not None
        and layer_scale_bounds_enabled(layer)
    )
    if smooth_box:
        x = fx
        y = fy
        lw = max(1, int(math.ceil(flw)))
        lh = max(1, int(math.ceil(flh)))
    else:
        x = int(round(fx))
        y = int(round(fy))
        lw = max(1, int(round(flw)))
        lh = max(1, int(round(flh)))
    if opacity <= 0:
        return

    if layer.type == "audio":
        return

    # TTS is audio-only — never burn the script onto frames/export.
    if layer.type == "tts":
        return

    # Fully outside the canvas — nothing to draw.
    if (smooth_box and (fx + flw <= 0 or fy + flh <= 0 or fx >= w or fy >= h)) or (
        not smooth_box and (x + lw <= 0 or y + lh <= 0 or x >= w or y >= h)
    ):
        return

    if layer.type == "ref":
        ref_id = (getattr(layer, "ref_post_id", None) or "").strip() or None
        if not ref_id:
            return
        stack = ref_stack or frozenset()
        if ref_id in stack:
            return
        try:
            nested = store.get_post(project.id, ref_id)
        except FileNotFoundError:
            return
        if nested.type != ProjectType.VIDEO:
            return
        local_t = 0.0
        if time_s is not None:
            local_t = max(0.0, float(time_s) - max(0.0, float(layer.start_s or 0.0)))
        nested_size = resolve_export_size(store, project, nested)
        frame = resolve_frame_at_abs_time(
            store,
            project,
            nested,
            local_t,
            canvas_size=nested_size,
            ref_stack=stack | {ref_id},
        )
        img = _fit_image_contain(frame.convert("RGBA"), lw, lh)
        if opacity < 1.0:
            alpha = img.split()[3]
            alpha = alpha.point(lambda p: int(p * opacity))
            img.putalpha(alpha)
        if smooth_box:
            _paste_rgba_rect(canvas, img, fx, fy, flw, flh)
        else:
            _paste_clipped(canvas, img, int(x), int(y))
        return

    if layer.type == "text" and layer.text:
        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        font = _get_font(layer.font_size, bold=layer.font_weight == "bold")
        fill = _hex_to_rgb(layer.color) + (int(255 * opacity),)
        draw.text((int(round(fx if smooth_box else x)), int(round(fy if smooth_box else y))), layer.text, font=font, fill=fill)
        _paste_clipped(canvas, overlay, 0, 0)
        return

    if layer.type == "icon" and (layer.icon_name or layer.text):
        icon_size = max(lw, lh)
        cache_dir = getattr(getattr(store, "cfg", None), "cache_dir", None) or Path("cache")
        img = render_icon_image(
            icon_set=layer.icon_set or "material",
            icon_name=layer.icon_name or layer.text,
            size=icon_size,
            color=layer.color or "#ffffff",
            cache_dir=Path(cache_dir),
        )
        img = _fit_image_contain(img, lw, lh)
        if opacity < 1.0:
            alpha = img.split()[3]
            alpha = alpha.point(lambda p: int(p * opacity))
            img.putalpha(alpha)
        if smooth_box:
            _paste_rgba_rect(canvas, img, fx, fy, flw, flh)
        else:
            _paste_clipped(canvas, img, int(x), int(y))
        return

    if layer.type in {"image", "video"} and layer.asset_id:
        try:
            asset, _ = resolve_referenced_asset(store, project, layer.asset_id)
            if is_image_asset(asset.type):
                # Prefer original pixels so timeline layers keep the source aspect.
                # Explicit use_format still selects a processed Instagram crop.
                fmt = str(getattr(layer, "use_format", None) or "").strip()
                if fmt and fmt in (asset.processed_formats or {}):
                    rel = asset.processed_formats[fmt]
                else:
                    rel = asset.original_path or asset.processed_formats.get("thumb")
                _, path = resolve_referenced_asset(store, project, layer.asset_id, rel_path=rel)
                img = load(path).convert("RGBA")
            else:
                _, path = resolve_referenced_asset(store, project, layer.asset_id)
                source_t = 0.0
                if time_s is not None:
                    source_t = layer_source_time(layer, float(time_s))
                frame = _extract_video_frame(path, time_s=source_t)
                img = (frame or Image.new("RGB", (lw, lh), (40, 40, 50))).convert("RGBA")
            # Spatial crop of source, then optional mirror, then match editor preview (object-fit: contain).
            img = _apply_layer_crop(img, layer)
            img = _apply_layer_flip(img, layer)
            img = _fit_image_contain(img, lw, lh)
            if (
                time_s is not None
                and scene_duration is not None
                and not layer_scale_bounds_enabled(layer)
            ):
                scale, ox, oy = layer_scale_at(layer, float(time_s), float(scene_duration))
                img = _apply_layer_scale(img, scale, ox, oy)
            if opacity < 1.0:
                alpha = img.split()[3]
                alpha = alpha.point(lambda p: int(p * opacity))
                img.putalpha(alpha)
            chroma_colors = layer_chroma_key_colors(layer)
            if chroma_colors:
                try:
                    tol = float(getattr(layer, "chroma_key_tolerance", 0.18) or 0.18)
                except (TypeError, ValueError):
                    tol = 0.18
                try:
                    soft = float(getattr(layer, "chroma_key_softness", 0.08) or 0.08)
                except (TypeError, ValueError):
                    soft = 0.08
                img = _apply_chroma_key(img, chroma_colors, tolerance=tol, softness=soft)
            mask_local_t: float | None = None
            mask_layer_dur: float | None = None
            if time_s is not None and scene_duration is not None:
                mask_local_t = max(0.0, float(time_s) - max(0.0, float(layer.start_s or 0.0)))
                mask_layer_dur = layer_effective_duration(layer, float(scene_duration))
            img = _apply_transparency_masks(
                img,
                layer.masks,
                box_w=lw,
                box_h=lh,
                layer_local_t=mask_local_t,
                layer_duration=mask_layer_dur,
            )
            if smooth_box:
                _paste_rgba_rect(canvas, img, fx, fy, flw, flh)
            else:
                _paste_clipped(canvas, img, int(x), int(y))
        except (FileNotFoundError, OSError):
            pass


def _fit_image_contain(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    """Scale image to fit inside box_w×box_h, centered on a transparent canvas."""
    box_w = max(1, int(box_w))
    box_h = max(1, int(box_h))
    iw, ih = img.size
    if iw <= 0 or ih <= 0:
        return Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    scale = min(box_w / iw, box_h / ih)
    nw = max(1, int(round(iw * scale)))
    nh = max(1, int(round(ih * scale)))
    resized = img.resize((nw, nh), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    out.paste(resized, ((box_w - nw) // 2, (box_h - nh) // 2), resized)
    return out


def _fit_image_cover(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    """Scale image to cover box_w×box_h, center-cropped (matches CSS object-fit: cover)."""
    box_w = max(1, int(box_w))
    box_h = max(1, int(box_h))
    iw, ih = img.size
    if iw <= 0 or ih <= 0:
        return Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    scale = max(box_w / iw, box_h / ih)
    nw = max(1, int(round(iw * scale)))
    nh = max(1, int(round(ih * scale)))
    resized = img.resize((nw, nh), Image.Resampling.LANCZOS).convert("RGBA")
    left = max(0, (nw - box_w) // 2)
    top = max(0, (nh - box_h) // 2)
    return resized.crop((left, top, left + box_w, top + box_h))


def render_layers(
    store: ProjectStore,
    project: Project,
    *,
    background_asset_id: str | None,
    background_format: str,
    layers: list[Layer],
    time_s: float | None = None,
    scene_duration: float | None = None,
    canvas_size: tuple[int, int] | None = None,
    background_color: str | None = None,
    ref_stack: frozenset[str] | None = None,
) -> Image.Image:
    canvas = _resolve_background(
        store,
        project,
        background_asset_id,
        background_format,
        canvas_size=canvas_size,
        time_s=time_s,
        background_color=background_color,
    ).convert("RGBA")
    for layer in sorted(layers, key=lambda l: l.z_index):
        if getattr(layer, "enabled", True) is False:
            continue
        if time_s is not None and scene_duration is not None:
            opacity = layer_opacity_at(layer, time_s, scene_duration)
            if opacity <= 0:
                continue
            _render_layer(
                canvas,
                layer,
                store,
                project,
                opacity_override=opacity,
                time_s=time_s,
                scene_duration=scene_duration,
                ref_stack=ref_stack,
            )
        else:
            _render_layer(
                canvas,
                layer,
                store,
                project,
                time_s=time_s,
                ref_stack=ref_stack,
            )
    return canvas.convert("RGB")


def render_image_post(
    store: ProjectStore,
    project: Project,
    post: Post,
    *,
    canvas_size: tuple[int, int] | None = None,
) -> Image.Image:
    return render_layers(
        store,
        project,
        background_asset_id=post.background_asset_id,
        background_format=post.background_format or post.target_format,
        layers=post.layers,
        canvas_size=canvas_size,
        background_color=post.background_color,
    )


def render_scene(
    store: ProjectStore,
    project: Project,
    scene: Scene,
    *,
    time_s: float | None = None,
    canvas_size: tuple[int, int] | None = None,
    post_background_color: str | None = None,
    post_background_asset_id: str | None = None,
    ref_stack: frozenset[str] | None = None,
) -> Image.Image:
    # Scene backgrounds default to transparent. Only an explicit scene color is a
    # scene fill; otherwise fall back to the post underlay for opaque export frames.
    # Scene background media overrides the post plate when set. Post plate is images only.
    scene_fill = str(scene.background_color or "").strip() or None
    bg_color = scene_fill or (str(post_background_color or "").strip() or None)
    scene_bg = str(getattr(scene, "background_asset_id", None) or "").strip() or None
    post_bg = str(post_background_asset_id or "").strip() or None
    if post_bg and not scene_bg:
        try:
            asset, _ = resolve_referenced_asset(store, project, post_bg)
            if not is_image_asset(asset.type):
                post_bg = None
        except (FileNotFoundError, ValueError, OSError):
            post_bg = None
    bg_asset = scene_bg or post_bg
    if time_s is None:
        frame = render_layers(
            store,
            project,
            background_asset_id=bg_asset,
            background_format=scene.background_format,
            layers=scene.layers,
            canvas_size=canvas_size,
            background_color=bg_color,
            ref_stack=ref_stack,
        )
        return apply_scene_effect(frame, scene, 0.0) if scene_has_effects(scene) else frame
    local_t = max(0.0, float(time_s))
    frame = render_layers(
        store,
        project,
        background_asset_id=bg_asset,
        background_format=scene.background_format,
        layers=scene.layers,
        time_s=local_t,
        scene_duration=max(0.5, scene.duration_s),
        canvas_size=canvas_size,
        background_color=bg_color,
        ref_stack=ref_stack,
    )
    return apply_scene_effect(frame, scene, local_t)


def render_composition(
    store: ProjectStore,
    project: Project,
    post: Post,
    *,
    scene_id: str | None = None,
    time_s: float | None = None,
    abs_time_s: float | None = None,
    canvas_size: tuple[int, int] | None = None,
) -> Image.Image:
    if post.type == ProjectType.IMAGE:
        return render_image_post(store, project, post, canvas_size=canvas_size)
    if abs_time_s is not None:
        return resolve_frame_at_abs_time(
            store, project, post, abs_time_s, canvas_size=canvas_size
        )
    scenes = post.scenes
    if not scenes:
        w, h = canvas_size or FORMAT_DIMENSIONS.get(post.target_format, FORMAT_DIMENSIONS["portrait"])
        return Image.new("RGB", (w, h), _background_rgb(post.background_color))
    if scene_id:
        scene = next((s for s in scenes if s.id == scene_id), scenes[0])
    else:
        scene = scenes[0]
    # Ref scenes have no local layers — render into the source post instead.
    ref_id = (scene.ref_post_id or "").strip() or None
    if ref_id:
        local = 0.0 if time_s is None else max(0.0, float(time_s))
        # Map host-scene-local time onto the absolute timeline of the host at this slot.
        host_rows = scene_timeline(post)
        host_row = next((r for r in host_rows if r[0].id == scene.id), None)
        abs_t = (host_row[1] if host_row else 0.0) + local
        return resolve_frame_at_abs_time(
            store, project, post, abs_t, canvas_size=canvas_size
        )
    return render_scene(
        store,
        project,
        scene,
        time_s=time_s,
        canvas_size=canvas_size,
        post_background_color=post.background_color,
        post_background_asset_id=post.background_asset_id,
    )


def _encode_scene_clip(frame_dir: Path, pattern: str, out_path: Path, fps: int) -> bool:
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-framerate", str(fps),
                "-i", str(frame_dir / pattern),
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                str(out_path),
            ],
            capture_output=True,
            check=True,
            timeout=3600,
        )
        return out_path.exists()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def _even_px(value: float) -> int:
    n = max(2, int(round(value)))
    return n if n % 2 == 0 else n - 1


def scene_direct_video_layer(
    scene: Scene,
    *,
    post_background_asset_id: str | None = None,
) -> Layer | None:
    """Sole full-opacity video layer when the scene can skip per-frame PIL export."""
    if scene_has_effects(scene):
        return None
    # Post/scene background plates need the PIL path (color + media underlay).
    if str(getattr(scene, "background_asset_id", None) or "").strip():
        return None
    if str(post_background_asset_id or "").strip():
        return None
    visuals: list[Layer] = []
    for layer in scene.layers or []:
        if getattr(layer, "enabled", True) is False:
            continue
        kind = str(getattr(layer, "type", "") or "")
        if kind in {"audio", "tts"}:
            continue
        if kind != "video":
            return None
        visuals.append(layer)
    if len(visuals) != 1:
        return None
    layer = visuals[0]
    if not str(getattr(layer, "asset_id", "") or "").strip():
        return None
    if getattr(layer, "masks", None):
        return None
    if layer_has_chroma_key(layer):
        return None
    if layer_has_scale_effect(layer):
        return None
    if layer_has_crop(layer):
        return None
    try:
        opacity = float(getattr(layer, "opacity", 1.0) or 1.0)
    except (TypeError, ValueError):
        opacity = 1.0
    if abs(opacity - 1.0) > 0.02:
        return None
    trans_in = str(getattr(layer, "transition_in", "none") or "none").strip().lower()
    trans_out = str(getattr(layer, "transition_out", "none") or "none").strip().lower()
    if trans_in not in {"", "none"} or trans_out not in {"", "none"}:
        return None
    return layer


def _encode_direct_video_scene(
    store: ProjectStore,
    project: Project,
    scene: Scene,
    layer: Layer,
    out_path: Path,
    canvas_size: tuple[int, int],
    *,
    post_background_color: str | None,
    fps: int,
) -> bool:
    """Encode a single-video scene with ffmpeg (trim/speed/letterbox). No frame dump."""
    try:
        _asset, src = resolve_referenced_asset(store, project, layer.asset_id or "")
    except (FileNotFoundError, ValueError, OSError):
        return False
    if not src.exists():
        return False
    scene_dur = max(0.5, float(scene.duration_s or 0.5))
    start = max(0.0, float(layer.start_s or 0.0))
    layer_dur = layer_effective_duration(layer, scene_dur)
    rate = layer_playback_rate(layer)
    src_start = max(0.0, float(getattr(layer, "source_start_s", 0.0) or 0.0))
    src_read = max(0.05, layer_dur * rate)
    w, h = canvas_size
    lw = _even_px((float(layer.width or 100.0) / 100.0) * w)
    lh = _even_px((float(layer.height or 100.0) / 100.0) * h)
    lx = max(0, int(round((float(layer.x or 0.0) / 100.0) * w)))
    ly = max(0, int(round((float(layer.y or 0.0) / 100.0) * h)))
    scene_fill = str(scene.background_color or "").strip() or None
    rgb = _background_rgb(scene_fill or post_background_color)
    bg = f"0x{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"
    # Speed, then delay onto the scene timeline; contain-fit inside the layer box.
    vf = (
        f"[0:v]setpts=(PTS-STARTPTS)/{rate:.6f}+{start:.6f}/TB,"
        f"scale={lw}:{lh}:force_original_aspect_ratio=decrease[vid];"
        f"[1:v][vid]overlay=x='{lx}+({lw}-w)/2':y='{ly}+({lh}-h)/2'"
    )
    timeout = min(3600, max(180, int(scene_dur * 8) + 60))
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-ss",
                f"{src_start:.3f}",
                "-t",
                f"{src_read:.3f}",
                "-i",
                str(src),
                "-f",
                "lavfi",
                "-i",
                f"color=c={bg}:s={w}x{h}:r={fps}:d={scene_dur:.3f}",
                "-filter_complex",
                vf,
                "-t",
                f"{scene_dur:.3f}",
                "-an",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-r",
                str(fps),
                str(out_path),
            ],
            capture_output=True,
            check=True,
            timeout=timeout,
        )
        return out_path.exists() and out_path.stat().st_size > 64
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("Direct ffmpeg scene encode failed: %s", exc)
        return False


def export_image(
    store: ProjectStore,
    project: Project,
    post: Post,
    out_path: Path,
    *,
    canvas_size: tuple[int, int] | None = None,
) -> bool:
    try:
        img = render_composition(store, project, post, canvas_size=canvas_size)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        save(img, out_path, quality=92)
        return out_path.exists()
    except OSError:
        return False


def _encode_black_clip(out_path: Path, duration_s: float, size: tuple[int, int], fps: int) -> bool:
    """Encode a black video-only segment for timeline gaps (matches scene clip streams)."""
    w, h = size
    dur = max(0.05, float(duration_s))
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "lavfi", "-i", f"color=c=black:s={w}x{h}:r={fps}",
                "-t", f"{dur:.3f}",
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                str(out_path),
            ],
            capture_output=True,
            check=True,
            timeout=120,
        )
        return out_path.exists()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def scale_exported_video(src: Path, dest: Path, size: tuple[int, int]) -> bool:
    """Scale an already-exported master clip to ``size`` with ffmpeg."""
    if not shutil.which("ffmpeg") or not src.exists():
        return False
    w, h = size
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(src),
                "-vf",
                f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(dest),
            ],
            capture_output=True,
            check=True,
            timeout=600,
        )
        return dest.exists()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False


def export_video(
    store: ProjectStore,
    project: Project,
    post: Post,
    out_path: Path,
    *,
    canvas_size: tuple[int, int] | None = None,
    progress: Callable[[float, str], None] | None = None,
) -> bool:
    """Export video post using ffmpeg. Returns True on success."""
    if not shutil.which("ffmpeg"):
        return False
    if post.type != ProjectType.VIDEO:
        return False

    def report(percent: float, message: str) -> None:
        if progress is None:
            return
        try:
            progress(max(0.0, min(100.0, float(percent))), str(message))
        except Exception:  # noqa: BLE001 — UI progress must not fail the encode
            pass

    scenes = expand_scenes_for_export(store, project.id, post)
    if not scenes:
        return False

    export_size = canvas_size or resolve_export_size(store, project, post)
    logger.info("Export size for post %s: %sx%s", post.id, export_size[0], export_size[1])
    report(1, "Preparing export…")

    scene_weights = [
        max(0.5, float(scene.duration_s or 0.5)) + max(0.0, float(scene.gap_before_s or 0.0))
        for scene in scenes
    ]
    total_weight = sum(scene_weights) or 1.0
    done_weight = 0.0
    scene_span = 82.0  # leave room for concat / audio / finish

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        segment_paths: list[Path] = []
        n_scenes = len(scenes)

        for i, scene in enumerate(scenes):
            label = (scene.name or "").strip() or f"Scene {i + 1}"
            gap = max(0.0, float(scene.gap_before_s or 0.0))
            if gap >= 0.05:
                report(
                    2 + scene_span * done_weight / total_weight,
                    f"{label} ({i + 1}/{n_scenes}) · gap",
                )
                gap_path = tmpdir / f"gap_{i:03d}.mp4"
                if _encode_black_clip(gap_path, gap, export_size, _EXPORT_FPS):
                    segment_paths.append(gap_path)
                done_weight += gap

            duration = max(0.5, scene.duration_s)
            seg_path = tmpdir / f"seg_{i:03d}.mp4"
            direct = scene_direct_video_layer(
                scene,
                post_background_asset_id=post.background_asset_id,
            )
            if direct is not None:
                report(
                    2 + scene_span * done_weight / total_weight,
                    f"{label} ({i + 1}/{n_scenes}) · encoding video",
                )
                if _encode_direct_video_scene(
                    store,
                    project,
                    scene,
                    direct,
                    seg_path,
                    export_size,
                    post_background_color=post.background_color,
                    fps=_EXPORT_FPS,
                ):
                    segment_paths.append(seg_path)
                    done_weight += duration
                    continue

            n_frames = max(1, int(duration * _EXPORT_FPS))
            frames_dir = tmpdir / f"scene_{i:03d}_frames"
            frames_dir.mkdir()
            step = max(1, n_frames // 20)

            for f in range(n_frames):
                if f == 0 or f == n_frames - 1 or f % step == 0:
                    frac = f / max(1, n_frames - 1) if n_frames > 1 else 1.0
                    report(
                        2 + scene_span * (done_weight + duration * frac) / total_weight,
                        f"{label} ({i + 1}/{n_scenes}) · frame {f + 1}/{n_frames}",
                    )
                t = f / _EXPORT_FPS
                frame = render_scene(
                    store,
                    project,
                    scene,
                    time_s=t,
                    canvas_size=export_size,
                    post_background_color=post.background_color,
                    post_background_asset_id=post.background_asset_id,
                )
                save(frame, frames_dir / f"frame_{f:05d}.jpg", quality=92)

            report(
                2 + scene_span * (done_weight + duration) / total_weight,
                f"{label} ({i + 1}/{n_scenes}) · encoding clip",
            )
            if not _encode_scene_clip(frames_dir, "frame_%05d.jpg", seg_path, _EXPORT_FPS):
                continue
            segment_paths.append(seg_path)
            done_weight += duration

        if not segment_paths:
            return False

        report(86, "Joining scenes…")
        concat_file = tmpdir / "concat.txt"
        concat_file.write_text("\n".join(f"file '{p}'" for p in segment_paths))

        video_only = tmpdir / "video.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(video_only)],
            capture_output=True,
            check=True,
            timeout=300,
        )

        report(90, "Mixing audio…")
        if _mux_audio_tracks(store, project, post, video_only, out_path):
            report(94, "Master render ready")
            return out_path.exists()

        shutil.copy(video_only, out_path)
        report(94, "Master render ready")
        return out_path.exists()


def _collect_audio_clips(
    store: ProjectStore,
    project: Project,
    post: Post,
) -> list[tuple[Path, float, float, float | None, float | None, float]]:
    """Return (audio_path, delay_s, volume, trim_start_s, trim_dur_s, playback_rate).

    ``trim_*`` are source-media windows for video-layer audio (in-point + source duration).
    ``playback_rate`` is applied with atempo after trim. TTS/audio layers use the whole
    file (trim fields None, rate 1.0).
    """
    clips: list[tuple[Path, float, float, float | None, float | None, float]] = []
    offset = 0.0
    for scene in expand_scenes_for_export(store, project.id, post):
        offset += max(0.0, float(scene.gap_before_s or 0.0))
        scene_dur = max(0.5, float(scene.duration_s or 0.5))
        for layer in scene.layers:
            if getattr(layer, "enabled", True) is False:
                continue
            if layer.type in ("tts", "audio"):
                if not layer.asset_id:
                    continue
                try:
                    _asset, path = resolve_referenced_asset(store, project, layer.asset_id)
                except (FileNotFoundError, ValueError, OSError):
                    continue
                if not path.exists():
                    continue
                delay = offset + max(0.0, layer.start_s)
                volume = max(0.0, min(2.0, float(layer.tts_volume)))
                clips.append((path, delay, volume, None, None, 1.0))
                continue
            if layer.type == "ref":
                ref_id = (getattr(layer, "ref_post_id", None) or "").strip() or None
                if not ref_id:
                    continue
                try:
                    nested = store.get_post(project.id, ref_id)
                except FileNotFoundError:
                    continue
                if nested.type != ProjectType.VIDEO:
                    continue
                nested_offset = offset + max(0.0, float(layer.start_s or 0.0))
                for path, delay, volume, trim_s, trim_d, rate in _collect_audio_clips(
                    store, project, nested
                ):
                    clips.append((path, nested_offset + delay, volume, trim_s, trim_d, rate))
                continue
            if layer.type != "video" or not layer.asset_id:
                continue
            if bool(getattr(layer, "mute_audio", False)):
                continue
            try:
                asset, path = resolve_referenced_asset(store, project, layer.asset_id)
            except (FileNotFoundError, ValueError, OSError):
                continue
            if not path.exists():
                continue
            if asset.has_audio is False:
                continue
            delay = offset + max(0.0, float(layer.start_s or 0.0))
            rate = layer_playback_rate(layer)
            trim_start = max(0.0, float(getattr(layer, "source_start_s", 0.0) or 0.0))
            timeline_dur = max(0.05, layer_effective_duration(layer, scene_dur))
            source_window = max(0.05, timeline_dur * rate)
            volume = max(0.0, min(2.0, float(layer.tts_volume if layer.tts_volume is not None else 1.0)))
            clips.append((path, delay, volume, trim_start, source_window, rate))
        offset += scene_dur

    # Legacy post-level music bed (pre-audio-layer posts)
    if post.music_asset_id:
        try:
            _asset, music_path = resolve_referenced_asset(store, project, post.music_asset_id)
            if music_path.exists():
                vol = max(0.0, min(2.0, float(post.music_volume)))
                clips.append((music_path, 0.0, vol, None, None, 1.0))
        except (FileNotFoundError, ValueError, OSError):
            pass
    return clips


def _mux_audio_tracks(
    store: ProjectStore,
    project: Project,
    post: Post,
    video_path: Path,
    out_path: Path,
) -> bool:
    """Mix audio/TTS/video-layer clips onto the video. Returns True on success."""
    inputs: list[str] = ["-i", str(video_path)]
    filter_parts: list[str] = []
    mix_labels: list[str] = []
    next_idx = 1

    for clip_path, delay_s, volume, trim_start, trim_dur, rate in _collect_audio_clips(
        store, project, post
    ):
        inputs.extend(["-i", str(clip_path)])
        delay_ms = int(delay_s * 1000)
        label = f"a{next_idx}"
        chain: list[str] = []
        if trim_start is not None and trim_dur is not None:
            end = float(trim_start) + float(trim_dur)
            chain.append(f"atrim=start={float(trim_start):.4f}:end={end:.4f}")
            chain.append("asetpts=PTS-STARTPTS")
            atempo = _audio_atempo_chain(float(rate or 1.0))
            if atempo:
                chain.append(atempo)
        chain.append(f"adelay={delay_ms}|{delay_ms}")
        chain.append(f"volume={volume}")
        filter_parts.append(f"[{next_idx}:a]{','.join(chain)}[{label}]")
        mix_labels.append(f"[{label}]")
        next_idx += 1

    if not mix_labels:
        return False

    if len(mix_labels) == 1:
        only = mix_labels[0].strip("[]")
        filter_parts.append(f"[{only}]anull[aout]")
    else:
        joined = "".join(mix_labels)
        filter_parts.append(
            f"{joined}amix=inputs={len(mix_labels)}:duration=first:dropout_transition=0[aout]"
        )

    filter_complex = ";".join(filter_parts)
    cmd = [
        "ffmpeg",
        "-y",
        *inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        str(out_path),
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=300)
        return out_path.exists()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False
