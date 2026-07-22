"""Project-scoped Media Manager folder bookmarks."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from content_sprout.config import AppConfig, LlmProviderConfig
from content_sprout.web import create_app


def _client(tmp_path: Path) -> TestClient:
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
    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)
    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    return TestClient(app)


def test_media_folders_are_project_scoped(tmp_path: Path):
    client = _client(tmp_path)
    folder_path = tmp_path / "media-a"
    folder_path.mkdir()

    pid_a = client.post("/api/projects", json={"name": "A"}).json()["project"]["id"]
    pid_b = client.post("/api/projects", json={"name": "B"}).json()["project"]["id"]

    assert client.get(f"/api/projects/{pid_a}/media/folders").json()["folders"] == []

    created = client.post(
        f"/api/projects/{pid_a}/media/folders",
        json={"label": "Cam dumps", "path": str(folder_path), "enabled": True},
    )
    assert created.status_code == 200, created.text
    folder_id = created.json()["folder"]["id"]

    listed_a = client.get(f"/api/projects/{pid_a}/media/folders").json()["folders"]
    assert len(listed_a) == 1
    assert listed_a[0]["id"] == folder_id
    assert client.get(f"/api/projects/{pid_b}/media/folders").json()["folders"] == []

    files = client.get(f"/api/projects/{pid_a}/media/folders/{folder_id}/files")
    assert files.status_code == 200
    assert files.json()["folder_id"] == folder_id

    assert client.get(f"/api/projects/{pid_b}/media/folders/{folder_id}/files").status_code == 404

    deleted = client.delete(f"/api/projects/{pid_a}/media/folders/{folder_id}")
    assert deleted.status_code == 200
    assert client.get(f"/api/projects/{pid_a}/media/folders").json()["folders"] == []
