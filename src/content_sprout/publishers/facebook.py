"""Facebook Page photo / video upload via Graph API."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from .common import PublishError, PublishResult, first_nonempty, media_kind, mime_for

GRAPH_VERSION = "v21.0"


async def publish(
    *,
    export_path: Path,
    title: str,
    caption: str,
    account: Any,
    account_creds: dict[str, str],
    platform_creds: dict[str, str],
    **_kwargs: Any,
) -> PublishResult:
    token = first_nonempty(account_creds.get("page_access_token"), platform_creds.get("page_access_token"))
    page_id = first_nonempty(
        account_creds.get("page_id"),
        getattr(account, "external_id", ""),
    )
    if not token or not page_id:
        raise PublishError(
            "Facebook Page id and page access token are required. "
            "Set External ID to the Page id and paste the token on the account."
        )
    kind = media_kind(export_path)
    text = (caption or title or "").strip()
    timeout = httpx.Timeout(300.0, connect=30.0)
    if kind == "video":
        url = f"https://graph-video.facebook.com/{GRAPH_VERSION}/{page_id}/videos"
        data = {"access_token": token, "description": text, "title": (title or export_path.stem)[:255]}
        field = "source"
    else:
        url = f"https://graph.facebook.com/{GRAPH_VERSION}/{page_id}/photos"
        data = {"access_token": token, "caption": text}
        field = "source"
    async with httpx.AsyncClient(timeout=timeout) as client:
        with export_path.open("rb") as fh:
            resp = await client.post(
                url,
                data=data,
                files={field: (export_path.name, fh, mime_for(export_path))},
            )
    try:
        payload = resp.json()
    except ValueError as exc:
        raise PublishError(f"Facebook returned a non-JSON response ({resp.status_code})") from exc
    if resp.is_error or (isinstance(payload, dict) and payload.get("error")):
        err = (payload or {}).get("error") if isinstance(payload, dict) else {}
        msg = err.get("message") if isinstance(err, dict) else resp.text
        raise PublishError(f"Facebook upload failed: {msg}")
    remote_id = str(payload.get("id") or payload.get("post_id") or "").strip()
    remote_url = ""
    if remote_id:
        remote_url = f"https://www.facebook.com/{remote_id}"
    return PublishResult(
        remote_id=remote_id,
        remote_url=remote_url,
        message="Uploaded to Facebook Page",
    )


def can_publish(account: Any, account_creds: dict[str, str], platform_creds: dict[str, str]) -> bool:
    token = first_nonempty(account_creds.get("page_access_token"), platform_creds.get("page_access_token"))
    page_id = first_nonempty(account_creds.get("page_id"), getattr(account, "external_id", ""))
    return bool(token and page_id)
