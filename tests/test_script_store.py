"""Tests for filesystem ScriptStore and post-scoped /api/projects/.../posts/.../scripts endpoints."""

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


def _make_client(tmp_path: Path) -> tuple[TestClient, str, str, str]:
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

    project = client.post("/api/projects", json={"name": "Alpha"}).json()["project"]
    pid = project["id"]
    post = client.post(
        f"/api/projects/{pid}/posts",
        json={"name": "Reel", "type": "video", "target_format": "portrait"},
    ).json()["post"]
    return client, pid, post["id"], tmp_path


def test_scripts_api_crud_is_post_scoped(tmp_path: Path):
    client, pid_a, post_a, root = _make_client(tmp_path)
    project_b = client.post("/api/projects", json={"name": "Beta"}).json()["project"]
    pid_b = project_b["id"]
    post_b = client.post(
        f"/api/projects/{pid_b}/posts",
        json={"name": "Other", "type": "video", "target_format": "portrait"},
    ).json()["post"]
    post_b_id = post_b["id"]

    empty = client.get(f"/api/projects/{pid_a}/posts/{post_a}/scripts").json()
    assert empty["scripts"] == []
    assert empty["active_script_id"] is None

    created = client.post(
        f"/api/projects/{pid_a}/posts/{post_a}/scripts",
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
    assert body["active"] is True
    assert created.json()["active_script_id"] == script_id
    assert (root / "projects" / pid_a / "posts" / post_a / "scripts" / script_id / "script.json").exists()
    assert not (root / "scripts" / script_id / "script.json").exists()

    listed_a = client.get(f"/api/projects/{pid_a}/posts/{post_a}/scripts").json()["scripts"]
    assert len(listed_a) == 1
    assert listed_a[0]["id"] == script_id
    assert listed_a[0]["active"] is True
    assert client.get(f"/api/projects/{pid_b}/posts/{post_b_id}/scripts").json()["scripts"] == []

    got = client.get(f"/api/projects/{pid_a}/posts/{post_a}/scripts/{script_id}").json()["script"]
    assert got["script"] == "Line one\nLine two"
    assert got["brief"]["topic"] == "demo"
    assert got["chat"][0]["content"] == "make it shorter"

    updated = client.put(
        f"/api/projects/{pid_a}/posts/{post_a}/scripts/{script_id}",
        json={"script": "Shorter version", "source": "refined"},
    )
    assert updated.status_code == 200
    assert updated.json()["script"]["script"] == "Shorter version"
    assert updated.json()["script"]["source"] == "refined"

    assert client.get(f"/api/projects/{pid_b}/posts/{post_b_id}/scripts/{script_id}").status_code == 404

    second = client.post(
        f"/api/projects/{pid_a}/posts/{post_a}/scripts",
        json={"title": "Alt", "script": "Alternate take", "source": "edited", "activate": False},
    )
    assert second.status_code == 200
    alt_id = second.json()["script"]["id"]
    assert second.json()["active_script_id"] == script_id  # first stays active

    activated = client.post(f"/api/projects/{pid_a}/posts/{post_a}/scripts/{alt_id}/activate")
    assert activated.status_code == 200
    assert activated.json()["active_script_id"] == alt_id
    assert activated.json()["script"]["active"] is True

    listed = client.get(f"/api/projects/{pid_a}/posts/{post_a}/scripts").json()["scripts"]
    by_id = {s["id"]: s for s in listed}
    assert by_id[alt_id]["active"] is True
    assert by_id[script_id]["active"] is False

    deleted = client.delete(f"/api/projects/{pid_a}/posts/{post_a}/scripts/{alt_id}")
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] == alt_id
    # Active should promote to remaining script
    assert deleted.json()["active_script_id"] == script_id
    assert client.get(f"/api/projects/{pid_a}/posts/{post_a}/scripts").json()["scripts"][0]["id"] == script_id

    client.post(
        f"/api/projects/{pid_a}/posts/{post_a}/scripts",
        json={"title": "A", "script": "aaa", "source": "edited"},
    )
    client.post(
        f"/api/projects/{pid_b}/posts/{post_b_id}/scripts",
        json={"title": "C", "script": "ccc", "source": "edited"},
    )
    cleared = client.delete(f"/api/projects/{pid_a}/posts/{post_a}/scripts")
    assert cleared.status_code == 200
    assert cleared.json()["deleted"] >= 1
    assert client.get(f"/api/projects/{pid_a}/posts/{post_a}/scripts").json()["scripts"] == []
    assert cleared.json()["active_script_id"] is None
    assert len(client.get(f"/api/projects/{pid_b}/posts/{post_b_id}/scripts").json()["scripts"]) == 1


def test_legacy_project_scripts_migrate_into_post(tmp_path: Path):
    client, pid, post_id, root = _make_client(tmp_path)
    # Seed a legacy project-level script folder.
    legacy_id = "legacy001"
    legacy_dir = root / "projects" / pid / "scripts" / legacy_id
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "script.json").write_text(
        '{"id":"legacy001","title":"Old","summary":"","script":"Legacy line",'
        '"chat":[],"brief":{},"source":"edited","created_at":"2020-01-01T00:00:00Z",'
        '"updated_at":"2020-01-01T00:00:00Z"}',
        encoding="utf-8",
    )
    listed = client.get(f"/api/projects/{pid}/posts/{post_id}/scripts").json()
    assert any(s["id"] == legacy_id for s in listed["scripts"])
    assert listed["active_script_id"] == legacy_id
    assert (root / "projects" / pid / "posts" / post_id / "scripts" / legacy_id / "script.json").exists()
    assert not (root / "projects" / pid / "scripts" / legacy_id / "script.json").exists()
