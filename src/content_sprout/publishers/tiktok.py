"""TikTok Content Posting API (FILE_UPLOAD)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from .common import PublishError, PublishResult, first_nonempty, media_kind, mime_for

INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/"
STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/"
PHOTO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/content/init/"
CHUNK = 10 * 1024 * 1024


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
    token = first_nonempty(account_creds.get("access_token"))
    if not token:
        raise PublishError("TikTok access token missing. Paste it on this account after OAuth.")
    kind = media_kind(export_path)
    if kind != "video":
        raise PublishError("TikTok Content Posting currently uploads video exports from this app.")
    privacy = first_nonempty(account_creds.get("privacy_level"), "SELF_ONLY")
    title_text = (caption or title or export_path.stem)[:150]
    size = export_path.stat().st_size
    chunk_size = size if size <= CHUNK else CHUNK
    total_chunks = max(1, (size + chunk_size - 1) // chunk_size)
    timeout = httpx.Timeout(180.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        init = await client.post(
            INIT_URL,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={
                "post_info": {
                    "title": title_text,
                    "privacy_level": privacy,
                    "disable_duet": False,
                    "disable_comment": False,
                    "disable_stitch": False,
                    "video_cover_timestamp_ms": 1000,
                },
                "source_info": {
                    "source": "FILE_UPLOAD",
                    "video_size": size,
                    "chunk_size": chunk_size,
                    "total_chunk_count": total_chunks,
                },
            },
        )
        payload = _json(init, "TikTok init")
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        upload_url = str(data.get("upload_url") or "")
        publish_id = str(data.get("publish_id") or "")
        if not upload_url:
            raise PublishError("TikTok did not return an upload URL. Check app scopes (video.publish).")
        with export_path.open("rb") as fh:
            for index in range(total_chunks):
                start = index * chunk_size
                chunk = fh.read(chunk_size)
                end = start + len(chunk) - 1
                put = await client.put(
                    upload_url,
                    content=chunk,
                    headers={
                        "Content-Type": mime_for(export_path),
                        "Content-Length": str(len(chunk)),
                        "Content-Range": f"bytes {start}-{end}/{size}",
                    },
                )
                if put.is_error:
                    raise PublishError(f"TikTok chunk upload failed ({put.status_code}): {put.text[:300]}")
    return PublishResult(
        remote_id=publish_id,
        message=f"Uploaded to TikTok inbox/publish queue ({privacy})",
        extra={"publish_id": publish_id},
    )


def can_publish(account: Any, account_creds: dict[str, str], platform_creds: dict[str, str]) -> bool:
    return bool(account_creds.get("access_token"))


def _json(resp: httpx.Response, label: str) -> dict:
    try:
        payload = resp.json()
    except ValueError:
        payload = {"raw": resp.text}
    if resp.is_error:
        err = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(err, dict):
            msg = err.get("message") or err.get("code") or str(err)
        else:
            msg = resp.text[:300]
        raise PublishError(f"{label} failed: {msg}")
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        err = payload["error"]
        code = str(err.get("code") or "")
        if code and code not in {"ok", "0"}:
            raise PublishError(f"{label} failed: {err.get('message') or code}")
    if not isinstance(payload, dict):
        raise PublishError(f"{label} returned an unexpected response")
    return payload
