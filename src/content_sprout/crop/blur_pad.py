"""Story-style blur padding — fit subject in frame over a blurred background."""

from __future__ import annotations

from PIL import Image, ImageFilter

from . import smart


def _contain_size(
    src_size: tuple[int, int], target_w: int, target_h: int
) -> tuple[int, int]:
    """Dimensions to fit `src` inside (target_w, target_h) preserving aspect."""
    src_w, src_h = src_size
    scale = min(target_w / src_w, target_h / src_h)
    return max(1, int(round(src_w * scale))), max(1, int(round(src_h * scale)))


def _blurred_background(
    img: Image.Image, target_w: int, target_h: int, blur_radius: int
) -> Image.Image:
    """Scale to cover the target, blur, then center-crop to exact size."""
    src_w, src_h = img.size
    target_aspect = target_w / target_h
    src_aspect = src_w / src_h

    if src_aspect > target_aspect:
        cover_h = target_h
        cover_w = int(round(cover_h * src_aspect))
    else:
        cover_w = target_w
        cover_h = int(round(cover_w / src_aspect))

    bg = img.resize((cover_w, cover_h), Image.Resampling.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    left = (cover_w - target_w) // 2
    top = (cover_h - target_h) // 2
    return bg.crop((left, top, left + target_w, top + target_h))


def fit(
    img: Image.Image,
    target_w: int,
    target_h: int,
    *,
    blur_radius: int = 60,
    faces: list[tuple[int, int, int, int]] | None = None,
) -> Image.Image:
    """Build a 9:16 (or any) frame with smart-cropped foreground over blur fill.

    The foreground uses the same face/saliency logic as `smart.crop_to` so the
    subject stays well framed; the background is a heavily blurred cover crop.
    """
    fit_w, fit_h = _contain_size(img.size, target_w, target_h)
    foreground = smart.crop_to(img, fit_w, fit_h, faces=faces)
    canvas = _blurred_background(img, target_w, target_h, blur_radius)

    x = (target_w - fit_w) // 2
    y = (target_h - fit_h) // 2
    canvas.paste(foreground, (x, y))
    return canvas
