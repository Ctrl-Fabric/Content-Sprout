"""Image I/O helpers — EXIF-aware load, sRGB normalization, save."""

import hashlib
from pathlib import Path

from PIL import Image, ImageOps

SUPPORTED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff", ".tif"}


def load(path: Path) -> Image.Image:
    """Load an image, honoring EXIF orientation, and return as RGB."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img


def save(img: Image.Image, path: Path, quality: int = 92) -> None:
    """Save image with sensible defaults per file extension."""
    path.parent.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        img.save(path, format="JPEG", quality=quality, optimize=True, progressive=True)
    elif suffix == ".png":
        img.save(path, format="PNG", optimize=True)
    else:
        img.save(path)


def file_sha256(path: Path, chunk_size: int = 1 << 20) -> str:
    """SHA-256 hex digest of file contents."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(chunk_size):
            h.update(chunk)
    return h.hexdigest()


def list_images(directory: Path, recursive: bool = True) -> list[Path]:
    """List supported image files under `directory`.

    With `recursive=True` (the default), descends into subfolders so the input
    tree can be mirrored 1:1 into the output tree. Skips `.done` and `.failed`.
    """
    if not directory.exists():
        return []
    iterator = directory.rglob("*") if recursive else directory.iterdir()
    out: list[Path] = []
    for p in iterator:
        if not p.is_file() or p.suffix.lower() not in SUPPORTED_EXT:
            continue
        if _is_triage_path(p):
            continue
        out.append(p)
    return sorted(out)


def _is_triage_path(path: Path) -> bool:
    return ".done" in path.parts or ".failed" in path.parts
