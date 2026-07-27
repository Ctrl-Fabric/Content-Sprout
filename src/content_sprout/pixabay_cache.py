"""Disk cache for Pixabay API responses (24-hour retention).

Pixabay requires API requests to be cached for 24 hours:
https://pixabay.com/api/docs/

Entries store the raw JSON response plus metadata (query, page, media type,
fetch/expiry timestamps). Fresh hits are served without calling Pixabay;
expired entries are refreshed on the next search.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CACHE_SUBDIR = "pixabay_api"
DEFAULT_TTL_HOURS = 24.0
MIN_TTL_HOURS = 24.0


def normalize_ttl_hours(ttl_hours: float | int | None) -> float:
    """Clamp TTL to Pixabay's required minimum of 24 hours.

    Missing, zero, or invalid values fall back to ``DEFAULT_TTL_HOURS``.
    """
    try:
        if ttl_hours is None:
            return DEFAULT_TTL_HOURS
        value = float(ttl_hours)
    except (TypeError, ValueError):
        return DEFAULT_TTL_HOURS
    if value <= 0:
        return DEFAULT_TTL_HOURS
    return max(MIN_TTL_HOURS, value)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def cache_root(cache_dir: Path) -> Path:
    root = Path(cache_dir).resolve() / CACHE_SUBDIR
    root.mkdir(parents=True, exist_ok=True)
    return root


def cache_key(
    *,
    media_type: str,
    query: str,
    page: int,
    page_size: int,
    api_key: str,
) -> str:
    """Stable key for a Pixabay search (API key hashed, not stored in clear)."""
    key_fp = hashlib.sha256((api_key or "").encode("utf-8")).hexdigest()[:16]
    raw = "|".join(
        [
            "pixabay-v1",
            (media_type or "").strip().lower(),
            (query or "").strip().casefold(),
            str(int(page or 1)),
            str(int(page_size or 24)),
            key_fp,
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def entry_path(cache_dir: Path, key: str) -> Path:
    return cache_root(cache_dir) / f"{key}.json"


def load_fresh(
    cache_dir: Path | None,
    *,
    media_type: str,
    query: str,
    page: int,
    page_size: int,
    api_key: str,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Return cached Pixabay JSON payload if present and not expired."""
    if cache_dir is None:
        return None
    key = cache_key(
        media_type=media_type,
        query=query,
        page=page,
        page_size=page_size,
        api_key=api_key,
    )
    path = entry_path(cache_dir, key)
    if not path.is_file():
        return None
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Pixabay cache read failed (%s): %s", path.name, exc)
        return None
    if not isinstance(meta, dict):
        return None
    expires = _parse_iso(str(meta.get("expires_at") or ""))
    if expires is None:
        return None
    current = now or _utcnow()
    if current >= expires:
        return None
    response = meta.get("response")
    if not isinstance(response, dict):
        return None
    return response


def prune_expired(
    cache_dir: Path | None,
    *,
    now: datetime | None = None,
) -> int:
    """Delete expired Pixabay cache JSON files. Returns number removed."""
    if cache_dir is None:
        return 0
    root = Path(cache_dir).resolve() / CACHE_SUBDIR
    if not root.is_dir():
        return 0
    current = now or _utcnow()
    removed = 0
    for path in root.glob("*.json"):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(meta, dict):
            continue
        expires = _parse_iso(str(meta.get("expires_at") or ""))
        if expires is None or current < expires:
            continue
        try:
            path.unlink(missing_ok=True)
            removed += 1
        except OSError as exc:
            logger.warning("Pixabay cache prune failed (%s): %s", path.name, exc)
    return removed


def store(
    cache_dir: Path | None,
    *,
    media_type: str,
    query: str,
    page: int,
    page_size: int,
    api_key: str,
    response: dict[str, Any],
    ttl_hours: float = DEFAULT_TTL_HOURS,
    now: datetime | None = None,
) -> Path | None:
    """Persist a Pixabay API response for ``ttl_hours`` (minimum 24)."""
    if cache_dir is None:
        return None
    if not isinstance(response, dict):
        return None
    ttl = normalize_ttl_hours(ttl_hours)
    current = now or _utcnow()
    expires = current + timedelta(hours=ttl)
    key = cache_key(
        media_type=media_type,
        query=query,
        page=page,
        page_size=page_size,
        api_key=api_key,
    )
    path = entry_path(cache_dir, key)
    payload = {
        "version": 1,
        "source": "pixabay",
        "media_type": media_type,
        "query": query,
        "page": int(page),
        "page_size": int(page_size),
        "fetched_at": _iso(current),
        "expires_at": _iso(expires),
        "ttl_hours": ttl,
        "response": response,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix="pixabay-cache-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(raw)
        Path(tmp_name).replace(path)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    try:
        prune_expired(cache_dir, now=current)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Pixabay cache prune skipped: %s", exc)
    return path
