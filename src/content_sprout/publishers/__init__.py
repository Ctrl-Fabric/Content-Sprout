"""Dispatch post exports to platform publishers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import facebook, instagram, linkedin, telegram, tiktok, x_twitter, youtube
from .common import PublishError, PublishResult

__all__ = ["PublishError", "PublishResult", "can_publish", "publish_export"]


def can_publish(
    platform: str,
    *,
    account: Any,
    account_creds: dict[str, str],
    platform_creds: dict[str, str],
    ig_session: Any = None,
    ig_cfg: Any = None,
) -> bool:
    platform = str(platform or "").strip().lower()
    if platform == "telegram":
        return telegram.can_publish(account, account_creds, platform_creds)
    if platform == "youtube":
        return youtube.can_publish(account, account_creds, platform_creds)
    if platform == "facebook":
        return facebook.can_publish(account, account_creds, platform_creds)
    if platform == "instagram":
        return instagram.can_publish(
            account, account_creds, platform_creds, ig_session=ig_session, ig_cfg=ig_cfg
        )
    if platform == "tiktok":
        return tiktok.can_publish(account, account_creds, platform_creds)
    if platform == "linkedin":
        return linkedin.can_publish(account, account_creds, platform_creds)
    if platform == "x":
        return x_twitter.can_publish(account, account_creds, platform_creds)
    return False


async def publish_export(
    platform: str,
    *,
    export_path: Path,
    title: str,
    caption: str,
    account: Any,
    account_creds: dict[str, str],
    platform_creds: dict[str, str],
    ig_cfg: Any = None,
    ig_session: Any = None,
    output_root: Path | None = None,
    cache_dir: Path | None = None,
    project_id: str = "",
    post_id: str = "",
) -> PublishResult:
    platform = str(platform or "").strip().lower()
    kwargs: dict[str, Any] = {
        "export_path": export_path,
        "title": title,
        "caption": caption,
        "account": account,
        "account_creds": account_creds,
        "platform_creds": platform_creds,
        "ig_cfg": ig_cfg,
        "ig_session": ig_session,
        "output_root": output_root,
        "cache_dir": cache_dir,
        "project_id": project_id,
        "post_id": post_id,
    }
    if platform == "telegram":
        return await telegram.publish(**kwargs)
    if platform == "youtube":
        return await youtube.publish(**kwargs)
    if platform == "facebook":
        return await facebook.publish(**kwargs)
    if platform == "instagram":
        return await instagram.publish(**kwargs)
    if platform == "tiktok":
        return await tiktok.publish(**kwargs)
    if platform == "linkedin":
        return await linkedin.publish(**kwargs)
    if platform == "x":
        return await x_twitter.publish(**kwargs)
    raise PublishError(f"No automated publisher for {platform}.")
