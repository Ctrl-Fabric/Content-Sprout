"""Ken Burns scale effect helpers for layer frames."""

from PIL import Image

from content_sprout.models import Layer
from content_sprout.render import (
    _apply_layer_scale,
    layer_has_scale_effect,
    layer_scale_at,
    layer_scale_effect,
)


def test_scale_in_grows_over_clip():
    layer = Layer(
        type="video",
        start_s=0,
        duration_s=4,
        scale_effect="scale-in",
        scale_amount=0.5,
        scale_speed=1.0,
        scale_direction="center",
    )
    s0, _, _ = layer_scale_at(layer, 0.0, 4.0)
    s_mid, _, _ = layer_scale_at(layer, 2.0, 4.0)
    s_end, _, _ = layer_scale_at(layer, 3.99, 4.0)
    assert abs(s0 - 1.0) < 1e-6
    assert abs(s_mid - 1.25) < 1e-6
    assert abs(s_end - 1.5) < 0.02


def test_scale_out_shrinks_over_clip():
    layer = Layer(
        type="video",
        start_s=0,
        duration_s=2,
        scale_effect="scale-out",
        scale_amount=0.4,
        scale_speed=1.0,
    )
    s0, _, _ = layer_scale_at(layer, 0.0, 2.0)
    s_end, _, _ = layer_scale_at(layer, 1.99, 2.0)
    assert abs(s0 - 1.4) < 1e-6
    assert abs(s_end - 1.0) < 0.02


def test_scale_speed_finishes_early():
    layer = Layer(
        type="video",
        start_s=0,
        duration_s=4,
        scale_effect="scale-in",
        scale_amount=0.5,
        scale_speed=2.0,
    )
    s_half, _, _ = layer_scale_at(layer, 2.0, 4.0)
    s_end, _, _ = layer_scale_at(layer, 3.5, 4.0)
    assert abs(s_half - 1.5) < 1e-6
    assert abs(s_end - 1.5) < 1e-6


def test_apply_layer_scale_keeps_box_size():
    img = Image.new("RGBA", (100, 80), (10, 20, 30, 255))
    out = _apply_layer_scale(img, 1.5, 0.5, 0.5)
    assert out.size == (100, 80)
    assert layer_has_scale_effect(Layer(scale_effect="scale-in"))
    assert layer_scale_effect(Layer(scale_effect="scale-out")) == "scale-out"


def test_apply_layer_scale_is_subpixel_smooth():
    """Consecutive zoom steps should move continuously (not stair-step on ints)."""
    img = Image.new("RGBA", (200, 200), (0, 0, 0, 255))
    for x in range(200):
        for y in range(200):
            img.putpixel((x, y), (x, y, 128, 255))
    # Off-center origin so the sample window slides as scale changes.
    a = _apply_layer_scale(img, 1.20, 0.2, 0.2)
    b = _apply_layer_scale(img, 1.21, 0.2, 0.2)
    c = _apply_layer_scale(img, 1.22, 0.2, 0.2)
    # Corner reflects the moving window; center stays pinned to the origin.
    assert a.getpixel((0, 0)) != b.getpixel((0, 0)) or b.getpixel((0, 0)) != c.getpixel((0, 0))
    assert a.getpixel((100, 100))[3] == 255


def test_scale_bounds_grows_toward_scene():
    from content_sprout.render import layer_scale_box_at

    layer = Layer(
        type="video",
        start_s=0,
        duration_s=2,
        x=25,
        y=25,
        width=50,
        height=50,
        scale_effect="scale-in",
        scale_amount=1.0,
        scale_speed=1.0,
        scale_bounds=True,
        scale_direction="center",
    )
    start = layer_scale_box_at(layer, 0.0, 2.0)
    end = layer_scale_box_at(layer, 1.99, 2.0)
    assert start is not None and end is not None
    assert abs(start[2] - 50) < 0.5
    assert abs(end[2] - 100) < 1.0
    assert abs(end[0]) < 1.0
    assert abs(end[1]) < 1.0
    assert layer_scale_box_at(Layer(scale_effect="scale-in"), 0.5, 2.0) is None
