"""Tests for non-destructive video asset edits (ffmpeg)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from content_sprout.config import AppConfig, RouterConfig
from content_sprout.models import CreateProjectRequest
from content_sprout.projects import ProjectStore
from content_sprout.video_edit import (
    VideoEditError,
    VideoInfo,
    _atempo_chain,
    _rotated_frame_size,
    _stream_rotation_deg,
    edit_video,
    preview_proxy_needed,
    probe_video_info,
    write_preview_proxy,
)
from content_sprout.web import create_app

ffmpeg = shutil.which("ffmpeg")
ffprobe = shutil.which("ffprobe")
pytestmark = pytest.mark.skipif(
    not ffmpeg or not ffprobe,
    reason="ffmpeg/ffprobe required for video edit tests",
)


def _store(tmp_path: Path) -> ProjectStore:
    assets = tmp_path / "assets"
    assets.mkdir(exist_ok=True)
    Image.new("RGBA", (40, 20), (0, 0, 0, 255)).save(assets / "logo_dark.png")
    Image.new("RGBA", (40, 20), (255, 255, 255, 255)).save(assets / "logo_white.png")
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        logo_dark=assets / "logo_dark.png",
        logo_white=assets / "logo_white.png",
        formats=["square"],
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
    )
    return ProjectStore(cfg.projects_dir, cfg)


def _make_test_mp4(
    path: Path,
    *,
    duration_s: float = 2.0,
    with_audio: bool = True,
    size: str = "320x240",
) -> None:
    """Generate a short solid-color MP4 (optional sine audio) via ffmpeg."""
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"color=c=blue:s={size}:d={duration_s:.2f}",
    ]
    if with_audio:
        cmd.extend(["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration_s:.2f}"])
        cmd.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
    else:
        cmd.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"])
    cmd.append(str(path))
    subprocess.run(cmd, check=True, timeout=60)


def _make_test_wav(path: Path, *, duration_s: float = 1.5) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=880:duration={duration_s:.2f}",
        str(path),
    ]
    subprocess.run(cmd, check=True, timeout=30)


def test_stream_rotation_swaps_coded_landscape_to_portrait():
    assert _stream_rotation_deg({"tags": {"rotate": "-90"}}) % 360 == 270
    assert _stream_rotation_deg({"side_data_list": [{"rotation": -90}]}) % 360 == 270
    w, h = _rotated_frame_size(1920, 1080, _stream_rotation_deg({"tags": {"rotate": "90"}}))
    assert (w, h) == (1080, 1920)
    w2, h2 = _rotated_frame_size(1920, 1080, 0)
    assert (w2, h2) == (1920, 1080)


def test_probe_video_info_includes_format_and_fps(tmp_path: Path):
    src = tmp_path / "clip.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=True)
    info = probe_video_info(src)
    assert info.has_audio
    assert info.width == 320
    assert info.height == 240
    assert info.fps is not None and 20 <= info.fps <= 30
    assert info.container
    assert info.video_codec
    assert info.file_size_bytes and info.file_size_bytes > 100


def test_preview_proxy_needed_skips_small_h264():
    small = VideoInfo(
        duration_s=2.0,
        has_audio=True,
        width=720,
        height=405,
        fps=30,
        video_codec="H.264",
    )
    assert preview_proxy_needed(small) is False
    uhd = VideoInfo(
        duration_s=12.0,
        has_audio=True,
        width=3840,
        height=2160,
        fps=30,
        video_codec="H.265",
    )
    assert preview_proxy_needed(uhd) is True


def test_write_preview_proxy_downscales(tmp_path: Path):
    src = tmp_path / "uhd.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=True, size="1280x720")
    dst = tmp_path / "preview.mp4"
    write_preview_proxy(src, dst)
    assert dst.is_file() and dst.stat().st_size > 32
    out = probe_video_info(dst)
    assert out.width and out.height
    assert max(out.width, out.height) <= 720


def test_ensure_video_preview_stamps_small_source(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Preview"))
    src = tmp_path / "small.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=False)
    asset = store.add_asset(project.id, "small.mp4", src.read_bytes())
    updated, status = store.ensure_video_preview(project.id, asset.id)
    assert status == "ready"
    assert updated.processed_formats.get("preview") == updated.original_path


def test_ensure_video_preview_writes_proxy_for_large_source(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Preview"))
    src = tmp_path / "wide.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=False, size="1280x720")
    asset = store.add_asset(project.id, "wide.mp4", src.read_bytes())
    updated, status = store.ensure_video_preview(project.id, asset.id)
    assert status == "ready"
    rel = updated.processed_formats.get("preview")
    assert rel and rel.endswith("preview.mp4")
    path = store.resolve_asset_path(project.id, rel)
    assert path.is_file()
    out = probe_video_info(path)
    assert out.width and max(out.width, out.height or 0) <= 720


def test_add_asset_probes_video_metadata(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Probe"))
    src = tmp_path / "hd.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=True)
    asset = store.add_asset(project.id, "hd.mp4", src.read_bytes())
    assert asset.type.value == "video"
    assert asset.width == 320
    assert asset.height == 240
    assert asset.fps is not None
    assert asset.container
    assert asset.video_codec
    assert asset.has_audio is True
    assert asset.duration_s is not None and asset.duration_s >= 0.8


def test_upload_api_returns_video_probe_fields(tmp_path: Path):
    store = _store(tmp_path)
    app = create_app(cfg=store.cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)
    project = store.create_project(CreateProjectRequest(name="UploadProbe"))
    src = tmp_path / "up.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=False)
    with src.open("rb") as fh:
        r = client.post(
            f"/api/projects/{project.id}/assets",
            files={"file": ("up.mp4", fh, "video/mp4")},
        )
    assert r.status_code == 200, r.text
    asset = r.json()["asset"]
    assert asset["type"] == "video"
    assert asset["width"] == 320
    assert asset["height"] == 240
    assert asset["fps"] is not None
    assert asset["container"]
    assert asset["has_audio"] is False

    info = client.get(f"/api/projects/{project.id}/assets/{asset['id']}/video/info")
    assert info.status_code == 200
    body = info.json()
    assert body["fps"] is not None
    assert body["video_codec"]
    assert body["container"]


def test_atempo_chain_splits_extreme_factors():
    assert "atempo=2.0" in _atempo_chain(4.0)
    assert "atempo=0.5" in _atempo_chain(0.25)
    assert _atempo_chain(1.0) == ""


def test_edit_video_clip_and_mute(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=2.0, with_audio=True)
    info = probe_video_info(src)
    assert info.has_audio
    assert info.duration_s is not None and info.duration_s >= 1.8

    edit_video(src, dst, start_s=0.4, end_s=1.2, mute=True)
    assert dst.exists() and dst.stat().st_size > 100
    out = probe_video_info(dst)
    assert not out.has_audio
    assert out.duration_s is not None
    assert 0.5 <= out.duration_s <= 1.1
    # Original untouched
    assert probe_video_info(src).has_audio


def test_edit_video_speed_up(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "fast.mp4"
    _make_test_mp4(src, duration_s=2.0, with_audio=True)
    edit_video(src, dst, speed=2.0)
    out = probe_video_info(dst)
    assert out.duration_s is not None
    assert 0.7 <= out.duration_s <= 1.3
    assert out.has_audio


def test_edit_video_add_audio(tmp_path: Path):
    src = tmp_path / "silent.mp4"
    audio = tmp_path / "bed.wav"
    dst = tmp_path / "mixed.mp4"
    _make_test_mp4(src, duration_s=1.5, with_audio=False)
    _make_test_wav(audio, duration_s=2.0)
    assert not probe_video_info(src).has_audio
    edit_video(src, dst, audio_path=audio)
    out = probe_video_info(dst)
    assert out.has_audio
    assert out.duration_s is not None and out.duration_s <= 1.8


def test_edit_video_rejects_mute_and_audio(tmp_path: Path):
    src = tmp_path / "src.mp4"
    audio = tmp_path / "a.wav"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=1.0)
    _make_test_wav(audio)
    with pytest.raises(VideoEditError):
        edit_video(src, dst, mute=True, audio_path=audio)


def test_video_edit_api_creates_new_asset(tmp_path: Path):
    store = _store(tmp_path)
    cfg = store.cfg
    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    project = store.create_project(CreateProjectRequest(name="VE"))
    src_file = tmp_path / "clip.mp4"
    _make_test_mp4(src_file, duration_s=2.0, with_audio=True)
    source = store.add_asset(project.id, "clip.mp4", src_file.read_bytes())
    source_path = store.resolve_asset_path(project.id, source.original_path)
    source_bytes = source_path.read_bytes()

    # Identity edit rejected
    bad = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/video/edit",
        json={},
    )
    assert bad.status_code == 400

    ok = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/video/edit",
        json={"start_s": 0.2, "end_s": 1.0, "mute": True, "name": "Silent clip"},
    )
    assert ok.status_code == 200, ok.text
    data = ok.json()
    assert data["source_asset_id"] == source.id
    assert data["asset"]["id"] != source.id
    assert data["asset"]["name"] == "Silent clip"
    assert data["asset"]["type"] == "video"
    assert data["has_audio"] is False

    # Original bytes unchanged
    assert source_path.read_bytes() == source_bytes
    project2 = store.get_project(project.id)
    assert len([a for a in project2.assets if a.type.value == "video"]) == 2

    info = client.get(f"/api/projects/{project.id}/assets/{source.id}/video/info")
    assert info.status_code == 200
    assert info.json()["has_audio"] is True


def test_edit_video_remove_ranges_concat(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=3.0, with_audio=True)
    # Cut out the middle second → keep ~0–1 + ~2–3 ≈ 2s
    edit_video(src, dst, remove_ranges=[(1.0, 2.0)])
    out = probe_video_info(dst)
    assert out.duration_s is not None
    assert 1.7 <= out.duration_s <= 2.4
    assert out.has_audio is True


def test_edit_video_aspect_square(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=False)
    # 320×240 → center-crop to 1:1 then scale to 1080×1080
    edit_video(src, dst, aspect_ratio="square", mute=True)
    out = probe_video_info(dst)
    assert out.width == 1080
    assert out.height == 1080


def test_edit_video_aspect_with_cuts(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=3.0, with_audio=True)
    edit_video(src, dst, remove_ranges=[(1.0, 2.0)], aspect_ratio="portrait")
    out = probe_video_info(dst)
    assert out.width == 1080
    assert out.height == 1350
    assert out.duration_s is not None
    assert 1.7 <= out.duration_s <= 2.4


def test_edit_video_rotate_90(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=False)
    edit_video(src, dst, rotate_deg=90, mute=True)
    out = probe_video_info(dst)
    # Keep original canvas (320×240); rotated content is letterboxed inside.
    assert out.width == 320
    assert out.height == 240


def test_edit_video_rotate_90_with_crop_swaps_then_crops(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=False)
    # Explicit crop is in post-rotate pixels (240×320 after 90°).
    edit_video(
        src,
        dst,
        rotate_deg=90,
        aspect_ratio="custom",
        crop=(20, 40, 200, 200),
        mute=True,
    )
    out = probe_video_info(dst)
    assert out.width == 200
    assert out.height == 200


def test_edit_video_explicit_crop(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=False)
    # Crop a 160×120 region from 320×240, custom keeps size (even)
    edit_video(src, dst, aspect_ratio="custom", crop=(40, 30, 160, 120), mute=True)
    out = probe_video_info(dst)
    assert out.width == 160
    assert out.height == 120


def test_edit_video_crop_offset_preset(tmp_path: Path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_test_mp4(src, duration_s=1.0, with_audio=False)
    # Off-center square crop then scale to Instagram square
    edit_video(src, dst, aspect_ratio="square", crop=(40, 0, 240, 240), mute=True)
    out = probe_video_info(dst)
    assert out.width == 1080
    assert out.height == 1080


def test_video_edit_api_rotate_and_crop(tmp_path: Path):
    store = _store(tmp_path)
    app = create_app(cfg=store.cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    project = store.create_project(CreateProjectRequest(name="Geo"))
    src_file = tmp_path / "clip.mp4"
    _make_test_mp4(src_file, duration_s=1.0, with_audio=True)
    source = store.add_asset(project.id, "clip.mp4", src_file.read_bytes())

    ok = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/video/edit",
        json={
            "name": "Rotated crop",
            "rotate_deg": 90,
            "aspect_ratio": "custom",
            "crop_x": 10,
            "crop_y": 20,
            "crop_w": 200,
            "crop_h": 200,
        },
    )
    assert ok.status_code == 200, ok.text
    info = client.get(
        f"/api/projects/{project.id}/assets/{ok.json()['asset']['id']}/video/info"
    )
    assert info.status_code == 200
    body = info.json()
    assert body["width"] == 200
    assert body["height"] == 200

    bad = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/video/edit",
        json={"crop_x": 0, "crop_w": 100},
    )
    assert bad.status_code == 400


def test_video_edit_api_aspect_ratio(tmp_path: Path):
    store = _store(tmp_path)
    app = create_app(cfg=store.cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    project = store.create_project(CreateProjectRequest(name="Aspect"))
    src_file = tmp_path / "clip.mp4"
    _make_test_mp4(src_file, duration_s=1.0, with_audio=True)
    source = store.add_asset(project.id, "clip.mp4", src_file.read_bytes())

    ok = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/video/edit",
        json={"name": "Square crop", "aspect_ratio": "square"},
    )
    assert ok.status_code == 200, ok.text
    data = ok.json()
    assert data["asset"]["name"] == "Square crop"
    info = client.get(f"/api/projects/{project.id}/assets/{data['asset']['id']}/video/info")
    assert info.status_code == 200
    body = info.json()
    assert body["width"] == 1080
    assert body["height"] == 1080


def test_video_edit_api_overwrite_edited_asset(tmp_path: Path):
    store = _store(tmp_path)
    app = create_app(cfg=store.cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    project = store.create_project(CreateProjectRequest(name="Overwrite"))
    src_file = tmp_path / "clip.mp4"
    _make_test_mp4(src_file, duration_s=2.0, with_audio=True)
    source = store.add_asset(project.id, "clip.mp4", src_file.read_bytes())

    # First edit creates a new edited asset
    created = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/video/edit",
        json={"name": "Working edit", "start_s": 0.2, "end_s": 1.5, "mute": True},
    )
    assert created.status_code == 200, created.text
    edited_id = created.json()["asset"]["id"]
    assert edited_id != source.id
    assert created.json()["overwritten"] is False

    before = store.get_project(project.id)
    video_count_before = len([a for a in before.assets if a.type.value == "video"])

    # Overwrite rejected on original (not in Edited videos group)
    bad = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/video/edit",
        json={"start_s": 0.1, "end_s": 0.8, "overwrite": True},
    )
    assert bad.status_code == 400

    # Overwrite succeeds on the edited asset — same id, no new video
    ok = client.post(
        f"/api/projects/{project.id}/assets/{edited_id}/video/edit",
        json={
            "name": "Working edit",
            "start_s": 0.0,
            "end_s": 0.9,
            "mute": True,
            "overwrite": True,
        },
    )
    assert ok.status_code == 200, ok.text
    data = ok.json()
    assert data["overwritten"] is True
    assert data["asset"]["id"] == edited_id
    assert data["asset"]["name"] == "Working edit"

    after = store.get_project(project.id)
    video_count_after = len([a for a in after.assets if a.type.value == "video"])
    assert video_count_after == video_count_before

    info = client.get(f"/api/projects/{project.id}/assets/{edited_id}/video/info")
    assert info.status_code == 200
    assert info.json()["duration_s"] is not None
    assert float(info.json()["duration_s"]) <= 1.2


def test_video_edit_api_remove_ranges(tmp_path: Path):
    store = _store(tmp_path)
    app = create_app(cfg=store.cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    project = store.create_project(CreateProjectRequest(name="Cuts"))
    src_file = tmp_path / "clip.mp4"
    _make_test_mp4(src_file, duration_s=3.0, with_audio=True)
    source = store.add_asset(project.id, "clip.mp4", src_file.read_bytes())

    ok = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/video/edit",
        json={
            "name": "Without middle",
            "remove_ranges": [{"start_s": 1.0, "end_s": 2.0}],
        },
    )
    assert ok.status_code == 200, ok.text
    data = ok.json()
    assert data["asset"]["name"] == "Without middle"
    assert data["duration_s"] is not None
    assert 1.7 <= float(data["duration_s"]) <= 2.4


def test_video_edit_api_replace_audio(tmp_path: Path):
    store = _store(tmp_path)
    app = create_app(cfg=store.cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    project = store.create_project(CreateProjectRequest(name="AudioReplace"))
    vid = tmp_path / "v.mp4"
    wav = tmp_path / "a.wav"
    _make_test_mp4(vid, duration_s=1.2, with_audio=False)
    _make_test_wav(wav, duration_s=1.0)
    video_asset = store.add_asset(project.id, "v.mp4", vid.read_bytes())
    audio_asset = store.add_asset(project.id, "a.wav", wav.read_bytes())

    r = client.post(
        f"/api/projects/{project.id}/assets/{video_asset.id}/video/edit",
        json={"audio_asset_id": audio_asset.id, "name": "With bed"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["has_audio"] is True
    assert r.json()["asset"]["name"] == "With bed"
