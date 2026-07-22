"""Facebook Login for Business — connect an Instagram Professional account."""

from __future__ import annotations

from urllib.parse import urlencode

from ..config import InstagramConfig
from .client import GraphClient
from .store import InstagramSession

OAUTH_SCOPES = [
    "instagram_basic",
    "instagram_content_publish",
    "pages_show_list",
    "pages_read_engagement",
]


def oauth_authorize_url(cfg: InstagramConfig, state: str) -> str:
    if not cfg.app_id:
        raise ValueError("instagram.app_id is not configured.")
    params = {
        "client_id": cfg.app_id,
        "redirect_uri": cfg.oauth_redirect_uri,
        "state": state,
        "scope": ",".join(OAUTH_SCOPES),
        "response_type": "code",
    }
    return f"https://www.facebook.com/{cfg.graph_api_version}/dialog/oauth?{urlencode(params)}"


async def exchange_code_for_session(cfg: InstagramConfig, code: str) -> InstagramSession:
    if not cfg.app_id or not cfg.app_secret:
        raise ValueError("instagram.app_id and instagram.app_secret are required.")

    client = GraphClient(cfg)
    token_resp = await client.get(
        "oauth/access_token",
        params={
            "client_id": cfg.app_id,
            "client_secret": cfg.app_secret,
            "redirect_uri": cfg.oauth_redirect_uri,
            "code": code,
        },
    )
    short_token = token_resp["access_token"]

    long_resp = await client.get(
        "oauth/access_token",
        params={
            "grant_type": "fb_exchange_token",
            "client_id": cfg.app_id,
            "client_secret": cfg.app_secret,
            "fb_exchange_token": short_token,
        },
    )
    user_token = long_resp["access_token"]
    expires_in = long_resp.get("expires_in")

    pages = await client.get(
        "me/accounts",
        params={
            "fields": "id,name,access_token,instagram_business_account{id,username}",
            "access_token": user_token,
        },
    )
    page_list = pages.get("data", [])
    if not page_list:
        raise ValueError(
            "No Facebook Pages found. Link your Instagram Professional account to a Page first."
        )

    chosen = None
    for page in page_list:
        ig = (page.get("instagram_business_account") or {})
        if ig.get("id"):
            chosen = (page, ig)
            break
    if not chosen:
        raise ValueError(
            "No Instagram Professional account linked to your Facebook Pages. "
            "Connect Instagram to a Page in the Instagram app, then try again."
        )

    page, ig = chosen
    expires_at = None
    if expires_in:
        from datetime import UTC, datetime, timedelta

        expires_at = (datetime.now(UTC) + timedelta(seconds=int(expires_in))).isoformat()

    return InstagramSession(
        page_id=str(page["id"]),
        page_name=str(page.get("name", "")),
        page_access_token=str(page["access_token"]),
        ig_user_id=str(ig["id"]),
        ig_username=str(ig.get("username", "")),
        token_expires_at=expires_at,
    )
