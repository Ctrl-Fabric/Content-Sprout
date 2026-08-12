"""Fixed size / scale presets for ComfyUI generation and upscale."""

from __future__ import annotations

from typing import Literal

SizePreset = tuple[int, int]

IMAGE_SIZE_PRESETS: tuple[SizePreset, ...] = (
    (512, 512),
    (512, 768),
    (768, 512),
    (640, 360),
    (360, 640),
)

VIDEO_SIZE_PRESETS: tuple[SizePreset, ...] = (
    (512, 288),
    (640, 360),
    (480, 480),
    (768, 432),
)

IMAGE_UPSCALE_SCALES: tuple[float, ...] = (1.5, 2.0)
VIDEO_UPSCALE_SCALES: tuple[float, ...] = (1.25, 1.5, 2.0)

DEFAULT_IMAGE_SIZE: SizePreset = (512, 512)
DEFAULT_VIDEO_SIZE: SizePreset = (640, 360)


def _norm_size(width: int, height: int) -> SizePreset:
    return int(width), int(height)


def is_image_size_preset(width: int, height: int) -> bool:
    return _norm_size(width, height) in IMAGE_SIZE_PRESETS


def is_video_size_preset(width: int, height: int) -> bool:
    return _norm_size(width, height) in VIDEO_SIZE_PRESETS


def is_image_upscale_scale(scale: float) -> bool:
    return any(abs(float(scale) - s) < 1e-6 for s in IMAGE_UPSCALE_SCALES)


def is_video_upscale_scale(scale: float) -> bool:
    return any(abs(float(scale) - s) < 1e-6 for s in VIDEO_UPSCALE_SCALES)


def validate_image_size(width: int | None, height: int | None) -> SizePreset:
    if width is None and height is None:
        return DEFAULT_IMAGE_SIZE
    if width is None or height is None:
        raise ValueError("Both width and height are required for image generation")
    size = _norm_size(width, height)
    if size not in IMAGE_SIZE_PRESETS:
        allowed = ", ".join(f"{w}x{h}" for w, h in IMAGE_SIZE_PRESETS)
        raise ValueError(f"Image size must be one of: {allowed}")
    return size


def validate_video_size(width: int | None, height: int | None) -> SizePreset:
    if width is None and height is None:
        return DEFAULT_VIDEO_SIZE
    if width is None or height is None:
        raise ValueError("Both width and height are required for video generation")
    size = _norm_size(width, height)
    if size not in VIDEO_SIZE_PRESETS:
        allowed = ", ".join(f"{w}x{h}" for w, h in VIDEO_SIZE_PRESETS)
        raise ValueError(f"Video size must be one of: {allowed}")
    return size


def validate_upscale_scale(scale: float, *, kind: Literal["image", "video"]) -> float:
    s = float(scale)
    allowed = IMAGE_UPSCALE_SCALES if kind == "image" else VIDEO_UPSCALE_SCALES
    if not any(abs(s - a) < 1e-6 for a in allowed):
        label = ", ".join(str(a) for a in allowed)
        raise ValueError(f"{kind.capitalize()} upscale scale must be one of: {label}")
    return next(a for a in allowed if abs(s - a) < 1e-6)


def size_preset_label(width: int, height: int) -> str:
    return f"{int(width)}×{int(height)}"
