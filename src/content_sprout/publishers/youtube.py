"""YouTube Data API v3 resumable upload."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from .common import PublishError, PublishResult, first_nonempty, media_kind, mime_for

YOUTUBE_SCOPES = (
    "https://www.googleapis.com/auth/youtube.upload "
    "https://www.googleapis.com/auth/youtube.readonly"
)
DEFAULT_REDIRECT = "http://127.0.0.1:8000/api/social-publish/youtube/callback"


def oauth_authorize_url(*, client_id: str, redirect_uri: str, state: str) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": YOUTUBE_SCOPES.strip(),
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"


async def exchange_code(
    *,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    code: str,
) -> dict[str, str]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
    payload = _json(resp, "YouTube OAuth")
    refresh = str(payload.get("refresh_token") or "").strip()
    access = str(payload.get("access_token") or "").strip()
    if not refresh and not access:
        raise PublishError("YouTube OAuth did not return tokens. Re-connect with prompt=consent.")
    expires_in = int(payload.get("expires_in") or 0)
    expires_at = ""
    if expires_in:
        expires_at = (datetime.now(UTC) + timedelta(seconds=expires_in)).isoformat()
    channel_id = ""
    if access:
        try:
            channel_id = await _lookup_channel_id(access)
        except PublishError:
            channel_id = ""
    return {
        "refresh_token": refresh,
        "access_token": access,
        "token_expires_at": expires_at,
        "channel_id": channel_id,
    }


async def _lookup_channel_id(access_token: str) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            "https://www.googleapis.com/youtube/v3/channels",
            params={"part": "id,snippet", "mine": "true"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
    payload = _json(resp, "YouTube channels")
    items = payload.get("items") or []
    if not items:
        return ""
    return str(items[0].get("id") or "")


async def _access_token(
    *,
    platform_creds: dict[str, str],
    account_creds: dict[str, str],
    cache_dir: Path | None = None,
    account_id: str = "",
) -> str:
    existing = str(account_creds.get("access_token") or "").strip()
    expires_at = str(account_creds.get("token_expires_at") or "").strip()
    if existing and expires_at:
        try:
            exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if exp > datetime.now(UTC) + timedelta(minutes=2):
                return existing
        except ValueError:
            pass
    refresh = str(account_creds.get("refresh_token") or "").strip()
    app = resolved_app_creds(platform_creds, account_creds)
    client_id = app["client_id"]
    client_secret = app["client_secret"]
    if not refresh:
        if existing:
            return existing
        raise PublishError("YouTube refresh token missing. Connect the account in Media Studio → Accounts.")
    if not client_id or not client_secret:
        raise PublishError(
            "YouTube OAuth client id/secret missing. Add a YouTube Data API v3 client "
            "when setting up the account."
        )
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh,
                "grant_type": "refresh_token",
            },
        )
    payload = _json(resp, "YouTube token refresh")
    access = str(payload.get("access_token") or "").strip()
    if not access:
        raise PublishError("YouTube token refresh failed. Re-connect the account.")
    expires_in = int(payload.get("expires_in") or 0)
    if cache_dir and account_id:
        from .. import social_credentials as creds

        updates = {"access_token": access}
        if expires_in:
            updates["token_expires_at"] = (
                datetime.now(UTC) + timedelta(seconds=expires_in)
            ).isoformat()
        creds.update_account_creds(
            cache_dir, account_id, platform="youtube", updates=updates
        )
    return access


async def publish(
    *,
    export_path: Path,
    title: str,
    caption: str,
    account: Any,
    account_creds: dict[str, str],
    platform_creds: dict[str, str],
    cache_dir: Path | None = None,
    **_kwargs: Any,
) -> PublishResult:
    kind = media_kind(export_path)
    if kind != "video":
        raise PublishError("YouTube upload expects a video export (mp4/mov).")
    access = await _access_token(
        platform_creds=platform_creds,
        account_creds=account_creds,
        cache_dir=cache_dir,
        account_id=str(getattr(account, "id", "") or ""),
    )
    privacy = first_nonempty(account_creds.get("privacy_status"), "unlisted")
    if privacy not in {"public", "unlisted", "private"}:
        privacy = "unlisted"
    snippet_title = (title or export_path.stem)[:100]
    description = (caption or "")[:5000]
    size = export_path.stat().st_size
    timeout = httpx.Timeout(300.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        start = await client.post(
            "https://www.googleapis.com/upload/youtube/v3/videos",
            params={"uploadType": "resumable", "part": "snippet,status"},
            headers={
                "Authorization": f"Bearer {access}",
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Length": str(size),
                "X-Upload-Content-Type": mime_for(export_path),
            },
            json={
                "snippet": {
                    "title": snippet_title,
                    "description": description,
                    "categoryId": "22",
                },
                "status": {
                    "privacyStatus": privacy,
                    "selfDeclaredMadeForKids": False,
                },
            },
        )
        if start.status_code not in {200, 201}:
            raise PublishError(_error_message(start, "YouTube upload init"))
        location = start.headers.get("Location") or start.headers.get("location")
        if not location:
            raise PublishError("YouTube did not return a resumable upload URL.")
        with export_path.open("rb") as fh:
            uploaded = await client.put(
                location,
                content=fh,
                headers={
                    "Authorization": f"Bearer {access}",
                    "Content-Type": mime_for(export_path),
                    "Content-Length": str(size),
                },
            )
    payload = _json(uploaded, "YouTube upload")
    video_id = str(payload.get("id") or "").strip()
    if not video_id:
        raise PublishError("YouTube upload succeeded but no video id was returned.")
    return PublishResult(
        remote_id=video_id,
        remote_url=f"https://youtu.be/{video_id}",
        message=f"Uploaded to YouTube ({privacy})",
    )


def resolved_app_creds(platform_creds: dict[str, str], account_creds: dict[str, str]) -> dict[str, str]:
    """Prefer per-account YouTube Data API v3 client creds, then Settings."""
    return {
        "client_id": first_nonempty(account_creds.get("client_id"), platform_creds.get("client_id")),
        "client_secret": first_nonempty(account_creds.get("client_secret"), platform_creds.get("client_secret")),
        "oauth_redirect_uri": first_nonempty(
            account_creds.get("oauth_redirect_uri"),
            platform_creds.get("oauth_redirect_uri"),
            DEFAULT_REDIRECT,
        ),
    }


def can_publish(account: Any, account_creds: dict[str, str], platform_creds: dict[str, str]) -> bool:
    has_token = bool(account_creds.get("refresh_token") or account_creds.get("access_token"))
    app = resolved_app_creds(platform_creds, account_creds)
    has_app = bool(app["client_id"] and app["client_secret"])
    return has_token and (has_app or bool(account_creds.get("access_token")))


def _json(resp: httpx.Response, label: str) -> dict:
    try:
        payload = resp.json()
    except ValueError:
        payload = {"raw": resp.text}
    if resp.is_error:
        raise PublishError(_error_message(resp, label, payload))
    if not isinstance(payload, dict):
        raise PublishError(f"{label} returned an unexpected response")
    return payload


def _error_message(resp: httpx.Response, label: str, payload: Any = None) -> str:
    if payload is None:
        try:
            payload = resp.json()
        except ValueError:
            payload = {"raw": resp.text}
    err = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(err, dict):
        msg = err.get("message") or err.get("status") or str(err)
        return f"{label} failed: {msg}"
    if isinstance(err, str) and err:
        return f"{label} failed: {err}"
    return f"{label} failed ({resp.status_code})"
