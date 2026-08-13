"""X (Twitter) media upload v1.1 + tweet v2."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from .common import PublishError, PublishResult, first_nonempty, media_kind, mime_for

UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json"
TWEET_URL = "https://api.twitter.com/2/tweets"
CHUNK = 4 * 1024 * 1024


def _pct(value: str) -> str:
    return quote(str(value), safe="-._~")


def oauth1_header(
    *,
    method: str,
    url: str,
    consumer_key: str,
    consumer_secret: str,
    token: str,
    token_secret: str,
    extra: dict[str, str] | None = None,
) -> str:
    oauth = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": token,
        "oauth_version": "1.0",
    }
    all_params = {**(extra or {}), **oauth}
    encoded = sorted((_pct(k), _pct(v)) for k, v in all_params.items())
    param_str = "&".join(f"{k}={v}" for k, v in encoded)
    base = "&".join([method.upper(), _pct(url.split("?")[0]), _pct(param_str)])
    signing_key = f"{_pct(consumer_secret)}&{_pct(token_secret)}"
    digest = hmac.new(signing_key.encode(), base.encode(), hashlib.sha1).digest()
    oauth["oauth_signature"] = base64.b64encode(digest).decode()
    parts = [f'{_pct(k)}="{_pct(v)}"' for k, v in sorted(oauth.items())]
    return "OAuth " + ", ".join(parts)


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
    consumer_key = first_nonempty(platform_creds.get("api_key"))
    consumer_secret = first_nonempty(platform_creds.get("api_secret"))
    token = first_nonempty(account_creds.get("access_token"))
    token_secret = first_nonempty(account_creds.get("access_token_secret"))
    if not all([consumer_key, consumer_secret, token, token_secret]):
        raise PublishError(
            "X needs API key/secret in Settings and access token + token secret on the account."
        )
    kind = media_kind(export_path)
    media_id = await _upload_media(
        export_path=export_path,
        kind=kind,
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        token=token,
        token_secret=token_secret,
    )
    text = (caption or title or "").strip()[:280]
    if not text:
        text = export_path.stem[:280]
    auth = oauth1_header(
        method="POST",
        url=TWEET_URL,
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        token=token,
        token_secret=token_secret,
    )
    timeout = httpx.Timeout(60.0, connect=20.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            TWEET_URL,
            headers={"Authorization": auth, "Content-Type": "application/json"},
            json={"text": text, "media": {"media_ids": [media_id]}},
        )
    try:
        payload = resp.json()
    except ValueError:
        payload = {"raw": resp.text}
    if resp.is_error:
        detail = payload.get("detail") if isinstance(payload, dict) else None
        errors = payload.get("errors") if isinstance(payload, dict) else None
        msg = detail or (errors[0].get("message") if isinstance(errors, list) and errors else resp.text[:300])
        raise PublishError(f"X tweet failed: {msg}")
    data = payload.get("data") if isinstance(payload, dict) else {}
    tweet_id = str((data or {}).get("id") or "")
    handle = str(getattr(account, "handle", "") or "").lstrip("@")
    remote_url = f"https://x.com/{handle}/status/{tweet_id}" if handle and tweet_id else (
        f"https://x.com/i/web/status/{tweet_id}" if tweet_id else ""
    )
    return PublishResult(
        remote_id=tweet_id,
        remote_url=remote_url,
        message="Posted to X",
        extra={"media_id": media_id},
    )


async def _upload_media(
    *,
    export_path: Path,
    kind: str,
    consumer_key: str,
    consumer_secret: str,
    token: str,
    token_secret: str,
) -> str:
    size = export_path.stat().st_size
    media_type = mime_for(export_path)
    category = "tweet_video" if kind == "video" else "tweet_image"
    timeout = httpx.Timeout(180.0, connect=30.0)
    init_params = {
        "command": "INIT",
        "total_bytes": str(size),
        "media_type": media_type,
        "media_category": category,
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        init = await client.post(
            UPLOAD_URL,
            params=init_params,
            headers={
                "Authorization": oauth1_header(
                    method="POST",
                    url=UPLOAD_URL,
                    consumer_key=consumer_key,
                    consumer_secret=consumer_secret,
                    token=token,
                    token_secret=token_secret,
                    extra=init_params,
                )
            },
        )
        init_payload = _json(init, "X media INIT")
        media_id = str(init_payload.get("media_id_string") or init_payload.get("media_id") or "")
        if not media_id:
            raise PublishError("X media INIT did not return media_id.")
        with export_path.open("rb") as fh:
            index = 0
            while True:
                chunk = fh.read(CHUNK)
                if not chunk:
                    break
                append_params = {
                    "command": "APPEND",
                    "media_id": media_id,
                    "segment_index": str(index),
                }
                append = await client.post(
                    UPLOAD_URL,
                    data=append_params,
                    files={"media": ("blob", chunk, media_type)},
                    headers={
                        "Authorization": oauth1_header(
                            method="POST",
                            url=UPLOAD_URL,
                            consumer_key=consumer_key,
                            consumer_secret=consumer_secret,
                            token=token,
                            token_secret=token_secret,
                        )
                    },
                )
                if append.is_error:
                    raise PublishError(f"X media APPEND failed ({append.status_code}): {append.text[:300]}")
                index += 1
        finalize_params = {"command": "FINALIZE", "media_id": media_id}
        finalized = await client.post(
            UPLOAD_URL,
            params=finalize_params,
            headers={
                "Authorization": oauth1_header(
                    method="POST",
                    url=UPLOAD_URL,
                    consumer_key=consumer_key,
                    consumer_secret=consumer_secret,
                    token=token,
                    token_secret=token_secret,
                    extra=finalize_params,
                )
            },
        )
        fin = _json(finalized, "X media FINALIZE")
        processing = fin.get("processing_info") if isinstance(fin.get("processing_info"), dict) else None
        while processing:
            state = str(processing.get("state") or "")
            if state == "succeeded":
                break
            if state == "failed":
                raise PublishError("X media processing failed.")
            wait = int(processing.get("check_after_secs") or 2)
            await asyncio.sleep(max(1, wait))
            status_params = {"command": "STATUS", "media_id": media_id}
            status = await client.get(
                UPLOAD_URL,
                params=status_params,
                headers={
                    "Authorization": oauth1_header(
                        method="GET",
                        url=UPLOAD_URL,
                        consumer_key=consumer_key,
                        consumer_secret=consumer_secret,
                        token=token,
                        token_secret=token_secret,
                        extra=status_params,
                    )
                },
            )
            st = _json(status, "X media STATUS")
            processing = st.get("processing_info") if isinstance(st.get("processing_info"), dict) else None
    return media_id


def can_publish(account: Any, account_creds: dict[str, str], platform_creds: dict[str, str]) -> bool:
    return bool(
        platform_creds.get("api_key")
        and platform_creds.get("api_secret")
        and account_creds.get("access_token")
        and account_creds.get("access_token_secret")
    )


def _json(resp: httpx.Response, label: str) -> dict:
    try:
        payload = resp.json()
    except ValueError:
        payload = {"raw": resp.text}
    if resp.is_error:
        raise PublishError(f"{label} failed ({resp.status_code}): {str(payload)[:400]}")
    if not isinstance(payload, dict):
        raise PublishError(f"{label} returned an unexpected response")
    return payload
