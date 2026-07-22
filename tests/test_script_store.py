"""Tests for filesystem ScriptStore and /api/scripts endpoints."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from content_sprout.config import AppConfig, LlmProviderConfig
from content_sprout.script_store import CreateScriptRequest, ScriptBrief, ScriptStore, UpdateScriptRequest
from content_sprout.web import create_app


def test_script_store_crud(tmp_path: Path):
    store = ScriptStore(tmp_path / "scripts")
    created = store.create_script(
        CreateScriptRequest(
            title="Focus mornings",
            summary="Three habits",
            script="Hook\nThree habits for focus.\nCTA",
            brief=ScriptBrief(topic="focus", platform="instagram_reel"),
            source="generated",
        )
    )
    assert created.id
    assert (tmp_path / "scripts" / created.id / "script.json").exists()

    listed = store.list_scripts()
    assert len(listed) == 1
    assert listed[0].id == created.id
    assert listed[0].word_count >= 5
    assert "habits" in listed[0].preview.lower()

    loaded = store.get_script(created.id)
    assert loaded.script.startswith("Hook")
    assert loaded.brief.topic == "focus"

    updated = store.update_script(
        created.id,
        UpdateScriptRequest(script="Hook\nUpdated.\nCTA", source="edited", title="Updated title"),
    )
    assert updated.title == "Updated title"
    assert "Updated" in updated.script
    assert updated.created_at == created.created_at
    assert updated.updated_at >= created.updated_at

    assert store.delete_script(created.id) == created.id
    assert store.list_scripts() == []


def test_scripts_api_crud(tmp_path: Path):
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        scripts_dir=tmp_path / "scripts",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="heuristic_only"),
    )
    from PIL import Image

    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)

    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    storage = client.get("/api/settings/storage").json()
    assert "scripts_dir" in storage
    assert Path(storage["scripts_dir_resolved"]).name == "scripts"

    caps = client.get("/api/config").json()
    assert "scripts_dir" in caps

    empty = client.get("/api/scripts").json()
    assert empty["scripts"] == []

    created = client.post(
        "/api/scripts",
        json={
            "title": "Demo",
            "summary": "A demo script",
            "script": "Line one\nLine two",
            "brief": {"topic": "demo", "tone": "calm"},
            "source": "manual",
            "chat": [{"role": "user", "content": "make it shorter"}],
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()["script"]
    script_id = body["id"]
    assert body["title"] == "Demo"
    assert body["createdAt"]
    assert (tmp_path / "scripts" / script_id / "script.json").exists()

    listed = client.get("/api/scripts").json()["scripts"]
    assert len(listed) == 1
    assert listed[0]["id"] == script_id

    got = client.get(f"/api/scripts/{script_id}").json()["script"]
    assert got["script"] == "Line one\nLine two"
    assert got["brief"]["topic"] == "demo"
    assert got["chat"][0]["content"] == "make it shorter"

    updated = client.put(
        f"/api/scripts/{script_id}",
        json={"script": "Shorter version", "source": "refined"},
    )
    assert updated.status_code == 200
    assert updated.json()["script"]["script"] == "Shorter version"
    assert updated.json()["script"]["source"] == "refined"

    deleted = client.delete(f"/api/scripts/{script_id}")
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] == script_id
    assert client.get("/api/scripts").json()["scripts"] == []

    # recreate then clear-all
    client.post("/api/scripts", json={"title": "A", "script": "aaa", "source": "edited"})
    client.post("/api/scripts", json={"title": "B", "script": "bbb", "source": "edited"})
    cleared = client.delete("/api/scripts")
    assert cleared.status_code == 200
    assert cleared.json()["deleted"] == 2
    assert client.get("/api/scripts").json()["scripts"] == []
