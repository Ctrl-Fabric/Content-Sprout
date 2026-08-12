from content_sprout.formats import downscale_export_keys, export_canvas_size, export_variant_specs


def test_export_canvas_size_video_follows_named_format():
    assert export_canvas_size("landscape", "4k", is_video=True) == (3840, 2160)
    assert export_canvas_size("portrait", "4k", is_video=True) == (2160, 3840)
    assert export_canvas_size("landscape", "1080p", is_video=True) == (1920, 1080)
    assert export_canvas_size("portrait", "1080p", is_video=True) == (1080, 1920)
    assert export_canvas_size("landscape", "720p", is_video=True) == (1280, 720)
    w, h = export_canvas_size("landscape", "standard", is_video=True)
    assert (w, h) == (854, 480)
    assert w % 2 == 0 and h % 2 == 0


def test_export_canvas_size_image_uses_instagram_presets():
    assert export_canvas_size("portrait", "4k", is_video=False) == (1080, 1350)
    assert export_canvas_size("landscape", "4k", is_video=False) == (1080, 566)
    assert export_canvas_size("square", None, is_video=False) == (1080, 1080)
    assert export_canvas_size("story", "1080p", is_video=False) == (1080, 1920)


def test_downscale_export_keys_never_upsizes():
    assert downscale_export_keys("4k") == ["4k", "1080p", "720p"]
    assert downscale_export_keys("1440p") == ["1440p", "1080p", "720p"]
    assert downscale_export_keys("1080p") == ["1080p", "720p"]
    assert downscale_export_keys("720p") == ["720p", "standard"]
    assert downscale_export_keys("standard") == ["standard"]
    assert downscale_export_keys("unknown") == ["1080p", "720p"]


def test_export_variant_specs_video_and_image():
    specs = export_variant_specs("landscape", "4k", is_video=True)
    assert [s["key"] for s in specs] == ["4k", "1080p", "720p"]
    assert specs[0]["master"] is True
    assert specs[0]["width"] == 3840 and specs[0]["height"] == 2160
    assert specs[1]["width"] == 1920 and specs[1]["height"] == 1080
    stills = export_variant_specs("portrait", "4k", is_video=False)
    assert stills == [{"key": "full", "label": "Full", "width": 1080, "height": 1350, "master": True}]
