"""Render post compositions to images (and video when ffmpeg is available)."""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .formats import FORMAT_DIMENSIONS
from .io import load, save
from .models import Layer, LayerMask, Post, Project, ProjectType, Scene
from .projects import ProjectStore

_EXPORT_FPS = 24
logger = logging.getLogger(__name__)


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


def layer_effective_duration(layer: Layer, scene_duration: float) -> float:
    if layer.duration_s is not None:
        return max(0.1, float(layer.duration_s))
    return max(0.1, scene_duration - max(0.0, layer.start_s))


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

    Does not expand reusable-post refs — use ``expanded_scene_timeline`` for export.
    """
    t = 0.0
    rows: list[tuple[Scene, float, float, float]] = []
    for scene in post.scenes:
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
    for scene in post.scenes or []:
        t += max(0.0, float(scene.gap_before_s or 0.0))
        ref_id = (scene.ref_post_id or "").strip() or None
        if ref_id:
            t += referenced_post_duration(store, project_id, ref_id, _stack=nested)
        else:
            t += max(0.5, float(scene.duration_s))
    return max(0.5, t) if post.scenes else 0.5


def sync_ref_scene_metadata(store: ProjectStore, project_id: str, post: Post) -> None:
    """Keep ref-scene name/duration in sync with the source post; clear local layers."""
    if post.type != ProjectType.VIDEO:
        post.is_reusable = False
        return
    for scene in post.scenes or []:
        ref_id = (scene.ref_post_id or "").strip() or None
        scene.ref_post_id = ref_id
        if not ref_id:
            continue
        scene.layers = []
        scene.background_asset_id = None
        try:
            src = store.get_post(project_id, ref_id)
        except FileNotFoundError:
            scene.name = scene.name or "Missing reusable post"
            scene.duration_s = max(0.5, float(scene.duration_s or 0.5))
            continue
        scene.name = src.name or scene.name or "Reusable post"
        scene.duration_s = referenced_post_duration(
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
) -> Image.Image:
    """Render the frame at an absolute timeline time (expands reusable refs)."""
    rows = expanded_scene_timeline(store, project.id, post)
    if not rows:
        w, h = canvas_size or FORMAT_DIMENSIONS.get(post.target_format, FORMAT_DIMENSIONS["portrait"])
        return Image.new("RGB", (w, h), (30, 30, 40))
    t = max(0.0, float(abs_time_s))
    scene, start, dur, end = rows[0]
    for cand_scene, cand_start, cand_dur, cand_end in rows:
        if t < cand_end - 1e-9:
            scene, start, dur, end = cand_scene, cand_start, cand_dur, cand_end
            break
        scene, start, dur, end = cand_scene, cand_start, cand_dur, cand_end
    local = min(max(0.0, t - start), max(0.0, dur - 1e-3))
    return render_scene(store, project, scene, time_s=local, canvas_size=canvas_size)


def layer_visible_at(layer: Layer, t: float, scene_duration: float) -> bool:
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
    """Compute export canvas size from media, capped by the smallest video.

    Keeps the post ``target_format`` aspect ratio.

    * **Video posts** size from video assets only. If none are present (text,
      TTS, stills, reusable clips without video), use ``FORMAT_DIMENSIONS``
      for the post format — never fall back to still-image pixel size.
    * **Image posts** may still use the smallest still as a ceiling, then
      fall back to the format preset.
    """
    fmt = post.target_format or "portrait"
    base_w, base_h = FORMAT_DIMENSIONS.get(fmt, FORMAT_DIMENSIONS["portrait"])
    aspect = base_w / base_h

    video_sizes: list[tuple[int, int]] = []
    image_sizes: list[tuple[int, int]] = []

    asset_ids: set[str] = set()
    if post.type == ProjectType.IMAGE:
        if post.background_asset_id:
            asset_ids.add(post.background_asset_id)
        for layer in post.layers:
            if layer.asset_id:
                asset_ids.add(layer.asset_id)
    else:
        for scene in post.scenes:
            if scene.background_asset_id:
                asset_ids.add(scene.background_asset_id)
            for layer in scene.layers:
                if layer.asset_id:
                    asset_ids.add(layer.asset_id)

    for asset_id in asset_ids:
        try:
            asset = store.get_asset(project.id, asset_id)
        except FileNotFoundError:
            continue
        path = store.materialize_asset(project.id, asset)
        size = _probe_media_size(path)
        if not size:
            continue
        if asset.type.value == "video":
            video_sizes.append(size)
        elif asset.type.value == "image":
            image_sizes.append(size)

    def _fit_to_ceiling(ceiling: tuple[int, int]) -> tuple[int, int]:
        cw, ch = ceiling
        # Fit aspect inside the ceiling box
        if cw / ch > aspect:
            h = ch
            w = int(h * aspect)
        else:
            w = cw
            h = int(w / aspect)
        w = max(2, w - (w % 2))
        h = max(2, h - (h % 2))
        return w, h

    def _format_default() -> tuple[int, int]:
        return base_w - (base_w % 2), base_h - (base_h % 2)

    if video_sizes:
        # Smallest video by area
        limiting = min(video_sizes, key=lambda s: (s[0] * s[1], max(s)))
        return _fit_to_ceiling(limiting)

    # Video posts without video media: format preset only (ignore stills).
    if post.type == ProjectType.VIDEO:
        return _format_default()

    if image_sizes:
        limiting = min(image_sizes, key=lambda s: (s[0] * s[1], max(s)))
        return _fit_to_ceiling(limiting)

    return _format_default()


def _resolve_background(
    store: ProjectStore,
    project: Project,
    asset_id: str | None,
    fmt: str,
    *,
    canvas_size: tuple[int, int] | None = None,
    time_s: float | None = None,
) -> Image.Image:
    w, h = canvas_size or FORMAT_DIMENSIONS.get(fmt, FORMAT_DIMENSIONS["portrait"])
    if not asset_id:
        return Image.new("RGB", (w, h), (30, 30, 40))

    asset = store.get_asset(project.id, asset_id)
    if asset.type.value == "image":
        rel = asset.processed_formats.get(fmt) or asset.original_path
        path = store.materialize_asset(project.id, asset, rel_path=rel)
        img = load(path)
        return img.resize((w, h), Image.Resampling.LANCZOS)

    path = store.materialize_asset(project.id, asset)
    frame = _extract_video_frame(path, time_s=max(0.0, float(time_s or 0.0)))
    if frame:
        return frame.resize((w, h), Image.Resampling.LANCZOS)
    return Image.new("RGB", (w, h), (20, 20, 30))


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

    if layer.type == "text" and layer.text:
        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        font = _get_font(layer.font_size, bold=layer.font_weight == "bold")
        fill = _hex_to_rgb(layer.color) + (int(255 * opacity),)
        draw.text((x, y), layer.text, font=font, fill=fill)
        _paste_clipped(canvas, overlay, 0, 0)
        return

    if layer.type in {"image", "video"} and layer.asset_id:
        try:
            asset = store.get_asset(project.id, layer.asset_id)
            if asset.type.value == "image":
                rel = asset.processed_formats.get(layer.use_format or "portrait") or asset.original_path
                path = store.materialize_asset(project.id, asset, rel_path=rel)
                img = load(path).convert("RGBA")
            else:
                path = store.materialize_asset(project.id, asset)
                local_t = 0.0
                if time_s is not None:
                    local_t = max(0.0, float(time_s) - max(0.0, float(layer.start_s or 0.0)))
                frame = _extract_video_frame(path, time_s=local_t)
                img = (frame or Image.new("RGB", (lw, lh), (40, 40, 50))).convert("RGBA")
            # Match editor preview (object-fit: cover) — fill the layer box.
            img = _fit_image_cover(img, lw, lh)
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
) -> Image.Image:
    canvas = _resolve_background(
        store,
        project,
        background_asset_id,
        background_format,
        canvas_size=canvas_size,
        time_s=time_s,
    ).convert("RGBA")
    for layer in sorted(layers, key=lambda l: l.z_index):
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
            )
        else:
            _render_layer(canvas, layer, store, project, time_s=time_s)
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
    )


def render_scene(
    store: ProjectStore,
    project: Project,
    scene: Scene,
    *,
    time_s: float | None = None,
    canvas_size: tuple[int, int] | None = None,
) -> Image.Image:
    if time_s is None:
        return render_layers(
            store,
            project,
            background_asset_id=scene.background_asset_id,
            background_format=scene.background_format,
            layers=scene.layers,
            canvas_size=canvas_size,
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
        return Image.new("RGB", (w, h), (30, 30, 40))
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
    return render_scene(store, project, scene, time_s=time_s, canvas_size=canvas_size)


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
            timeout=300,
        )
        return out_path.exists()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def export_image(store: ProjectStore, project: Project, post: Post, out_path: Path) -> bool:
    try:
        img = render_composition(store, project, post)
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


def export_video(store: ProjectStore, project: Project, post: Post, out_path: Path) -> bool:
    """Export video post using ffmpeg. Returns True on success."""
    if not shutil.which("ffmpeg"):
        return False
    if post.type != ProjectType.VIDEO:
        return False

    scenes = expand_scenes_for_export(store, project.id, post)
    if not scenes:
        return False

    export_size = resolve_export_size(store, project, post)
    logger.info("Export size for post %s: %sx%s", post.id, export_size[0], export_size[1])

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        segment_paths: list[Path] = []

        for i, scene in enumerate(scenes):
            gap = max(0.0, float(scene.gap_before_s or 0.0))
            if gap >= 0.05:
                gap_path = tmpdir / f"gap_{i:03d}.mp4"
                if _encode_black_clip(gap_path, gap, export_size, _EXPORT_FPS):
                    segment_paths.append(gap_path)

            duration = max(0.5, scene.duration_s)
            n_frames = max(1, int(duration * _EXPORT_FPS))
            frames_dir = tmpdir / f"scene_{i:03d}_frames"
            frames_dir.mkdir()

            for f in range(n_frames):
                t = f / _EXPORT_FPS
                frame = render_scene(store, project, scene, time_s=t, canvas_size=export_size)
                save(frame, frames_dir / f"frame_{f:05d}.jpg", quality=92)

            seg_path = tmpdir / f"seg_{i:03d}.mp4"
            if not _encode_scene_clip(frames_dir, "frame_%05d.jpg", seg_path, _EXPORT_FPS):
                continue
            segment_paths.append(seg_path)

        if not segment_paths:
            return False

        concat_file = tmpdir / "concat.txt"
        concat_file.write_text("\n".join(f"file '{p}'" for p in segment_paths))

        video_only = tmpdir / "video.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(video_only)],
            capture_output=True,
            check=True,
            timeout=300,
        )

        if _mux_audio_tracks(store, project, post, video_only, out_path):
            return out_path.exists()

        shutil.copy(video_only, out_path)
        return out_path.exists()


def _collect_audio_clips(
    store: ProjectStore,
    project: Project,
    post: Post,
) -> list[tuple[Path, float, float]]:
    """Return (audio_path, delay_s, volume) for TTS + audio layers (and legacy music)."""
    clips: list[tuple[Path, float, float]] = []
    offset = 0.0
    for scene in expand_scenes_for_export(store, project.id, post):
        offset += max(0.0, float(scene.gap_before_s or 0.0))
        for layer in scene.layers:
            if layer.type not in ("tts", "audio") or not layer.asset_id:
                continue
            try:
                asset = store.get_asset(project.id, layer.asset_id)
                path = store.materialize_asset(project.id, asset)
            except (FileNotFoundError, ValueError):
                continue
            if not path.exists():
                continue
            delay = offset + max(0.0, layer.start_s)
            volume = max(0.0, min(2.0, float(layer.tts_volume)))
            clips.append((path, delay, volume))
        offset += max(0.5, scene.duration_s)

    # Legacy post-level music bed (pre-audio-layer posts)
    if post.music_asset_id:
        try:
            asset = store.get_asset(project.id, post.music_asset_id)
            music_path = store.materialize_asset(project.id, asset)
            if music_path.exists():
                vol = max(0.0, min(2.0, float(post.music_volume)))
                clips.append((music_path, 0.0, vol))
        except (FileNotFoundError, ValueError):
            pass
    return clips


def _mux_audio_tracks(
    store: ProjectStore,
    project: Project,
    post: Post,
    video_path: Path,
    out_path: Path,
) -> bool:
    """Mix audio/TTS clips onto the video. Returns True on success."""
    inputs: list[str] = ["-i", str(video_path)]
    filter_parts: list[str] = []
    mix_labels: list[str] = []
    next_idx = 1

    for clip_path, delay_s, volume in _collect_audio_clips(store, project, post):
        inputs.extend(["-i", str(clip_path)])
        delay_ms = int(delay_s * 1000)
        label = f"a{next_idx}"
        filter_parts.append(
            f"[{next_idx}:a]adelay={delay_ms}|{delay_ms},volume={volume}[{label}]"
        )
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
