"""Export must crop layers that hang outside the canvas (match preview overflow:hidden)."""

from PIL import Image

from content_sprout.render import (
    _background_rgb,
    _fit_image_contain,
    _fit_image_cover,
    _paste_clipped,
)


def test_paste_clipped_crops_negative_origin():
    canvas = Image.new("RGBA", (100, 100), (0, 0, 0, 255))
    # Distinct left (red) / right (green) halves so we can verify which part lands on canvas.
    src = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    for x in range(50):
        for y in range(100):
            src.putpixel((x, y), (255, 0, 0, 255))
            src.putpixel((x + 50, y), (0, 255, 0, 255))

    # Place so only the right half of src is visible on the canvas.
    _paste_clipped(canvas, src, -50, 0)

    assert canvas.getpixel((0, 50))[:3] == (0, 255, 0)
    assert canvas.getpixel((49, 50))[:3] == (0, 255, 0)
    # Far-right of canvas should stay background (src only covers x=0..49).
    assert canvas.getpixel((75, 50))[:3] == (0, 0, 0)


def test_paste_clipped_crops_overflow_edges():
    canvas = Image.new("RGBA", (100, 100), (0, 0, 0, 255))
    src = Image.new("RGBA", (80, 80), (0, 128, 255, 255))
    _paste_clipped(canvas, src, 70, 70)

    assert canvas.getpixel((99, 99))[:3] == (0, 128, 255)
    assert canvas.getpixel((50, 50))[:3] == (0, 0, 0)


def test_paste_clipped_skips_fully_outside():
    canvas = Image.new("RGBA", (40, 40), (10, 10, 10, 255))
    src = Image.new("RGBA", (20, 20), (255, 255, 0, 255))
    _paste_clipped(canvas, src, 100, 100)
    assert canvas.getpixel((20, 20))[:3] == (10, 10, 10)


def test_fit_cover_fills_box():
    img = Image.new("RGB", (200, 100), (255, 0, 0))
    covered = _fit_image_cover(img, 100, 100)
    assert covered.size == (100, 100)
    assert covered.getpixel((50, 50))[0] > 200


def test_fit_contain_letterboxes_without_crop():
    img = Image.new("RGBA", (100, 100), (255, 0, 0, 255))
    contained = _fit_image_contain(img, 200, 100)
    assert contained.size == (200, 100)
    # Center is the square media; sides are transparent padding.
    assert contained.getpixel((100, 50))[:3] == (255, 0, 0)
    assert contained.getpixel((5, 50))[3] == 0
    assert contained.getpixel((195, 50))[3] == 0


def test_background_rgb_parses_hex_and_falls_back():
    assert _background_rgb("#ff0000") == (255, 0, 0)
    assert _background_rgb("#0f0") == (0, 255, 0)
    assert _background_rgb(None) == (0, 0, 0)
    assert _background_rgb("") == (0, 0, 0)
    assert _background_rgb("transparent") == (0, 0, 0)
    assert _background_rgb("not-a-color") == (0, 0, 0)
