"""Tests for Media Manager folders, listing, import, and publish packages."""

from __future__ import annotations

from pathlib import Path

import yaml
from fastapi.testclient import TestClient
from PIL import Image

from content_sprout.config import (
    AppConfig,
    MediaManagerConfig,
    MonitoredFolder,
    PublishPlatform,
    RouterConfig,
    default_publish_platforms,
    save_media_manager_folders,
    write_config,
)
from content_sprout.media_manager import (
    browse_directories,
    create_publish_package,
    list_media_files,
    safe_resolve_under,
)
from content_sprout.models import CreateProjectRequest
from content_sprout.projects import ProjectStore
from content_sprout.web import create_app


def _write_jpeg(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), (10, 20, 30)).save(path, format="JPEG")


def _app_client(tmp_path: Path, *, folders: list[MonitoredFolder] | None = None):
    assets = tmp_path / "assets"
    assets.mkdir(exist_ok=True)
    Image.new("RGBA", (40, 20), (0, 0, 0, 255)).save(assets / "logo_dark.png")
    Image.new("RGBA", (40, 20), (255, 255, 255, 255)).save(assets / "logo_white.png")
    media = tmp_path / "media_lib"
    media.mkdir()
    _write_jpeg(media / "shot.jpg")
    (media / "clip.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42fake")
    (media / "notes.txt").write_text("skip me", encoding="utf-8")
    nested = media / "sub"
    nested.mkdir()
    _write_jpeg(nested / "nested.jpg")

    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        logo_dark=assets / "logo_dark.png",
        logo_white=assets / "logo_white.png",
        formats=["square"],
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
        media_manager=MediaManagerConfig(
            monitored_folders=folders
            or [
                MonitoredFolder(
                    id="fold1",
                    label="Lib",
                    path=str(media),
                    enabled=True,
                )
            ],
            publish_platforms=default_publish_platforms(),
        ),
    )
    config_path = tmp_path / "config.yaml"
    write_config(config_path, cfg)
    app = create_app(cfg=cfg, config_path=config_path)
    return TestClient(app), cfg, media, config_path


def test_safe_resolve_rejects_traversal(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "ok.jpg").write_bytes(b"x")
    outside = tmp_path / "secret.txt"
    outside.write_text("nope", encoding="utf-8")
    resolved = safe_resolve_under(root, "ok.jpg")
    assert resolved == (root / "ok.jpg").resolve()
    try:
        safe_resolve_under(root, "../secret.txt")
        assert False, "expected traversal to fail"
    except ValueError as exc:
        assert "escapes" in str(exc).lower()


def test_list_media_files_filters_types(tmp_path: Path):
    root = tmp_path / "lib"
    root.mkdir()
    _write_jpeg(root / "a.jpg")
    (root / "b.mp4").write_bytes(b"fake")
    (root / "c.txt").write_text("x", encoding="utf-8")
    all_files = list_media_files(root)
    assert {f["name"] for f in all_files} == {"a.jpg", "b.mp4"}
    images = list_media_files(root, media_type="image")
    assert [f["name"] for f in images] == ["a.jpg"]
    videos = list_media_files(root, media_type="video")
    assert [f["name"] for f in videos] == ["b.mp4"]
    q = list_media_files(root, query="a.jp")
    assert [f["name"] for f in q] == ["a.jpg"]


def test_folder_crud_and_list_api(tmp_path: Path):
    client, _cfg, media, config_path = _app_client(tmp_path)
    listed = client.get("/api/media/folders")
    assert listed.status_code == 200
    assert len(listed.json()["folders"]) == 1

    files = client.get("/api/media/folders/fold1/files")
    assert files.status_code == 200
    names = {f["name"] for f in files.json()["files"]}
    assert "shot.jpg" in names
    assert "clip.mp4" in names
    assert "nested.jpg" in names
    assert "notes.txt" not in names

    images = client.get("/api/media/folders/fold1/files?media_type=image")
    assert {f["name"] for f in images.json()["files"]} == {"shot.jpg", "nested.jpg"}

    other = tmp_path / "other"
    other.mkdir()
    _write_jpeg(other / "x.jpg")
    created = client.post(
        "/api/media/folders",
        json={"label": "Other", "path": str(other), "enabled": True},
    )
    assert created.status_code == 200, created.text
    new_id = created.json()["folder"]["id"]

    deleted = client.delete(f"/api/media/folders/{new_id}")
    assert deleted.status_code == 200

    raw = yaml.safe_load(config_path.read_text())
    assert len(raw["media_manager"]["monitored_folders"]) == 1


def test_media_file_path_escape(tmp_path: Path):
    client, _cfg, media, _ = _app_client(tmp_path)
    r = client.get(
        "/api/media/file",
        params={"folder_id": "fold1", "path": "../config.yaml"},
    )
    assert r.status_code == 400

    ok = client.get(
        "/api/media/file",
        params={"folder_id": "fold1", "path": "shot.jpg"},
    )
    assert ok.status_code == 200
    assert ok.headers["content-type"].startswith("image/")


