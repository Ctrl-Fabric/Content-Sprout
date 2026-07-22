"""Heuristic logo placement — luminance + edge density per corner."""

from __future__ import annotations

import numpy as np
from PIL import Image

from ..config import LogoConfig
from .base import Corner, LogoVariant, PlacementDecision

# Corners in evaluation order.
_CORNERS: tuple[Corner, ...] = ("tl", "tr", "bl", "br")


def _logo_footprint(
    img_w: int, img_h: int, logo_cfg: LogoConfig, logo_aspect: float
) -> tuple[int, int, int]:
    """Return (logo_w, logo_h, padding_px) for the overlay region."""
    logo_w = max(1, int(round(img_w * logo_cfg.width_pct / 100.0)))
    logo_h = max(1, int(round(logo_w / logo_aspect)))
    pad = max(1, int(round(img_w * logo_cfg.padding_pct / 100.0)))
    return logo_w, logo_h, pad


def _corner_box(
    corner: Corner,
    img_w: int,
    img_h: int,
    logo_w: int,
    logo_h: int,
    pad: int,
) -> tuple[int, int, int, int]:
    """Pixel box (x1, y1, x2, y2) covering logo + padding at `corner`."""
    if corner == "tl":
        return (0, 0, min(img_w, logo_w + 2 * pad), min(img_h, logo_h + 2 * pad))
    if corner == "tr":
        return (max(0, img_w - logo_w - 2 * pad), 0, img_w, min(img_h, logo_h + 2 * pad))
    if corner == "bl":
        return (0, max(0, img_h - logo_h - 2 * pad), min(img_w, logo_w + 2 * pad), img_h)
    # br
    return (
        max(0, img_w - logo_w - 2 * pad),
        max(0, img_h - logo_h - 2 * pad),
        img_w,
        img_h,
    )


def _perceptual_luminance(rgb: np.ndarray) -> float:
    """Mean perceptual luminance in 0–255 for an HxWx3 uint8 patch."""
    # ITU-R BT.601 weights on uint8 — good enough for corner sampling.
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    return float(np.mean(lum))


def _edge_density(gray: np.ndarray) -> float:
    """Normalized edge density 0–1 using Sobel magnitude mean."""
    import cv2

    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    # Typical Sobel magnitudes on 8-bit images sit well below 255.
    return float(np.clip(np.mean(mag) / 128.0, 0.0, 1.0))


def decide(
    img: Image.Image,
    logo_cfg: LogoConfig,
    logo_aspect: float,
) -> PlacementDecision:
    """Pick the quietest corner, then dark vs white from its luminance.

    Corner ranking minimizes edge density (visual busyness). Logo variant uses
    mean luminance at the winning corner: light background → dark logo.
    """
    arr = np.asarray(img.convert("RGB"))
    img_h, img_w = arr.shape[:2]
    logo_w, logo_h, pad = _logo_footprint(img_w, img_h, logo_cfg, logo_aspect)

    busyness: dict[Corner, float] = {}
    luminance: dict[Corner, float] = {}

    for corner in _CORNERS:
        x1, y1, x2, y2 = _corner_box(corner, img_w, img_h, logo_w, logo_h, pad)
        patch = arr[y1:y2, x1:x2]
        if patch.size == 0:
            busyness[corner] = 1.0
            luminance[corner] = 128.0
            continue
        gray = np.dot(patch[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)
        busyness[corner] = _edge_density(gray)
        luminance[corner] = _perceptual_luminance(patch)

    # Quietest corner wins; ties broken by _CORNERS evaluation order (deterministic).
    corner_rank = {c: i for i, c in enumerate(_CORNERS)}
    best_corner = min(_CORNERS, key=lambda c: (busyness[c], corner_rank[c]))
    sorted_busy = sorted(busyness[c] for c in _CORNERS)
    gap = sorted_busy[1] - sorted_busy[0]

    lum = luminance[best_corner]
    variant: LogoVariant = "dark" if lum >= 128.0 else "white"

    # Map busyness gap to confidence for Phase 6 hybrid router.
    confidence = float(np.clip(gap / 0.25, 0.0, 1.0))
    second_best_gap = float(gap)

    return PlacementDecision(
        corner=best_corner,
        logo_variant=variant,
        confidence=confidence,
        second_best_gap=second_best_gap,
    )
