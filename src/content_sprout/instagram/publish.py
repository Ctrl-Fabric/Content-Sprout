"""Publish single-image or carousel posts to Instagram."""

from __future__ import annotations

from urllib.parse import quote

from ..config import InstagramConfig
from .client import GraphClient
from .store import InstagramSession

MAX_CAROUSEL_ITEMS = 10


def public_image_url(cfg: InstagramConfig, relative_path: str) -> str:
    base = cfg.public_base_url.rstrip("/")
    if not base:
        raise ValueError(
            "instagram.public_base_url is not set. Meta must fetch images over public HTTPS "
            "(e.g. run `ngrok http 17829` and set CONTENT_SPROUT_PUBLIC_BASE_URL)."
        )
    return f"{base}/api/output/file?path={quote(relative_path, safe='/')}"


async def publish_post(
    cfg: InstagramConfig,
    session: InstagramSession,
    *,
    image_paths: list[str],
    caption: str,
) -> dict[str, str]:
    """Publish one or more output images (by relative path under output/)."""
    if not image_paths:
        raise ValueError("Select at least one image.")
    if len(image_paths) > MAX_CAROUSEL_ITEMS:
        raise ValueError(f"Instagram supports at most {MAX_CAROUSEL_ITEMS} images per carousel.")

    urls = [public_image_url(cfg, p) for p in image_paths]
    client = GraphClient(cfg)
    token = session.page_access_token
    ig_id = session.ig_user_id

    if len(urls) == 1:
        container = await client.post(
            f"{ig_id}/media",
            data={
                "image_url": urls[0],
                "caption": caption,
                "access_token": token,
            },
        )
        creation_id = str(container["id"])
    else:
        child_ids: list[str] = []
        for url in urls:
            child = await client.post(
                f"{ig_id}/media",
                data={
                    "image_url": url,
                    "is_carousel_item": "true",
                    "access_token": token,
                },
            )
            child_ids.append(str(child["id"]))
        container = await client.post(
            f"{ig_id}/media",
            data={
                "media_type": "CAROUSEL",
                "children": ",".join(child_ids),
                "caption": caption,
                "access_token": token,
            },
        )
        creation_id = str(container["id"])

    published = await client.post(
        f"{ig_id}/media_publish",
        data={"creation_id": creation_id, "access_token": token},
    )
    media_id = str(published["id"])
    return {"media_id": media_id, "creation_id": creation_id}
