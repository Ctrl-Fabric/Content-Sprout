"""Horizontal flip for video/image layers."""

from PIL import Image

from content_sprout.models import Layer
from content_sprout.render import _apply_layer_flip, layer_flip_horizontal


def test_flip_horizontal_flag():
    assert not layer_flip_horizontal(Layer(type="video"))
    assert not layer_flip_horizontal(Layer(type="video", flip_horizontal=False))
    assert layer_flip_horizontal(Layer(type="video", flip_horizontal=True))


def test_apply_layer_flip_mirrors_pixels():
    img = Image.new("RGBA", (4, 2), (0, 0, 0, 255))
    img.putpixel((0, 0), (255, 0, 0, 255))
    img.putpixel((3, 0), (0, 255, 0, 255))
    layer = Layer(type="video", flip_horizontal=True)
    out = _apply_layer_flip(img, layer)
    assert out.size == (4, 2)
    assert out.getpixel((0, 0))[:3] == (0, 255, 0)
    assert out.getpixel((3, 0))[:3] == (255, 0, 0)


def test_apply_layer_flip_noop_when_off():
    img = Image.new("RGBA", (2, 1), (10, 20, 30, 255))
    img.putpixel((0, 0), (1, 2, 3, 255))
    out = _apply_layer_flip(img, Layer(type="video", flip_horizontal=False))
    assert out.getpixel((0, 0))[:3] == (1, 2, 3)
