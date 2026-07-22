"""Per-image processing manifest written beside outputs."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass
class ImageManifest:
    source: str
    sha256: str
    processed_at: str
    formats: list[str]
    outputs: list[str]
    placement: dict[str, Any] | None = None
    story_fit_mode: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def now(
        cls,
        *,
        source: str,
        sha256: str,
        formats: list[str],
        outputs: list[str],
        placement: dict[str, Any] | None = None,
        story_fit_mode: str | None = None,
        **extra: Any,
    ) -> ImageManifest:
        return cls(
            source=source,
            sha256=sha256,
            processed_at=datetime.now(UTC).isoformat(),
            formats=formats,
            outputs=outputs,
            placement=placement,
            story_fit_mode=story_fit_mode,
            extra=extra,
        )


def write(path: Path, manifest: ImageManifest) -> None:
    """Write `manifest.json` next to format outputs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = asdict(manifest)
    if not manifest.extra:
        payload.pop("extra", None)
    else:
        payload.update(manifest.extra)
        payload.pop("extra", None)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
