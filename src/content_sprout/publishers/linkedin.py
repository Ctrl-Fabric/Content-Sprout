"""LinkedIn UGC photo / video upload."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from .common import PublishError, PublishResult, first_nonempty, media_kind, mime_for

REGISTER_URL = "https://api.linkedin.com/v2/assets?action=registerUpload"
UGC_URL = "https://api.linkedin.com/v2/ugcPosts"


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
    author = first_nonempty(
        account_creds.get("author_urn"),
        getattr(account, "external_id", ""),
    )
    if not token:
        raise PublishError("LinkedIn access token missing. Paste a member token on this account.")
    if not author:
        raise PublishError("LinkedIn author URN missing. Set External ID to urn:li:person:… or urn:li:organization:…")
    if not author.startswith("urn:li:"):
        author = f"urn:li:person:{author}"
    kind = media_kind(export_path)
    recipe = (
        "urn:li:digitalmediaRecipe:feedshare-video"
        if kind == "video"
        else "urn:li:digitalmediaRecipe:feedshare-image"
    )
    timeout = httpx.Timeout(180.0, connect=30.0)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=timeout) as client:
        registered = await client.post(
            REGISTER_URL,
            headers=headers,
            json={
                "registerUploadRequest": {
                    "recipes": [recipe],
                    "owner": author,
                    "serviceRelationships": [
                        {
                            "relationshipType": "OWNER",
                            "identifier": "urn:li:userGeneratedContent",
                        }
                    ],
                }
            },
        )
        payload = _json(registered, "LinkedIn register upload")
        value = payload.get("value") if isinstance(payload.get("value"), dict) else {}
        asset = str(value.get("asset") or "")
        upload_mech = (
            (value.get("uploadMechanism") or {})
            .get("com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest")
            or {}
        )
        upload_url = str(upload_mech.get("uploadUrl") or "")
        if not asset or not upload_url:
            raise PublishError("LinkedIn did not return an upload URL. Check token scopes (w_member_social).")
        with export_path.open("rb") as fh:
            put = await client.put(
                upload_url,
                content=fh.read(),
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": mime_for(export_path),
                },
            )
        if put.is_error:
            raise PublishError(f"LinkedIn binary upload failed ({put.status_code}): {put.text[:300]}")
        category = "VIDEO" if kind == "video" else "IMAGE"
        commentary = (caption or title or "").strip() or export_path.stem
        created = await client.post(
            UGC_URL,
            headers=headers,
            json={
                "author": author,
                "lifecycleState": "PUBLISHED",
                "specificContent": {
                    "com.linkedin.ugc.ShareContent": {
                        "shareCommentary": {"text": commentary[:3000]},
                        "shareMediaCategory": category,
                        "media": [
                            {
                                "status": "READY",
                                "description": {"text": (title or export_path.stem)[:200]},
                                "media": asset,
                                "title": {"text": (title or export_path.stem)[:200]},
                            }
                        ],
                    }
                },
                "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"},
            },
        )
        ugc = _json(created, "LinkedIn create post")
    remote_id = str(ugc.get("id") or asset)
    return PublishResult(
        remote_id=remote_id,
        message="Published to LinkedIn",
        extra={"asset": asset},
    )


def can_publish(account: Any, account_creds: dict[str, str], platform_creds: dict[str, str]) -> bool:
    token = bool(account_creds.get("access_token"))
    author = first_nonempty(account_creds.get("author_urn"), getattr(account, "external_id", ""))
    return bool(token and author)


def _json(resp: httpx.Response, label: str) -> dict:
    try:
        payload = resp.json()
    except ValueError:
        payload = {"raw": resp.text}
    if resp.is_error:
        msg = ""
        if isinstance(payload, dict):
            msg = str(payload.get("message") or payload.get("error") or payload)[:400]
        raise PublishError(f"{label} failed ({resp.status_code}): {msg or resp.text[:300]}")
    if not isinstance(payload, dict):
        raise PublishError(f"{label} returned an unexpected response")
    return payload
