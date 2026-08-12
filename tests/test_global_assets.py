"""App-wide global asset library API."""

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
        global_assets_dir=tmp_path / "global_assets",
        logo_dark=tmp_path / "ld.png",
        logo_white=tmp_path / "lw.png",
        llm=LlmProviderConfig(provider="heuristic_only"),
    )
    Image.new("RGBA", (10, 10)).save(cfg.logo_dark)
    Image.new("RGBA", (10, 10)).save(cfg.logo_white)
    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    return TestClient(app)


def test_rename_global_asset(tmp_path: Path):
    client = _client(tmp_path)
    png = tmp_path / "logo.png"
    Image.new("RGBA", (12, 12), (20, 80, 180, 255)).save(png)
    uploaded = client.post(
        "/api/global-assets",
        files={"file": ("logo.png", png.read_bytes(), "image/png")},
        data={"name": "Original name", "asset_type": "photo"},
    )
    assert uploaded.status_code == 200, uploaded.text
    asset_id = uploaded.json()["asset"]["id"]

    renamed = client.patch(
        f"/api/global-assets/{asset_id}",
        json={"name": "Hero mark"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["asset"]["name"] == "Hero mark"

    listed = client.get("/api/global-assets").json()["assets"]
    assert listed[0]["name"] == "Hero mark"
