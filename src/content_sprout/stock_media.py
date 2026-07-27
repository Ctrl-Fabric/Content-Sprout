"""Browse openly licensed stock media (Openverse + optional Pixabay).

Openverse (https://api.openverse.org) indexes Creative Commons images and audio
with no API key required for modest use. Pixabay is optional for videos (and
extra image/audio coverage) when a free API key is configured in Settings.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, urlencode

import httpx

from . import pixabay_cache

logger = logging.getLogger(__name__)

OPENVERSE_BASE = "https://api.openverse.org/v1"
PIXABAY_IMAGE_API = "https://pixabay.com/api/"
PIXABAY_VIDEO_API = "https://pixabay.com/api/videos/"

StockMediaType = Literal["image", "video", "audio"]
StockSearchType = Literal["all", "image", "video", "audio"]


@dataclass
class StockItem:
    id: str
    source: str  # openverse | pixabay
    type: StockMediaType
    title: str
    thumb_url: str | None
    preview_url: str | None
    download_url: str
    page_url: str
    license: str
    creator: str | None
    attribution: str
    width: int | None = None
    height: int | None = None
    duration_s: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source": self.source,
            "type": self.type,
            "title": self.title,
            "thumb_url": self.thumb_url,
            "preview_url": self.preview_url,
            "download_url": self.download_url,
            "page_url": self.page_url,
            "license": self.license,
            "creator": self.creator,
            "attribution": self.attribution,
            "width": self.width,
            "height": self.height,
            "duration_s": self.duration_s,
        }


@dataclass
class StockSearchResult:
    items: list[StockItem]
    page: int
    page_size: int
    total: int
    sources: list[str]
    query: str
    media_type: StockSearchType

    def to_dict(self) -> dict[str, Any]:
        return {
            "items": [i.to_dict() for i in self.items],
            "page": self.page,
            "page_size": self.page_size,
            "total": self.total,
            "sources": self.sources,
            "query": self.query,
            "type": self.media_type,
        }


def _safe_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _clean_title(value: str | None, fallback: str = "Untitled") -> str:
    text = re.sub(r"\s+", " ", (value or "").strip())
    return text[:160] or fallback


def _attribution(title: str, creator: str | None, license_name: str, page_url: str) -> str:
    who = creator or "Unknown"
    lic = license_name or "open license"
    return f'"{title}" by {who} — {lic}. {page_url}'.strip()


def available_sources(*, pixabay_api_key: str | None = None) -> dict[str, Any]:
    pixabay = bool((pixabay_api_key or "").strip())
    return {
        "openverse": {
            "id": "openverse",
            "label": "Openverse",
            "types": ["image", "audio"],
            "requires_key": False,
            "enabled": True,
            "note": "Creative Commons images & audio (no API key).",
        },
        "pixabay": {
            "id": "pixabay",
            "label": "Pixabay",
            "types": ["image", "video"],
            "requires_key": True,
            "enabled": pixabay,
            "note": "Free stock images and videos when a Pixabay API key is set in Settings.",
        },
    }


def search_stock(
    *,
    media_type: StockSearchType,
    query: str,
    page: int = 1,
    page_size: int = 24,
    pixabay_api_key: str | None = None,
    timeout_s: float = 30.0,
    cache_dir: Path | None = None,
    pixabay_cache_ttl_hours: float = 24.0,
) -> StockSearchResult:
    q = (query or "").strip()
    if not q:
        raise ValueError("Enter a search query.")
    page = max(1, int(page or 1))
    page_size = max(1, min(40, int(page_size or 24)))
    key = (pixabay_api_key or "").strip() or None

    if media_type == "all":
        # Mix images, audio, and videos across open sources for the browse page.
        per = max(4, page_size // 3)
        combined: list[StockItem] = []
        sources_used: list[str] = []
        total = 0
        for mt in ("image", "audio", "video"):
            try:
                part = _search_one_type(
                    mt,  # type: ignore[arg-type]
                    q,
                    page=page,
                    page_size=per,
                    pixabay_api_key=key,
                    timeout_s=timeout_s,
                    cache_dir=cache_dir,
                    pixabay_cache_ttl_hours=pixabay_cache_ttl_hours,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Stock search (%s) failed: %s", mt, exc)
                continue
            seen = {i.download_url for i in combined}
            for it in part.items:
                if it.download_url in seen:
                    continue
                combined.append(it)
                seen.add(it.download_url)
            for s in part.sources:
                if s not in sources_used:
                    sources_used.append(s)
            total += part.total
        return StockSearchResult(
            items=combined[:page_size],
            page=page,
            page_size=page_size,
            total=total,
            sources=sources_used,
            query=q,
            media_type="all",
        )

    return _search_one_type(
        media_type,
        q,
        page=page,
        page_size=page_size,
        pixabay_api_key=key,
        timeout_s=timeout_s,
        cache_dir=cache_dir,
        pixabay_cache_ttl_hours=pixabay_cache_ttl_hours,
    )


def _search_one_type(
    media_type: StockMediaType,
    query: str,
    *,
    page: int,
    page_size: int,
    pixabay_api_key: str | None,
    timeout_s: float,
    cache_dir: Path | None = None,
    pixabay_cache_ttl_hours: float = 24.0,
) -> StockSearchResult:
    items: list[StockItem] = []
    sources_used: list[str] = []
    total = 0
    openverse_total = 0
    key = (pixabay_api_key or "").strip() or None

    if media_type in ("image", "audio"):
        try:
            ov_items, ov_total = _search_openverse(
                media_type, query, page=page, page_size=page_size, timeout_s=timeout_s
            )
            items.extend(ov_items)
            openverse_total = ov_total
            total = max(total, ov_total)
            if ov_items or ov_total:
                sources_used.append("openverse")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Openverse search failed: %s", exc)
            if media_type == "audio" and not key:
                raise

    if key and media_type in ("image", "video"):
        try:
            px_items, px_total = _search_pixabay(
                media_type,
                query,
                page=page,
                page_size=page_size,
                api_key=key,
                timeout_s=timeout_s,
                cache_dir=cache_dir,
                cache_ttl_hours=pixabay_cache.normalize_ttl_hours(pixabay_cache_ttl_hours),
            )
            seen = {i.download_url for i in items}
            for it in px_items:
                if it.download_url in seen:
                    continue
                items.append(it)
                seen.add(it.download_url)
            total = max(total, px_total + openverse_total)
            if px_items or px_total:
                sources_used.append("pixabay")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Pixabay search failed: %s", exc)
            if media_type == "video" and not items:
                raise

    if media_type == "video" and not key and not items:
        # Videos require Pixabay (Openverse has no video index here).
        return StockSearchResult(
            items=[],
            page=page,
            page_size=page_size,
            total=0,
            sources=[],
            query=query,
            media_type=media_type,
        )

    return StockSearchResult(
        items=items[:page_size],
        page=page,
        page_size=page_size,
        total=total,
        sources=sources_used,
        query=query,
        media_type=media_type,
    )


def _search_openverse(
    media_type: Literal["image", "audio"],
    query: str,
    *,
    page: int,
    page_size: int,
    timeout_s: float,
) -> tuple[list[StockItem], int]:
    path = "images" if media_type == "image" else "audio"
    params = {
        "q": query,
        "page": page,
        "page_size": page_size,
        "mature": "false",
    }
    url = f"{OPENVERSE_BASE}/{path}/?{urlencode(params)}"
    try:
        with httpx.Client(timeout=timeout_s, follow_redirects=True) as client:
            r = client.get(url, headers={"User-Agent": "Content-sprout/1.0 (local; open-source stock browser)"})
            r.raise_for_status()
            data = r.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Openverse search failed: %s", exc)
        raise RuntimeError(f"Openverse search failed: {exc}") from exc

    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        results = []
    total = _safe_int((data or {}).get("result_count")) or len(results)
    items: list[StockItem] = []
    for raw in results:
        if not isinstance(raw, dict):
            continue
        item = _normalize_openverse(raw, media_type)
        if item:
            items.append(item)
    return items, total


def _normalize_openverse(raw: dict[str, Any], media_type: Literal["image", "audio"]) -> StockItem | None:
    download = (raw.get("url") or "").strip()
    if not download:
        return None
    title = _clean_title(raw.get("title"))
    creator = (raw.get("creator") or "").strip() or None
    license_name = (raw.get("license") or "cc").strip()
    if raw.get("license_version"):
        license_name = f"{license_name} {raw.get('license_version')}".strip()
    page_url = (raw.get("foreign_landing_url") or raw.get("detail_url") or download).strip()
    thumb = (raw.get("thumbnail") or "").strip() or None
    preview = download if media_type == "audio" else thumb
    oid = str(raw.get("id") or download)
    duration_ms = _safe_int(raw.get("duration"))
    duration_s = (duration_ms / 1000.0) if duration_ms and media_type == "audio" else None
    return StockItem(
        id=f"openverse:{media_type}:{oid}",
        source="openverse",
        type=media_type,
        title=title,
        thumb_url=thumb,
        preview_url=preview,
        download_url=download,
        page_url=page_url,
        license=license_name,
        creator=creator,
        attribution=_attribution(title, creator, license_name, page_url),
        width=_safe_int(raw.get("width")),
        height=_safe_int(raw.get("height")),
        duration_s=duration_s,
    )


def _search_pixabay(
    media_type: Literal["image", "video"],
    query: str,
    *,
    page: int,
    page_size: int,
    api_key: str,
    timeout_s: float,
    cache_dir: Path | None = None,
    cache_ttl_hours: float = 24.0,
) -> tuple[list[StockItem], int]:
    if media_type == "video":
        base = PIXABAY_VIDEO_API
        params = {
            "key": api_key,
            "q": query,
            "page": page,
            "per_page": page_size,
            "safesearch": "true",
        }
    else:
        base = PIXABAY_IMAGE_API
        params = {
            "key": api_key,
            "q": query,
            "page": page,
            "per_page": page_size,
            "safesearch": "true",
            "image_type": "photo",
        }

    cached = pixabay_cache.load_fresh(
        cache_dir,
        media_type=media_type,
        query=query,
        page=page,
        page_size=page_size,
        api_key=api_key,
    )
    if cached is not None:
        data = cached
        logger.debug(
            "Pixabay cache hit type=%s q=%r page=%s",
            media_type,
            query,
            page,
        )
    else:
        if cache_dir is not None:
            pixabay_cache.prune_expired(cache_dir)
        url = f"{base}?{urlencode(params)}"
        try:
            with httpx.Client(timeout=timeout_s, follow_redirects=True) as client:
                r = client.get(url)
                r.raise_for_status()
                data = r.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Pixabay search failed: %s", exc)
            raise RuntimeError(f"Pixabay search failed: {exc}") from exc
        if isinstance(data, dict):
            pixabay_cache.store(
                cache_dir,
                media_type=media_type,
                query=query,
                page=page,
                page_size=page_size,
                api_key=api_key,
                response=data,
                ttl_hours=cache_ttl_hours,
            )

    hits = data.get("hits") if isinstance(data, dict) else None
    if not isinstance(hits, list):
        hits = []
    total = _safe_int((data or {}).get("totalHits")) or len(hits)
    items: list[StockItem] = []
    for raw in hits:
        if not isinstance(raw, dict):
            continue
        item = _normalize_pixabay(raw, media_type)
        if item:
            items.append(item)
    return items, total


def _normalize_pixabay(raw: dict[str, Any], media_type: Literal["image", "video"]) -> StockItem | None:
    pid = str(raw.get("id") or "")
    if not pid:
        return None
    page_url = (raw.get("pageURL") or f"https://pixabay.com/").strip()
    creator = (raw.get("user") or "").strip() or None
    license_name = "Pixabay License"
    title = _clean_title(raw.get("tags"), fallback=f"Pixabay {media_type}")

    if media_type == "video":
        videos = raw.get("videos") if isinstance(raw.get("videos"), dict) else {}
        medium = videos.get("medium") if isinstance(videos.get("medium"), dict) else {}
        small = videos.get("small") if isinstance(videos.get("small"), dict) else {}
        tiny = videos.get("tiny") if isinstance(videos.get("tiny"), dict) else {}
        download = (medium.get("url") or small.get("url") or tiny.get("url") or "").strip()
        if not download:
            return None
        picture_id = str(raw.get("picture_id") or "").strip()
        thumb = (
            f"https://i.vimeocdn.com/video/{picture_id}_295x166.jpg"
            if picture_id
            else (raw.get("userImageURL") or "").strip() or None
        )
        preview = download
        width = _safe_int(medium.get("width") or raw.get("width"))
        height = _safe_int(medium.get("height") or raw.get("height"))
        duration_s = _safe_float(raw.get("duration"))
    else:
        download = (raw.get("largeImageURL") or raw.get("webformatURL") or raw.get("imageURL") or "").strip()
        if not download:
            return None
        thumb = (raw.get("previewURL") or raw.get("webformatURL") or "").strip() or None
        preview = thumb
        width = _safe_int(raw.get("imageWidth") or raw.get("webformatWidth"))
        height = _safe_int(raw.get("imageHeight") or raw.get("webformatHeight"))
        duration_s = None

    return StockItem(
        id=f"pixabay:{media_type}:{pid}",
        source="pixabay",
        type=media_type,
        title=title,
        thumb_url=thumb,
        preview_url=preview,
        download_url=download,
        page_url=page_url,
        license=license_name,
        creator=creator,
        attribution=_attribution(title, creator, license_name, page_url),
        width=width,
        height=height,
        duration_s=duration_s,
    )


def fetch_remote_bytes(
    url: str,
    *,
    timeout_s: float = 60.0,
    max_bytes: int = 80 * 1024 * 1024,
) -> tuple[bytes, str | None]:
    """Download a remote media file. Returns (bytes, content-type)."""
    target = (url or "").strip()
    if not target.startswith(("http://", "https://")):
        raise ValueError("Invalid download URL")
    with httpx.Client(timeout=timeout_s, follow_redirects=True) as client:
        with client.stream("GET", target, headers={"User-Agent": "Content-sprout/1.0"}) as r:
            r.raise_for_status()
            ctype = r.headers.get("content-type")
            chunks: list[bytes] = []
            size = 0
            for chunk in r.iter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError("File too large to download")
                chunks.append(chunk)
            return b"".join(chunks), ctype


def filename_for_stock_item(item: StockItem, content_type: str | None = None) -> str:
    base = re.sub(r"[^\w.\-]+", "_", item.title).strip("_")[:60] or item.type
    ext = ""
    if content_type:
        if "jpeg" in content_type or "jpg" in content_type:
            ext = ".jpg"
        elif "png" in content_type:
            ext = ".png"
        elif "webp" in content_type:
            ext = ".webp"
        elif "mp4" in content_type:
            ext = ".mp4"
        elif "webm" in content_type:
            ext = ".webm"
        elif "mpeg" in content_type or "mp3" in content_type:
            ext = ".mp3"
        elif "wav" in content_type:
            ext = ".wav"
        elif "ogg" in content_type:
            ext = ".ogg"
    if not ext:
        path = item.download_url.split("?", 1)[0]
        m = re.search(r"\.([a-zA-Z0-9]{2,5})$", path)
        if m:
            ext = f".{m.group(1).lower()}"
        elif item.type == "image":
            ext = ".jpg"
        elif item.type == "video":
            ext = ".mp4"
        else:
            ext = ".mp3"
    return f"{base}{ext}"


def quote_url(url: str) -> str:
    return quote(url, safe=":/?&=%#")
