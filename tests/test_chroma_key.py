"""Chroma-key removes matching colors from layer frames on export."""

from PIL import Image

from content_sprout.models import Layer
from content_sprout.render import (
    _apply_chroma_key,
    layer_chroma_key_colors,
    layer_has_chroma_key,
)


def test_chroma_key_makes_green_transparent():
    img = Image.new("RGBA", (40, 40), (0, 255, 0, 255))
    # Paint a non-key pixel.
    img.putpixel((5, 5), (255, 0, 0, 255))
    out = _apply_chroma_key(img, ["#00ff00"], tolerance=0.2, softness=0.05)
    assert out.getpixel((20, 20))[3] == 0
    assert out.getpixel((5, 5))[3] == 255
    assert out.getpixel((5, 5))[:3] == (255, 0, 0)


def test_chroma_key_blue_screen_keeps_subject_opaque():
    """RGB-distance keying used to ghost green clothing; screen key must not."""
    img = Image.new("RGBA", (40, 40), (40, 90, 210, 255))  # blue screen
    img.putpixel((10, 10), (55, 150, 85, 255))  # green hoodie
    img.putpixel((12, 12), (210, 155, 125, 255))  # skin
    img.putpixel((14, 14), (140, 140, 145, 255))  # gray pants
    out = _apply_chroma_key(img, ["#1e50c8"], tolerance=0.18, softness=0.08)
    assert out.getpixel((20, 20))[3] == 0
    assert out.getpixel((10, 10))[3] == 255
    assert out.getpixel((12, 12))[3] == 255
    assert out.getpixel((14, 14))[3] == 255


def test_chroma_key_empty_colors_is_noop():
    img = Image.new("RGBA", (10, 10), (12, 34, 56, 200))
    out = _apply_chroma_key(img, [], tolerance=0.3, softness=0.1)
    assert out.getpixel((5, 5)) == (12, 34, 56, 200)


def test_layer_chroma_helpers():
    bare = Layer(type="video")
    assert not layer_has_chroma_key(bare)
    keyed = Layer(type="video", chroma_key_colors=["#0f0", "#00FF00", "nope"])
    colors = layer_chroma_key_colors(keyed)
    assert colors == ["#00ff00"]
    assert layer_has_chroma_key(keyed)
