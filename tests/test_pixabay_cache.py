"""Tests for Pixabay 24-hour API response cache."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from content_sprout import pixabay_cache
from content_sprout.stock_media import search_stock


def _px_payload(title_tag: str = "sunset, beach") -> dict:
    return {
        "totalHits": 1,
        "hits": [
            {
                "id": 42,
                "tags": title_tag,
                "pageURL": "https://pixabay.com/photos/42/",
                "user": "pix",
                "largeImageURL": "https://cdn.example/large.jpg",
                "previewURL": "https://cdn.example/prev.jpg",
                "imageWidth": 1920,
                "imageHeight": 1080,
            }
        ],
    }


def test_pixabay_cache_round_trip(tmp_path: Path):
    now = datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc)
    path = pixabay_cache.store(
        tmp_path,
        media_type="image",
        query="ocean",
        page=1,
        page_size=24,
        api_key="test-key",
        response=_px_payload(),
        ttl_hours=24,
        now=now,
    )
    assert path is not None and path.is_file()
    meta = path.read_text(encoding="utf-8")
    assert '"fetched_at"' in meta
    assert '"expires_at"' in meta
    assert '"response"' in meta

    hit = pixabay_cache.load_fresh(
        tmp_path,
        media_type="image",
        query="ocean",
        page=1,
        page_size=24,
        api_key="test-key",
        now=now + timedelta(hours=1),
    )
    assert hit is not None
    assert hit["hits"][0]["id"] == 42

    miss = pixabay_cache.load_fresh(
        tmp_path,
        media_type="image",
        query="ocean",
        page=1,
        page_size=24,
        api_key="test-key",
        now=now + timedelta(hours=25),
    )
    assert miss is None


def test_pixabay_cache_key_isolates_query_and_key(tmp_path: Path):
    k1 = pixabay_cache.cache_key(
        media_type="image", query="a", page=1, page_size=12, api_key="k1"
    )
    k2 = pixabay_cache.cache_key(
        media_type="image", query="b", page=1, page_size=12, api_key="k1"
    )
    k3 = pixabay_cache.cache_key(
        media_type="image", query="a", page=1, page_size=12, api_key="k2"
    )
    assert k1 != k2
    assert k1 != k3


def test_search_pixabay_uses_cache_within_ttl(tmp_path: Path):
    payload = _px_payload("waves")
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = payload
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.__exit__.return_value = False
    mock_client.get.return_value = mock_resp

    with patch("content_sprout.stock_media.httpx.Client", return_value=mock_client):
        # Openverse may also call httpx — allow both; Pixabay is the one with key.
        # Force image search to use only Pixabay by making Openverse fail.
        with patch(
            "content_sprout.stock_media._search_openverse",
            side_effect=RuntimeError("skip openverse"),
        ):
            r1 = search_stock(
                media_type="image",
                query="waves",
                page_size=12,
                pixabay_api_key="secret",
                cache_dir=tmp_path,
                pixabay_cache_ttl_hours=24,
            )
            assert mock_client.get.call_count == 1
            assert any(i.source == "pixabay" for i in r1.items)

            r2 = search_stock(
                media_type="image",
                query="waves",
                page_size=12,
                pixabay_api_key="secret",
                cache_dir=tmp_path,
                pixabay_cache_ttl_hours=24,
            )
            # Second identical search must not hit the network again.
            assert mock_client.get.call_count == 1
            assert len(r2.items) == len(r1.items)
            assert r2.items[0].id == r1.items[0].id


def test_search_pixabay_refreshes_after_ttl(tmp_path: Path):
    now = datetime(2026, 7, 24, 10, 0, tzinfo=timezone.utc)
    pixabay_cache.store(
        tmp_path,
        media_type="image",
        query="forest",
        page=1,
        page_size=12,
        api_key="secret",
        response=_px_payload("old forest"),
        ttl_hours=24,
        now=now - timedelta(hours=25),
    )

    fresh = _px_payload("new forest")
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = fresh
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.__exit__.return_value = False
    mock_client.get.return_value = mock_resp

    with patch("content_sprout.stock_media.httpx.Client", return_value=mock_client):
        with patch(
            "content_sprout.stock_media._search_openverse",
            side_effect=RuntimeError("skip openverse"),
        ):
            result = search_stock(
                media_type="image",
                query="forest",
                page_size=12,
                pixabay_api_key="secret",
                cache_dir=tmp_path,
                pixabay_cache_ttl_hours=24,
            )
    assert mock_client.get.call_count == 1
    assert "new forest" in result.items[0].title
