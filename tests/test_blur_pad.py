"""Tests for story blur-pad rendering."""

from PIL import Image

from content_sprout.config import AppConfig, StoryConfig
from content_sprout.crop import blur_pad
from content_sprout.formats import FORMAT_DIMENSIONS
from content_sprout.pipeline import render_format


def test_blur_pad_exact_story_dimensions():
    img = Image.new("RGB", (4000, 3000), (80, 120, 200))
    w, h = FORMAT_DIMENSIONS["story"]
    out = blur_pad.fit(img, w, h, blur_radius=20, faces=[])
    assert out.size == (w, h)


def test_render_format_story_uses_blur_pad_when_configured():
    img = Image.new("RGB", (3000, 2000), (200, 100, 50))
    cfg = AppConfig(story=StoryConfig(fit_mode="blur_pad", blur_radius=15))
    w, h = FORMAT_DIMENSIONS["story"]
    out = render_format(img, "story", w, h, faces=[], cfg=cfg)
    assert out.size == (w, h)


def test_render_format_story_uses_smart_crop_when_configured():
    img = Image.new("RGB", (3000, 2000), (200, 100, 50))
    cfg = AppConfig(story=StoryConfig(fit_mode="smart_crop"))
    w, h = FORMAT_DIMENSIONS["story"]
    out = render_format(img, "story", w, h, faces=[], cfg=cfg)
    assert out.size == (w, h)
