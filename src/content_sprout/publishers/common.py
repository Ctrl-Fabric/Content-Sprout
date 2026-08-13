"""Shared helpers for social publishers."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v"}


@dataclass
class PublishResult:
    remote_url: str = ""
    remote_id: str = ""
    message: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


class PublishError(Exception):
    """Raised when a platform upload fails."""


def media_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        return "image"
    if suffix in VIDEO_SUFFIXES:
        return "video"
    raise PublishError(f"Unsupported export type for publish: {path.suffix}")


def mime_for(path: Path) -> str:
    suffix = path.suffix.lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".m4v": "video/mp4",
    }.get(suffix, "application/octet-stream")


def first_nonempty(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""
