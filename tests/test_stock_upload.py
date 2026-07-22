"""Tests for stock upload destinations and submission packages."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from content_sprout.config import (
    AppConfig,
    RouterConfig,
    StockMediaConfig,
    StockUploadSite,
    save_stock_media_settings,
    stock_upload_sites_public,
)
from content_sprout.models import CreateProjectRequest
from content_sprout.projects import ProjectStore
from content_sprout.stock_upload import (
    UploadMeta,
    build_shutterstock_csv,
    check_site_connection,
    write_submission_package,
)
from content_sprout.web import create_app


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
        stock_media=StockMediaConfig(
            upload_sites=[
                StockUploadSite(
                    id="pkg1",
                    name="Local package",
                    provider="package",
                    enabled=True,
                    portal_url="https://example.com/portal",
                )
            ]
        ),
    )
    return ProjectStore(cfg.projects_dir, cfg)


def test_build_shutterstock_csv_columns():
    csv_text = build_shutterstock_csv(
        UploadMeta(
            title="Night city",
            description="Timelapse of downtown",
            keywords=["city", "night", "timelapse"],
            category="1",
        ),
        "night_city.mp4",
    )
    lines = csv_text.strip().splitlines()
    assert lines[0] == "Filename,Description,Keywords,Categories"
    assert "night_city.mp4" in lines[1]
    assert "city, night, timelapse" in lines[1]


def test_write_submission_package(tmp_path: Path):
    video = tmp_path / "src.mp4"
    video.write_bytes(b"fake-mp4-bytes")
    out = tmp_path / "pkg"
    site = StockUploadSite(name="SS", provider="package", portal_url="https://submit.example/")
    dest, csv_path = write_submission_package(
        out,
        video,
        UploadMeta(title="Clip", keywords=["a", "b"], filename="Clip One.mp4"),
        site=site,
    )
    assert dest.exists()
    assert dest.name == "Clip_One.mp4"
    assert csv_path.exists()
    assert "Clip_One.mp4" in csv_path.read_text(encoding="utf-8")
    assert (out / "README.txt").exists()
    assert "https://submit.example/" in (out / "README.txt").read_text(encoding="utf-8")


def test_package_connection_check_ok():
    site = StockUploadSite(provider="package")
    result = check_site_connection(site)
    assert result["ok"] is True


def test_save_upload_sites_keeps_password(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("stock_media:\n  pixabay_api_key: ''\n", encoding="utf-8")
    save_stock_media_settings(
        cfg_path,
        {
            "upload_sites": [
                {
                    "id": "ss1",
                    "name": "Shutterstock",
                    "provider": "shutterstock_ftps",
                    "username": "contrib",
                    "password": "secret123",
                    "host": "ftps.shutterstock.com",
                }
            ]
        },
    )
    # Blank password keeps existing
    updated = save_stock_media_settings(
        cfg_path,
        {
            "upload_sites": [
                {
                    "id": "ss1",
                    "name": "Shutterstock",
                    "provider": "shutterstock_ftps",
                    "username": "contrib2",
                    "password": "",
                    "host": "ftps.shutterstock.com",
                }
            ]
        },
    )
    assert updated.upload_sites[0].password == "secret123"
    assert updated.upload_sites[0].username == "contrib2"

    public = stock_upload_sites_public(
        AppConfig(stock_media=updated, projects_dir=tmp_path / "p", cache_dir=tmp_path / "c")
    )
    assert public[0]["password_set"] is True
    assert "secret123" not in public[0]["password_masked"]


def test_stock_upload_api_package(tmp_path: Path):
    store = _store(tmp_path)
    # Persist sites into the app config path used by create_app
    cfg = store.cfg
    config_path = tmp_path / "config.yaml"
    from content_sprout.config import write_config

    write_config(config_path, cfg)
    app = create_app(cfg=cfg, config_path=config_path)
    client = TestClient(app)

    project = store.create_project(CreateProjectRequest(name="StockUp"))
    video = store.add_asset(project.id, "edit.mp4", b"\x00\x00\x00\x18ftypmp42fake")

    settings = client.get("/api/stock/settings")
    assert settings.status_code == 200
    sites = settings.json()["upload_sites"]
    assert len(sites) == 1
    site_id = sites[0]["id"]

    r = client.post(
        f"/api/projects/{project.id}/assets/{video.id}/stock/upload",
        json={
            "site_ids": [site_id],
            "title": "Edited clip",
            "description": "From Video Editor",
            "keywords": ["edit", "demo"],
            "category": "1",
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok_count"] == 1
    assert data["results"][0]["ok"] is True
    pkg = Path(data["results"][0]["package_dir"])
    assert pkg.is_dir()
    assert (pkg / "metadata.csv").exists()
    assert (pkg / "README.txt").exists()


def test_stock_upload_rejects_image(tmp_path: Path):
    store = _store(tmp_path)
    from content_sprout.config import write_config

    config_path = tmp_path / "config.yaml"
    write_config(config_path, store.cfg)
    client = TestClient(create_app(cfg=store.cfg, config_path=config_path))
    project = store.create_project(CreateProjectRequest(name="Img"))
    buf = __import__("io").BytesIO()
    Image.new("RGB", (20, 20), (1, 2, 3)).save(buf, format="JPEG")
    image = store.add_asset(project.id, "p.jpg", buf.getvalue())
    site_id = store.cfg.stock_media.upload_sites[0].id
    r = client.post(
        f"/api/projects/{project.id}/assets/{image.id}/stock/upload",
        json={"site_ids": [site_id], "title": "Nope"},
    )
    assert r.status_code == 400
