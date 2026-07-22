"""Transparency masks punch holes through image/video layers on export."""

from PIL import Image

from content_sprout.models import LayerMask
from content_sprout.render import (
    _apply_transparency_masks,
    mask_active_at,
    mask_effective_duration,
)


def test_transparency_mask_punches_hole():
    img = Image.new("RGBA", (100, 100), (0, 128, 255, 255))
    masks = [LayerMask(type="rect", kind="transparency", x=25, y=25, width=50, height=50)]
    out = _apply_transparency_masks(img, masks, box_w=100, box_h=100)
    # Outside the hole stays opaque.
    assert out.getpixel((10, 10))[3] == 255
    # Center of the hole is fully transparent.
    assert out.getpixel((50, 50))[3] == 0


def test_no_masks_leaves_image_unchanged():
    img = Image.new("RGBA", (40, 40), (10, 20, 30, 200))
    out = _apply_transparency_masks(img, [], box_w=40, box_h=40)
    assert out.getpixel((20, 20)) == (10, 20, 30, 200)


def test_mask_effective_duration_defaults_to_layer_remainder():
    mask = LayerMask(start_s=1.0, duration_s=None)
    assert mask_effective_duration(mask, 5.0) == 4.0


def test_mask_active_at_respects_timing():
    mask = LayerMask(start_s=1.0, duration_s=2.0)
    assert not mask_active_at(mask, 0.5, 5.0)
    assert mask_active_at(mask, 1.0, 5.0)
    assert mask_active_at(mask, 2.5, 5.0)
    assert not mask_active_at(mask, 3.0, 5.0)


def test_timed_mask_only_applies_when_active():
    img = Image.new("RGBA", (100, 100), (0, 128, 255, 255))
    masks = [
        LayerMask(
            type="rect",
            kind="transparency",
            x=25,
            y=25,
            width=50,
            height=50,
            start_s=1.0,
            duration_s=1.0,
        )
    ]
    inactive = _apply_transparency_masks(
        img, masks, box_w=100, box_h=100, layer_local_t=0.2, layer_duration=5.0
    )
    assert inactive.getpixel((50, 50))[3] == 255

    active = _apply_transparency_masks(
        img, masks, box_w=100, box_h=100, layer_local_t=1.5, layer_duration=5.0
    )
    assert active.getpixel((50, 50))[3] == 0
