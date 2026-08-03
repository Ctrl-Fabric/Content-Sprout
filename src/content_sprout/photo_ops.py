"""Deterministic Pillow photo operations for editor AI."""

from __future__ import annotations

from typing import Any

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


ALLOWED_OPS = frozenset(
    {
        "brightness",
        "contrast",
        "saturation",
        "blur",
        "sharpen",
        "crop",
        "rotate",
        "flip",
        "grade",
        "resize",
        "apply_logo",
    }
)


def apply_photo_ops(img: Image.Image, ops: list[dict[str, Any]]) -> tuple[Image.Image, bool | None]:
    """Apply ordered ops. Returns (image, apply_logo flag if set else None)."""
    out = img.convert("RGBA")
    apply_logo: bool | None = None

    for raw in ops or []:
        if not isinstance(raw, dict):
            continue
        op = str(raw.get("op", "")).strip().lower()
        if op not in ALLOWED_OPS:
            continue

        if op == "brightness":
            value = float(raw.get("value", 1.0))
            value = max(0.2, min(3.0, value))
            out = ImageEnhance.Brightness(out.convert("RGB")).enhance(value).convert("RGBA")
        elif op == "contrast":
            value = float(raw.get("value", 1.0))
            value = max(0.2, min(3.0, value))
            out = ImageEnhance.Contrast(out.convert("RGB")).enhance(value).convert("RGBA")
        elif op == "saturation":
            value = float(raw.get("value", 1.0))
            value = max(0.0, min(3.0, value))
            out = ImageEnhance.Color(out.convert("RGB")).enhance(value).convert("RGBA")
        elif op == "blur":
            radius = float(raw.get("radius", raw.get("value", 0)))
            radius = max(0.0, min(20.0, radius))
            if radius > 0:
                out = out.filter(ImageFilter.GaussianBlur(radius=radius))
        elif op == "sharpen":
            value = float(raw.get("value", 1.0))
            value = max(0.0, min(3.0, value))
            if value > 1.0:
                out = ImageEnhance.Sharpness(out.convert("RGB")).enhance(value).convert("RGBA")
        elif op == "crop":
            box = raw.get("box") or [0, 0, 1, 1]
            if len(box) != 4:
                continue
            left, top, right, bottom = (float(x) for x in box)
            left = max(0.0, min(1.0, left))
            top = max(0.0, min(1.0, top))
            right = max(0.0, min(1.0, right))
            bottom = max(0.0, min(1.0, bottom))
            if right <= left or bottom <= top:
                continue
            w, h = out.size
            out = out.crop(
                (
                    int(left * w),
                    int(top * h),
                    int(right * w),
                    int(bottom * h),
                )
            )
        elif op == "rotate":
            degrees = float(raw.get("degrees", raw.get("value", 0)))
            degrees = max(-180.0, min(180.0, degrees))
            if abs(degrees) > 0.01:
                out = out.rotate(-degrees, expand=True, fillcolor=(0, 0, 0, 0))
        elif op == "flip":
            axis = str(raw.get("axis", "horizontal")).lower()
            if axis.startswith("v"):
                out = ImageOps.flip(out)
            else:
                out = ImageOps.mirror(out)
        elif op == "grade":
            preset = str(raw.get("preset", "none")).lower()
            rgb = out.convert("RGB")
            r, g, b = rgb.split()
            if preset == "warm":
                r = r.point(lambda x: min(255, int(x * 1.08)))
                b = b.point(lambda x: int(x * 0.92))
            elif preset == "cool":
                b = b.point(lambda x: min(255, int(x * 1.08)))
                r = r.point(lambda x: int(x * 0.92))
            else:
                continue
            out = Image.merge("RGB", (r, g, b)).convert("RGBA")
        elif op == "resize":
            try:
                width = int(raw.get("width") or 0)
                height = int(raw.get("height") or 0)
            except (TypeError, ValueError):
                continue
            width = max(8, min(8192, width))
            height = max(8, min(8192, height))
            if width >= 8 and height >= 8:
                out = out.resize((width, height), Image.Resampling.LANCZOS)
        elif op == "apply_logo":
            apply_logo = bool(raw.get("value", True))

    return out, apply_logo


def image_to_jpeg_bytes(img: Image.Image, *, quality: int = 92) -> bytes:
    buf = __import__("io").BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    return buf.getvalue()
