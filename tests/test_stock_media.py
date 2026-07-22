"""Tests for open-license stock media normalization and search helpers."""

from unittest.mock import MagicMock, patch

from content_sprout.stock_media import (
    _normalize_openverse,
    _normalize_pixabay,
    filename_for_stock_item,
    search_stock,
)


def test_normalize_openverse_image():
    raw = {
        "id": "abc",
        "title": "Mountain Lake",
        "url": "https://example.com/photo.jpg",
        "thumbnail": "https://example.com/thumb.jpg",
        "creator": "Ada",
        "license": "by",
        "license_version": "4.0",
        "foreign_landing_url": "https://example.com/page",
        "width": 1200,
        "height": 800,
    }
    item = _normalize_openverse(raw, "image")
    assert item is not None
    assert item.source == "openverse"
    assert item.type == "image"
    assert item.title == "Mountain Lake"
    assert item.download_url.endswith("photo.jpg")
    assert item.license == "by 4.0"
    assert item.creator == "Ada"
    assert "Ada" in item.attribution
    assert item.width == 1200


def test_normalize_openverse_audio_duration():
    raw = {
        "id": "aud1",
        "title": "Jazz Clip",
        "url": "https://example.com/clip.mp3",
        "creator": "Miles",
        "license": "by-sa",
        "duration": 12500,
    }
    item = _normalize_openverse(raw, "audio")
    assert item is not None
    assert item.type == "audio"
    assert item.duration_s == 12.5


def test_normalize_pixabay_image_and_video():
    img = _normalize_pixabay(
        {
            "id": 42,
            "tags": "sunset, beach",
            "pageURL": "https://pixabay.com/photos/42/",
            "user": "pix",
            "largeImageURL": "https://cdn.example/large.jpg",
            "previewURL": "https://cdn.example/prev.jpg",
            "imageWidth": 1920,
            "imageHeight": 1080,
        },
        "image",
    )
    assert img is not None
    assert img.source == "pixabay"
    assert img.type == "image"
    assert img.download_url.endswith("large.jpg")
    assert img.license == "Pixabay License"

    vid = _normalize_pixabay(
        {
            "id": 99,
            "tags": "waves",
            "pageURL": "https://pixabay.com/videos/99/",
            "user": "cam",
            "picture_id": "123456789",
            "duration": 8,
            "videos": {
                "medium": {"url": "https://cdn.example/med.mp4", "width": 1280, "height": 720},
            },
        },
        "video",
    )
    assert vid is not None
    assert vid.type == "video"
    assert vid.download_url.endswith("med.mp4")
    assert "123456789" in (vid.thumb_url or "")
    assert vid.duration_s == 8.0


def test_filename_for_stock_item():
    from content_sprout.stock_media import StockItem

    item = StockItem(
        id="x",
        source="openverse",
        type="image",
        title="Hello World!",
        thumb_url=None,
        preview_url=None,
        download_url="https://example.com/a/b/c.png?x=1",
        page_url="https://example.com",
        license="cc0",
        creator=None,
        attribution="",
    )
    assert filename_for_stock_item(item) == "Hello_World.png"
    assert filename_for_stock_item(item, "image/jpeg").endswith(".jpg")


def test_search_stock_requires_query():
    try:
        search_stock(media_type="image", query="  ")
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "query" in str(exc).lower()


def test_search_stock_openverse_mocked():
    ov_payload = {
        "result_count": 1,
        "results": [
            {
                "id": "1",
                "title": "Forest",
                "url": "https://example.com/f.jpg",
                "thumbnail": "https://example.com/t.jpg",
                "creator": "Sam",
                "license": "cc0",
                "foreign_landing_url": "https://example.com/p",
            }
        ],
    }

    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = ov_payload

    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.__exit__.return_value = False
    mock_client.get.return_value = mock_resp

    with patch("content_sprout.stock_media.httpx.Client", return_value=mock_client):
        result = search_stock(media_type="image", query="forest", page_size=12)

    assert result.media_type == "image"
    assert result.query == "forest"
    assert "openverse" in result.sources
    assert len(result.items) == 1
    assert result.items[0].title == "Forest"


def test_search_video_without_pixabay_empty():
    result = search_stock(media_type="video", query="ocean", pixabay_api_key=None)
    assert result.items == []
    assert result.sources == []
