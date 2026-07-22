"""Non-destructive video edits via ffmpeg (always write a new file).

Each operation produces a new MP4; source files are never overwritten.
There is no undo — callers keep the original asset and register a new one.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class VideoEditError(RuntimeError):
    """Raised when ffmpeg/ffprobe fails or inputs are invalid."""


@dataclass(frozen=True)
class VideoInfo:
    duration_s: float | None
    has_audio: bool
    width: int | None = None
    height: int | None = None


def ffmpeg_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def probe_video_info(path: Path) -> VideoInfo:
    """Return duration / audio / size for a media file."""
    if not path.exists():
        raise VideoEditError(f"File not found: {path}")
    if not shutil.which("ffprobe"):
        raise VideoEditError("ffprobe is not installed. Install ffmpeg (brew install ffmpeg).")

    duration_s: float | None = None
    try:
        raw = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            text=True,
            timeout=30,
        ).strip()
        if raw and raw.upper() != "N/A":
            duration_s = max(0.0, float(raw))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, OSError):
        duration_s = None

    has_audio = False
    try:
        streams = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                str(path),
            ],
            text=True,
            timeout=30,
        ).strip()
        has_audio = bool(streams)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        has_audio = False

    width: int | None = None
    height: int | None = None
    try:
        size_raw = subprocess.check_output(
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
        if "x" in size_raw:
            w_s, h_s = size_raw.split("x", 1)
            width, height = int(w_s), int(h_s)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, OSError):
        pass

    return VideoInfo(duration_s=duration_s, has_audio=has_audio, width=width, height=height)


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


def edit_video(
    src: Path,
    dst: Path,
    *,
    start_s: float | None = None,
    end_s: float | None = None,
    speed: float = 1.0,
    mute: bool = False,
    audio_path: Path | None = None,
    audio_volume: float = 1.0,
) -> None:
    """Encode ``src`` into ``dst`` with optional clip / speed / audio changes.

    Never modifies ``src``. Raises :class:`VideoEditError` on failure.
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

    start = max(0.0, float(start_s)) if start_s is not None else None
    end = float(end_s) if end_s is not None else None
    if start is not None and end is not None and end <= start + 0.05:
        raise VideoEditError("Clip end must be at least 0.05s after start.")

    info = probe_video_info(src)
    if end is not None and info.duration_s is not None and end > info.duration_s + 0.25:
        raise VideoEditError(
            f"Clip end ({end:.2f}s) is past the video duration ({info.duration_s:.2f}s)."
        )

    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()

    cmd: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]

    # Input seeking for clip start (fast); accurate enough for asset editing.
    if start is not None and start > 0.001:
        cmd.extend(["-ss", f"{start:.3f}"])
    cmd.extend(["-i", str(src)])

    if end is not None:
        # Duration of the selected window (before speed change).
        clip_start = start or 0.0
        clip_dur = max(0.05, end - clip_start)
        cmd.extend(["-t", f"{clip_dur:.3f}"])

    replace_audio = audio_path is not None and not mute
    if replace_audio:
        cmd.extend(["-i", str(audio_path)])

    keep_source_audio = (not mute) and (not replace_audio) and info.has_audio

    vf_parts: list[str] = []
    af_parts: list[str] = []
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
