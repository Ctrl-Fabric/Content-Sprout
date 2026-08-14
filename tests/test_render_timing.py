"""Tests for per-layer video timing."""

from content_sprout.models import Layer, Post, ProjectType, Scene
from content_sprout.render import (
    apply_speech_duration,
    ensure_scene_fits_layer,
    layer_effective_duration,
    layer_opacity_at,
    layer_visible_at,
    scene_direct_video_layer,
    scene_timeline,
)


def test_layer_source_time_respects_in_point():
    from content_sprout.render import layer_source_time

    layer = Layer(type="video", start_s=1.0, duration_s=5.0, source_start_s=2.0)
    # At scene t=2 → layer local 1 → source 3
    assert layer_source_time(layer, 2.0) == 3.0
    assert layer_source_time(layer, 1.0) == 2.0
    assert layer_source_time(layer, 0.5) == 2.0  # before layer start clamps local to 0


def test_layer_source_time_scales_with_playback_rate():
    from content_sprout.render import layer_playback_rate, layer_source_time

    fast = Layer(type="video", start_s=0.0, duration_s=2.0, source_start_s=1.0, playback_rate=2.0)
    slow = Layer(type="video", start_s=0.0, duration_s=4.0, source_start_s=1.0, playback_rate=0.5)
    assert layer_playback_rate(fast) == 2.0
    assert layer_playback_rate(slow) == 0.5
    # 1s of timeline at 2× consumes 2s of source from in-point 1 → 3
    assert layer_source_time(fast, 1.0) == 3.0
    # 2s of timeline at 0.5× consumes 1s of source from in-point 1 → 2
    assert layer_source_time(slow, 2.0) == 2.0


def test_layer_playback_rate_clamps():
    from content_sprout.render import layer_playback_rate

    assert layer_playback_rate(Layer(type="video", playback_rate=0.1)) == 0.5
    assert layer_playback_rate(Layer(type="video", playback_rate=50)) == 20.0
    assert layer_playback_rate(Layer(type="video", playback_rate=0)) == 1.0


def test_audio_atempo_chain_covers_slow_and_20x():
    from content_sprout.render import _audio_atempo_chain

    assert _audio_atempo_chain(1.0) == ""
    assert _audio_atempo_chain(0.5) == "atempo=0.500000"
    chain_20 = _audio_atempo_chain(20.0)
    assert "atempo=2.0" in chain_20
    # 20 = 2×2×2×2×1.25 → five stages
    assert chain_20.count("atempo=") == 5


def test_layer_visible_window():
    layer = Layer(start_s=1.0, duration_s=2.0)
    assert not layer_visible_at(layer, 0.5, scene_duration=5.0)
    assert layer_visible_at(layer, 1.0, scene_duration=5.0)
    assert layer_visible_at(layer, 2.5, scene_duration=5.0)
    assert not layer_visible_at(layer, 3.0, scene_duration=5.0)


def test_layer_default_duration_to_scene_end():
    layer = Layer(start_s=2.0, duration_s=None)
    assert layer_effective_duration(layer, scene_duration=5.0) == 3.0
    assert layer_visible_at(layer, 4.5, scene_duration=5.0)
    assert not layer_visible_at(layer, 5.0, scene_duration=5.0)


def test_fade_in_reduces_opacity():
    layer = Layer(start_s=0.0, duration_s=2.0, transition_in="fade-in", opacity=1.0)
    assert layer_opacity_at(layer, 0.0, scene_duration=2.0) == 0.0
    assert 0 < layer_opacity_at(layer, 0.1, scene_duration=2.0) < 1.0
    assert layer_opacity_at(layer, 1.0, scene_duration=2.0) == 1.0


def test_fade_out_reduces_opacity():
    layer = Layer(start_s=0.0, duration_s=2.0, transition_out="fade-out", opacity=1.0)
    assert layer_opacity_at(layer, 1.0, scene_duration=2.0) == 1.0
    assert 0 < layer_opacity_at(layer, 1.9, scene_duration=2.0) < 1.0
    assert layer_opacity_at(layer, 2.0, scene_duration=2.0) == 0.0


def test_fly_in_offsets_from_north():
    from content_sprout.render import layer_visual_at

    layer = Layer(
        start_s=0.0,
        duration_s=2.0,
        transition_in="fly-in",
        transition_in_direction="N",
        transition_in_duration_s=1.0,
        opacity=1.0,
    )
    opacity, ox, oy = layer_visual_at(layer, 0.0, scene_duration=2.0)
    assert opacity == 1.0
    assert ox == 0.0
    assert oy < -50.0
    opacity, ox, oy = layer_visual_at(layer, 1.0, scene_duration=2.0)
    assert opacity == 1.0
    assert ox == 0.0
    assert abs(oy) < 0.01


