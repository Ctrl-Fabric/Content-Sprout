"""Tests for heuristic placement and logo compositing."""

from pathlib import Path

import numpy as np
from PIL import Image

from content_sprout.compose import apply_logo, load_logo
from content_sprout.config import LogoConfig
from content_sprout.placement.heuristic import decide


def _solid(w: int, h: int, color: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGB", (w, h), color)


def _make_logo(path: Path, fill: tuple[int, int, int, int]) -> None:
    img = Image.new("RGBA", (200, 80), fill)
    img.save(path, "PNG")


def test_heuristic_picks_dark_logo_on_light_quiet_corner():
    # White canvas; only bottom-right is busy → top-left should win + dark logo.
    img = _solid(1080, 1080, (250, 250, 250))
    arr = np.asarray(img).copy()
    h, w = arr.shape[:2]
    rng = np.random.default_rng(0)
    arr[h // 2 :, w // 2 :] = rng.integers(0, 255, (h // 2, w // 2, 3), dtype=np.uint8)
    img = Image.fromarray(arr)

    decision = decide(img, LogoConfig(), logo_aspect=2.5)
    assert decision.logo_variant == "dark"
    assert decision.corner == "tl"


def test_heuristic_picks_white_logo_on_dark_corner():
    img = _solid(1080, 1080, (20, 20, 20))
    decision = decide(img, LogoConfig(), logo_aspect=2.5)
    assert decision.logo_variant == "white"


def test_compose_applies_logo(tmp_path: Path):
    dark = tmp_path / "dark.png"
    white = tmp_path / "white.png"
    _make_logo(dark, (0, 0, 0, 255))
    _make_logo(white, (255, 255, 255, 255))

    base = _solid(400, 400, (240, 240, 240))
    before = np.asarray(base).copy()
    out = apply_logo(
        base,
        corner="br",
        variant="dark",
        logo_dark=load_logo(dark),
        logo_white=load_logo(white),
        logo_cfg=LogoConfig(width_pct=20.0, padding_pct=5.0),
    )
    after = np.asarray(out)
    assert not np.array_equal(before, after)
    assert out.size == (400, 400)


def test_choose_logo_length_prefers_short_on_tall_canvas():
    from content_sprout.compose import choose_logo_length

    short = Image.new("RGBA", (40, 40), (0, 0, 0, 255))
    full = Image.new("RGBA", (200, 40), (0, 0, 0, 255))
    # Story-like tall canvas
    logo, length = choose_logo_length(
        short=short, full=full, img_w=1080, img_h=1920, logo_cfg=LogoConfig()
    )
    assert length == "short"
    assert logo.size == short.size


def test_choose_logo_length_prefers_full_on_square_when_it_fits():
    from content_sprout.compose import choose_logo_length

    short = Image.new("RGBA", (40, 40), (0, 0, 0, 255))
    full = Image.new("RGBA", (200, 40), (0, 0, 0, 255))
    logo, length = choose_logo_length(
        short=short, full=full, img_w=1080, img_h=1080, logo_cfg=LogoConfig()
    )
    assert length == "full"
    assert logo.size == full.size


def test_resolve_logo_theme_requires_dark_availability():
    from content_sprout.compose import resolve_logo_theme
    from content_sprout.pipeline import LogoAssets

    light = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
    logos = LogoAssets(
        dark=light,
        white=light,
        aspect=1.0,
        light_short=light,
        has_dark=False,
        has_light=True,
    )
    assert resolve_logo_theme("dark", logos) == "white"
    assert resolve_logo_theme("white", logos) == "white"
