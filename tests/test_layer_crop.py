"""Spatial crop helpers for video/image layers."""

from PIL import Image

from content_sprout.models import Layer
from content_sprout.render import (
    _apply_layer_crop,
    layer_crop_direction,
    layer_crop_percent,
    layer_crop_rect,
    layer_has_crop,
)


def test_crop_from_west():
    layer = Layer(type="video", crop_direction="W", crop_percent=20)
    assert layer_has_crop(layer)
    assert layer_crop_percent(layer) == 20
    assert layer_crop_direction(layer) == "W"
    x, y, w, h = layer_crop_rect(layer)
    assert abs(x - 0.2) < 1e-6
    assert abs(y - 0.0) < 1e-6
    assert abs(w - 0.8) < 1e-6
    assert abs(h - 1.0) < 1e-6


def test_crop_center_insets_all_sides():
    layer = Layer(type="video", crop_direction="center", crop_percent=20)
    x, y, w, h = layer_crop_rect(layer)
    assert abs(x - 0.1) < 1e-6
    assert abs(y - 0.1) < 1e-6
    assert abs(w - 0.8) < 1e-6
    assert abs(h - 0.8) < 1e-6


def test_crop_off_when_percent_zero():
    layer = Layer(type="video", crop_direction="E", crop_percent=0)
    assert not layer_has_crop(layer)
    assert layer_crop_rect(layer) is None


def test_apply_layer_crop_pixels():
    img = Image.new("RGBA", (100, 50), (0, 255, 0, 255))
    for x in range(20, 100):
        for y in range(50):
            img.putpixel((x, y), (255, 0, 0, 255))
    layer = Layer(type="video", crop_direction="W", crop_percent=20)
    out = _apply_layer_crop(img, layer)
    assert out.size == (80, 50)
    assert out.getpixel((0, 0))[:3] == (255, 0, 0)
