"""Tests for ComfyUI / Wan text-to-video integration."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from content_sprout.comfyui import (
    default_workflow_path,
    load_workflow,
    patch_workflow,
    snap_wan_frames,
)
from content_sprout.config import AppConfig, comfyui_ready, load, save_comfyui_settings, write_config


def test_snap_wan_frames():
    assert snap_wan_frames(1) == 1
    assert snap_wan_frames(33) == 33
    assert snap_wan_frames(34) == 33
    assert snap_wan_frames(35) == 33
    assert snap_wan_frames(37) == 37


def test_default_workflow_loads():
    path = default_workflow_path()
    assert path.is_file()
    wf = load_workflow(path)
    assert any(n.get("class_type") == "UNETLoader" for n in wf.values())
    assert any(n.get("class_type") == "EmptyHunyuanLatentVideo" for n in wf.values())
    assert any(n.get("class_type") == "SaveVideo" for n in wf.values())


def test_patch_workflow_sets_prompt_and_size():
    wf = load_workflow(default_workflow_path())
    patched = patch_workflow(
        wf,
        prompt="a red balloon floating over a lake",
        negative_prompt="blurry",
        width=480,
        height=832,
        frames=17,
        fps=16,
        steps=20,
        cfg=5.5,
        seed=42,
        diffusion_model="wan2.1_t2v_1.3B_fp16.safetensors",
        clip_name="umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        vae_name="wan_2.1_vae.safetensors",
    )
    texts = [
        n["inputs"]["text"]
        for n in patched.values()
        if n.get("class_type") == "CLIPTextEncode"
    ]
    assert "a red balloon floating over a lake" in texts
    assert "blurry" in texts

    latent = next(n for n in patched.values() if n.get("class_type") == "EmptyHunyuanLatentVideo")
    assert latent["inputs"]["width"] == 480
    assert latent["inputs"]["height"] == 832
    assert latent["inputs"]["length"] == 17

    sampler = next(n for n in patched.values() if n.get("class_type") == "KSampler")
    assert sampler["inputs"]["seed"] == 42
    assert sampler["inputs"]["steps"] == 20
    assert sampler["inputs"]["cfg"] == 5.5


def test_save_comfyui_settings(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    write_config(config_path, AppConfig())
    saved = save_comfyui_settings(
        config_path,
        {
            "enabled": True,
            "base_url": "http://127.0.0.1:8188",
            "diffusion_model": "wan2.1_t2v_14B_fp16.safetensors",
            "width": 640,
            "height": 640,
            "frames": 25,
        },
    )
    assert saved.enabled is True
    assert saved.provider == "local"
    assert saved.diffusion_model == "wan2.1_t2v_14B_fp16.safetensors"
    assert saved.width == 640
    reloaded = load(config_path)
    assert comfyui_ready(reloaded)
    assert reloaded.comfyui.frames == 25
    assert reloaded.comfyui.provider == "local"


def test_comfyui_client_generate_video_mocked():
    from content_sprout.comfyui import ComfyUIClient
    from content_sprout.config import ComfyUIConfig

    cfg = ComfyUIConfig(enabled=True, base_url="http://127.0.0.1:8188", timeout_s=30)
    client = ComfyUIClient(cfg)
    fake_mp4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32

    class FakeResponse:
        def __init__(self, status_code=200, payload=None, content=b""):
            self.status_code = status_code
            self._payload = payload
            self.content = content
            self.text = json.dumps(payload) if payload is not None else ""

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self._calls = 0

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, json=None, headers=None):
            assert url.endswith("/prompt")
            assert "prompt" in json
            return FakeResponse(200, {"prompt_id": "abc-123"})

        def get(self, url, params=None, headers=None):
            if "/history/" in url:
                self._calls += 1
                if self._calls < 2:
                    return FakeResponse(200, {})
                return FakeResponse(
                    200,
                    {
                        "abc-123": {
                            "outputs": {
                                "50": {
                                    "videos": [
                                        {
                                            "filename": "wan_00001_.mp4",
                                            "subfolder": "content_sprout",
                                            "type": "output",
                                        }
                                    ]
                                }
                            }
                        }
                    },
                )
            if url.endswith("/view"):
                assert params["filename"] == "wan_00001_.mp4"
                return FakeResponse(200, content=fake_mp4)
            raise AssertionError(url)

    with patch("content_sprout.comfyui.httpx.Client", FakeClient):
        data = client.generate_video("sunset over the ocean")
    assert data == fake_mp4


def test_begin_and_finalize_generated_video(tmp_path: Path):
    from content_sprout.config import AppConfig
    from content_sprout.models import AssetStatus, CreateProjectRequest
    from content_sprout.projects import ProjectStore

    cfg = AppConfig(projects_dir=tmp_path / "projects", cache_dir=tmp_path / "cache")
    cfg.projects_dir.mkdir()
    cfg.cache_dir.mkdir()
    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="VidGen"))
    asset = store.begin_generated_video(project.id, name="Clip", filename="clip.mp4")
    assert asset.status == AssetStatus.PROCESSING
    done = store.finalize_generated_video(project.id, asset.id, b"fake-video-bytes")
    assert done.status == AssetStatus.READY
    path = store.resolve_asset_path(project.id, done.original_path)
    assert path.read_bytes() == b"fake-video-bytes"
