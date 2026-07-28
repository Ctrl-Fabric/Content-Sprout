"""Tests for per-layer video timing."""

from content_sprout.models import Layer, Post, ProjectType, Scene
from content_sprout.render import (
    apply_speech_duration,
    ensure_scene_fits_layer,
    layer_effective_duration,
    layer_opacity_at,
    layer_visible_at,
    scene_timeline,
)


def test_layer_source_time_respects_in_point():
    from content_sprout.render import layer_source_time

    layer = Layer(type="video", start_s=1.0, duration_s=5.0, source_start_s=2.0)
    # At scene t=2 → layer local 1 → source 3
    assert layer_source_time(layer, 2.0) == 3.0
    assert layer_source_time(layer, 1.0) == 2.0
    assert layer_source_time(layer, 0.5) == 2.0  # before layer start clamps local to 0


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
