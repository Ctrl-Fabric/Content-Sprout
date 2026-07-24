"""Generate and store AI catalog descriptions for project assets."""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

from .config import AppConfig, vision_llm_ready
from .io import load as load_image
from .llm import factory as llm_factory
from .llm.prompts import ASSET_DESCRIPTION_PROMPT
from .models import Asset, AssetType
from .projects import ProjectStore

log = logging.getLogger(__name__)

MAX_DESCRIPTION_CHARS = 500
MAX_PROBE_EDGE = 1024
# Large videos are costly to frame-extract + send to vision LLMs.
AI_DESCRIBE_MAX_VIDEO_BYTES = 20 * 1024 * 1024


def video_too_large_for_ai_describe(asset: Asset) -> bool:
    """True when a video should not be sent to the AI describer."""
    if asset.type != AssetType.VIDEO:
        return False
    size = asset.file_size_bytes
    if size is None:
        return False
    return int(size) > AI_DESCRIBE_MAX_VIDEO_BYTES


def _downscale_for_llm(img: Image.Image, max_edge: int = MAX_PROBE_EDGE) -> Image.Image:
    w, h = img.size
    longest = max(w, h)
    if longest <= max_edge:
        return img.convert("RGB") if img.mode != "RGB" else img
    scale = max_edge / float(longest)
    size = (max(1, int(w * scale)), max(1, int(h * scale)))
    out = img.resize(size, Image.Resampling.LANCZOS)
    return out.convert("RGB") if out.mode != "RGB" else out


def _extract_video_frame(path: Path) -> Image.Image | None:
    if not shutil.which("ffmpeg"):
        return None
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        out = Path(tmp.name)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), "-vframes", "1", "-q:v", "2", str(out)],
            capture_output=True,
            check=True,
            timeout=30,
        )
        return load_image(out)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return None
    finally:
        out.unlink(missing_ok=True)


def _visual_for_asset(store: ProjectStore, project_id: str, asset: Asset) -> Image.Image | None:
    try:
        path = store.materialize_asset(project_id, asset)
    except (ValueError, FileNotFoundError):
        return None
    if not path.exists():
        return None
    if asset.type == AssetType.IMAGE:
        try:
            return load_image(path)
        except OSError:
            return None
    if asset.type == AssetType.VIDEO:
        return _extract_video_frame(path)
    return None


def _normalize_description(raw: object) -> str:
    text = " ".join(str(raw or "").split()).strip()
    if not text:
        return ""
    if len(text) > MAX_DESCRIPTION_CHARS:
        text = text[: MAX_DESCRIPTION_CHARS - 1].rstrip() + "…"
    return text


def describe_asset(
    store: ProjectStore,
    cfg: AppConfig,
    project_id: str,
    asset_id: str,
    *,
    force: bool = False,
) -> Asset | None:
    """Run LLM description for one asset and persist it. Returns updated asset or None."""
    if not vision_llm_ready(cfg):
        return None
    try:
        asset = store.get_asset(project_id, asset_id)
    except FileNotFoundError:
        return None
    if asset.description and not force:
        return asset
    if video_too_large_for_ai_describe(asset):
        log.info(
            "Skipping AI describe for large video %s/%s (%s bytes)",
            project_id,
            asset_id,
            asset.file_size_bytes,
        )
        return None

    images: list[Image.Image] = []
    visual = _visual_for_asset(store, project_id, asset)
    if visual is not None:
        images.append(_downscale_for_llm(visual))

    meta_lines = [
        f"type: {asset.type.value}",
        f"name: {asset.name}",
        f"original_filename: {asset.original_filename}",
    ]
    if asset.group:
        meta_lines.append(f"group: {asset.group}")
    if asset.type == AssetType.AUDIO and not images:
        meta_lines.append(
            "note: no waveform preview available; describe from filename/name as a speech or music bed asset."
        )
    if asset.type == AssetType.VIDEO and not images:
        meta_lines.append(
            "note: no video frame could be extracted; describe from filename/name only."
        )

    prompt = (
        f"{ASSET_DESCRIPTION_PROMPT}\n\nAsset metadata:\n"
        + "\n".join(meta_lines)
    )

    try:
        client = llm_factory.create_json_client(cfg)
        data = client.complete_json(prompt, images=images or None)
    except Exception:  # noqa: BLE001
        log.exception("Asset description failed for %s/%s", project_id, asset_id)
        return None

    description = _normalize_description(
        data.get("description") if isinstance(data, dict) else ""
    )
    if not description:
        return None

    try:
        return store.set_asset_description(project_id, asset_id, description)
    except FileNotFoundError:
        return None
