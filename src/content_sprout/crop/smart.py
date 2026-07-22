"""Subject-aware smart crop.

Order of preference per image:
  1. Faces (MediaPipe)  — center the crop on detected face(s), zoom as little as
                          possible, preserve full face area when source allows.
  2. Saliency (smartcrop) — when no faces, ask `smartcrop` for the most
                          interesting region with the target aspect ratio.
  3. Center crop        — graceful fallback if everything else fails.
"""

from __future__ import annotations

from PIL import Image

from . import center, faces as faces_mod

# Lazy singleton for the smartcrop scorer (fairly cheap to construct, but no need
# to recreate every call).
_smartcrop_inst = None


def _get_smartcrop():
    global _smartcrop_inst
    if _smartcrop_inst is None:
        import smartcrop

        _smartcrop_inst = smartcrop.SmartCrop()
    return _smartcrop_inst


def crop_to(
    img: Image.Image,
    target_w: int,
    target_h: int,
    faces: list[tuple[int, int, int, int]] | None = None,
) -> Image.Image:
    """Return a copy of `img` cropped and resized to exactly (target_w, target_h).

    If `faces` is provided, it is used directly (lets callers detect once per
    source image and reuse across all formats). If `None`, faces are detected
    on demand.
    """
    target_aspect = target_w / target_h

    if faces is None:
        faces = faces_mod.detect(img)

    if faces:
        subject = _union_with_padding(faces, padding=0.10, src_size=img.size)
        box = _max_crop_for_subject(img.size, target_aspect, subject)
    else:
        box = _smartcrop_box(img, target_w, target_h)

    if box is None:
        return center.crop_to(img, target_w, target_h)

    return img.crop(box).resize((target_w, target_h), Image.Resampling.LANCZOS)


# ---------------------------------------------------------------------------
# Face-driven crop: center on subject, take the largest valid window.
# ---------------------------------------------------------------------------


def _union_with_padding(
    boxes: list[tuple[int, int, int, int]],
    padding: float,
    src_size: tuple[int, int],
) -> tuple[float, float, float, float]:
    """Outer-padded union of bboxes, clamped to source bounds."""
    src_w, src_h = src_size
    x1 = min(b[0] for b in boxes)
    y1 = min(b[1] for b in boxes)
    x2 = max(b[2] for b in boxes)
    y2 = max(b[3] for b in boxes)

    pad_x = (x2 - x1) * padding
    pad_y = (y2 - y1) * padding
    return (
        max(0.0, x1 - pad_x),
        max(0.0, y1 - pad_y),
        min(float(src_w), x2 + pad_x),
        min(float(src_h), y2 + pad_y),
    )


def _max_crop_for_subject(
    src_size: tuple[int, int],
    target_aspect: float,
    subject: tuple[float, float, float, float],
) -> tuple[int, int, int, int]:
    """Pick the largest crop window with `target_aspect` that:
       - fits inside source
       - contains the subject when possible (centered on subject otherwise)
    """
    src_w, src_h = src_size
    sx1, sy1, sx2, sy2 = subject
    subj_cx = (sx1 + sx2) / 2.0
    subj_cy = (sy1 + sy2) / 2.0
    subj_w = sx2 - sx1
    subj_h = sy2 - sy1

    # Largest crop with the right aspect ratio that fits in the source.
    if src_w / src_h > target_aspect:
        crop_h = float(src_h)
        crop_w = crop_h * target_aspect
    else:
        crop_w = float(src_w)
        crop_h = crop_w / target_aspect

    # If the subject is larger than the max crop along either axis, shrink the
    # crop to fit subject (+ small margin) — this means zooming in less than the
    # "largest possible" choice, which is fine. Keep aspect locked.
    needed_w = max(subj_w, subj_h * target_aspect) * 1.10
    needed_h = needed_w / target_aspect
    if needed_w > crop_w and needed_w <= src_w:
        crop_w, crop_h = needed_w, needed_h

    # Center on subject, then clamp so the window stays inside the source.
    x1 = max(0.0, min(float(src_w) - crop_w, subj_cx - crop_w / 2.0))
    y1 = max(0.0, min(float(src_h) - crop_h, subj_cy - crop_h / 2.0))

    return (
        int(round(x1)),
        int(round(y1)),
        int(round(x1 + crop_w)),
        int(round(y1 + crop_h)),
    )


# ---------------------------------------------------------------------------
# Saliency crop (no faces detected).
# ---------------------------------------------------------------------------


def _smartcrop_box(
    img: Image.Image, target_w: int, target_h: int
) -> tuple[int, int, int, int] | None:
    """Ask `smartcrop` for the best window with the target aspect ratio.

    Returns None if smartcrop misbehaves; caller should fall back to center crop.
    """
    try:
        result = _get_smartcrop().crop(img, target_w, target_h)
    except Exception:
        return None

    top = result.get("top_crop") if isinstance(result, dict) else None
    if not top:
        return None

    try:
        x = int(top["x"])
        y = int(top["y"])
        w = int(top["width"])
        h = int(top["height"])
    except (KeyError, TypeError, ValueError):
        return None

    if w <= 0 or h <= 0:
        return None
    return (x, y, x + w, y + h)
