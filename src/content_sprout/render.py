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

from PIL import Image, ImageDraw, ImageFont

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
        ref_stack=ref_stack,
    )


def layer_visible_at(layer: Layer, t: float, scene_duration: float) -> bool:
    if getattr(layer, "enabled", True) is False:
        return False
    start = max(0.0, layer.start_s)
    end = start + layer_effective_duration(layer, scene_duration)
    return start <= t < end


def layer_opacity_at(layer: Layer, t: float, scene_duration: float) -> float:
    if not layer_visible_at(layer, t, scene_duration):
        return 0.0
    base = layer.opacity
    start = max(0.0, layer.start_s)
    dur = layer_effective_duration(layer, scene_duration)
    fade_d = min(0.5, dur / 4)
    rel = t - start
    if layer.transition_in == "fade-in" and fade_d > 0 and rel < fade_d:
        base *= rel / fade_d
    if layer.transition_out == "fade-out" and fade_d > 0 and rel > dur - fade_d:
        remaining = dur - rel
        base *= remaining / fade_d
    return max(0.0, min(1.0, base))


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
    if not asset_id:
        return Image.new("RGB", (w, h), fill)

    try:
        asset, _ = resolve_referenced_asset(store, project, asset_id)
    except (FileNotFoundError, ValueError, OSError):
        return Image.new("RGB", (w, h), fill)

    if is_image_asset(asset.type):
        rel = asset.processed_formats.get(fmt) or asset.original_path
        try:
            _, path = resolve_referenced_asset(store, project, asset_id, rel_path=rel)
        except (FileNotFoundError, ValueError, OSError):
            return Image.new("RGB", (w, h), fill)
        img = load(path)
        return img.resize((w, h), Image.Resampling.LANCZOS)

    try:
        _, path = resolve_referenced_asset(store, project, asset_id)
    except (FileNotFoundError, ValueError, OSError):
        return Image.new("RGB", (w, h), fill)
    frame = _extract_video_frame(path, time_s=max(0.0, float(time_s or 0.0)))
    if frame:
        return frame.resize((w, h), Image.Resampling.LANCZOS)
    return Image.new("RGB", (w, h), fill)


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
    x = int(round(layer.x / 100 * w))
    y = int(round(layer.y / 100 * h))
    lw = max(1, int(round(layer.width / 100 * w)))
    lh = max(1, int(round(layer.height / 100 * h)))
    opacity = layer.opacity if opacity_override is None else opacity_override
    if opacity <= 0:
        return

    if layer.type == "audio":
        return

    # TTS is audio-only — never burn the script onto frames/export.
    if layer.type == "tts":
        return

    # Fully outside the canvas — nothing to draw.
    if x + lw <= 0 or y + lh <= 0 or x >= w or y >= h:
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
        _paste_clipped(canvas, img, x, y)
        return

    if layer.type == "text" and layer.text:
        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        font = _get_font(layer.font_size, bold=layer.font_weight == "bold")
        fill = _hex_to_rgb(layer.color) + (int(255 * opacity),)
        draw.text((x, y), layer.text, font=font, fill=fill)
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
        _paste_clipped(canvas, img, x, y)
        return

    if layer.type in {"image", "video"} and layer.asset_id:
        try:
            asset, _ = resolve_referenced_asset(store, project, layer.asset_id)
            if is_image_asset(asset.type):
                rel = asset.processed_formats.get(layer.use_format or "portrait") or asset.original_path
                _, path = resolve_referenced_asset(store, project, layer.asset_id, rel_path=rel)
                img = load(path).convert("RGBA")
            else:
                _, path = resolve_referenced_asset(store, project, layer.asset_id)
                source_t = 0.0
                if time_s is not None:
                    source_t = layer_source_time(layer, float(time_s))
                frame = _extract_video_frame(path, time_s=source_t)
                img = (frame or Image.new("RGB", (lw, lh), (40, 40, 50))).convert("RGBA")
            # Match editor preview (object-fit: contain) — full media, no crop.
            img = _fit_image_contain(img, lw, lh)
            if opacity < 1.0:
                alpha = img.split()[3]
                alpha = alpha.point(lambda p: int(p * opacity))
                img.putalpha(alpha)
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
            _paste_clipped(canvas, img, x, y)
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
    ref_stack: frozenset[str] | None = None,
) -> Image.Image:
    # Scene backgrounds default to transparent. Only an explicit scene color is a
    # scene fill; otherwise fall back to the post underlay for opaque export frames.
    scene_fill = str(scene.background_color or "").strip() or None
    bg_color = scene_fill or (str(post_background_color or "").strip() or None)
    if time_s is None:
        return render_layers(
            store,
            project,
            background_asset_id=scene.background_asset_id,
            background_format=scene.background_format,
            layers=scene.layers,
            canvas_size=canvas_size,
            background_color=bg_color,
            ref_stack=ref_stack,
        )
    return render_layers(
        store,
        project,
        background_asset_id=scene.background_asset_id,
        background_format=scene.background_format,
        layers=scene.layers,
        time_s=max(0.0, time_s),
        scene_duration=max(0.5, scene.duration_s),
        canvas_size=canvas_size,
        background_color=bg_color,
        ref_stack=ref_stack,
    )


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


def scene_direct_video_layer(scene: Scene) -> Layer | None:
    """Sole full-opacity video layer when the scene can skip per-frame PIL export."""
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
            direct = scene_direct_video_layer(scene)
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
