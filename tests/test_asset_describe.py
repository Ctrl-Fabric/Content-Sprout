"""Tests for AI asset catalog descriptions."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock

from PIL import Image
from fastapi.testclient import TestClient

from content_sprout.asset_describe import describe_asset
from content_sprout.config import AppConfig, LlmProviderConfig, RouterConfig
from content_sprout.models import CreateProjectRequest
from content_sprout.projects import ProjectStore
from content_sprout.web import create_app


def _png_bytes(color=(80, 120, 200), size=(64, 48)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _cfg(tmp_path: Path, *, provider: str = "ollama") -> AppConfig:
    logo_dark = tmp_path / "logo_dark.png"
    logo_white = tmp_path / "logo_white.png"
    Image.new("RGBA", (40, 20), (0, 0, 0, 255)).save(logo_dark)
    Image.new("RGBA", (40, 20), (255, 255, 255, 255)).save(logo_white)
    return AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        logo_dark=logo_dark,
        logo_white=logo_white,
        formats=["square", "portrait"],
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
        llm=LlmProviderConfig(provider=provider),
    )


def test_describe_asset_persists_description(tmp_path: Path, monkeypatch):
    cfg = _cfg(tmp_path)
    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="Desc"))
    asset = store.add_asset(project.id, "beach.png", _png_bytes())

    mock_client = MagicMock()
    mock_client.complete_json.return_value = {
        "description": "A blue abstract color field useful as a calm background.",
    }
    monkeypatch.setattr(
        "content_sprout.llm.factory.create_json_client",
        lambda _cfg: mock_client,
    )

    updated = describe_asset(store, cfg, project.id, asset.id, force=True)
    assert updated is not None
    assert "blue" in updated.description.lower()
    reloaded = store.get_asset(project.id, asset.id)
    assert reloaded.description == updated.description
    mock_client.complete_json.assert_called_once()
    call_kw = mock_client.complete_json.call_args.kwargs
    assert call_kw.get("images")


def test_describe_asset_skipped_when_heuristic_only(tmp_path: Path, monkeypatch):
    cfg = _cfg(tmp_path, provider="heuristic_only")
    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="NoAI"))
    asset = store.add_asset(project.id, "beach.png", _png_bytes())
    called = MagicMock()
    monkeypatch.setattr("content_sprout.llm.factory.create_json_client", called)
    assert describe_asset(store, cfg, project.id, asset.id, force=True) is None
    called.assert_not_called()
    assert store.get_asset(project.id, asset.id).description == ""


def test_upload_queues_describe(tmp_path: Path, monkeypatch):
    cfg = _cfg(tmp_path)
    config_path = tmp_path / "config.yaml"
    app = create_app(cfg=cfg, config_path=config_path)
    client = TestClient(app)

    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="Upload"))

    mock_client = MagicMock()
    mock_client.complete_json.return_value = {"description": "Warm product still life."}
    monkeypatch.setattr(
        "content_sprout.llm.factory.create_json_client",
        lambda _cfg: mock_client,
    )
    monkeypatch.setattr(
        "content_sprout.projects.ProjectStore.process_asset",
        lambda self, project_id, asset_id: self.get_asset(project_id, asset_id),
    )

    r = client.post(
        f"/api/projects/{project.id}/assets",
        files={"file": ("still.png", _png_bytes(), "image/png")},
        data={"apply_logo": "false", "group": ""},
    )
    assert r.status_code == 200, r.text
    asset_id = r.json()["asset"]["id"]

    described = store.get_asset(project.id, asset_id)
    assert "product" in described.description.lower() or "Warm" in described.description

    caps = client.get("/api/ai/capabilities").json()
    assert caps["asset_describe"] is True
