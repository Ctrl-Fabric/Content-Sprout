"""Tests for photo ops, layout validation, image-gen config, and AI APIs."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock

from PIL import Image
from fastapi.testclient import TestClient

from content_sprout.ai_layout import prune_unreferenced_media_layers, validate_proposed_post
from content_sprout.config import (
    AppConfig,
    ImageGenConfig,
    LlmProviderConfig,
    image_gen_ready,
    load,
    save_image_gen_settings,
    vision_llm_ready,
)
from content_sprout.models import CreatePostRequest, CreateProjectRequest, Post, ProjectType
from content_sprout.photo_ops import apply_photo_ops, image_to_jpeg_bytes
from content_sprout.projects import ProjectStore
from content_sprout.web import create_app


def _store(tmp_path: Path) -> ProjectStore:
    from content_sprout.config import RouterConfig

    assets = tmp_path / "assets"
    assets.mkdir(exist_ok=True)
    Image.new("RGBA", (40, 20), (0, 0, 0, 255)).save(assets / "logo_dark.png")
    Image.new("RGBA", (40, 20), (255, 255, 255, 255)).save(assets / "logo_white.png")
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        logo_dark=assets / "logo_dark.png",
        logo_white=assets / "logo_white.png",
        formats=["square", "portrait"],
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
        llm=LlmProviderConfig(provider="ollama"),
    )
    return ProjectStore(cfg.projects_dir, cfg)


def test_apply_photo_ops_brightness_and_crop():
    img = Image.new("RGB", (100, 100), (128, 128, 128))
    out, logo = apply_photo_ops(
        img,
        [
            {"op": "brightness", "value": 1.2},
            {"op": "crop", "box": [0.1, 0.1, 0.9, 0.9]},
            {"op": "apply_logo", "value": False},
        ],
    )
    assert out.size == (80, 80)
    assert logo is False
    assert len(image_to_jpeg_bytes(out)) > 100


def test_validate_proposed_post_rejects_bad_asset_and_locks_id(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="AI"))
    post = store.create_post(project.id, CreatePostRequest(name="P", type=ProjectType.IMAGE))
    project = store.get_project(project.id)

    proposed = post.model_dump()
    proposed["id"] = "hijacked"
    proposed["background_asset_id"] = "missing-asset"
    proposed["layers"] = [
        {
            "id": "layer1",
            "type": "text",
            "x": 10,
            "y": 10,
            "width": 40,
            "height": 20,
            "text": "Hello",
            "asset_id": "also-missing",
        }
    ]
    fixed = validate_proposed_post(proposed, project=project, current=post)
    assert fixed.id == post.id
    assert fixed.background_asset_id is None or fixed.background_asset_id == post.background_asset_id
    assert fixed.layers[0].asset_id is None


def test_save_image_gen_settings_and_ready_flags(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    ig = save_image_gen_settings(
        config_path,
        {
            "enabled": True,
            "api_key": "ig-secret",
            "model": "gpt-image-1",
            "base_url": "https://api.example.com/v1",
        },
    )
    assert ig.enabled is True
    assert ig.provider == "proxy"
    assert ig.api_key == "ig-secret"
    reloaded = load(config_path)
    assert image_gen_ready(reloaded) is True

    # blank key keeps existing
    ig2 = save_image_gen_settings(config_path, {"model": "other-model"})
    assert ig2.api_key == "ig-secret"
    assert ig2.model == "other-model"

    cfg_h = AppConfig(llm=LlmProviderConfig(provider="heuristic_only"))
    assert vision_llm_ready(cfg_h) is False
    assert image_gen_ready(
        AppConfig(image_gen=ImageGenConfig(provider="proxy", api_key="", base_url="https://x", model="m"))
    ) is False
    assert image_gen_ready(
        AppConfig(image_gen=ImageGenConfig(provider="local", api_key="", base_url="http://127.0.0.1:8080/v1", model="m"))
    ) is True


def test_ai_capabilities_and_layout_with_mock(tmp_path: Path, monkeypatch):
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="ollama"),
    )
    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)
    config_path = tmp_path / "config.yaml"

    app = create_app(cfg=cfg, config_path=config_path)
    client = TestClient(app)

    caps = client.get("/api/ai/capabilities").json()
    assert caps["vision_llm"] is True
    assert caps["layout_edit"] is True
    assert caps["script_generate"] is True
    assert caps["image_gen"] is False

    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="Demo"))
    post = store.create_post(project.id, CreatePostRequest(name="Post", type=ProjectType.IMAGE))

    proposed = post.model_dump()
    proposed["layers"] = [
        {
            "id": "abc123def456",
            "type": "text",
            "x": 12,
            "y": 15,
            "width": 60,
            "height": 20,
            "text": "Improved",
            "font_size": 56,
            "color": "#ffffff",
            "font_weight": "bold",
            "z_index": 1,
        }
    ]

    mock_client = MagicMock()
    mock_client.complete_json.return_value = {
        "summary": "Moved text",
        "post": proposed,
    }
    monkeypatch.setattr(
        "content_sprout.llm.factory.create_json_client",
        lambda _cfg: mock_client,
    )

    r = client.post(
        f"/api/projects/{project.id}/posts/{post.id}/ai/layout",
        json={"instruction": "Make headline bigger", "apply": False, "include_preview": False},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied"] is False
    assert body["post"]["layers"][0]["text"] == "Improved"

    r2 = client.post(
        f"/api/projects/{project.id}/posts/{post.id}/ai/layout",
        json={"instruction": "Apply it", "apply": True, "include_preview": False},
    )
    assert r2.status_code == 200
    assert r2.json()["applied"] is True
    saved = store.get_post(project.id, post.id)
    assert saved.layers[0].text == "Improved"


def test_ai_photo_edit_local_ops_with_mock(tmp_path: Path, monkeypatch):
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="ollama"),
        formats=["square", "portrait"],
    )
    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)
    config_path = tmp_path / "config.yaml"
    app = create_app(cfg=cfg, config_path=config_path)
    client = TestClient(app)

    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="Photos"))
    post = store.create_post(project.id, CreatePostRequest(name="P", type=ProjectType.IMAGE))
    buf = BytesIO()
    Image.new("RGB", (200, 200), (90, 100, 110)).save(buf, format="JPEG")
    asset = store.add_asset(project.id, "bg.jpg", buf.getvalue(), apply_logo=False)
    post.background_asset_id = asset.id
    store.update_post(project.id, post.id, post)

    mock_client = MagicMock()
    mock_client.complete_json.return_value = {
        "summary": "Brightened",
        "ops": [{"op": "brightness", "value": 1.1}],
    }
    monkeypatch.setattr(
        "content_sprout.llm.factory.create_json_client",
        lambda _cfg: mock_client,
    )
    # Skip heavy processing in background
    monkeypatch.setattr(
        "content_sprout.projects.ProjectStore.process_asset",
        lambda self, pid, aid: self.get_asset(pid, aid),
    )

    r = client.post(
        f"/api/projects/{project.id}/posts/{post.id}/ai/photo-edit",
        json={
            "instruction": "Brighten a bit",
            "use_background": True,
            "use_local_ops": True,
            "use_generative": False,
            "set_as_background": True,
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["asset"]["id"] != asset.id
    assert "(AI edit)" in data["asset"]["name"]
    updated = store.get_post(project.id, post.id)
    assert updated.background_asset_id == data["asset"]["id"]


def test_ai_suggest_with_mock(tmp_path: Path, monkeypatch):
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="ollama"),
    )
    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)
    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)
    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="S"))
    post = store.create_post(project.id, CreatePostRequest(name="P", type=ProjectType.IMAGE))

    mock_client = MagicMock()
    mock_client.complete_json.return_value = {
        "disclaimer": "Not legal advice.",
        "suggestions": [
            {
                "id": "s1",
                "category": "reach",
                "severity": "info",
                "title": "Increase contrast",
                "detail": "Text may be hard to read.",
                "action": None,
            }
        ],
    }
    monkeypatch.setattr(
        "content_sprout.llm.factory.create_json_client",
        lambda _cfg: mock_client,
    )

    r = client.post(
        f"/api/projects/{project.id}/posts/{post.id}/ai/suggest",
        json={"include_preview": False},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["suggestions"][0]["title"] == "Increase contrast"
    assert "legal advice" in body["disclaimer"].lower()


def test_ai_hashtags_with_mock(tmp_path: Path, monkeypatch):
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="ollama"),
    )
    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)
    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)
    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="S"))
    post = store.create_post(project.id, CreatePostRequest(name="Morning Routine", type=ProjectType.VIDEO))

    mock_client = MagicMock()
    mock_client.complete_json.return_value = {
        "hashtags": ["#MorningRoutine", "productivity", "#FocusTips", "#MorningRoutine"],
        "groups": [
            {"label": "Trending", "tags": ["#MorningRoutine", "#FocusTips"]},
            {"label": "Niche", "tags": ["#DeepWorkHabits"]},
        ],
        "note": "Lean into routine + focus discovery tags.",
    }
    monkeypatch.setattr(
        "content_sprout.llm.factory.create_json_client",
        lambda _cfg: mock_client,
    )

    r = client.post(
        f"/api/projects/{project.id}/posts/{post.id}/ai/hashtags",
        json={
            "description": "A short video about building a calm morning routine for deep work.",
            "title": "Morning Routine",
            "platforms": ["tiktok", "instagram"],
            "count": 10,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "#MorningRoutine" in body["hashtags"]
    assert "#productivity" in body["hashtags"]
    assert body["hashtags"].count("#MorningRoutine") == 1
    assert body["note"]


def test_prune_unreferenced_media_layers():
    post = Post(
        name="V",
        type=ProjectType.VIDEO,
        scenes=[
            {
                "name": "S1",
                "duration_s": 5,
                "layers": [
                    {"id": "a1", "type": "image", "asset_id": None, "x": 0, "y": 0, "width": 100, "height": 100},
                    {"id": "t1", "type": "tts", "text": "Hello", "x": 0, "y": 0, "width": 10, "height": 10},
                    {"id": "x1", "type": "text", "text": "Title", "x": 10, "y": 10, "width": 40, "height": 20},
                ],
            }
        ],
    )
    pruned = prune_unreferenced_media_layers(post)
    types = [layer.type for layer in pruned.scenes[0].layers]
    assert types == ["tts", "text"]


def test_ai_script_video_with_mock(tmp_path: Path, monkeypatch):
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="ollama"),
        formats=["square", "portrait"],
    )
    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)
    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="ScriptDemo"))
    post = store.create_post(project.id, CreatePostRequest(name="Vid", type=ProjectType.VIDEO))
    buf = BytesIO()
    Image.new("RGB", (200, 200), (40, 80, 120)).save(buf, format="JPEG")
    asset = store.add_asset(project.id, "hero.jpg", buf.getvalue(), apply_logo=False)
    store.set_asset_description(project.id, asset.id, "Blue product hero shot on a clean backdrop")

    proposed = post.model_dump()
    proposed["scenes"] = [
        {
            "id": "scene0000001",
            "name": "Intro",
            "duration_s": 6,
            "background_asset_id": asset.id,
            "background_format": "portrait",
            "layers": [
                {
                    "id": "tts000000001",
                    "type": "tts",
                    "text": "Welcome to our product.",
                    "x": 0,
                    "y": 0,
                    "width": 10,
                    "height": 10,
                    "start_s": 0,
                    "duration_s": 5,
                    "z_index": 2,
                },
                {
                    "id": "txt000000001",
                    "type": "text",
                    "text": "Welcome",
                    "x": 10,
                    "y": 70,
                    "width": 80,
                    "height": 15,
                    "font_size": 48,
                    "color": "#ffffff",
                    "font_weight": "bold",
                    "start_s": 0,
                    "duration_s": 6,
                    "z_index": 3,
                },
                {
                    "id": "img000000001",
                    "type": "image",
                    "asset_id": "not-a-real-asset",
                    "x": 0,
                    "y": 0,
                    "width": 100,
                    "height": 100,
                },
            ],
        }
    ]

    mock_client = MagicMock()
    mock_client.complete_json.return_value = {
        "summary": "One scene with hero background and narration",
        "post": proposed,
    }
    monkeypatch.setattr(
        "content_sprout.llm.factory.create_json_client",
        lambda _cfg: mock_client,
    )

    # Image post should be rejected
    image_post = store.create_post(project.id, CreatePostRequest(name="Img", type=ProjectType.IMAGE))
    bad = client.post(
        f"/api/projects/{project.id}/posts/{image_post.id}/ai/script-video",
        json={"script": "Hello world", "apply": False},
    )
    assert bad.status_code == 400

    r = client.post(
        f"/api/projects/{project.id}/posts/{post.id}/ai/script-video",
        json={
            "script": "Welcome to our product. Show the hero shot.",
            "apply": False,
            "include_preview": False,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied"] is False
    assert body["post"]["scenes"][0]["background_asset_id"] == asset.id
    layer_types = [layer["type"] for layer in body["post"]["scenes"][0]["layers"]]
    assert "tts" in layer_types
    assert "text" in layer_types
    # invalid image asset pruned
    assert all(layer.get("asset_id") != "not-a-real-asset" for layer in body["post"]["scenes"][0]["layers"])
    assert not any(layer["type"] == "image" and not layer.get("asset_id") for layer in body["post"]["scenes"][0]["layers"])

    prompt = mock_client.complete_json.call_args.args[0]
    assert asset.id in prompt
    assert "Welcome to our product" in prompt
    assert "available_assets" in prompt

    r2 = client.post(
        f"/api/projects/{project.id}/posts/{post.id}/ai/script-video",
        json={"script": "Welcome to our product.", "apply": True, "include_preview": False},
    )
    assert r2.status_code == 200
    assert r2.json()["applied"] is True
    saved = store.get_post(project.id, post.id)
    assert saved.scenes[0].background_asset_id == asset.id
    assert any(layer.type == "tts" for layer in saved.scenes[0].layers)


def test_ai_script_generate_and_refine_with_mock(tmp_path: Path, monkeypatch):
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="ollama"),
    )
    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)
    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    mock_client = MagicMock()
    mock_client.complete_json.side_effect = [
        {
            "title": "Focus mornings",
            "summary": "Three habits for remote focus.",
            "script": "Hook\nHere are three habits.\n[VISUAL: desk setup]\nCTA\nTry one today.",
        },
        {
            "reply": "Shortened the hook and kept your CTA.",
            "summary": "Punchier hook",
            "script": "Hook\nThree habits. Start now.\nCTA\nTry one today.",
        },
    ]
    monkeypatch.setattr(
        "content_sprout.llm.factory.create_json_client",
        lambda _cfg: mock_client,
    )

    r = client.post(
        "/api/ai/script/generate",
        json={
            "topic": "morning focus habits",
            "platform": "instagram_reel",
            "tone": "conversational",
            "length": "short",
            "format": "talking_head",
            "audience": "remote workers",
            "notes": "end with CTA",
            "language": "English",
            "duration_s": 45,
            "ideation_notes": "• Hook: cold open with coffee spill\n• Mention async standups",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Focus mornings"
    assert "three habits" in body["script"].lower()
    prompt = mock_client.complete_json.call_args_list[0].args[0]
    assert "morning focus habits" in prompt
    assert "Brief" in prompt
    assert "duration_s" in prompt
    assert "45" in prompt
    assert "Post ideation notes" in prompt
    assert "coffee spill" in prompt
    assert "async standups" in prompt

    r2 = client.post(
        "/api/ai/script/refine",
        json={
            "script": body["script"],
            "message": "Make the hook punchier",
            "history": [{"role": "user", "content": "earlier note"}],
            "topic": "morning focus habits",
            "platform": "instagram_reel",
            "tone": "conversational",
            "ideation_notes": "Keep the coffee spill hook",
        },
    )
    assert r2.status_code == 200, r2.text
    refined = r2.json()
    assert "punchier" in refined["reply"].lower() or "hook" in refined["reply"].lower()
    assert "Start now" in refined["script"]
    refine_prompt = mock_client.complete_json.call_args_list[1].args[0]
    assert "Post ideation notes" in refine_prompt
    assert "coffee spill hook" in refine_prompt

    r3 = client.post("/api/ai/script/generate", json={"topic": ""})
    assert r3.status_code == 422

    cfg_off = AppConfig(
        projects_dir=tmp_path / "projects2",
        cache_dir=tmp_path / "cache2",
        input_dir=tmp_path / "input2",
        output_dir=tmp_path / "output2",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="heuristic_only"),
    )
    app_off = create_app(cfg=cfg_off, config_path=tmp_path / "config-off.yaml")
    client_off = TestClient(app_off)
    r4 = client_off.post("/api/ai/script/generate", json={"topic": "x"})
    assert r4.status_code == 400

