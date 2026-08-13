"""Instagram Graph publisher — stills (existing) and Reels."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from ..instagram import publish as ig_publish
from ..instagram.client import GraphClient, InstagramApiError
from ..instagram.store import InstagramSession
from .common import PublishError, PublishResult, first_nonempty, media_kind


async def publish(
    *,
    export_path: Path,
    title: str,
    caption: str,
    account: Any,
    account_creds: dict[str, str],
    ig_cfg: Any,
    ig_session: InstagramSession | None,
    output_root: Path,
    project_id: str,
    post_id: str,
    **_kwargs: Any,
) -> PublishResult:
    token = first_nonempty(
        account_creds.get("page_access_token"),
        getattr(ig_session, "page_access_token", "") if ig_session else "",
    )
    ig_user_id = first_nonempty(
        account_creds.get("ig_user_id"),
        getattr(account, "external_id", ""),
        getattr(ig_session, "ig_user_id", "") if ig_session else "",
    )
    if not token or not ig_user_id:
        raise PublishError(
            "Instagram is not connected. Connect in Settings → Social publish, "
            "or paste a Page token + IG user id on this account."
        )
    if not ig_cfg or not getattr(ig_cfg, "public_base_url", ""):
        raise PublishError(
            "Instagram Graph publish needs a public HTTPS base URL (ngrok / tunnel) "
            "so Meta can fetch the file. Set it in Settings → Social publish."
        )
    kind = media_kind(export_path)
    text = (caption or title or "").strip()
    rel = _stage_for_public(export_path, output_root, project_id, post_id)
    if kind == "image":
        session = InstagramSession(
            page_id=str(getattr(ig_session, "page_id", "") or "0"),
            page_name=str(getattr(ig_session, "page_name", "") or ""),
            page_access_token=token,
            ig_user_id=ig_user_id,
            ig_username=str(getattr(ig_session, "ig_username", "") or ""),
        )
        try:
            result = await ig_publish.publish_post(
                ig_cfg, session, image_paths=[rel], caption=text
            )
        except (ValueError, InstagramApiError) as exc:
            raise PublishError(str(exc)) from exc
        return PublishResult(
            remote_id=str(result.get("media_id") or ""),
            remote_url=str(result.get("permalink") or result.get("url") or ""),
            message="Published to Instagram",
            extra=result,
        )
    return await _publish_reel(
        ig_cfg=ig_cfg,
        token=token,
        ig_user_id=ig_user_id,
        rel_path=rel,
        caption=text,
    )


async def _publish_reel(
    *,
    ig_cfg: Any,
    token: str,
    ig_user_id: str,
    rel_path: str,
    caption: str,
) -> PublishResult:
    video_url = f"{str(ig_cfg.public_base_url).rstrip('/')}/api/output/file?path={quote(rel_path, safe='/')}"
    client = GraphClient(ig_cfg)
    try:
        container = await client.post(
            f"{ig_user_id}/media",
            data={
                "media_type": "REELS",
                "video_url": video_url,
                "caption": caption,
                "share_to_feed": "true",
                "access_token": token,
            },
        )
        creation_id = str(container.get("id") or "")
        if not creation_id:
            raise PublishError("Instagram did not return a Reels container id.")
        await _wait_container(ig_cfg, creation_id, token)
        published = await client.post(
            f"{ig_user_id}/media_publish",
            data={"creation_id": creation_id, "access_token": token},
        )
    except InstagramApiError as exc:
        raise PublishError(str(exc)) from exc
    media_id = str(published.get("id") or "")
    permalink = ""
    try:
        info = await client.get(
            media_id,
            params={"fields": "permalink", "access_token": token},
        )
        permalink = str(info.get("permalink") or "")
    except InstagramApiError:
        permalink = ""
    return PublishResult(
        remote_id=media_id,
        remote_url=permalink,
        message="Published Instagram Reel",
        extra={"creation_id": creation_id},
    )


async def _wait_container(ig_cfg: Any, creation_id: str, token: str) -> None:
    timeout = httpx.Timeout(60.0, connect=20.0)
    version = getattr(ig_cfg, "graph_api_version", "v21.0")
    url = f"https://graph.facebook.com/{version}/{creation_id}"
    for _ in range(40):
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, params={"fields": "status_code,status", "access_token": token})
        try:
            payload = resp.json()
        except ValueError:
            payload = {}
        code = str((payload or {}).get("status_code") or "").upper()
        if code == "FINISHED":
            return
        if code in {"ERROR", "EXPIRED"}:
            raise PublishError(
                f"Instagram Reels processing failed ({code}): {payload.get('status') or resp.text}"
            )
        await asyncio.sleep(4)
    raise PublishError("Timed out waiting for Instagram to process the Reel.")


def _stage_for_public(export_path: Path, output_root: Path, project_id: str, post_id: str) -> str:
    stage = Path(output_root) / "ig-staging" / project_id / post_id
    stage.mkdir(parents=True, exist_ok=True)
    dest = stage / export_path.name
    shutil.copy2(export_path, dest)
    try:
        return str(dest.relative_to(output_root))
    except ValueError:
        return str(dest)


def can_publish(
    account: Any,
    account_creds: dict[str, str],
    platform_creds: dict[str, str],
    *,
    ig_session: InstagramSession | None = None,
    ig_cfg: Any = None,
) -> bool:
    token = first_nonempty(
        account_creds.get("page_access_token"),
        getattr(ig_session, "page_access_token", "") if ig_session else "",
    )
    ig_user_id = first_nonempty(
        account_creds.get("ig_user_id"),
        getattr(account, "external_id", ""),
        getattr(ig_session, "ig_user_id", "") if ig_session else "",
    )
    public = bool(ig_cfg and getattr(ig_cfg, "public_base_url", ""))
    return bool(token and ig_user_id and public)