def test_fly_out_offsets_to_east():
    from content_sprout.render import layer_visual_at

    layer = Layer(
        start_s=0.0,
        duration_s=2.0,
        transition_out="fly-out",
        transition_out_direction="E",
        transition_out_duration_s=1.0,
        opacity=1.0,
    )
    opacity, ox, oy = layer_visual_at(layer, 1.0, scene_duration=2.0)
    assert opacity == 1.0
    assert ox == 0.0
    assert oy == 0.0
    opacity, ox, oy = layer_visual_at(layer, 1.99, scene_duration=2.0)
    assert opacity == 1.0
    assert ox > 99.0
    assert oy == 0.0


def test_custom_transition_duration():
    from content_sprout.render import layer_visual_at

    layer = Layer(
        start_s=0.0,
        duration_s=4.0,
        transition_in="fade-in",
        transition_in_duration_s=2.0,
        opacity=1.0,
    )
    assert layer_opacity_at(layer, 1.0, scene_duration=4.0) == 0.5
    opacity, _, _ = layer_visual_at(layer, 2.0, scene_duration=4.0)
    assert opacity == 1.0


def test_apply_speech_duration_sets_layer_and_grows_scene():
    scene = Scene(id="s1", name="Scene", duration_s=5.0, layers=[])
    layer = Layer(id="l1", type="tts", start_s=1.0, duration_s=5.0)
    apply_speech_duration(scene, layer, 8.4)
    assert layer.duration_s == 8.4
    assert scene.duration_s == 9.4


def test_apply_speech_duration_does_not_shrink_scene():
    scene = Scene(id="s1", name="Scene", duration_s=12.0, layers=[])
    layer = Layer(id="l1", type="tts", start_s=0.0, duration_s=12.0)
    apply_speech_duration(scene, layer, 3.0)
    assert layer.duration_s == 3.0
    assert scene.duration_s == 12.0


def test_ensure_scene_fits_layer_grows_without_clamping():
    scene = Scene(id="s1", name="Scene", duration_s=5.0, layers=[])
    layer = Layer(id="l1", type="image", start_s=2.0, duration_s=4.0)
    delta = ensure_scene_fits_layer(scene, layer)
    assert delta == 1.0
    assert scene.duration_s == 6.0


def test_scene_timeline_includes_gaps():
    post = Post(
        name="v",
        type=ProjectType.VIDEO,
        scenes=[
            Scene(id="a", name="A", duration_s=5.0, gap_before_s=0.0),
            Scene(id="b", name="B", duration_s=3.0, gap_before_s=1.5),
        ],
    )
    rows = scene_timeline(post)
    assert rows[0][1] == 0.0 and rows[0][3] == 5.0
    assert rows[1][1] == 6.5 and rows[1][3] == 9.5


class _FakeStore:
    def __init__(self, posts: dict[str, Post]):
        self._posts = posts

    def get_post(self, _project_id: str, post_id: str) -> Post:
        if post_id not in self._posts:
            raise FileNotFoundError(post_id)
        return self._posts[post_id]


def test_expand_reusable_post_ref_preserves_host_gap():
    from content_sprout.render import expand_scenes_for_export, post_total_duration

    intro = Post(
        id="intro",
        name="Intro",
        type=ProjectType.VIDEO,
        is_reusable=True,
        scenes=[
            Scene(id="i1", name="Logo", duration_s=2.0, gap_before_s=0.0),
            Scene(id="i2", name="Title", duration_s=3.0, gap_before_s=0.5),
        ],
    )
    host = Post(
        id="host",
        name="Main",
        type=ProjectType.VIDEO,
        scenes=[
            Scene(id="r1", name="Intro", duration_s=1.0, gap_before_s=1.0, ref_post_id="intro"),
            Scene(id="m1", name="Body", duration_s=4.0, gap_before_s=0.0),
        ],
    )
    store = _FakeStore({"intro": intro, "host": host})
    expanded = expand_scenes_for_export(store, "proj", host)
    assert len(expanded) == 3
    assert expanded[0].name == "Logo"
    assert expanded[0].gap_before_s == 1.0  # host gap on first expanded scene
    assert expanded[1].name == "Title"
    assert expanded[1].gap_before_s == 0.5
    assert expanded[2].name == "Body"
    assert post_total_duration(store, "proj", host) == 1.0 + 2.0 + 0.5 + 3.0 + 4.0


def test_scene_direct_video_layer_accepts_sole_video():
    video = Layer(type="video", asset_id="clip-1", opacity=1.0, start_s=0, duration_s=10)
    audio = Layer(type="audio", asset_id="bed-1")
    scene = Scene(layers=[video, audio])
    assert scene_direct_video_layer(scene) is video


def test_scene_direct_video_layer_rejects_extra_visuals_and_masks():
    video = Layer(type="video", asset_id="clip-1")
    text = Layer(type="text", text="Hello")
    assert scene_direct_video_layer(Scene(layers=[video, text])) is None
    masked = Layer(type="video", asset_id="clip-1", masks=[{"id": "m1", "x": 0, "y": 0, "width": 10, "height": 10}])
    assert scene_direct_video_layer(Scene(layers=[masked])) is None
    faded = Layer(type="video", asset_id="clip-1", opacity=0.5)
    assert scene_direct_video_layer(Scene(layers=[faded])) is None
