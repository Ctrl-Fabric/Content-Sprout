"""Social credential vault: YouTube Data API v3 client on the account."""

from pathlib import Path

from content_sprout import social_credentials as sc
from content_sprout.publishers import youtube


def test_youtube_account_client_creds_override_platform(tmp_path: Path):
    cache = tmp_path / "cache"
    sc.update_platform_creds(
        cache, "youtube", {"client_id": "plat-id", "client_secret": "plat-secret"}
    )
    sc.update_account_creds(
        cache,
        "acc1",
        platform="youtube",
        updates={"client_id": "acc-id", "client_secret": "acc-secret"},
    )
    merged = sc.resolve_youtube_app_creds(cache, "acc1")
    assert merged["client_id"] == "acc-id"
    assert merged["client_secret"] == "acc-secret"


def test_youtube_app_creds_fall_back_to_platform(tmp_path: Path):
    cache = tmp_path / "cache"
    sc.update_platform_creds(
        cache, "youtube", {"client_id": "plat-id", "client_secret": "plat-secret"}
    )
    sc.update_account_creds(
        cache, "acc1", platform="youtube", updates={"refresh_token": "rt"}
    )
    merged = sc.resolve_youtube_app_creds(cache, "acc1")
    assert merged["client_id"] == "plat-id"
    assert merged["client_secret"] == "plat-secret"


def test_youtube_blank_client_secret_keeps_existing(tmp_path: Path):
    cache = tmp_path / "cache"
    sc.update_account_creds(
        cache,
        "acc1",
        platform="youtube",
        updates={"client_id": "id-1", "client_secret": "secret-1"},
    )
    sc.update_account_creds(
        cache,
        "acc1",
        platform="youtube",
        updates={"client_id": "id-2", "client_secret": ""},
    )
    creds = sc.get_account_creds(cache, "acc1")
    assert creds["client_id"] == "id-2"
    assert creds["client_secret"] == "secret-1"


def test_youtube_public_view_masks_secret_and_flags_app(tmp_path: Path):
    cache = tmp_path / "cache"
    sc.update_account_creds(
        cache,
        "acc1",
        platform="youtube",
        updates={"client_id": "visible-id", "client_secret": "hidden"},
    )
    view = sc.public_account_view("youtube", sc.get_account_creds(cache, "acc1"))
    fields = {f["key"]: f for f in view["fields"]}
    assert fields["client_id"]["value"] == "visible-id"
    assert fields["client_secret"]["value"] == ""
    assert fields["client_secret"]["set"] is True
    assert view["has_app_credentials"] is True
    assert view["has_credentials"] is False


def test_youtube_can_publish_with_account_app_creds():
    assert youtube.can_publish(
        None,
        {"refresh_token": "rt", "client_id": "id", "client_secret": "sec"},
        {},
    )
    assert not youtube.can_publish(None, {"refresh_token": "rt"}, {})
    assert youtube.can_publish(
        None, {"refresh_token": "rt"}, {"client_id": "id", "client_secret": "sec"}
    )
