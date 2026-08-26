"""Photo Magic documents and GIMP-style layer stacking."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from content_sprout.config import AppConfig, LlmProviderConfig
from content_sprout.photo_magic import (
    PhotoMagicLayer,
    PhotoMagicStore,
    SavePhotoMagicDocument,
    SavePhotoMagicLayer,
    insert_layer_above,
    lower_layer,
    lower_layer_to_bottom,
    raise_layer,
    raise_layer_to_top,
    reorder_layers,
    selection_after_delete,
)
from content_sprout.web import create_app


def _layers(*names: str) -> list[PhotoMagicLayer]:
    return [PhotoMagicLayer(id=name.lower(), name=name) for name in names]


def test_gimp_insert_above_selected():
    stack = _layers("Top", "Mid", "Back")
    added = PhotoMagicLayer(id="new", name="New")
    out = insert_layer_above(stack, added, selected_layer_id="mid")
    assert [layer.id for layer in out] == ["top", "new", "mid", "back"]


def test_gimp_insert_with_no_selection_goes_to_top():
    stack = _layers("Top", "Back")
    added = PhotoMagicLayer(id="new", name="New")
    out = insert_layer_above(stack, added, selected_layer_id=None)
    assert [layer.id for layer in out] == ["new", "top", "back"]


def test_gimp_raise_lower_and_extremes():
    stack = _layers("A", "B", "C")
    assert [layer.id for layer in raise_layer(stack, "b")] == ["b", "a", "c"]
    assert [layer.id for layer in raise_layer(stack, "a")] == ["a", "b", "c"]
    assert [layer.id for layer in lower_layer(stack, "b")] == ["a", "c", "b"]
    assert [layer.id for layer in lower_layer(stack, "c")] == ["a", "b", "c"]
    assert [layer.id for layer in raise_layer_to_top(stack, "c")] == ["c", "a", "b"]
    assert [layer.id for layer in lower_layer_to_bottom(stack, "a")] == ["b", "c", "a"]


def test_gimp_reorder_and_delete_selection():
    stack = _layers("A", "B", "C")
    reordered = reorder_layers(stack, ["c", "a", "b"])
    assert [layer.id for layer in reordered] == ["c", "a", "b"]
    remaining = _layers("B", "C")
    assert selection_after_delete(remaining, 0) == "b"
    assert selection_after_delete(_layers("A"), 1) == "a"
    assert selection_after_delete([], 0) is None


def test_store_create_and_gimp_order(tmp_path: Path):
    store = PhotoMagicStore(tmp_path / "pm", scope="global", project_id=None, post_id=None)
    red = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
    doc = store.create_document(name="Hero", source_image=red, source_name="Hero")
    assert doc.layers[0].name == "Hero"
    assert doc.selected_layer_id == doc.layers[0].id

    blue = Image.new("RGBA", (8, 8), (0, 0, 255, 255))
    doc = store.add_layer(doc.id, name="Blue", image=blue)
    assert [layer.name for layer in doc.layers] == ["Blue", "Hero"]
    assert doc.layers[0].id == doc.selected_layer_id

    hero_id = doc.layers[1].id
    doc = store.raise_layer(doc.id, hero_id)
    assert [layer.name for layer in doc.layers] == ["Hero", "Blue"]

    doc = store.lower_layer_to_bottom(doc.id, hero_id)
    assert [layer.name for layer in doc.layers] == ["Blue", "Hero"]

    blue_id = doc.layers[0].id
    doc = store.duplicate_layer(doc.id, blue_id)
    assert [layer.name for layer in doc.layers] == ["Blue copy", "Blue", "Hero"]
    assert doc.layers[0].id == doc.selected_layer_id
    assert doc.layers[0].id != blue_id

    preview = store.render_preview(doc.id)
    assert preview.size == (8, 8)
    # Top layer is opaque blue, so the flatten is blue — not the red background.
    assert preview.getpixel((4, 4))[:3] == (0, 0, 255)


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


def test_photo_magic_api_scopes(tmp_path: Path):
    client = _client(tmp_path)
    png = tmp_path / "src.png"
    Image.new("RGBA", (12, 10), (10, 80, 200, 255)).save(png)

    uploaded = client.post(
        "/api/global-assets",
        files={"file": ("src.png", png.read_bytes(), "image/png")},
        data={"name": "Lake", "asset_type": "photo"},
    )
    assert uploaded.status_code == 200, uploaded.text
    asset_id = uploaded.json()["asset"]["id"]

    created = client.post(
        "/api/photo-magic",
        json={
            "scope": "global",
            "name": "Lake edit",
            "source_asset_id": asset_id,
            "source_asset_scope": "global",
        },
    )
    assert created.status_code == 200, created.text
    doc = created.json()["document"]
    assert doc["scope"] == "global"
    assert doc["width"] == 12
    assert doc["height"] == 10
    assert len(doc["layers"]) == 1
    assert doc["layers"][0]["name"] == "Lake"

    listed = client.get("/api/photo-magic", params={"scope": "global"})
    assert listed.status_code == 200
    assert listed.json()["documents"][0]["id"] == doc["id"]

    added = client.post(
        f"/api/photo-magic/{doc['id']}/layers",
        params={"scope": "global"},
        json={"name": "Overlay", "fill": "white"},
    )
    assert added.status_code == 200, added.text
    layers = added.json()["document"]["layers"]
    assert [layer["name"] for layer in layers] == ["Overlay", "Lake"]

    project = client.post("/api/projects", json={"name": "Campaign"}).json()["project"]
    post = client.post(
        f"/api/projects/{project['id']}/posts",
        json={"name": "Launch", "type": "image"},
    ).json()["post"]

    project_doc = client.post(
        "/api/photo-magic",
        json={
            "scope": "project",
            "project_id": project["id"],
            "name": "Project canvas",
            "width": 64,
            "height": 48,
        },
    )
    assert project_doc.status_code == 200, project_doc.text
    assert project_doc.json()["document"]["scope"] == "project"
    assert project_doc.json()["document"]["project_id"] == project["id"]

    post_doc = client.post(
        "/api/photo-magic",
        json={
            "scope": "post",
            "project_id": project["id"],
            "post_id": post["id"],
            "name": "Post canvas",
            "width": 32,
            "height": 32,
        },
    )
    assert post_doc.status_code == 200, post_doc.text
    assert post_doc.json()["document"]["scope"] == "post"
    assert post_doc.json()["document"]["post_id"] == post["id"]

    scoped = client.get(
        "/api/photo-magic",
        params={"scope": "post", "project_id": project["id"], "post_id": post["id"]},
    )
    assert scoped.status_code == 200
    assert len(scoped.json()["documents"]) == 1
    assert scoped.json()["documents"][0]["name"] == "Post canvas"

    preview = client.get(
        f"/api/photo-magic/{doc['id']}/preview",
        params={"scope": "global"},
    )
    assert preview.status_code == 200
    assert preview.headers["content-type"].startswith("image/png")


def test_replace_stack_commits_working_layers(tmp_path: Path):
    store = PhotoMagicStore(tmp_path / "pm", scope="global", project_id=None, post_id=None)
    red = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
    doc = store.create_document(name="Hero", source_image=red, source_name="Hero")
    kept = doc.layers[0]
    added = SavePhotoMagicLayer(id="newlayer01", name="Blue", width=8, height=8)
    saved = store.replace_stack(
        doc.id,
        SavePhotoMagicDocument(
            name="Hero saved",
            selected_layer_id="newlayer01",
            layers=[
                added,
                SavePhotoMagicLayer(
                    id=kept.id,
                    name=kept.name,
                    width=kept.width,
                    height=kept.height,
                ),
            ],
        ),
        {"newlayer01": Image.new("RGBA", (8, 8), (0, 0, 255, 255))},
    )
    assert saved.name == "Hero saved"
    assert [layer.name for layer in saved.layers] == ["Blue", "Hero"]
    assert saved.selected_layer_id == "newlayer01"
    preview = store.render_preview(saved.id)
    assert preview.getpixel((4, 4))[:3] == (0, 0, 255)


def test_save_api_commits_stack(tmp_path: Path):
    client = _client(tmp_path)
    created = client.post(
        "/api/photo-magic",
        json={"scope": "global", "name": "Draft", "width": 16, "height": 16},
    )
    assert created.status_code == 200, created.text
    doc = created.json()["document"]
    layer = doc["layers"][0]
    png = tmp_path / "overlay.png"
    Image.new("RGBA", (16, 16), (0, 255, 0, 255)).save(png)
    saved = client.put(
        f"/api/photo-magic/{doc['id']}/save",
        params={"scope": "global"},
        data={
            "document": (
                '{"name":"Committed","selected_layer_id":"overlay1",'
                '"layers":['
                '{"id":"overlay1","name":"Green","width":16,"height":16},'
                f'{{"id":"{layer["id"]}","name":"{layer["name"]}","width":16,"height":16}}'
                "]}"
            )
        },
        files={"raster_overlay1": ("overlay.png", png.read_bytes(), "image/png")},
    )
    assert saved.status_code == 200, saved.text
    out = saved.json()["document"]
    assert out["name"] == "Committed"
    assert [item["name"] for item in out["layers"]] == ["Green", layer["name"]]


def test_save_api_commits_canvas_size(tmp_path: Path):
    client = _client(tmp_path)
    created = client.post(
        "/api/photo-magic",
        json={"scope": "global", "name": "Crop me", "width": 32, "height": 32},
    )
    assert created.status_code == 200, created.text
    doc = created.json()["document"]
    layer = doc["layers"][0]
    png = tmp_path / "crop.png"
    Image.new("RGBA", (16, 16), (0, 0, 255, 255)).save(png)
    saved = client.put(
        f"/api/photo-magic/{doc['id']}/save",
        params={"scope": "global"},
        data={
            "document": (
                '{"name":"Cropped","width":16,"height":16,"selected_layer_id":'
                f'"{layer["id"]}","layers":['
                f'{{"id":"{layer["id"]}","name":"{layer["name"]}","width":16,"height":16,'
                '"offset_x":0,"offset_y":0}]}'
            )
        },
        files={f"raster_{layer['id']}": ("crop.png", png.read_bytes(), "image/png")},
    )
    assert saved.status_code == 200, saved.text
    out = saved.json()["document"]
    assert out["width"] == 16
    assert out["height"] == 16
    assert out["layers"][0]["width"] == 16
    assert out["layers"][0]["height"] == 16


def test_save_api_creates_composition_without_prior_file(tmp_path: Path):
    client = _client(tmp_path)
    png = tmp_path / "fresh.png"
    Image.new("RGBA", (12, 12), (255, 128, 0, 255)).save(png)
    saved = client.put(
        "/api/photo-magic/a1b2c3d4e5f6/save",
        params={"scope": "global"},
        data={
            "document": (
                '{"name":"Local first","width":12,"height":12,"selected_layer_id":"layer01",'
                '"layers":[{"id":"layer01","name":"Paint","width":12,"height":12}]}'
            )
        },
        files={"raster_layer01": ("fresh.png", png.read_bytes(), "image/png")},
    )
    assert saved.status_code == 200, saved.text
    out = saved.json()["document"]
    assert out["id"] == "a1b2c3d4e5f6"
    assert out["name"] == "Local first"
    listed = client.get("/api/photo-magic", params={"scope": "global"})
    assert listed.status_code == 200
    assert any(item["id"] == "a1b2c3d4e5f6" for item in listed.json()["documents"])


def test_save_stores_sequential_composition_json(tmp_path: Path):
    client = _client(tmp_path)
    created = client.post(
        "/api/photo-magic",
        json={"scope": "global", "name": "Log", "width": 16, "height": 16},
    )
    assert created.status_code == 200, created.text
    doc = created.json()["document"]
    composition = created.json()["composition"]
    assert composition["instructions"] == []
    assert composition["cursor"] == -1
    assert composition["baseline"]["id"] == doc["id"]
    layer = doc["layers"][0]
    png = tmp_path / "src.png"
    Image.new("RGBA", (16, 16), (9, 9, 9, 255)).save(png)
    steps = [
        {
            "id": "instr01",
            "label": "Rename composition to “Logged”",
            "kind": "rename_doc",
            "name": "Logged",
        },
        {
            "id": "instr02",
            "label": "Hide layer",
            "kind": "patch_layer",
            "layerId": layer["id"],
            "patch": {"visible": False},
        },
    ]
    saved = client.put(
        f"/api/photo-magic/{doc['id']}/save",
        params={"scope": "global"},
        data={
            "document": json.dumps(
                {
                    "name": "Logged",
                    "selected_layer_id": layer["id"],
                    "layers": [
                        {
                            "id": layer["id"],
                            "name": layer["name"],
                            "width": 16,
                            "height": 16,
                        }
                    ],
                }
            ),
            "composition": json.dumps(
                {
                    "baseline": composition["baseline"],
                    "instructions": steps,
                    "cursor": 1,
                }
            ),
        },
        files={
            f"source_{layer['id']}": ("src.png", png.read_bytes(), "image/png"),
            f"raster_{layer['id']}": ("src.png", png.read_bytes(), "image/png"),
        },
    )
    assert saved.status_code == 200, saved.text
    out = saved.json()
    assert out["document"]["name"] == "Logged"
    assert [item["kind"] for item in out["composition"]["instructions"]] == [
        "rename_doc",
        "patch_layer",
    ]
    assert out["composition"]["cursor"] == 1
    opened = client.get(f"/api/photo-magic/{doc['id']}", params={"scope": "global"})
    assert opened.status_code == 200
    assert opened.json()["composition"]["cursor"] == 1
    assert opened.json()["composition"]["instructions"][0]["name"] == "Logged"
    source = client.get(
        f"/api/photo-magic/{doc['id']}/sources/{layer['id']}",
        params={"scope": "global"},
    )
    assert source.status_code == 200
    assert source.headers["content-type"].startswith("image/png")
    stored = (
        tmp_path
        / "global_assets"
        / "photo_magic"
        / doc["id"]
        / "composition.json"
    )
    assert stored.is_file()
    payload = json.loads(stored.read_text())
    assert payload["instructions"][1]["kind"] == "patch_layer"


def test_ai_services_crud_and_capabilities(tmp_path: Path):
    client = _client(tmp_path)
    listed = client.get("/api/ai/services", params={"category": "image"})
    assert listed.status_code == 200
    assert listed.json()["services"] == []

    saved = client.put(
        "/api/ai/services",
        json={
            "services": [
                {
                    "id": "img01",
                    "name": "Local editor",
                    "category": "image",
                    "host": "local",
                    "protocol": "openai_images",
                    "enabled": True,
                    "base_url": "http://127.0.0.1:9999/v1",
                    "model": "gpt-image-1",
                    "timeout_s": 120,
                },
                {
                    "id": "vid01",
                    "name": "Local Comfy",
                    "category": "video",
                    "host": "local",
                    "protocol": "comfyui",
                    "enabled": True,
                    "base_url": "http://127.0.0.1:8188",
                    "timeout_s": 600,
                },
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    services = saved.json()["services"]
    assert any(item["id"] == "img01" for item in services)
    assert any(item["id"] == "vid01" for item in services)

    caps = client.get("/api/ai/capabilities")
    assert caps.status_code == 200
    body = caps.json()
    assert any(item["id"] == "img01" for item in body["image_services"])
    assert any(item["id"] == "vid01" for item in body["video_services"])
    # Not ready until the endpoint is reachable / keys valid — still listed when enabled.
    settings = client.get("/api/llm/settings")
    assert settings.status_code == 200
    assert any(item["id"] == "img01" for item in settings.json().get("ai_services", []))


def test_photo_magic_ai_edit_requires_ready_service(tmp_path: Path):
    client = _client(tmp_path)
    created = client.post(
        "/api/photo-magic",
        json={"scope": "global", "name": "AI", "width": 8, "height": 8},
    )
    assert created.status_code == 200, created.text
    doc = created.json()["document"]
    png = tmp_path / "in.png"
    Image.new("RGBA", (8, 8), (10, 20, 30, 255)).save(png)
    edited = client.post(
        f"/api/photo-magic/{doc['id']}/ai-edit",
        params={"scope": "global"},
        data={"instruction": "Make it warmer", "service_id": ""},
        files={"file": ("in.png", png.read_bytes(), "image/png")},
    )
    assert edited.status_code == 400
    assert "image ai service" in edited.json()["detail"].lower()


def test_layer_can_sit_halfway_outside_canvas(tmp_path: Path):
    store = PhotoMagicStore(tmp_path / "pm", scope="global", project_id=None, post_id=None)
    red = Image.new("RGBA", (16, 16), (255, 0, 0, 255))
    doc = store.create_document(name="Shift", source_image=red, source_name="Red")
    layer = doc.layers[0]
    saved = store.replace_stack(
        doc.id,
        SavePhotoMagicDocument(
            width=16,
            height=16,
            layers=[
                SavePhotoMagicLayer(
                    id=layer.id,
                    name=layer.name,
                    width=16,
                    height=16,
                    offset_x=-8,
                    offset_y=0,
                )
            ],
        ),
        {layer.id: red},
    )
    preview = store.render_preview(saved.id)
    assert preview.getpixel((0, 8))[:3] == (255, 0, 0)
    assert preview.getpixel((15, 8))[3] == 0


def test_layer_mask_hides_pixels(tmp_path: Path):
    store = PhotoMagicStore(tmp_path / "pm", scope="global", project_id=None, post_id=None)
    white = Image.new("RGBA", (8, 8), (255, 255, 255, 255))
    mask = Image.new("L", (8, 8), 0)
    for y in range(8):
        for x in range(4, 8):
            mask.putpixel((x, y), 255)
    doc = store.create_document(name="Masked", source_image=white, source_name="White")
    layer = doc.layers[0]
    saved = store.replace_stack(
        doc.id,
        SavePhotoMagicDocument(
            layers=[
                SavePhotoMagicLayer(
                    id=layer.id,
                    name=layer.name,
                    width=8,
                    height=8,
                    has_mask=True,
                    mask_enabled=True,
                    opacity=0.5,
                )
            ],
        ),
        {layer.id: white},
        {layer.id: mask},
    )
    assert saved.layers[0].has_mask
    preview = store.render_preview(saved.id)
    assert preview.getpixel((1, 4))[3] == 0
    pixel = preview.getpixel((6, 4))
    assert pixel[0] == pixel[1] == pixel[2]
    assert 0 < pixel[3] < 255
