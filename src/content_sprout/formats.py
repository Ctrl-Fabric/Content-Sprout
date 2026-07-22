"""Instagram output format presets."""

from typing import Literal

FormatName = Literal["square", "portrait", "landscape", "story"]

# (width, height) in pixels. Instagram's recommended publishing sizes.
FORMAT_DIMENSIONS: dict[str, tuple[int, int]] = {
    "square": (1080, 1080),       # 1:1
    "portrait": (1080, 1350),     # 4:5    — best feed engagement
    "landscape": (1080, 566),     # 1.91:1
    "story": (1080, 1920),        # 9:16   — Stories & Reels
}


def aspect(name: str) -> float:
    w, h = FORMAT_DIMENSIONS[name]
    return w / h