def test_import_to_project(tmp_path: Path):
    client, cfg, media, _ = _app_client(tmp_path)
    store = ProjectStore(cfg.projects_dir, cfg)
    project = store.create_project(CreateProjectRequest(name="ImportMe"))

    r = client.post(
        "/api/media/import",
        json={
            "project_id": project.id,
            "folder_id": "fold1",
            "paths": ["shot.jpg", "sub/nested.jpg"],
            "group": "FromDisk",
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["imported_count"] == 2
    assert not data["errors"]
    refreshed = store.get_project(project.id)
    assert len(refreshed.assets) == 2
    assert all(a.group == "FromDisk" for a in refreshed.assets)


def test_publish_package_shape(tmp_path: Path):
    client, cfg, media, _ = _app_client(tmp_path)
    platforms = client.get("/api/media/publish/platforms")
    assert platforms.status_code == 200
    plats = platforms.json()["platforms"]
    assert len(plats) >= 3
    assert {p["id"] for p in plats} >= {"pixabay", "pexels", "unsplash"}

    created = client.post(
        "/api/media/publish/packages",
        json={
            "folder_id": "fold1",
            "paths": ["shot.jpg", "clip.mp4"],
            "platform_ids": ["pixabay", "pexels"],
            "title": "City night",
            "description": "Timelapse",
            "tags": ["city", "night"],
        },
    )
    assert created.status_code == 200, created.text
    pkg = created.json()["package"]
    assert pkg["status"] == "draft"
    assert pkg["title"] == "City night"
    assert pkg["file_count"] == 2
    assert {p["id"] for p in pkg["platforms"]} == {"pixabay", "pexels"}
    pkg_dir = Path(pkg["package_dir"])
    assert (pkg_dir / "metadata.json").is_file()
    assert (pkg_dir / "README.txt").is_file()
    assert (pkg_dir / "files" / "shot.jpg").is_file()
    assert (pkg_dir / "files" / "clip.mp4").is_file()

    opened = client.post(f"/api/media/publish/packages/{pkg['id']}/open")
    assert opened.status_code == 200
    assert opened.json()["package"]["status"] == "opened"
    urls = opened.json()["contributor_urls"]
    assert len(urls) == 2
    assert all(u["contributor_url"] for u in urls)

    submitted = client.post(f"/api/media/publish/packages/{pkg['id']}/mark-submitted")
    assert submitted.status_code == 200
    assert submitted.json()["package"]["status"] == "submitted"

    listed = client.get("/api/media/publish/packages")
    assert listed.status_code == 200
    assert listed.json()["packages"][0]["id"] == pkg["id"]


def test_create_publish_package_helper(tmp_path: Path):
    src = tmp_path / "a.jpg"
    _write_jpeg(src)
    cache = tmp_path / "cache"
    plat = PublishPlatform(
        id="pixabay",
        label="Pixabay",
        enabled=True,
        contributor_url="https://pixabay.com/accounts/media/upload/",
    )
    summary = create_publish_package(
        cache,
        sources=[(src, "a.jpg")],
        platforms=[plat],
        title="T",
        tags=["one"],
    )
    assert summary["status"] == "draft"
    assert summary["file_count"] == 1
    assert Path(summary["package_dir"]).is_dir()


def test_save_media_manager_folders_persists(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    write_config(config_path, AppConfig())
    folder = MonitoredFolder(label="D", path=str(tmp_path), enabled=True)
    updated = save_media_manager_folders(config_path, [folder])
    assert len(updated.monitored_folders) == 1
    assert updated.monitored_folders[0].label == "D"
    assert len(updated.publish_platforms) >= 3


def test_browse_directories_lists_children(tmp_path: Path):
    child_a = tmp_path / "Alpha"
    child_b = tmp_path / "beta"
    child_a.mkdir()
    child_b.mkdir()
    (tmp_path / "file.txt").write_text("x", encoding="utf-8")
    (tmp_path / ".hidden").mkdir()

    result = browse_directories(str(tmp_path))
    assert result["path"] == str(tmp_path.resolve())
    assert result["parent"] == str(tmp_path.resolve().parent)
    names = [d["name"] for d in result["directories"]]
    assert names == ["Alpha", "beta"]
    assert all("path" in d for d in result["directories"])
    assert result["roots"]


def test_browse_directories_rejects_file(tmp_path: Path):
    file_path = tmp_path / "not-a-dir.txt"
    file_path.write_text("x", encoding="utf-8")
    try:
        browse_directories(str(file_path))
        assert False, "expected failure for file path"
    except ValueError as exc:
        assert "not a directory" in str(exc).lower()


def test_browse_api(tmp_path: Path):
    client, _cfg, _media, _ = _app_client(tmp_path)
    nested = tmp_path / "pick_me"
    nested.mkdir()

    home = client.get("/api/media/browse")
    assert home.status_code == 200
    assert "path" in home.json()
    assert "directories" in home.json()
    assert "roots" in home.json()

    listed = client.get("/api/media/browse", params={"path": str(tmp_path)})
    assert listed.status_code == 200
    names = {d["name"] for d in listed.json()["directories"]}
    assert "pick_me" in names
    assert "media_lib" in names

    missing = client.get("/api/media/browse", params={"path": str(tmp_path / "nope")})
    assert missing.status_code == 400


def test_pick_folder_api(tmp_path: Path, monkeypatch):
    client, _cfg, _media, _ = _app_client(tmp_path)
    chosen = str((tmp_path / "chosen").resolve())
    (tmp_path / "chosen").mkdir()

    monkeypatch.setattr(
        "content_sprout.media_manager.pick_directory_native",
        lambda title="Select a folder": chosen,
    )
    ok = client.post("/api/media/pick-folder")
    assert ok.status_code == 200
    body = ok.json()
    assert body["cancelled"] is False
    assert body["path"] == chosen
    assert body["name"] == "chosen"

    monkeypatch.setattr(
        "content_sprout.media_manager.pick_directory_native",
        lambda title="Select a folder": None,
    )
    cancelled = client.post("/api/media/pick-folder")
    assert cancelled.status_code == 200
    assert cancelled.json()["cancelled"] is True
    assert cancelled.json()["path"] is None
