"""Tests for project store, posts, migration, and asset processing."""

import json
from pathlib import Path

import pytest
from PIL import Image

from content_sprout.config import AppConfig, RouterConfig
from content_sprout.models import CreatePostRequest, CreateProjectRequest, Layer, ProjectType
from content_sprout.projects import ProjectStore, detect_asset_type


def _make_image(path: Path) -> None:
    Image.new("RGB", (800, 600), (100, 150, 200)).save(path, "JPEG")


def _make_logo(path: Path) -> None:
    Image.new("RGBA", (100, 40), (0, 0, 0, 255)).save(path, "PNG")


def _store(tmp_path: Path, formats: list[str] | None = None) -> ProjectStore:
    assets = tmp_path / "assets"
    assets.mkdir(exist_ok=True)
    _make_logo(assets / "logo_dark.png")
    _make_logo(assets / "logo_white.png")
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        logo_dark=assets / "logo_dark.png",
        logo_white=assets / "logo_white.png",
        formats=formats or ["square", "portrait", "landscape", "story"],
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
    )
    return ProjectStore(cfg.projects_dir, cfg)


def test_detect_asset_type():
    assert detect_asset_type("photo.jpg") is not None
    assert detect_asset_type("clip.mp4") is not None
    assert detect_asset_type("song.mp3") is not None
    assert detect_asset_type("doc.pdf") is None


