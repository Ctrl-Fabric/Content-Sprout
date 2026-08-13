"""Logo compositing onto rendered Instagram images."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

from PIL import Image, ImageFilter

from .config import LogoConfig
from .placement.base import Corner, LogoVariant

if TYPE_CHECKING:
    from .pipeline import LogoAssets

# Prefer short marks on tall canvases so a wide wordmark does not dominate.
_FULL_MIN_ASPECT = 0.9  # img_w / img_h — square/landscape and up
# Cap full-logo height so it cannot cover too much of the frame.
_FULL_MAX_HEIGHT_FRAC = 0.10


@lru_cache(maxsize=4)
def _load_logo_cached(path: str) -> Image.Image:
    with Image.open(path) as img:
        return img.convert("RGBA")


def load_logo(path: Path) -> Image.Image:
    """Load a logo PNG (RGBA) from disk."""
    return _load_logo_cached(str(path.resolve())).copy()


def logo_aspect(path: Path) -> float:
    logo = load_logo(path)
    return logo.width / logo.height


def _scaled_logo(logo: Image.Image, target_w: int, opacity: float) -> Image.Image:
    aspect = logo.width / logo.height
    target_h = max(1, int(round(target_w / aspect)))
    scaled = logo.resize((target_w, target_h), Image.Resampling.LANCZOS)
    if opacity >= 0.999:
        return scaled
    r, g, b, a = scaled.split()
    a = a.point(lambda p: int(p * opacity))
    return Image.merge("RGBA", (r, g, b, a))


def _position(corner: Corner, img_w: int, img_h: int, logo_w: int, logo_h: int, pad: int) -> tuple[int, int]:
    if corner == "tl":
        return pad, pad
    if corner == "tr":
        return img_w - logo_w - pad, pad
    if corner == "bl":
        return pad, img_h - logo_h - pad
    return img_w - logo_w - pad, img_h - logo_h - pad


def resolve_logo_theme(variant: LogoVariant, logos: LogoAssets) -> LogoVariant:
    """Clamp dark/white to available theme assets.

    Dark is only used when a dark logo exists; otherwise light (and vice versa).
    """
    want_dark = variant == "dark"
    if want_dark and logos.has_dark:
        return "dark"
    if not want_dark and logos.has_light:
        return "white"
    if logos.has_dark:
        return "dark"
    return "white"


def choose_logo_length(
    *,
    short: Image.Image | None,
    full: Image.Image | None,
    img_w: int,
    img_h: int,
    logo_cfg: LogoConfig,
) -> tuple[Image.Image, str]:
    """Pick short vs full so the mark fits the canvas without dominating it."""
    if full is None and short is None:
        raise ValueError("No logo image available for chosen theme.")
    if full is None:
        return short, "short"  # type: ignore[return-value]
    if short is None:
        return full, "full"

    aspect = img_w / max(1, img_h)
    if aspect < _FULL_MIN_ASPECT:
        return short, "short"

    target_w = max(1, int(round(img_w * logo_cfg.width_pct / 100.0)))
    full_aspect = full.width / max(1, full.height)
    full_h = target_w / full_aspect
    if full_h / max(1, img_h) > _FULL_MAX_HEIGHT_FRAC:
        return short, "short"
    return full, "full"


def pick_logo_image(
    logos: LogoAssets,
    variant: LogoVariant,
    img_w: int,
    img_h: int,
    logo_cfg: LogoConfig,
) -> tuple[Image.Image, LogoVariant, str]:
    """Select theme (dark/light) and length (short/full) for this canvas."""
    theme = resolve_logo_theme(variant, logos)
    if theme == "dark":
        short = logos.dark_short or logos.dark
        full = logos.dark_full
    else:
        short = logos.light_short or logos.white
        full = logos.light_full
    logo, length = choose_logo_length(
        short=short, full=full, img_w=img_w, img_h=img_h, logo_cfg=logo_cfg
    )
    return logo, theme, length


def apply_logo(
    img: Image.Image,
    *,
    corner: Corner,
    variant: LogoVariant,
    logo_cfg: LogoConfig,
    logo_dark: Image.Image | None = None,
    logo_white: Image.Image | None = None,
    logos: LogoAssets | None = None,
) -> Image.Image:
    """Composite the chosen logo onto `img` (returns a new RGB image)."""
    base = img.convert("RGBA")
    img_w, img_h = base.size

    if logos is not None:
        logo_src, _theme, _length = pick_logo_image(
            logos, variant, img_w, img_h, logo_cfg
        )
    else:
        if logo_dark is None or logo_white is None:
            raise ValueError("logo_dark and logo_white are required when logos is omitted.")
        logo_src = logo_dark if variant == "dark" else logo_white

    target_w = max(1, int(round(img_w * logo_cfg.width_pct / 100.0)))
    logo = _scaled_logo(logo_src, target_w, logo_cfg.opacity)
    logo_w, logo_h = logo.size
    pad = max(1, int(round(img_w * logo_cfg.padding_pct / 100.0)))
    x, y = _position(corner, img_w, img_h, logo_w, logo_h, pad)

    if logo_cfg.shadow:
        shadow = logo.copy()
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=3))
        # Darken shadow alpha
        r, g, b, a = shadow.split()
        a = a.point(lambda p: int(p * 0.45))
        shadow = Image.merge("RGBA", (r, g, b, a))
        base.alpha_composite(shadow, (x + 2, y + 2))

    base.alpha_composite(logo, (x, y))
    return base.convert("RGB")
