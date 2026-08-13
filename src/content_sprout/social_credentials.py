"""Encrypted local vault for social publish credentials.

App-level OAuth client IDs / bot tokens and per-account access tokens live here,
not in project.json. Encryption uses a Fernet key under the cache directory
(same deterrence model as locked stock assets).
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any

from cryptography.fernet import InvalidToken

from . import asset_crypto
from .config import mask_secret

VAULT_FILENAME = "social_credentials.enc"
KEY_FILENAME = "social_creds.key"

# Values that can be shown in the UI (destination IDs, privacy flags).
PUBLIC_ACCOUNT_FIELDS = {
    "chat_id",
    "page_id",
    "channel_id",
    "ig_user_id",
    "open_id",
    "author_urn",
    "privacy_status",
    "privacy_level",
}

SECRET_ACCOUNT_FIELDS = {
    "bot_token",
    "refresh_token",
    "access_token",
    "access_token_secret",
    "page_access_token",
    "token_expires_at",
}

# Masked in UI; blank on update keeps the stored value.
MASKED_ACCOUNT_FIELDS = SECRET_ACCOUNT_FIELDS | {"client_secret"}
KEEP_IF_BLANK_ACCOUNT_FIELDS = MASKED_ACCOUNT_FIELDS | {"client_id", "oauth_redirect_uri"}

SECRET_PLATFORM_FIELDS = {
    "client_id",
    "client_secret",
    "bot_token",
    "api_key",
    "api_secret",
    "client_key",
    "oauth_redirect_uri",
}

PLATFORM_ACCOUNT_FIELDS: dict[str, tuple[str, ...]] = {
    "youtube": (
        "client_id",
        "client_secret",
        "oauth_redirect_uri",
        "refresh_token",
        "access_token",
        "token_expires_at",
        "privacy_status",
        "channel_id",
    ),
    "telegram": ("bot_token", "chat_id"),
    "facebook": ("page_access_token", "page_id"),
    "instagram": ("page_access_token", "ig_user_id"),
    "tiktok": ("access_token", "refresh_token", "open_id", "privacy_level"),
    "linkedin": ("access_token", "author_urn"),
    "x": ("access_token", "access_token_secret"),
    "other": (),
}

PLATFORM_APP_FIELDS: dict[str, tuple[str, ...]] = {
    "youtube": ("client_id", "client_secret", "oauth_redirect_uri"),
    "telegram": ("bot_token",),
    "facebook": (),
    "instagram": (),
    "tiktok": ("client_key", "client_secret"),
    "linkedin": ("client_id", "client_secret"),
    "x": ("api_key", "api_secret"),
    "other": (),
}


def _key_path(cache_dir: Path) -> Path:
    return Path(cache_dir).resolve() / KEY_FILENAME


def _vault_path(cache_dir: Path) -> Path:
    return Path(cache_dir).resolve() / VAULT_FILENAME


def _load_or_create_key(cache_dir: Path) -> bytes:
    path = _key_path(cache_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        raw = path.read_bytes()
        if len(raw) >= 32:
            return raw[:32]
        raise asset_crypto.AssetCryptoError("social_creds.key is corrupt or too short")
    raw = secrets.token_bytes(32)
    path.write_bytes(raw)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return raw


def _empty_vault() -> dict[str, Any]:
    return {"platforms": {}, "accounts": {}}


def load_vault(cache_dir: Path) -> dict[str, Any]:
    path = _vault_path(cache_dir)
    if not path.exists():
        return _empty_vault()
    key = _load_or_create_key(cache_dir)
    blob = path.read_bytes()
    try:
        if asset_crypto.is_encrypted_blob(blob):
            raw = asset_crypto.decrypt_bytes(blob, key)
        else:
            # Allow a one-time plaintext migration if a dev file was written.
            raw = blob
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, InvalidToken, asset_crypto.AssetCryptoError):
        return _empty_vault()
    if not isinstance(data, dict):
        return _empty_vault()
    platforms = data.get("platforms") if isinstance(data.get("platforms"), dict) else {}
    accounts = data.get("accounts") if isinstance(data.get("accounts"), dict) else {}
    return {"platforms": dict(platforms), "accounts": dict(accounts)}


def save_vault(cache_dir: Path, vault: dict[str, Any]) -> None:
    key = _load_or_create_key(cache_dir)
    payload = json.dumps(
        {
            "platforms": vault.get("platforms") or {},
            "accounts": vault.get("accounts") or {},
        },
        indent=2,
    ).encode("utf-8")
    path = _vault_path(cache_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(asset_crypto.encrypt_bytes(payload, key))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def get_platform_creds(cache_dir: Path, platform: str) -> dict[str, str]:
    vault = load_vault(cache_dir)
    raw = vault.get("platforms", {}).get(str(platform).strip().lower()) or {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if str(v).strip()}


def update_platform_creds(cache_dir: Path, platform: str, updates: dict[str, Any]) -> dict[str, str]:
    platform = str(platform).strip().lower()
    allowed = set(PLATFORM_APP_FIELDS.get(platform, ()))
    vault = load_vault(cache_dir)
    platforms = dict(vault.get("platforms") or {})
    current = dict(platforms.get(platform) or {})
    for key, value in updates.items():
        if key not in allowed:
            continue
        text = "" if value is None else str(value).strip()
        if not text:
            # Blank means keep existing secret (except non-secrets like redirect URI).
            if key in {"oauth_redirect_uri"}:
                current.pop(key, None)
            continue
        current[key] = text
    if current:
        platforms[platform] = current
    else:
        platforms.pop(platform, None)
    vault["platforms"] = platforms
    save_vault(cache_dir, vault)
    return {str(k): str(v) for k, v in current.items()}


def resolve_youtube_app_creds(cache_dir: Path, account_id: str = "") -> dict[str, str]:
    """Account YouTube Data API v3 client creds, falling back to Settings."""
    merged = dict(get_platform_creds(cache_dir, "youtube"))
    if account_id:
        account = get_account_creds(cache_dir, account_id)
        for key in ("client_id", "client_secret", "oauth_redirect_uri"):
            value = str(account.get(key) or "").strip()
            if value:
                merged[key] = value
    return merged


def get_account_creds(cache_dir: Path, account_id: str) -> dict[str, str]:
    vault = load_vault(cache_dir)
    raw = vault.get("accounts", {}).get(str(account_id).strip()) or {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if str(v).strip()}


def update_account_creds(
    cache_dir: Path,
    account_id: str,
    *,
    platform: str,
    updates: dict[str, Any],
) -> dict[str, str]:
    account_id = str(account_id).strip()
    platform = str(platform).strip().lower()
    allowed = set(PLATFORM_ACCOUNT_FIELDS.get(platform, ()))
    vault = load_vault(cache_dir)
    accounts = dict(vault.get("accounts") or {})
    current = dict(accounts.get(account_id) or {})
    current["platform"] = platform
    for key, value in updates.items():
        if key not in allowed:
            continue
        text = "" if value is None else str(value).strip()
        if not text:
            if key in KEEP_IF_BLANK_ACCOUNT_FIELDS:
                continue  # keep existing secret / client id when blank
            current.pop(key, None)
            continue
        current[key] = text
    accounts[account_id] = {k: v for k, v in current.items() if str(v).strip()}
    vault["accounts"] = accounts
    save_vault(cache_dir, vault)
    return {str(k): str(v) for k, v in accounts[account_id].items()}


def delete_account_creds(cache_dir: Path, account_id: str) -> None:
    vault = load_vault(cache_dir)
    accounts = dict(vault.get("accounts") or {})
    if str(account_id) in accounts:
        accounts.pop(str(account_id), None)
        vault["accounts"] = accounts
        save_vault(cache_dir, vault)


def public_platform_view(platform: str, creds: dict[str, str]) -> dict[str, Any]:
    fields = []
    for key in PLATFORM_APP_FIELDS.get(platform, ()):
        value = creds.get(key, "")
        secret = key in SECRET_PLATFORM_FIELDS and key != "oauth_redirect_uri" and key != "client_id"
        fields.append(
            {
                "key": key,
                "set": bool(value),
                "secret": secret,
                "value": value if not secret else "",
                "masked": mask_secret(value) if secret and value else (value or ""),
            }
        )
    return {
        "platform": platform,
        "configured": any(creds.get(k) for k in PLATFORM_APP_FIELDS.get(platform, ()) if k != "oauth_redirect_uri"),
        "fields": fields,
    }


def save_youtube_oauth_state(
    cache_dir: Path,
    *,
    state: str,
    project_id: str,
    account_id: str,
    redirect_uri: str,
) -> None:
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "youtube_oauth_state.json").write_text(
        json.dumps(
            {
                "state": state,
                "project_id": project_id,
                "account_id": account_id,
                "redirect_uri": redirect_uri,
            }
        ),
        encoding="utf-8",
    )


def pop_youtube_oauth_state(cache_dir: Path, state: str) -> dict[str, str] | None:
    path = Path(cache_dir) / "youtube_oauth_state.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        path.unlink(missing_ok=True)
        return None
    path.unlink(missing_ok=True)
    if str(data.get("state") or "") != str(state):
        return None
    return {
        "project_id": str(data.get("project_id") or ""),
        "account_id": str(data.get("account_id") or ""),
        "redirect_uri": str(data.get("redirect_uri") or ""),
    }


def public_account_view(platform: str, creds: dict[str, str]) -> dict[str, Any]:
    fields = []
    for key in PLATFORM_ACCOUNT_FIELDS.get(platform, ()):
        value = creds.get(key, "")
        secret = key in MASKED_ACCOUNT_FIELDS
        fields.append(
            {
                "key": key,
                "set": bool(value),
                "secret": secret,
                "value": "" if secret else value,
                "masked": mask_secret(value) if secret and value else (value or ""),
            }
        )
    return {
        "platform": platform,
        "has_credentials": any(
            creds.get(k) for k in PLATFORM_ACCOUNT_FIELDS.get(platform, ()) if k in SECRET_ACCOUNT_FIELDS
        ),
        "has_app_credentials": bool(creds.get("client_id") and creds.get("client_secret")),
        "fields": fields,
    }