def test_create_project_has_no_posts(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Campaign"))
    assert project.id
    assert project.posts == []
    assert (tmp_path / "projects" / project.id / "posts").is_dir()
    assert (tmp_path / "projects" / project.id / "assets").is_dir()
    meta = (tmp_path / "projects" / project.id / "project.json").read_text(encoding="utf-8")
    import json

    payload = json.loads(meta)
    assert "post" not in payload
    assert "type" not in payload
    assert "assets" in payload


def test_create_project_and_add_image_asset(tmp_path: Path):
    store = _store(tmp_path, formats=["square", "portrait"])

    project = store.create_project(CreateProjectRequest(name="Test Post"))
    assert project.id
    assert project.posts == []

    img = tmp_path / "sample.jpg"
    _make_image(img)
    asset = store.add_asset(project.id, "sample.jpg", img.read_bytes(), apply_logo=True)
    assert asset.type.value == "image"
    assert asset.status.value == "pending"

    processed = store.process_asset(project.id, asset.id)
    assert processed.status.value == "ready"
    assert "square" in processed.processed_formats
    assert "portrait" in processed.processed_formats
    assert "thumb" in processed.processed_formats

    sq = store.resolve_asset_path(project.id, processed.processed_formats["square"])
    assert sq.exists()
    thumb = store.resolve_asset_path(project.id, processed.processed_formats["thumb"])
    assert thumb.exists()
    with Image.open(thumb) as timg:
        assert max(timg.size) <= 320


def test_add_asset_copies_into_project_and_ignores_source_file(tmp_path: Path):
    """Uploads become an owned project copy; deleting the machine original must not matter."""
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Owned copy"))
    source = tmp_path / "Downloads" / "nested" / "photo.jpg"
    source.parent.mkdir(parents=True)
    _make_image(source)
    payload = source.read_bytes()

    asset = store.add_asset(
        project.id,
        str(source),  # path-like client name must not become a machine path reference
        payload,
        apply_logo=False,
    )

    assert asset.original_filename == "photo.jpg"
    assert not Path(asset.original_path).is_absolute()
    assert asset.original_path.startswith("assets/")
    assert asset.original_path.endswith("/original.jpg")

    owned = store.resolve_asset_path(project.id, asset.original_path)
    assert owned.exists()
    assert owned.read_bytes() == payload
    assert owned != source.resolve()

    source.write_bytes(b"corrupted-not-an-image")
    source.unlink()
    assert not source.exists()
    assert owned.exists()
    assert owned.read_bytes() == payload

    # Processing and resolves must still use only the project copy.
    processed = store.process_asset(project.id, asset.id)
    assert processed.status.value == "ready"
    assert store.resolve_asset_path(project.id, processed.processed_formats["square"]).exists()

    with pytest.raises(ValueError):
        store.resolve_asset_path(project.id, str(tmp_path / "anywhere.jpg"))
    with pytest.raises(ValueError):
        store.resolve_asset_path(project.id, "../outside.jpg")


def test_update_asset_group(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Grouped"))
    img = tmp_path / "logo.jpg"
    _make_image(img)
    asset = store.add_asset(project.id, "logo.jpg", img.read_bytes(), apply_logo=False)
    assert asset.group == ""

    updated = store.update_asset(project.id, asset.id, group="Branding")
    assert updated.group == "Branding"

    reloaded = store.get_project(project.id)
    found = next(a for a in reloaded.assets if a.id == asset.id)
    assert found.group == "Branding"
    assert "Branding" in reloaded.asset_groups

    cleared = store.update_asset(project.id, asset.id, group="  ")
    assert cleared.group == ""


def test_create_empty_asset_group_then_upload(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Groups"))
    store.add_asset_group(project.id, "Branding")
    reloaded = store.get_project(project.id)
    assert reloaded.asset_groups == ["Branding"]

    img = tmp_path / "logo.jpg"
    _make_image(img)
    asset = store.add_asset(
        project.id, "logo.jpg", img.read_bytes(), apply_logo=False, group="Branding"
    )
    assert asset.group == "Branding"
    store.delete_asset_group(project.id, "Branding")
    after = store.get_project(project.id)
    assert "Branding" not in after.asset_groups
    assert after.assets[0].group == ""


def test_process_asset_all_formats_and_thumb(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Formats"))
    img = tmp_path / "sample.jpg"
    _make_image(img)
    asset = store.add_asset(project.id, "sample.jpg", img.read_bytes(), apply_logo=False)
    processed = store.process_asset(project.id, asset.id)
    for fmt in ("square", "portrait", "landscape", "story", "thumb"):
        assert fmt in processed.processed_formats
        path = store.resolve_asset_path(project.id, processed.processed_formats[fmt])
        assert path.exists()


def test_video_post_gets_default_scene(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Reel"))
    post = store.create_post(
        project.id,
        CreatePostRequest(name="Main reel", type=ProjectType.VIDEO),
    )
    assert post.type == ProjectType.VIDEO
    assert len(post.scenes) == 1
    assert post.scenes[0].name == "Scene 1"
    reloaded = store.get_project(project.id)
    assert len(reloaded.posts) == 1
    assert reloaded.posts[0].id == post.id


def test_create_post_persists_target_format(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Fmt"))
    post = store.create_post(
        project.id,
        CreatePostRequest(name="Wide", type=ProjectType.IMAGE, target_format="landscape"),
    )
    assert post.target_format == "landscape"
    assert post.background_format == "landscape"
    loaded = store.get_post(project.id, post.id)
    assert loaded.target_format == "landscape"


def test_multi_post_share_one_asset(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Shared"))
    img = tmp_path / "bg.jpg"
    _make_image(img)
    asset = store.add_asset(project.id, "bg.jpg", img.read_bytes(), apply_logo=False)
    store.process_asset(project.id, asset.id)

    image_post = store.create_post(
        project.id,
        CreatePostRequest(name="Feed", type=ProjectType.IMAGE, target_format="portrait"),
    )
    video_post = store.create_post(
        project.id,
        CreatePostRequest(name="Reel", type=ProjectType.VIDEO, target_format="story"),
    )
    image_post.background_asset_id = asset.id
    image_post.background_format = "portrait"
    store.update_post(project.id, image_post.id, image_post)

    video_post.scenes[0].background_asset_id = asset.id
    video_post.scenes[0].background_format = "story"
    store.update_post(project.id, video_post.id, video_post)

    project = store.get_project(project.id)
    assert len(project.posts) == 2
    assert len(project.assets) == 1
    assert store.get_post(project.id, image_post.id).background_asset_id == asset.id
    assert store.get_post(project.id, video_post.id).scenes[0].background_asset_id == asset.id


def test_video_layers_belong_to_scenes(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Scenes"))
    post = store.create_post(
        project.id,
        CreatePostRequest(name="Reel", type=ProjectType.VIDEO, target_format="story"),
    )
    # Simulate a mistaken top-level layer on a video post.
    post.layers = [Layer(type="text", text="orphan")]
    post.scenes[0].layers = [Layer(type="text", text="scene-owned")]
    store.update_post(project.id, post.id, post)

    loaded = store.get_post(project.id, post.id)
    assert loaded.layers == []
    assert len(loaded.scenes[0].layers) == 2
    assert {l.text for l in loaded.scenes[0].layers} == {"orphan", "scene-owned"}


def test_post_scoped_assets_visibility(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Scoped"))
    post_a = store.create_post(
        project.id,
        CreatePostRequest(name="Post A", type=ProjectType.IMAGE, target_format="portrait"),
    )
    post_b = store.create_post(
        project.id,
        CreatePostRequest(name="Post B", type=ProjectType.IMAGE, target_format="portrait"),
    )
    img = tmp_path / "a.jpg"
    _make_image(img)

    shared = store.add_asset(project.id, "shared.jpg", img.read_bytes(), apply_logo=False)
    only_a = store.add_asset(
        project.id, "a-only.jpg", img.read_bytes(), apply_logo=False, post_id=post_a.id
    )
    only_b = store.add_asset(
        project.id, "b-only.jpg", img.read_bytes(), apply_logo=False, post_id=post_b.id
    )

    project = store.get_project(project.id)
    visible_a = {a.id for a in ProjectStore.visible_assets(project, post_a.id)}
    visible_b = {a.id for a in ProjectStore.visible_assets(project, post_b.id)}
    assert shared.id in visible_a and shared.id in visible_b
    assert only_a.id in visible_a and only_a.id not in visible_b
    assert only_b.id in visible_b and only_b.id not in visible_a
    assert store.asset_visible_to_post(project.id, only_a.id, post_a.id)
    assert not store.asset_visible_to_post(project.id, only_a.id, post_b.id)


def test_delete_post_removes_post_scoped_assets(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Cleanup"))
    post = store.create_post(
        project.id,
        CreatePostRequest(name="Temp", type=ProjectType.IMAGE, target_format="portrait"),
    )
    img = tmp_path / "x.jpg"
    _make_image(img)
    shared = store.add_asset(project.id, "shared.jpg", img.read_bytes(), apply_logo=False)
    private = store.add_asset(
        project.id, "private.jpg", img.read_bytes(), apply_logo=False, post_id=post.id
    )
    store.delete_post(project.id, post.id)
    project = store.get_project(project.id)
    ids = {a.id for a in project.assets}
    assert shared.id in ids
    assert private.id not in ids


def test_update_asset_scope(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Move"))
    post = store.create_post(
        project.id,
        CreatePostRequest(name="P1", type=ProjectType.IMAGE, target_format="portrait"),
    )
    img = tmp_path / "m.jpg"
    _make_image(img)
    asset = store.add_asset(project.id, "m.jpg", img.read_bytes(), apply_logo=False)
    assert asset.post_id is None
    moved = store.update_asset(project.id, asset.id, post_id=post.id, set_post_id=True)
    assert moved.post_id == post.id
    shared = store.update_asset(project.id, asset.id, post_id=None, set_post_id=True)
    assert shared.post_id is None


def test_rename_asset(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Rename"))
    img = tmp_path / "photo.jpg"
    _make_image(img)
    asset = store.add_asset(project.id, "photo.jpg", img.read_bytes(), apply_logo=False)
    assert asset.name == "photo"
    renamed = store.update_asset(project.id, asset.id, name="  Hero shot  ")
    assert renamed.name == "Hero shot"
    reloaded = store.get_asset(project.id, asset.id)
    assert reloaded.name == "Hero shot"
    # On-disk copy path is unchanged — rename is display metadata only.
    assert reloaded.original_path == asset.original_path
    assert store.resolve_asset_path(project.id, reloaded.original_path).exists()


def test_migrate_legacy_singular_post(tmp_path: Path):
    store = _store(tmp_path)
    project_id = "legacy-campaign"
    pdir = tmp_path / "projects" / project_id
    pdir.mkdir(parents=True)
    (pdir / "assets").mkdir()
    legacy = {
        "id": project_id,
        "name": "Legacy Campaign",
        "type": "image",
        "created_at": "2024-01-01T00:00:00+00:00",
        "updated_at": "2024-01-02T00:00:00+00:00",
        "assets": [],
        "post": {
            "target_format": "square",
            "background_format": "square",
            "background_asset_id": None,
            "layers": [
                {
                    "id": "layer1",
                    "type": "text",
                    "text": "Hello",
                    "x": 10,
                    "y": 10,
                    "width": 80,
                    "height": 20,
                }
            ],
            "scenes": [],
        },
    }
    import json

    (pdir / "project.json").write_text(json.dumps(legacy, indent=2), encoding="utf-8")

    project = store.get_project(project_id)
    assert len(project.assets) == 0
    assert len(project.posts) == 1
    post = project.posts[0]
    assert post.type == ProjectType.IMAGE
    assert post.target_format == "square"
    assert post.layers[0].text == "Hello"

    meta = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    assert "post" not in meta
    assert "type" not in meta
    post_file = pdir / "posts" / post.id / "post.json"
    assert post_file.exists()


def test_resolve_export_size_uses_format_defaults(tmp_path: Path):
    from content_sprout.render import resolve_export_size

    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Size"))
    post = store.create_post(
        project.id,
        CreatePostRequest(name="Portrait", type=ProjectType.IMAGE, target_format="portrait"),
    )
    project = store.get_project(project.id)
    w, h = resolve_export_size(store, project, post)
    assert w == 1080
    assert h == 1350
    assert w % 2 == 0 and h % 2 == 0


def test_resolve_export_size_video_ignores_still_images(tmp_path: Path):
    """Video posts without video media use format preset, not still pixel size."""
    from content_sprout.models import Layer, Scene
    from content_sprout.render import resolve_export_size

    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="VidSize"))
    post = store.create_post(
        project.id,
        CreatePostRequest(name="Reel", type=ProjectType.VIDEO, target_format="story"),
    )
    # Small still that would otherwise shrink export if used as ceiling.
    tiny = Image.new("RGB", (320, 240), (10, 20, 30))
    buf = __import__("io").BytesIO()
    tiny.save(buf, format="JPEG")
    asset = store.add_asset(project.id, "tiny.jpg", buf.getvalue(), post_id=post.id)
    post = store.get_post(project.id, post.id)
    post.scenes = [
        Scene(
            name="Scene 1",
            duration_s=3.0,
            background_asset_id=asset.id,
            layers=[Layer(type="image", asset_id=asset.id, width=50, height=50)],
        )
    ]
    post = store.update_post(project.id, post.id, post)
    project = store.get_project(project.id)

    w, h = resolve_export_size(store, project, post)
    assert (w, h) == (1080, 1920)


def test_project_logos_stored_as_assets(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Branded"))

    dark_short = tmp_path / "dark_short.png"
    dark_full = tmp_path / "dark_full.png"
    light_short = tmp_path / "light_short.png"
    light_full = tmp_path / "light_full.png"
    Image.new("RGBA", (40, 40), (20, 20, 20, 255)).save(dark_short)
    Image.new("RGBA", (160, 40), (20, 20, 20, 255)).save(dark_full)
    Image.new("RGBA", (40, 40), (240, 240, 240, 255)).save(light_short)
    Image.new("RGBA", (160, 40), (240, 240, 240, 255)).save(light_full)

    store.set_project_logo(project.id, "dark_short", "dark_short.png", dark_short.read_bytes())
    store.set_project_logo(project.id, "dark_full", "dark_full.png", dark_full.read_bytes())
    store.set_project_logo(project.id, "light_short", "light_short.png", light_short.read_bytes())
    store.set_project_logo(project.id, "light_full", "light_full.png", light_full.read_bytes())
    project = store.get_project(project.id)

    assert project.logo_dark_short_asset_id
    assert project.logo_dark_full_asset_id
    assert project.logo_light_short_asset_id
    assert project.logo_light_full_asset_id
    for path in (
        project.logo_dark_short_path,
        project.logo_dark_full_path,
        project.logo_light_short_path,
        project.logo_light_full_path,
    ):
        assert path and path.startswith("assets/")
        assert (tmp_path / "projects" / project.id / path).exists()

    short_asset = next(a for a in project.assets if a.id == project.logo_dark_short_asset_id)
    assert short_asset.name == "Dark short logo"
    assert short_asset.group == "Branding"
    assert short_asset.original_path == project.logo_dark_short_path
    assert "thumb" in (short_asset.processed_formats or {})
    assert "Branding" in project.asset_groups

    logos = store.resolve_logos_for_project(project.id)
    assert logos is not None

    store.clear_project_logos(
        project.id,
        clear_dark_short=True,
        clear_dark_full=True,
        clear_light_short=True,
        clear_light_full=True,
    )
    project = store.get_project(project.id)
    assert project.logo_dark_short_path is None
    assert project.logo_dark_full_path is None
    assert project.logo_light_short_path is None
    assert project.logo_light_full_path is None
    # Assets remain available in the Branding library
    assert any(a.name == "Dark short logo" and a.group == "Branding" for a in project.assets)
    assert store.resolve_logos_for_project(project.id) is not None


def test_new_project_seeds_branding_group(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Fresh"))
    assert project.asset_groups == ["Branding"]


def test_logo_assets_synced_into_branding_on_load(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Sync"))
    dark = tmp_path / "d.png"
    Image.new("RGBA", (32, 32), (0, 0, 0, 255)).save(dark)
    store.set_project_logo(project.id, "dark_short", "d.png", dark.read_bytes())
    project = store.get_project(project.id)
    asset = next(a for a in project.assets if a.id == project.logo_dark_short_asset_id)
    asset.group = ""
    store._save_project_meta(project)

    reloaded = store.get_project(project.id)
    synced = next(a for a in reloaded.assets if a.id == reloaded.logo_dark_short_asset_id)
    assert synced.group == "Branding"
    assert "Branding" in reloaded.asset_groups
    assert "thumb" in (synced.processed_formats or {})


def test_legacy_short_full_logos_migrate_to_dark(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="Legacy"))
    pfile = tmp_path / "projects" / project.id / "project.json"
    data = json.loads(pfile.read_text())
    # Simulate pre-migration project.json with short/full only.
    asset_dir = tmp_path / "projects" / project.id / "assets" / "legacy01"
    asset_dir.mkdir(parents=True)
    Image.new("RGBA", (32, 32), (0, 0, 0, 255)).save(asset_dir / "original.png")
    data["assets"] = [
        {
            "id": "legacy01",
            "name": "Short logo",
            "type": "image",
            "status": "ready",
            "original_filename": "logo_short.png",
            "original_path": "assets/legacy01/original.png",
            "group": "Branding",
            "apply_logo": False,
            "created_at": project.created_at,
            "updated_at": project.updated_at,
        }
    ]
    data["logo_short_asset_id"] = "legacy01"
    data["logo_short_path"] = "assets/legacy01/original.png"
    pfile.write_text(json.dumps(data, indent=2))

    loaded = store.get_project(project.id)
    assert loaded.logo_dark_short_path == "assets/legacy01/original.png"
    assert loaded.logo_dark_short_asset_id == "legacy01"
    assert loaded.logo_light_short_path is None
    logos = store.resolve_logos_for_project(project.id)
    assert logos is not None


def test_download_assets_zip_includes_tts_audio(tmp_path: Path):
    from io import BytesIO

    import zipfile
    from fastapi.testclient import TestClient

    from content_sprout.web import create_app

    store = _store(tmp_path)
    cfg = store.cfg
    app = create_app(cfg=cfg, config_path=tmp_path / "config.yaml")
    client = TestClient(app)

    project = store.create_project(CreateProjectRequest(name="Downloads"))
    buf = BytesIO()
    Image.new("RGB", (40, 40), (10, 20, 30)).save(buf, format="JPEG")
    store.add_asset(project.id, "photo.jpg", buf.getvalue(), apply_logo=False)
    audio = store.add_generated_audio(
        project.id,
        name="Narration",
        data=b"RIFF....WAVEfmt ",
        filename="speech.wav",
    )

    empty = client.get("/api/projects/missing/assets/zip")
    assert empty.status_code == 404

    z = client.get(f"/api/projects/{project.id}/assets/zip")
    assert z.status_code == 200
    assert "application/zip" in z.headers.get("content-type", "")
    names = zipfile.ZipFile(BytesIO(z.content)).namelist()
    assert any(n.startswith("image/") and "photo.jpg" in n for n in names)
    assert any(n.startswith("audio/") and "speech.wav" in n for n in names)

    one = client.get(f"/api/projects/{project.id}/assets/{audio.id}/download")
    assert one.status_code == 200
    assert "speech.wav" in (one.headers.get("content-disposition") or "")
    assert one.content.startswith(b"RIFF")
