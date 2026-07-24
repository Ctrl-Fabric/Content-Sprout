"""Tests for stock asset encryption and daily download quotas."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from content_sprout import asset_crypto, stock_quota
from content_sprout.config import AppConfig, RouterConfig
from content_sprout.models import CreateProjectRequest
from content_sprout.projects import ProjectStore
from content_sprout.web import create_app


def _tiny_jpeg() -> bytes:
    from io import BytesIO

    buf = BytesIO()
    Image.new("RGB", (64, 48), (20, 80, 160)).save(buf, "JPEG")
    return buf.getvalue()


def test_crypto_round_trip(tmp_path: Path):
    key = asset_crypto.load_or_create_key(tmp_path)
    key2 = asset_crypto.load_or_create_key(tmp_path)
    assert key == key2
    plain = b"hello-stock-bytes"
    blob = asset_crypto.encrypt_bytes(plain, key)
    assert asset_crypto.is_encrypted_blob(blob)
    assert not asset_crypto.is_encrypted_blob(plain)
    assert asset_crypto.decrypt_bytes(blob, key) == plain


def test_quota_allows_then_blocks_and_resets(tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    limit = 2
    s0 = stock_quota.get_status(cache, limit)
    assert s0.used == 0 and s0.remaining == 2 and s0.allowed

    s1 = stock_quota.consume(cache, limit)
    assert s1.used == 1 and s1.remaining == 1
    s2 = stock_quota.consume(cache, limit)
    assert s2.used == 2 and s2.remaining == 0

    with pytest.raises(stock_quota.QuotaExceeded) as exc:
        stock_quota.consume(cache, limit)
    assert "2/2" in str(exc.value)

    # On-disk usage must be encrypted (not editable plaintext JSON).
    path = stock_quota.usage_path(cache)
    assert path.is_file()
    blob = path.read_bytes()
    assert asset_crypto.is_encrypted_blob(blob)
    assert b'"count"' not in blob

    # Simulate date rollover via encrypted rewrite.
    key = asset_crypto.load_or_create_key(cache)
    stock_quota._write_usage(path, "2000-01-01", 99, key)  # noqa: SLF001
    s3 = stock_quota.get_status(cache, limit)
    assert s3.used == 0 and s3.remaining == 2
    stock_quota.consume(cache, limit)
    assert stock_quota.get_status(cache, limit).used == 1


def test_quota_usage_file_tamper_fails_closed(tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    stock_quota.consume(cache, 5)
    path = stock_quota.usage_path(cache)
    path.write_bytes(b"not-a-valid-encrypted-quota")
    status = stock_quota.get_status(cache, 5)
    assert status.used == 5
    assert status.remaining == 0
    assert not status.allowed
    with pytest.raises(stock_quota.QuotaExceeded):
        stock_quota.consume(cache, 5)


def test_quota_migrates_legacy_plaintext(tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    legacy = stock_quota.legacy_usage_path(cache)
    from datetime import date

    today = date.today().isoformat()
    legacy.write_text(
        json.dumps({"date": today, "count": 3}),
        encoding="utf-8",
    )
    status = stock_quota.get_status(cache, 10)
    assert status.used == 3
    assert status.remaining == 7
    assert not legacy.exists()
    enc = stock_quota.usage_path(cache)
    assert enc.is_file()
    assert asset_crypto.is_encrypted_blob(enc.read_bytes())


def test_quota_unlimited(tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    for _ in range(5):
        status = stock_quota.consume(cache, 0)
        assert status.remaining is None
        assert status.allowed


def _store(tmp_path: Path) -> ProjectStore:
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        formats=["portrait"],
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
    )
    return ProjectStore(cfg.projects_dir, cfg)


def test_locked_asset_written_encrypted(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Lock"))
    data = _tiny_jpeg()
    asset = store.add_asset(
        project.id,
        "stock.jpg",
        data,
        locked=True,
        source="pixabay",
    )
    assert asset.locked is True
    assert asset.source == "pixabay"
    assert asset.original_path.endswith(".csasset")
    disk = store.resolve_asset_path(project.id, asset.original_path)
    raw = disk.read_bytes()
    assert asset_crypto.is_encrypted_blob(raw)
    assert store.read_media_bytes(project.id, asset.original_path) == data
    plain_path = store.materialize_asset(project.id, asset)
    assert plain_path.read_bytes() == data
    assert plain_path.suffix.lower() in {".jpg", ".jpeg"}


def _client(tmp_path: Path) -> tuple[TestClient, Path]:
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        "\n".join(
            [
                f"projects_dir: {tmp_path / 'projects'}",
                f"cache_dir: {tmp_path / 'cache'}",
                "stock_media:",
                "  daily_download_limit: 2",
                "  timeout_s: 30",
                "  pixabay_api_key: ''",
                "  upload_sites: []",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    app = create_app(config_path=cfg_path)
    return TestClient(app), cfg_path


def test_stock_download_forbidden(tmp_path: Path):
    client, _ = _client(tmp_path)
    r = client.get(
        "/api/stock/download",
        params={"url": "https://example.com/photo.jpg", "title": "x"},
    )
    assert r.status_code == 403


def test_from_stock_locks_and_quota(tmp_path: Path):
    client, _ = _client(tmp_path)
    created = client.post("/api/projects", json={"name": "P"}).json()
    project_id = created["project"]["id"]
    jpeg = _tiny_jpeg()

    with patch(
        "content_sprout.web.fetch_remote_bytes",
        return_value=(jpeg, "image/jpeg"),
    ):
        r1 = client.post(
            f"/api/projects/{project_id}/assets/from-stock",
            json={
                "download_url": "https://cdn.example/a.jpg",
                "title": "A",
                "type": "image",
                "source": "pixabay",
            },
        )
        assert r1.status_code == 200, r1.text
        body1 = r1.json()
        asset = body1["asset"]
        assert asset["locked"] is True
        assert asset["source"] == "pixabay"
        assert asset["original_path"].endswith(".csasset")

        r2 = client.post(
            f"/api/projects/{project_id}/assets/from-stock",
            json={
                "download_url": "https://cdn.example/b.jpg",
                "title": "B",
                "type": "image",
                "source": "openverse",
            },
        )
        assert r2.status_code == 200, r2.text

        r3 = client.post(
            f"/api/projects/{project_id}/assets/from-stock",
            json={
                "download_url": "https://cdn.example/c.jpg",
                "title": "C",
                "type": "image",
                "source": "pixabay",
            },
        )
        assert r3.status_code == 429

    asset_id = asset["id"]
    dl = client.get(f"/api/projects/{project_id}/assets/{asset_id}/download")
    assert dl.status_code == 403

    preview = client.get(
        f"/api/projects/{project_id}/file",
        params={"path": asset["original_path"]},
    )
    assert preview.status_code == 200
    assert preview.content == jpeg
    assert "attachment" not in (preview.headers.get("content-disposition") or "").lower()

    z = client.get(f"/api/projects/{project_id}/assets/zip")
    assert z.status_code == 404
    assert "locked" in z.json()["detail"].lower()


def test_crop_inherits_lock(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Crop"))
    data = _tiny_jpeg()
    source = store.add_asset(
        project.id,
        "stock.jpg",
        data,
        locked=True,
        source="pixabay",
    )
    client, _ = _client(tmp_path)
    # Re-point client store by using the same config dirs — create_app loads cfg.
    # Use store paths already under tmp_path via a fresh client that shares dirs.
    cfg_path = tmp_path / "config.yaml"
    if not cfg_path.exists():
        cfg_path.write_text(
            "\n".join(
                [
                    f"projects_dir: {tmp_path / 'projects'}",
                    f"cache_dir: {tmp_path / 'cache'}",
                    "stock_media:",
                    "  daily_download_limit: 20",
                    "  timeout_s: 30",
                    "  pixabay_api_key: ''",
                    "  upload_sites: []",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
    app = create_app(config_path=cfg_path)
    client = TestClient(app)

    r = client.post(
        f"/api/projects/{project.id}/assets/{source.id}/crop",
        json={"box": [0.1, 0.1, 0.9, 0.9]},
    )
    assert r.status_code == 200, r.text
    child = r.json()["asset"]
    assert child["locked"] is True
    assert child["source"] == "pixabay"
    assert child["original_path"].endswith(".csasset")
