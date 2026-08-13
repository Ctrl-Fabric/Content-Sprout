"""Telegram Bot API publisher (sendPhoto / sendVideo)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from .common import PublishError, PublishResult, first_nonempty, media_kind, mime_for

TELEGRAM_VIDEO_LIMIT = 50 * 1024 * 1024


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
    token = first_nonempty(account_creds.get("bot_token"), platform_creds.get("bot_token"))
    chat_id = first_nonempty(
        account_creds.get("chat_id"),
        getattr(account, "external_id", ""),
        getattr(account, "handle", ""),
    )
    if not token:
        raise PublishError("Telegram bot token missing. Save it on the account or in Settings.")
    if not chat_id:
        raise PublishError("Telegram chat / channel id missing. Set External ID (@channel or numeric id).")

    kind = media_kind(export_path)
    text = (caption or title or "").strip()
    if len(text) > 1024:
        text = text[:1021] + "…"

    if kind == "video" and export_path.stat().st_size > TELEGRAM_VIDEO_LIMIT:
        raise PublishError(
            "Telegram Bot API limits videos to 50MB. Export a smaller file or upload this one manually."
        )

    endpoint = "sendVideo" if kind == "video" else "sendPhoto"
    field = "video" if kind == "video" else "photo"
    url = f"https://api.telegram.org/bot{token}/{endpoint}"
    data = {"chat_id": chat_id, "caption": text, "supports_streaming": "true"}
    timeout = httpx.Timeout(180.0, connect=30.0)
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
        raise PublishError(f"Telegram returned a non-JSON response ({resp.status_code})") from exc
    if not payload.get("ok"):
        desc = payload.get("description") or resp.text
        raise PublishError(f"Telegram upload failed: {desc}")
    result = payload.get("result") or {}
    msg_id = str(result.get("message_id") or "")
    chat = result.get("chat") or {}
    username = str(chat.get("username") or "").strip()
    remote_url = f"https://t.me/{username}/{msg_id}" if username and msg_id else ""
    return PublishResult(
        remote_id=msg_id,
        remote_url=remote_url,
        message=f"Posted to Telegram ({chat_id})",
        extra={"chat_id": str(chat.get("id") or chat_id)},
    )


def can_publish(account: Any, account_creds: dict[str, str], platform_creds: dict[str, str]) -> bool:
    token = first_nonempty(account_creds.get("bot_token"), platform_creds.get("bot_token"))
    chat_id = first_nonempty(
        account_creds.get("chat_id"),
        getattr(account, "external_id", ""),
        getattr(account, "handle", ""),
    )
    return bool(token and chat_id)
