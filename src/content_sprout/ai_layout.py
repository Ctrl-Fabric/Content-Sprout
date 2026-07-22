"""Validate and sanitize LLM-proposed post layouts."""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from .models import Asset, Layer, Post, Project, ProjectType, Scene


def _collect_asset_ids(project: Project, post_id: str | None = None) -> set[str]:
    """Ids visible to a post: project-level + that post's assets."""
    from .projects import ProjectStore

    return {a.id for a in ProjectStore.visible_assets(project, post_id)}


def _sanitize_layer(layer: Layer, asset_ids: set[str]) -> Layer:
    data = layer.model_dump()
    if data.get("asset_id") and data["asset_id"] not in asset_ids:
        data["asset_id"] = None
    data["x"] = max(0.0, min(100.0, float(data.get("x", 0))))
    data["y"] = max(0.0, min(100.0, float(data.get("y", 0))))
    data["width"] = max(1.0, min(100.0, float(data.get("width", 10))))
    data["height"] = max(1.0, min(100.0, float(data.get("height", 10))))
    data["opacity"] = max(0.0, min(1.0, float(data.get("opacity", 1))))
    return Layer.model_validate(data)


def validate_proposed_post(
    proposed: dict[str, Any] | Post,
    *,
    project: Project,
    current: Post,
) -> Post:
    """Validate LLM output as a Post, preserving identity and scrubbing bad refs."""
    if isinstance(proposed, Post):
        raw = proposed.model_dump()
    elif isinstance(proposed, dict):
        raw = dict(proposed)
    else:
        raise ValueError("Proposed layout must be an object")

    # Identity locks
    raw["id"] = current.id
    raw["type"] = current.type.value if isinstance(current.type, ProjectType) else current.type
    raw.setdefault("name", current.name)
    raw.setdefault("created_at", current.created_at)

    try:
        post = Post.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(f"Invalid post layout: {exc.errors()[0]}") from exc

    asset_ids = _collect_asset_ids(project, current.id)

    if post.background_asset_id and post.background_asset_id not in asset_ids:
        post.background_asset_id = current.background_asset_id
    if post.music_asset_id and post.music_asset_id not in asset_ids:
        post.music_asset_id = current.music_asset_id

    post.layers = [_sanitize_layer(layer, asset_ids) for layer in post.layers]

    scenes: list[Scene] = []
    for scene in post.scenes:
        sdata = scene.model_dump()
        if sdata.get("background_asset_id") and sdata["background_asset_id"] not in asset_ids:
            sdata["background_asset_id"] = None
        sdata["layers"] = [
            _sanitize_layer(Layer.model_validate(layer), asset_ids).model_dump()
            for layer in sdata.get("layers") or []
        ]
        scenes.append(Scene.model_validate(sdata))
    post.scenes = scenes

    if post.type == ProjectType.VIDEO and not post.scenes:
        raise ValueError("Video posts must include at least one scene")
    if post.type == ProjectType.IMAGE:
        # Keep scenes empty for image posts
        post.scenes = []

    return post


def prune_unreferenced_media_layers(post: Post) -> Post:
    """Drop image/audio layers that have no asset after sanitization."""

    def _keep(layer: Layer) -> bool:
        if layer.type in ("image", "video", "audio") and not layer.asset_id:
            return False
        return True

    post.layers = [layer for layer in post.layers if _keep(layer)]
    for scene in post.scenes:
        scene.layers = [layer for layer in scene.layers if _keep(layer)]
    return post


def source_asset_from_target(
    project: Project,
    post: Post,
    *,
    asset_id: str | None,
    use_background: bool,
    layer_id: str | None,
) -> Asset:
    """Resolve which image asset the photo-edit should start from."""
    if asset_id:
        for a in project.assets:
            if a.id == asset_id:
                if a.type.value != "image":
                    raise ValueError("Photo edit target must be an image asset")
                if a.post_id and a.post_id != post.id:
                    raise ValueError("Asset belongs to another post")
                return a
        raise ValueError(f"Asset not found: {asset_id}")

    if use_background:
        bg = post.background_asset_id
        if post.type == ProjectType.VIDEO and post.scenes:
            bg = post.scenes[0].background_asset_id or bg
        if not bg:
            raise ValueError("Post has no background asset")
        return source_asset_from_target(project, post, asset_id=bg, use_background=False, layer_id=None)

    if layer_id:
        layers = list(post.layers)
        for scene in post.scenes:
            layers.extend(scene.layers)
        for layer in layers:
            if layer.id == layer_id:
                if not layer.asset_id:
                    raise ValueError("Selected layer has no image asset")
                return source_asset_from_target(
                    project, post, asset_id=layer.asset_id, use_background=False, layer_id=None
                )
        raise ValueError(f"Layer not found: {layer_id}")

    raise ValueError("Specify asset_id, use_background, or layer_id")
