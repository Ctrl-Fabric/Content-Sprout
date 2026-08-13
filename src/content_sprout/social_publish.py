"""Project social accounts helpers for the Upload workflow."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import publishers
from . import social_credentials as creds
from .instagram import store as ig_store
from .models import PublishAttempt, PublishPostRequest
from .publishers.common import PublishError


def enrich_account(
    account: Any,
    *,
    cache_dir: Path,
    ig_cfg: Any = None,
    ig_session: Any = None,
) -> dict:
    data = account.model_dump(mode="json") if hasattr(account, "model_dump") else dict(account)
    platform = str(data.get("platform") or "")
    account_creds = creds.get_account_creds(cache_dir, str(data.get("id") or ""))
    platform_creds = creds.get_platform_creds(cache_dir, platform)
    ready = publishers.can_publish(
        platform,
        account=account,
        account_creds=account_creds,
        platform_creds=platform_creds,
        ig_session=ig_session,
        ig_cfg=ig_cfg,
    )
    view = creds.public_account_view(platform, account_creds)
    data["publish_ready"] = ready
    data["has_credentials"] = bool(view.get("has_credentials"))
    if platform == "youtube":
        yt_app = creds.resolve_youtube_app_creds(cache_dir, str(data.get("id") or ""))
        data["has_app_credentials"] = bool(yt_app.get("client_id") and yt_app.get("client_secret"))
    else:
        data["has_app_credentials"] = bool(view.get("has_app_credentials"))
    data["publish_mode"] = "direct" if ready else "manual"
    if ready:
        data["status"] = "connected"
    elif data.get("status") == "connected":
        data["status"] = "needs_credentials"
    return data


def dump_project_with_publish(project: Any, *, cache_dir: Path, ig_cfg: Any = None) -> dict:
    ig_session = ig_store.load_session(cache_dir) if ig_cfg and getattr(ig_cfg, "enabled", True) else None
    data = project.model_dump(mode="json")
    data["social_accounts"] = [
        enrich_account(a, cache_dir=cache_dir, ig_cfg=ig_cfg, ig_session=ig_session)
        for a in (project.social_accounts or [])
    ]
    return data


async def publish_post_to_social_accounts(
    *,
    store: Any,
    project_id: str,
    post_id: str,
    body: PublishPostRequest,
    ig_cfg: Any,
    output_root: Path,
    cache_dir: Path,
) -> dict:
    """Publish a post export to selected project social accounts."""
    project = store.get_project(project_id)
    post = store.get_post(project_id, post_id)

    accounts_by_id = {a.id: a for a in (project.social_accounts or []) if a.enabled}
    selected = []
    for aid in body.account_ids:
        acc = accounts_by_id.get(str(aid).strip())
        if not acc:
            raise FileNotFoundError(f"Social account not found: {aid}")
        selected.append(acc)
    if not selected:
        raise ValueError("Select at least one enabled social account.")

    export_path = store.latest_post_export(project_id, post_id)
    if export_path is None:
        raise ValueError("No export found for this post. Run Export first, then upload.")

    caption = (body.caption or "").strip() or post.name
    title = (body.title or "").strip() or post.name
    attempts: list[PublishAttempt] = []
    results: list[dict] = []

    ig_session = ig_store.load_session(cache_dir) if ig_cfg and getattr(ig_cfg, "enabled", True) else None

    for acc in selected:
        label = acc.label or acc.handle or acc.platform
        attempt = PublishAttempt(
            account_id=acc.id,
            platform=acc.platform,
            account_label=label,
            caption=caption,
            export_path=str(export_path),
        )
        account_creds = creds.get_account_creds(cache_dir, acc.id)
        platform_creds = creds.get_platform_creds(cache_dir, acc.platform)
        ready = publishers.can_publish(
            acc.platform,
            account=acc,
            account_creds=account_creds,
            platform_creds=platform_creds,
            ig_session=ig_session,
            ig_cfg=ig_cfg,
        )
        if not ready:
            attempt.status = "manual"
            attempt.message = _manual_message(acc, export_path, ig_session=ig_session, ig_cfg=ig_cfg)
            results.append(
                {
                    "account_id": acc.id,
                    "ok": True,
                    "manual": True,
                    "export_path": str(export_path),
                    "message": attempt.message,
                }
            )
            attempts.append(attempt)
            continue
        try:
            published = await publishers.publish_export(
                acc.platform,
                export_path=export_path,
                title=title,
                caption=caption,
                account=acc,
                account_creds=account_creds,
                platform_creds=platform_creds,
                ig_cfg=ig_cfg,
                ig_session=ig_session,
                output_root=output_root,
                cache_dir=cache_dir,
                project_id=project_id,
                post_id=post_id,
            )
            attempt.status = "published"
            attempt.message = published.message or f"Published to {acc.platform}"
            attempt.remote_url = published.remote_url
            results.append(
                {
                    "account_id": acc.id,
                    "ok": True,
                    "remote_id": published.remote_id,
                    "remote_url": published.remote_url,
                    "message": attempt.message,
                    **(published.extra or {}),
                }
            )
        except PublishError as exc:
            attempt.status = "failed"
            attempt.message = str(exc)
            results.append({"account_id": acc.id, "ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            attempt.status = "failed"
            attempt.message = str(exc)
            results.append({"account_id": acc.id, "ok": False, "error": str(exc)})
        attempts.append(attempt)

    platforms = list(dict.fromkeys([*(post.platforms or []), *[a.platform for a in selected]]))
    post.platforms = platforms
    post = store.update_post(project_id, post_id, post)
    post = store.append_publish_attempts(project_id, post_id, attempts)
    project = store.get_project(project_id)
    return {
        "ok": True,
        "title": title,
        "caption": caption,
        "export_path": str(export_path),
        "results": results,
        "attempts": [a.model_dump(mode="json") for a in attempts],
        "post": post.model_dump(mode="json"),
        "project": dump_project_with_publish(project, cache_dir=cache_dir, ig_cfg=ig_cfg),
    }


def _manual_message(acc: Any, export_path: Path, *, ig_session: Any, ig_cfg: Any) -> str:
    label = acc.label or acc.handle or acc.platform
    handle = f" ({acc.handle})" if acc.handle else ""
    if acc.platform == "instagram":
        if not (ig_cfg and getattr(ig_cfg, "public_base_url", "")):
            return (
                "Instagram needs a public HTTPS base URL in Settings so Meta can fetch the file. "
                f"Until then, upload {export_path.name} manually."
            )
        if not ig_session and not acc.external_id:
            return (
                "Instagram is not connected. Connect in Settings or paste credentials on this account, "
                f"or upload {export_path.name} manually to @{acc.handle or label}."
            )
    if acc.platform == "youtube":
        return (
            "YouTube upload needs a YouTube Data API v3 client ID/secret on this account "
            f"and a connected channel. Export ready at {export_path} — upload to {label}{handle}."
        )
    return (
        f"Direct {acc.platform} upload needs credentials on this account (or in Settings). "
        f"Export ready at {export_path} — upload to {label}{handle}."
    )
