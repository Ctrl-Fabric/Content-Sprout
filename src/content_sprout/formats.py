"""Output format presets (image stills + named video delivery sizes)."""

from typing import Literal

FormatName = Literal["square", "portrait", "landscape", "story"]

# (width, height) in pixels. Instagram's recommended publishing sizes.
FORMAT_DIMENSIONS: dict[str, tuple[int, int]] = {
    "square": (1080, 1080),       # 1:1
    "portrait": (1080, 1350),     # 4:5    — best feed engagement
    "landscape": (1080, 566),     # 1.91:1
    "story": (1080, 1920),        # 9:16   — Stories & Reels
}

# Landscape 16:9 height for each named video delivery format.
VIDEO_FORMAT_HEIGHT: dict[str, int] = {
    "4k": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "standard": 480,
}

VIDEO_FORMAT_LABELS: dict[str, str] = {
    "4k": "4K UHD",
    "1440p": "1440p QHD",
    "1080p": "1080p Full HD",
    "720p": "720p HD",
    "standard": "Standard / SD",
}

# Master plus a short ladder of smaller shares (never larger than the chosen format).
_DOWNSCALE_EXTRAS: dict[str, tuple[str, ...]] = {
    "4k": ("1080p", "720p"),
    "1440p": ("1080p", "720p"),
    "1080p": ("720p",),
    "720p": ("standard",),
    "standard": (),
}

_VIDEO_FORMAT_ALIASES = {
    "uhd": "4k",
    "2160p": "4k",
    "qhd": "1440p",
    "2k": "1440p",
    "fhd": "1080p",
    "fullhd": "1080p",
    "hd1080": "1080p",
    "hd": "720p",
    "sd": "standard",
    "480p": "standard",
    "generic": "standard",
}


def aspect(name: str) -> float:
    w, h = FORMAT_DIMENSIONS[name]
    return w / h


def _even(n: int) -> int:
    n = max(2, int(n))
    return n + (n % 2)


def normalize_video_format_key(raw: str | None) -> str:
    key = str(raw or "1080p").strip().lower().replace(" ", "")
    key = _VIDEO_FORMAT_ALIASES.get(key, key)
    return key if key in VIDEO_FORMAT_HEIGHT else "1080p"


def export_canvas_size(
    target_format: str | None,
    video_format: str | None = "1080p",
    *,
    is_video: bool = True,
) -> tuple[int, int]:
    """Pixel size chosen at post creation — never source clip resolution.

    Video posts: ``video_format`` (4K / 1080p / …) × orientation (16:9 or 9:16).
    Image posts: Instagram ``FORMAT_DIMENSIONS`` for the orientation.
    """
    fmt = str(target_format or "portrait").strip().lower()
    if not is_video:
        w, h = FORMAT_DIMENSIONS.get(fmt, FORMAT_DIMENSIONS["portrait"])
        return _even(w), _even(h)

    height = VIDEO_FORMAT_HEIGHT[normalize_video_format_key(video_format)]
    if fmt == "landscape":
        return _even(round(height * 16 / 9)), _even(height)
    if fmt == "square":
        edge = _even(height)
        return edge, edge
    return _even(height), _even(round(height * 16 / 9))


def downscale_export_keys(video_format: str | None) -> list[str]:
    """Master delivery key plus a few smaller versions."""
    key = normalize_video_format_key(video_format)
    extras = [k for k in _DOWNSCALE_EXTRAS.get(key, ()) if k != key]
    return [key, *extras]


def export_variant_specs(
    target_format: str | None,
    video_format: str | None,
    *,
    is_video: bool = True,
) -> list[dict]:
    """Pixel sizes offered on the Export step."""
    if not is_video:
        w, h = export_canvas_size(target_format, video_format, is_video=False)
        return [
            {
                "key": "full",
                "label": "Full",
                "width": w,
                "height": h,
                "master": True,
            }
        ]
    specs: list[dict] = []
    keys = downscale_export_keys(video_format)
    for i, key in enumerate(keys):
        w, h = export_canvas_size(target_format, key, is_video=True)
        specs.append(
            {
                "key": key,
                "label": VIDEO_FORMAT_LABELS.get(key, key),
                "width": w,
                "height": h,
                "master": i == 0,
            }
        )
    return specs
