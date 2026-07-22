"""Caption / title suggestions from output folder names and manifests."""

from __future__ import annotations

import json
import re
from pathlib import Path


def _humanize_name(text: str) -> str:
    """Turn 'Vacation2026/sunset_beach' into 'Sunset Beach'."""
    stem = Path(text).stem if "/" not in text and "\\" not in text else text
    stem = stem.replace("\\", "/").split("/")[-1]
    stem = re.sub(r"[_\-]+", " ", stem)
    stem = re.sub(r"(\d{4})(\d{2})(\d{2})", r"\1-\2-\3", stem)
    stem = re.sub(r"([a-z])([A-Z])", r"\1 \2", stem)
    words = [w.capitalize() for w in stem.split() if w]
    return " ".join(words) if words else "New Post"


def _load_manifest_source(output_root: Path, rel_path: str) -> str | None:
    """Return manifest source path for an output file's group folder."""
    folder = str(Path(rel_path).parent)
    if folder == ".":
        folder = ""
    manifest = output_root / folder / "manifest.json" if folder else output_root / "manifest.json"
    if not manifest.exists():
        return None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        src = data.get("source")
        return str(src) if src else None
    except (json.JSONDecodeError, OSError):
        return None


def suggest_post_text(
    *,
    image_paths: list[str],
    output_root: Path,
) -> dict[str, str | list[str]]:
    """Build title, description, and caption variants from selected output paths."""
    if not image_paths:
        return {"title": "", "description": "", "caption": "", "alternatives": []}

    folders = sorted({str(Path(p).parent) for p in image_paths if Path(p).parent != Path(".")})
    primary_folder = folders[0] if folders else Path(image_paths[0]).stem

    manifest_source = _load_manifest_source(output_root, image_paths[0])
    label = _humanize_name(manifest_source or primary_folder or image_paths[0])

    count = len(image_paths)
    if count == 1:
        title = label
        description = f"A moment captured — {label}."
    else:
        title = label if len(folders) <= 1 else "Photo Collection"
        description = f"{count} photos{f' from {label}' if len(folders) == 1 else ''}."

    hashtags = _suggest_hashtags(label, count)
    caption_body = f"{description}\n\n{' '.join(hashtags)}"
    caption = f"{title}\n\n{caption_body}" if title else caption_body

    alternatives = [
        f"{label} ✨\n\n{' '.join(hashtags[:4])}",
        f"New post: {label}\n\n{description}",
        f"{label}\n\n{' '.join(hashtags)}",
    ]

    return {
        "title": title,
        "description": description,
        "caption": caption,
        "alternatives": alternatives,
    }


def _suggest_hashtags(label: str, count: int) -> list[str]:
    base = ["#photography", "#instagood", "#photooftheday"]
    words = [w.lower() for w in re.findall(r"[A-Za-z]{3,}", label)]
    for w in words[:3]:
        tag = f"#{w}"
        if tag not in base:
            base.append(tag)
    if count > 1 and "#carousel" not in base:
        base.append("#carousel")
    return base[:8]


def build_caption(title: str, description: str) -> str:
    """Combine UI title + description into an Instagram caption."""
    title = title.strip()
    description = description.strip()
    if title and description:
        return f"{title}\n\n{description}"
    return title or description
