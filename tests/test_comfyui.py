"""Tests for ComfyUI media generation integration."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from content_sprout.comfyui import (
    apply_workflow_inputs,
    default_node_title,
    export_workflow_bundle,
    import_workflow_bundle,
    is_ui_workflow,
    list_workflow_inputs,
    load_workflow_from_data,
    merge_workflow_input_config,
    patch_workflow,
    resolve_named_workflow,
    resolve_workflow_for_op,
    save_workflow_upload,
    settings_defaults_for_op,
    snap_wan_frames,
    workflow_inputs_for_op,
)
from content_sprout.config import AppConfig, ComfyUIConfig, comfyui_ready, load, save_comfyui_settings, write_config

# Minimal API-format graph for unit tests (not a real ComfyUI workflow).
SAMPLE_API_WORKFLOW = {
    "1": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "positive", "clip": ["0", 0]},
    },
    "2": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "negative", "clip": ["0", 0]},
    },
    "3": {
        "class_type": "EmptyHunyuanLatentVideo",
        "inputs": {"width": 640, "height": 360, "length": 33, "batch_size": 1},
    },
    "4": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 0,
            "steps": 30,
            "cfg": 6.0,
            "sampler_name": "uni_pc",
            "scheduler": "simple",
            "denoise": 1.0,
            "model": ["0", 0],
            "positive": ["1", 0],
            "negative": ["2", 0],
            "latent_image": ["3", 0],
        },
    },
    "5": {
        "class_type": "SaveVideo",
        "inputs": {"filename_prefix": "content_sprout", "images": ["4", 0]},
    },
}


def test_snap_wan_frames():
    assert snap_wan_frames(1) == 1
    assert snap_wan_frames(33) == 33
    assert snap_wan_frames(34) == 33
    assert snap_wan_frames(35) == 33
    assert snap_wan_frames(37) == 37


def test_patch_workflow_sets_prompt_and_size():
    wf = load_workflow_from_data(json.loads(json.dumps(SAMPLE_API_WORKFLOW)))
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
            "workflow_image_to_video": "wan22_i2v",
            "frames": 25,
        },
    )
    assert saved.enabled is True
    assert saved.provider == "local"
    assert saved.workflow_image_to_video == "wan22_i2v"
    assert saved.frames == 25
    reloaded = load(config_path)
    assert comfyui_ready(reloaded)
    assert reloaded.comfyui.frames == 25
    assert reloaded.comfyui.provider == "local"


def test_reject_ui_workflow_upload(tmp_path: Path):
    cfg = ComfyUIConfig()
    ui_format = {
        "nodes": [{"id": 1}],
        "links": [],
    }
    with pytest.raises(ValueError, match="editor format"):
        save_workflow_upload(
            cfg,
            config_dir=tmp_path,
            filename="ui_workflow.json",
            raw_bytes=json.dumps(ui_format).encode("utf-8"),
        )


def test_save_api_workflow_upload(tmp_path: Path):
    cfg = ComfyUIConfig()
    api_format = SAMPLE_API_WORKFLOW
    saved = save_workflow_upload(
        cfg,
        config_dir=tmp_path,
        filename="custom_t2v.json",
        raw_bytes=json.dumps(api_format).encode("utf-8"),
    )
    assert saved["stem"] == "custom_t2v"
    stored = tmp_path / "tools" / "comfyui" / "workflows" / "custom_t2v.json"
    assert stored.is_file()
    assert not is_ui_workflow(api_format)


def test_resolve_named_workflow_uses_internal_storage_only(tmp_path: Path):
    cfg = ComfyUIConfig()
    external = tmp_path / "external_wan.json"
    external.write_text("{}", encoding="utf-8")
    internal_dir = tmp_path / "tools" / "comfyui" / "workflows"
    internal_dir.mkdir(parents=True)
    internal = internal_dir / "wan_i2v.json"
    internal.write_text(json.dumps(SAMPLE_API_WORKFLOW), encoding="utf-8")

    resolved = resolve_named_workflow(cfg, "wan_i2v", config_dir=tmp_path)
    assert resolved == internal

    with pytest.raises(FileNotFoundError):
        resolve_named_workflow(cfg, str(external), config_dir=tmp_path)


def test_migrate_legacy_workflows_into_tools_storage(tmp_path: Path):
    from content_sprout.comfyui import resolve_workflows_dir

    cfg = ComfyUIConfig()
    legacy = tmp_path / "workflows"
    legacy.mkdir()
    (legacy / "legacy_t2i.json").write_text(json.dumps(SAMPLE_API_WORKFLOW), encoding="utf-8")
    dest = resolve_workflows_dir(cfg, config_dir=tmp_path)
    assert dest == tmp_path / "tools" / "comfyui" / "workflows"
    assert (dest / "legacy_t2i.json").is_file()
    resolved = resolve_named_workflow(cfg, "legacy_t2i", config_dir=tmp_path)
    assert resolved == dest / "legacy_t2i.json"


def test_text_to_video_requires_configured_workflow():
    cfg = ComfyUIConfig()
    with pytest.raises(ValueError, match="Text → video"):
        resolve_workflow_for_op(cfg, "text_to_video")


def test_package_default_used_when_unassigned(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from content_sprout import comfyui as comfyui_mod

    package = tmp_path / "package_workflows"
    package.mkdir()
    (package / "text_to_video.json").write_text(json.dumps(SAMPLE_API_WORKFLOW), encoding="utf-8")
    monkeypatch.setattr(comfyui_mod, "PACKAGE_WORKFLOWS_DIR", package)
    monkeypatch.setattr(
        comfyui_mod,
        "PACKAGE_CATALOG_PATH",
        package / "catalog.json",
    )
    (package / "catalog.json").write_text(
        json.dumps(
            {
                "version": 1,
                "defaults": {"text_to_video": "text_to_video"},
                "workflows": {
                    "text_to_video": {
                        "title": "T2V",
                        "ops": ["text_to_video"],
                        "models": [
                            {
                                "filename": "demo.safetensors",
                                "role": "unet",
                                "notes": "demo",
                            }
                        ],
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    cfg = ComfyUIConfig()
    path = resolve_workflow_for_op(cfg, "text_to_video", config_dir=tmp_path)
    assert path == package / "text_to_video.json"

    from content_sprout.comfyui import list_stored_workflows, workflow_details

    listed = list_stored_workflows(cfg, config_dir=tmp_path)
    entry = next(w for w in listed if w["stem"] == "text_to_video")
    assert entry["available"] is True
    assert entry["title"] == "T2V"
    assert any(m["filename"] == "demo.safetensors" for m in entry["models"])

    details = workflow_details(cfg, "text_to_video", config_dir=tmp_path)
    assert details["graph"]["nodes"]
    assert details["available"] is True


def test_extract_model_requirements_from_loaders():
    from content_sprout.comfyui import extract_model_requirements, build_workflow_graph

    wf = {
        "1": {
            "class_type": "UNETLoader",
            "_meta": {"title": "Wan UNET"},
            "inputs": {"unet_name": "wan2.1_t2v_1.3B_fp16.safetensors", "weight_dtype": "default"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"},
        },
        "3": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "wan_2.1_vae.safetensors"},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "hello", "clip": ["2", 0]},
        },
    }
    models = extract_model_requirements(wf)
    names = {m["filename"] for m in models}
    assert "wan2.1_t2v_1.3B_fp16.safetensors" in names
    assert "umt5_xxl_fp8_e4m3fn_scaled.safetensors" in names
    assert "wan_2.1_vae.safetensors" in names
    roles = {m["filename"]: m["role"] for m in models}
    assert roles["wan2.1_t2v_1.3B_fp16.safetensors"] == "unet"

    graph = build_workflow_graph(wf)
    assert len(graph["nodes"]) == 4
    assert any(e["from"] == "2" and e["to"] == "4" for e in graph["edges"])
    loader = next(n for n in graph["nodes"] if n["id"] == "1")
    assert loader["is_model_loader"] is True


def test_no_builtin_wan21_workflow():
    from content_sprout.comfyui import PACKAGE_CATALOG_PATH, PACKAGE_WORKFLOWS_DIR

    assert not (PACKAGE_WORKFLOWS_DIR / "wan21_t2v_api.json").exists()
    assert PACKAGE_CATALOG_PATH.is_file()

def test_comfyui_client_generate_video_mocked(tmp_path: Path):
    from content_sprout.comfyui import ComfyUIClient
    from content_sprout.config import ComfyUIConfig

    workflows = tmp_path / "tools" / "comfyui" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "custom_t2v.json").write_text(json.dumps(SAMPLE_API_WORKFLOW), encoding="utf-8")

    cfg = ComfyUIConfig(
        enabled=True,
        base_url="http://127.0.0.1:8188",
        timeout_s=30,
        workflow_text_to_video="custom_t2v",
    )
    client = ComfyUIClient(cfg, config_dir=tmp_path)
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


def test_default_node_title_humanizes():
    assert default_node_title("CLIPTextEncode") == "CLIP Text Encode"
    assert default_node_title("Empty_Latent_Image") == "Empty Latent Image"


def test_list_workflow_inputs_all_primitives():
    wf = {
        "1": {
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIP Text Encode"},
            "inputs": {"text": "default titled", "clip": ["0", 0]},
        },
        "2": {
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "Positive Prompt"},
            "inputs": {"text": "hello world", "clip": ["0", 0]},
        },
        "3": {
            "class_type": "KSampler",
            "_meta": {"title": "My Sampler"},
            "inputs": {
                "seed": 7,
                "steps": 20,
                "cfg": 5.5,
                "model": ["0", 0],
                "positive": ["2", 0],
            },
        },
    }
    fields = list_workflow_inputs(wf)
    ids = {f["id"] for f in fields}
    # All primitive fields, including default-titled nodes
    assert "1.text" in ids
    assert "2.text" in ids
    assert "3.seed" in ids
    assert "3.steps" in ids
    assert "3.cfg" in ids
    # Links are skipped
    assert "1.clip" not in ids
    assert "3.model" not in ids
    assert "3.positive" not in ids
    pos = next(f for f in fields if f["id"] == "2.text")
    assert pos["default"] == "hello world"
    assert pos["type"] == "string"


def test_apply_workflow_inputs_after_patch():
    wf = load_workflow_from_data(json.loads(json.dumps(SAMPLE_API_WORKFLOW)))
    wf["1"]["_meta"] = {"title": "Positive Prompt"}
    patched = patch_workflow(wf, prompt="from patch", seed=1, steps=10)
    assert patched["1"]["inputs"]["text"] == "from patch"
    final = apply_workflow_inputs(patched, {"1.text": "from override"})
    assert final["1"]["inputs"]["text"] == "from override"
    assert final["4"]["inputs"]["steps"] == 10


def test_workflow_inputs_for_op_only_enabled(tmp_path: Path):
    workflows = tmp_path / "tools" / "comfyui" / "workflows"
    workflows.mkdir(parents=True)
    wf = {
        "9": {
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "Scene Prompt"},
            "inputs": {"text": "from json", "clip": ["0", 0]},
        },
        "10": {
            "class_type": "KSampler",
            "inputs": {"seed": 1, "steps": 12, "model": ["0", 0]},
        },
    }
    (workflows / "custom_t2i.json").write_text(json.dumps(wf), encoding="utf-8")
    cfg = ComfyUIConfig(
        workflow_text_to_image="custom_t2i",
        workflow_input_config={
            "text_to_image": {
                "9.text": {"enabled": True, "default": "from settings"},
                "10.steps": {"enabled": False, "default": 99},
            }
        },
    )
    fields = workflow_inputs_for_op(cfg, "text_to_image", config_dir=tmp_path)
    assert len(fields) == 1
    assert fields[0]["id"] == "9.text"
    assert fields[0]["default"] == "from settings"
    assert fields[0]["enabled"] is True

    annotated = merge_workflow_input_config(
        list_workflow_inputs(wf),
        cfg.workflow_input_config["text_to_image"],
    )
    assert any(f["id"] == "10.steps" and not f["enabled"] for f in annotated)
    assert settings_defaults_for_op(cfg, "text_to_image") == {"9.text": "from settings"}


def test_save_comfyui_workflow_input_config(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    write_config(config_path, AppConfig())
    saved = save_comfyui_settings(
        config_path,
        {
            "workflow_input_config": {
                "text_to_video": {
                    "2.text": {"enabled": True, "default": "night sky"},
                },
            }
        },
    )
    assert saved.workflow_input_config["text_to_video"]["2.text"]["default"] == "night sky"
    reloaded = load(config_path)
    assert (
        reloaded.comfyui.workflow_input_config["text_to_video"]["2.text"]["enabled"] is True
    )


def test_migrate_legacy_workflow_input_defaults():
    cfg = ComfyUIConfig(
        workflow_input_defaults={"text_to_image": {"1.text": "legacy"}},
    )
    assert cfg.workflow_input_config["text_to_image"]["1.text"]["enabled"] is True
    assert cfg.workflow_input_config["text_to_image"]["1.text"]["default"] == "legacy"


def test_export_import_workflow_bundle_roundtrip(tmp_path: Path):
    import zipfile
    from io import BytesIO

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    cfg = ComfyUIConfig(
        workflow_text_to_image="custom_t2i",
        workflow_text_to_video="custom_t2v",
        frames=41,
        fps=24.0,
        steps=18,
        cfg=7.5,
        workflow_input_config={
            "text_to_image": {"1.text": {"enabled": True, "default": "portrait"}},
        },
        negative_prompt="blurry",
    )
    save_workflow_upload(
        cfg,
        config_dir=source,
        filename="custom_t2i.json",
        raw_bytes=json.dumps(SAMPLE_API_WORKFLOW).encode("utf-8"),
    )
    save_workflow_upload(
        cfg,
        config_dir=source,
        filename="custom_t2v.json",
        raw_bytes=json.dumps(SAMPLE_API_WORKFLOW).encode("utf-8"),
    )

    blob = export_workflow_bundle(cfg, config_dir=source)
    with zipfile.ZipFile(BytesIO(blob)) as zf:
        names = set(zf.namelist())
        assert "manifest.json" in names
        assert "workflows/custom_t2i.json" in names
        assert "workflows/custom_t2v.json" in names
        manifest = json.loads(zf.read("manifest.json"))
        assert manifest["kind"] == "content_sprout_comfyui_workflow_bundle"
        assert manifest["settings"]["workflow_text_to_image"] == "custom_t2i"
        assert manifest["settings"]["frames"] == 41

    empty = ComfyUIConfig()
    updates, imported = import_workflow_bundle(
        empty,
        config_dir=target,
        raw_bytes=blob,
    )
    assert {e["stem"] for e in imported} == {"custom_t2i", "custom_t2v"}
    assert updates["workflow_text_to_image"] == "custom_t2i"
    assert updates["workflow_text_to_video"] == "custom_t2v"
    assert updates["frames"] == 41
    assert updates["fps"] == 24.0
    assert updates["steps"] == 18
    assert updates["cfg"] == 7.5
    assert updates["negative_prompt"] == "blurry"
    assert updates["workflow_input_config"]["text_to_image"]["1.text"]["default"] == "portrait"
    stored = target / "tools" / "comfyui" / "workflows"
    assert (stored / "custom_t2i.json").is_file()
    assert (stored / "custom_t2v.json").is_file()


def test_import_workflow_bundle_rejects_bad_zip(tmp_path: Path):
    with pytest.raises(ValueError, match="not a valid zip"):
        import_workflow_bundle(
            ComfyUIConfig(),
            config_dir=tmp_path,
            raw_bytes=b"not-a-zip",
        )
