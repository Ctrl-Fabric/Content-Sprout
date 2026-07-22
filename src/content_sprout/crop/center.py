"""Center crop + resize. Baseline Cropper; replaced by smart variants later."""

from PIL import Image


def crop_to(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Center-crop `img` to the target aspect ratio, then resize to exact dims.

    Never upscales the source beyond its native resolution along the crop axis;
    only crops + downsamples with high-quality Lanczos.
    """
    src_w, src_h = img.size
    target_aspect = target_w / target_h
    src_aspect = src_w / src_h

    if src_aspect > target_aspect:
        # Source is wider than target — trim the sides.
        new_w = int(round(src_h * target_aspect))
        left = (src_w - new_w) // 2
        box = (left, 0, left + new_w, src_h)
    else:
        # Source is taller than target — trim top and bottom.
        new_h = int(round(src_w / target_aspect))
        top = (src_h - new_h) // 2
        box = (0, top, src_w, top + new_h)

    cropped = img.crop(box)
    return cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)
