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
from content_sprout.video_edit import VideoEditError, _atempo_chain, edit_video, probe_video_info
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


def _make_test_mp4(path: Path, *, duration_s: float = 2.0, with_audio: bool = True) -> None:
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
        f"color=c=blue:s=320x240:d={duration_s:.2f}",
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
