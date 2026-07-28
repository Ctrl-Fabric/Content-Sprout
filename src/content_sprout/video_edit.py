"""Non-destructive video edits via ffmpeg (always write a new file).

Each operation produces a new MP4; source files are never overwritten.
There is no undo — callers keep the original asset and register a new one.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path


class VideoEditError(RuntimeError):
    """Raised when ffmpeg/ffprobe fails or inputs are invalid."""


@dataclass(frozen=True)
class VideoInfo:
    duration_s: float | None
    has_audio: bool
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    container: str | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    bitrate_kbps: int | None = None
    file_size_bytes: int | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def ffmpeg_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def extract_video_frame(path: Path, time_s: float = 0.0) -> "Image.Image | None":
    """Extract a single RGB frame from a video via ffmpeg. Returns None on failure."""
    from PIL import Image

    if not shutil.which("ffmpeg"):
        return None
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        out = Path(tmp.name)
    try:
        seek = max(0.0, float(time_s or 0.0))
        cmd = ["ffmpeg", "-y"]
        if seek > 0.001:
            # Seek before -i for speed; fine for still thumbnails.
            cmd.extend(["-ss", f"{seek:.3f}"])
        cmd.extend(["-i", str(path), "-vframes", "1", "-q:v", "2", str(out)])
        subprocess.run(
            cmd,
            capture_output=True,
            check=True,
            timeout=60,
        )
        if not out.is_file() or out.stat().st_size < 32:
            return None
        return Image.open(out).convert("RGB")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return None
    finally:
        out.unlink(missing_ok=True)


def _parse_frame_rate(rate: str | None) -> float | None:
    """Parse ffprobe r_frame_rate / avg_frame_rate (e.g. ``30000/1001``)."""
    raw = (rate or "").strip()
    if not raw or raw.upper() in {"N/A", "0/0"}:
        return None
    try:
        if "/" in raw:
            num_s, den_s = raw.split("/", 1)
            den = float(den_s)
            if den == 0:
                return None
            value = float(num_s) / den
        else:
            value = float(raw)
        if value <= 0 or value > 1000:
            return None
        return round(value, 3)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _friendly_container(format_name: str | None, path: Path) -> str | None:
    """Pick a short container label from ffprobe format_name or the file suffix."""
    ext = path.suffix.lower().lstrip(".")
    raw = (format_name or "").strip().lower()
    # Multi-alias format names: prefer the real file extension.
    if not raw:
        return ext or None
    if "," in raw:
        return ext or raw.split(",", 1)[0].strip() or None
    aliases = {
        "mpegts": "ts",
        "matroska": "mkv",
        "asf": "wmv",
        "mpeg": "mpg",
        "ogg": "ogv",
    }
    return aliases.get(raw, raw)


def _codec_label(name: str | None) -> str | None:
    if not name:
        return None
    aliases = {
        "h264": "H.264",
        "avc1": "H.264",
        "hevc": "H.265",
        "h265": "H.265",
        "vp9": "VP9",
        "vp8": "VP8",
        "av1": "AV1",
        "prores": "ProRes",
        "mpeg4": "MPEG-4",
        "mpeg2video": "MPEG-2",
        "mjpeg": "MJPEG",
        "aac": "AAC",
        "mp3": "MP3",
        "opus": "Opus",
        "vorbis": "Vorbis",
        "flac": "FLAC",
        "pcm_s16le": "PCM",
    }
    key = name.strip().lower()
    return aliases.get(key, name.strip())


def probe_video_info(path: Path) -> VideoInfo:
    """Return duration, codecs, fps, and size for a media file via ffprobe."""
    if not path.exists():
        raise VideoEditError(f"File not found: {path}")
    if not shutil.which("ffprobe"):
        raise VideoEditError("ffprobe is not installed. Install ffmpeg (brew install ffmpeg).")

    file_size_bytes: int | None = None
    try:
        file_size_bytes = path.stat().st_size
    except OSError:
        file_size_bytes = None

    try:
        raw = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            text=True,
            timeout=60,
        )
        payload = json.loads(raw or "{}")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as exc:
        raise VideoEditError(f"ffprobe failed for {path.name}: {exc}") from exc

    fmt = payload.get("format") or {}
    streams = payload.get("streams") or []
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration_s: float | None = None
    for candidate in (
        fmt.get("duration"),
        (video_stream or {}).get("duration"),
        (audio_stream or {}).get("duration"),
    ):
        try:
            if candidate is not None and str(candidate).upper() != "N/A":
                duration_s = max(0.0, float(candidate))
                break
        except (TypeError, ValueError):
            continue

    width: int | None = None
    height: int | None = None
    fps: float | None = None
    video_codec: str | None = None
    if video_stream:
        try:
            width = int(video_stream["width"]) if video_stream.get("width") is not None else None
        except (TypeError, ValueError):
            width = None
        try:
            height = int(video_stream["height"]) if video_stream.get("height") is not None else None
        except (TypeError, ValueError):
            height = None
        fps = _parse_frame_rate(video_stream.get("avg_frame_rate")) or _parse_frame_rate(
            video_stream.get("r_frame_rate")
        )
        video_codec = _codec_label(video_stream.get("codec_name"))

    audio_codec = _codec_label(audio_stream.get("codec_name")) if audio_stream else None
    has_audio = audio_stream is not None
    container = _friendly_container(fmt.get("format_name"), path)
    if container:
        container = container.upper() if len(container) <= 4 else container

    bitrate_kbps: int | None = None
    for candidate in (fmt.get("bit_rate"), (video_stream or {}).get("bit_rate")):
        try:
            if candidate is not None and str(candidate).upper() != "N/A":
                bitrate_kbps = max(0, int(round(float(candidate) / 1000.0)))
                break
        except (TypeError, ValueError):
            continue

    return VideoInfo(
        duration_s=duration_s,
        has_audio=has_audio,
        width=width,
        height=height,
        fps=fps,
        container=container,
        video_codec=video_codec,
        audio_codec=audio_codec,
        bitrate_kbps=bitrate_kbps,
        file_size_bytes=file_size_bytes,
    )


def _atempo_chain(factor: float) -> str:
    """Build an atempo filter chain (each stage must be in 0.5–2.0)."""
    if abs(factor - 1.0) < 1e-6:
        return ""
    parts: list[str] = []
    remaining = float(factor)
    # Speed up: repeatedly apply ≤2.0; slow down: repeatedly apply ≥0.5.
    while remaining > 2.0 + 1e-9:
        parts.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5 - 1e-9:
        parts.append("atempo=0.5")
        remaining /= 0.5
    parts.append(f"atempo={remaining:.6f}")
    return ",".join(parts)


def _merge_time_ranges(ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Merge overlapping/adjacent (start, end) ranges; drop empty ones."""
    cleaned = sorted(
        ((float(a), float(b)) for a, b in ranges if float(b) > float(a) + 1e-6),
        key=lambda pair: pair[0],
    )
    if not cleaned:
        return []
    merged: list[tuple[float, float]] = [cleaned[0]]
    for start, end in cleaned[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end + 1e-6:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _normalize_remove_ranges(
    remove_ranges: list[tuple[float, float]] | None,
    *,
    clip_start: float,
    clip_end: float,
) -> list[tuple[float, float]]:
    """Clamp remove ranges to the clip window and merge overlaps."""
    if not remove_ranges:
        return []
    if clip_end <= clip_start + 0.05:
        raise VideoEditError("Clip window is too short.")
    clamped: list[tuple[float, float]] = []
    for raw_start, raw_end in remove_ranges:
        start = max(clip_start, float(raw_start))
        end = min(clip_end, float(raw_end))
        if end <= start + 0.05:
            continue
        clamped.append((start, end))
    return _merge_time_ranges(clamped)


def _keep_segments_after_removes(
    clip_start: float,
    clip_end: float,
    remove_ranges: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Invert remove ranges inside the clip window into keep segments."""
    keeps: list[tuple[float, float]] = []
    cursor = float(clip_start)
    for start, end in remove_ranges:
        if start > cursor + 0.05:
            keeps.append((cursor, start))
        cursor = max(cursor, end)
    if clip_end > cursor + 0.05:
        keeps.append((cursor, float(clip_end)))
    if not keeps:
        raise VideoEditError("Cut-out ranges remove the entire clip — nothing left to keep.")
    return keeps


def _even_dim(n: float) -> int:
    """ffmpeg yuv420p-friendly even dimension (≥ 2)."""
    v = max(2, int(round(float(n))))
    return v if v % 2 == 0 else v - 1


def _rotated_frame_size(width: int | None, height: int | None, rotate_deg: int) -> tuple[int | None, int | None]:
    if width is None or height is None:
        return width, height
    d = int(rotate_deg) % 360
    if d in (90, 270):
        return int(height), int(width)
    return int(width), int(height)


def _rotate_vf(rotate_deg: int) -> str | None:
    d = int(rotate_deg) % 360
    if d == 0:
        return None
    if d == 90:
        return "transpose=1"  # 90° clockwise
    if d == 180:
        return "hflip,vflip"
    if d == 270:
        return "transpose=2"  # 90° counter-clockwise
    raise VideoEditError("rotate_deg must be 0, 90, 180, or 270.")


def _center_crop_scale_vf(aspect_ratio: str) -> str:
    from .formats import FORMAT_DIMENSIONS

    if aspect_ratio not in FORMAT_DIMENSIONS:
        raise VideoEditError(f"Unknown aspect ratio: {aspect_ratio}")
    w, h = FORMAT_DIMENSIONS[aspect_ratio]
    return (
        f"crop='min(iw,ih*{w}/{h})':'min(ih,iw*{h}/{w})',"
        f"scale={w}:{h}"
    )


def _scale_after_crop_vf(aspect_ratio: str | None, crop_w: float, crop_h: float) -> str | None:
    """Scale cropped pixels to a preset size, or cap custom crops at 1920 on the long edge."""
    from .formats import FORMAT_DIMENSIONS

    if aspect_ratio and aspect_ratio in FORMAT_DIMENSIONS:
        tw, th = FORMAT_DIMENSIONS[aspect_ratio]
        return f"scale={tw}:{th}"

    max_edge = 1920.0
    w = float(crop_w)
    h = float(crop_h)
    longest = max(w, h)
    scale = 1.0 if longest <= max_edge else max_edge / longest
    ow = _even_dim(w * scale)
    oh = _even_dim(h * scale)
    if ow == _even_dim(w) and oh == _even_dim(h) and abs(scale - 1.0) < 1e-6:
        if int(round(w)) % 2 == 0 and int(round(h)) % 2 == 0:
            return None
        return f"scale={ow}:{oh}"
    return f"scale={ow}:{oh}"


def _fit_to_frame_vf(width: int, height: int) -> str:
    """Scale to fit inside ``width``×``height``, letterbox/pillarbox with black."""
    w = _even_dim(width)
    h = _even_dim(height)
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black"
    )


def _geometry_vf(
    *,
    rotate_deg: int = 0,
    crop: tuple[float, float, float, float] | None = None,
    aspect_ratio: str | None = None,
    src_width: int | None = None,
    src_height: int | None = None,
) -> str | None:
    """Build rotate → crop → scale filter chain.

    ``crop`` is ``(x, y, w, h)`` in post-rotate source pixels.
    When ``crop`` is omitted and ``aspect_ratio`` is a named Instagram preset,
    falls back to center-crop + scale.
    With ``aspect_ratio=original`` (no crop), a 90°/270° rotate is fitted back
    into the source frame size so the output keeps the original aspect ratio.
    """
    parts: list[str] = []
    rot = _rotate_vf(rotate_deg)
    if rot:
        parts.append(rot)

    preset = (aspect_ratio or "original").strip() or "original"
    if crop is not None:
        cx, cy, cw, ch = (float(crop[0]), float(crop[1]), float(crop[2]), float(crop[3]))
        if cw < 2 or ch < 2:
            raise VideoEditError("Crop size must be at least 2×2 pixels.")
        rot_w, rot_h = _rotated_frame_size(src_width, src_height, rotate_deg)
        if rot_w is not None and rot_h is not None:
            if cx < -0.5 or cy < -0.5 or cx + cw > rot_w + 1.0 or cy + ch > rot_h + 1.0:
                raise VideoEditError(
                    f"Crop ({cx:.0f},{cy:.0f} {cw:.0f}×{ch:.0f}) is outside the "
                    f"rotated frame ({rot_w}×{rot_h})."
                )
            # Clamp into frame and force even output dims for libx264.
            cx = max(0.0, min(cx, float(rot_w - 2)))
            cy = max(0.0, min(cy, float(rot_h - 2)))
            cw = min(cw, float(rot_w) - cx)
            ch = min(ch, float(rot_h) - cy)
        out_w = _even_dim(cw)
        out_h = _even_dim(ch)
        ix = int(max(0, round(cx)))
        iy = int(max(0, round(cy)))
        # Keep crop origin even when possible (chroma).
        if ix % 2:
            ix -= 1
        if iy % 2:
            iy -= 1
        parts.append(f"crop={out_w}:{out_h}:{ix}:{iy}")
        scale = _scale_after_crop_vf(preset if preset != "original" else "custom", out_w, out_h)
        if scale:
            parts.append(scale)
    elif preset in ("square", "portrait", "landscape", "story"):
        parts.append(_center_crop_scale_vf(preset))
    elif preset == "custom":
        raise VideoEditError("Custom aspect requires an explicit crop rectangle.")
    elif rot and src_width and src_height and int(rotate_deg) % 180 == 90:
        # Keep the source canvas size/aspect after a 90°/270° rotate.
        parts.append(_fit_to_frame_vf(int(src_width), int(src_height)))

    return ",".join(parts) if parts else None


def edit_video(
    src: Path,
    dst: Path,
    *,
    start_s: float | None = None,
    end_s: float | None = None,
    remove_ranges: list[tuple[float, float]] | None = None,
    speed: float = 1.0,
    mute: bool = False,
    audio_path: Path | None = None,
    audio_volume: float = 1.0,
    aspect_ratio: str | None = None,
    rotate_deg: int = 0,
    crop: tuple[float, float, float, float] | None = None,
) -> None:
    """Encode ``src`` into ``dst`` with optional clip / cut-outs / geometry / speed / audio.

    Never modifies ``src``. Raises :class:`VideoEditError` on failure.

    ``remove_ranges`` are source-timeline (start, end) pairs cut out of the
    clip window; remaining segments are concatenated in timeline order.
    Geometry order: rotate → crop → scale. ``crop`` is post-rotate pixels
    ``(x, y, w, h)``. Named ``aspect_ratio`` presets scale to Instagram sizes;
    ``custom`` keeps the crop (max edge 1920). With ``aspect_ratio=original``,
    a 90°/270° rotate is letterboxed back into the source frame so the output
    keeps the original aspect ratio.
    """
    if not shutil.which("ffmpeg"):
        raise VideoEditError("ffmpeg is not installed. Install it with: brew install ffmpeg")
    if not src.exists():
        raise VideoEditError(f"Source video not found: {src}")
    if audio_path is not None and not audio_path.exists():
        raise VideoEditError(f"Audio file not found: {audio_path}")
    if mute and audio_path is not None:
        raise VideoEditError("Cannot mute and add audio in the same edit.")

    speed = float(speed)
    if speed < 0.25 or speed > 4.0:
        raise VideoEditError("Speed must be between 0.25× and 4.0×.")

    rotate_deg = int(rotate_deg) % 360
    if rotate_deg not in (0, 90, 180, 270):
        raise VideoEditError("rotate_deg must be 0, 90, 180, or 270.")

    info = probe_video_info(src)
    geometry_vf = _geometry_vf(
        rotate_deg=rotate_deg,
        crop=crop,
        aspect_ratio=aspect_ratio,
        src_width=info.width,
        src_height=info.height,
    )
    duration = float(info.duration_s) if info.duration_s is not None else None

    clip_start = max(0.0, float(start_s)) if start_s is not None else 0.0
    if end_s is not None:
        clip_end = float(end_s)
    elif duration is not None:
        clip_end = duration
    else:
        clip_end = None

    if clip_end is not None and clip_end <= clip_start + 0.05:
        raise VideoEditError("Clip end must be at least 0.05s after start.")
    if clip_end is not None and duration is not None and clip_end > duration + 0.25:
        raise VideoEditError(
            f"Clip end ({clip_end:.2f}s) is past the video duration ({duration:.2f}s)."
        )

    effective_end = clip_end if clip_end is not None else duration
    if remove_ranges:
        if effective_end is None:
            raise VideoEditError("Cannot apply cut-out ranges without a known video duration.")
        removes = _normalize_remove_ranges(
            remove_ranges,
            clip_start=clip_start,
            clip_end=effective_end,
        )
        keeps = _keep_segments_after_removes(clip_start, effective_end, removes)
    elif effective_end is not None:
        keeps = [(clip_start, effective_end)]
    else:
        keeps = [(clip_start, None)]  # type: ignore[list-item]

    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()

    # Multi-segment cut-outs need trim+concat. A single keep window uses the
    # faster -ss/-t path (including when removes collapsed to one segment).
    if len(keeps) > 1:
        assert all(seg[1] is not None for seg in keeps)
        _edit_video_concat_segments(
            src,
            dst,
            keeps=[(float(a), float(b)) for a, b in keeps],  # type: ignore[misc]
            speed=speed,
            mute=mute,
            audio_path=audio_path,
            audio_volume=audio_volume,
            has_audio=bool(info.has_audio),
            geometry_vf=geometry_vf,
        )
        return

    # Single segment — reuse the original seek/duration pipeline.
    start = keeps[0][0]
    end = keeps[0][1]
    _edit_video_single_segment(
        src,
        dst,
        start_s=start if start > 0.001 else None,
        end_s=end,
        speed=speed,
        mute=mute,
        audio_path=audio_path,
        audio_volume=audio_volume,
        has_audio=bool(info.has_audio),
        geometry_vf=geometry_vf,
    )


def _edit_video_single_segment(
    src: Path,
    dst: Path,
    *,
    start_s: float | None,
    end_s: float | None,
    speed: float,
    mute: bool,
    audio_path: Path | None,
    audio_volume: float,
    has_audio: bool,
    geometry_vf: str | None = None,
    aspect_vf: str | None = None,  # backward-compat alias
) -> None:
    if geometry_vf is None and aspect_vf:
        geometry_vf = aspect_vf
    cmd: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]

    start = max(0.0, float(start_s)) if start_s is not None else None
    end = float(end_s) if end_s is not None else None

    # Input seeking for clip start (fast); accurate enough for asset editing.
    if start is not None and start > 0.001:
        cmd.extend(["-ss", f"{start:.3f}"])
    cmd.extend(["-i", str(src)])

    if end is not None:
        clip_start = start or 0.0
        clip_dur = max(0.05, end - clip_start)
        cmd.extend(["-t", f"{clip_dur:.3f}"])

    replace_audio = audio_path is not None and not mute
    if replace_audio:
        cmd.extend(["-i", str(audio_path)])

    keep_source_audio = (not mute) and (not replace_audio) and has_audio

    vf_parts: list[str] = []
    af_parts: list[str] = []
    if geometry_vf:
        vf_parts.append(geometry_vf)
    if abs(speed - 1.0) > 1e-3:
        vf_parts.append(f"setpts=PTS/{speed:.6f}")
        if keep_source_audio:
            chain = _atempo_chain(speed)
            if chain:
                af_parts.append(chain)

    vol = max(0.0, min(2.0, float(audio_volume)))
    if replace_audio and abs(vol - 1.0) > 1e-3:
        af_parts.append(f"volume={vol:.4f}")

    # Always re-encode so clip boundaries and speed changes are accurate.
    if replace_audio:
        filter_complex: list[str] = []
        if vf_parts:
            filter_complex.append(f"[0:v]{','.join(vf_parts)}[vout]")
            vmap = "[vout]"
        else:
            vmap = "0:v:0"
        if af_parts:
            filter_complex.append(f"[1:a]{','.join(af_parts)}[aout]")
            amap = "[aout]"
        else:
            amap = "1:a:0"
        if filter_complex:
            cmd.extend(["-filter_complex", ";".join(filter_complex)])
        cmd.extend(["-map", vmap, "-map", amap])
        cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart",
                str(dst),
            ]
        )
    elif mute or not keep_source_audio:
        if vf_parts:
            cmd.extend(["-vf", ",".join(vf_parts)])
        cmd.extend(
            [
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-movflags",
                "+faststart",
                str(dst),
            ]
        )
    else:
        if vf_parts:
            cmd.extend(["-vf", ",".join(vf_parts)])
        if af_parts:
            cmd.extend(["-af", ",".join(af_parts)])
        cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                str(dst),
            ]
        )

    _run_ffmpeg(cmd)


def _edit_video_concat_segments(
    src: Path,
    dst: Path,
    *,
    keeps: list[tuple[float, float]],
    speed: float,
    mute: bool,
    audio_path: Path | None,
    audio_volume: float,
    has_audio: bool,
    geometry_vf: str | None = None,
    aspect_vf: str | None = None,  # backward-compat alias
) -> None:
    """Cut multiple keep-segments and concat them, then apply geometry / speed / audio."""
    if geometry_vf is None and aspect_vf:
        geometry_vf = aspect_vf
    replace_audio = audio_path is not None and not mute
    keep_source_audio = (not mute) and (not replace_audio) and has_audio
    n = len(keeps)
    if n < 2:
        raise VideoEditError("Internal error: concat path requires 2+ segments.")

    parts: list[str] = []
    for i, (start, end) in enumerate(keeps):
        parts.append(
            f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[v{i}]"
        )
        if keep_source_audio:
            parts.append(
                f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS[a{i}]"
            )

    if keep_source_audio:
        concat_in = "".join(f"[v{i}][a{i}]" for i in range(n))
        parts.append(f"{concat_in}concat=n={n}:v=1:a=1[vcat][acat]")
        v_label = "[vcat]"
        a_label = "[acat]"
    else:
        concat_in = "".join(f"[v{i}]" for i in range(n))
        parts.append(f"{concat_in}concat=n={n}:v=1:a=0[vcat]")
        v_label = "[vcat]"
        a_label = None

    v_chain: list[str] = []
    if geometry_vf:
        v_chain.append(geometry_vf)
    if abs(speed - 1.0) > 1e-3:
        v_chain.append(f"setpts=PTS/{speed:.6f}")
        if keep_source_audio and a_label is not None:
            chain = _atempo_chain(speed)
            if chain:
                parts.append(f"{a_label}{chain}[aout]")
                a_label = "[aout]"
    if v_chain:
        parts.append(f"{v_label}{','.join(v_chain)}[vout]")
        v_label = "[vout]"

    vol = max(0.0, min(2.0, float(audio_volume)))
    if replace_audio:
        if abs(vol - 1.0) > 1e-3:
            parts.append(f"[1:a]volume={vol:.4f}[aout]")
            a_map = "[aout]"
        else:
            a_map = "1:a:0"

    cmd: list[str] = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
    ]
    if replace_audio:
        cmd.extend(["-i", str(audio_path)])
    cmd.extend(["-filter_complex", ";".join(parts)])
    cmd.extend(["-map", v_label])
    if replace_audio:
        cmd.extend(["-map", a_map, "-shortest"])
        cmd.extend(["-c:a", "aac", "-b:a", "192k"])
    elif keep_source_audio and a_label is not None:
        cmd.extend(["-map", a_label])
        cmd.extend(["-c:a", "aac", "-b:a", "192k"])
    else:
        cmd.append("-an")
    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-movflags",
            "+faststart",
            str(dst),
        ]
    )
    _run_ffmpeg(cmd)


def _run_ffmpeg(cmd: list[str]) -> None:
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=600)
    except subprocess.TimeoutExpired as exc:
        raise VideoEditError("Video edit timed out.") from exc
    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        detail = err.splitlines()[-1] if err else "ffmpeg failed"
        raise VideoEditError(detail) from exc
    except OSError as exc:
        raise VideoEditError(f"Could not run ffmpeg: {exc}") from exc
