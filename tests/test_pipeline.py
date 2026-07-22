"""Smoke tests for the resize/smart-crop pipeline + folder mirroring."""

from pathlib import Path

from PIL import Image

from content_sprout import io as iio
from content_sprout.config import AppConfig, RouterConfig
from content_sprout.crop import center, smart
from content_sprout.formats import FORMAT_DIMENSIONS
from content_sprout.pipeline import process_dir, process_one, resolve_logos


def _make_logo(path: Path, fill: tuple[int, int, int, int]) -> None:
    Image.new("RGBA", (200, 80), fill).save(path, "PNG")


def _make_synthetic(path: Path, w: int = 4000, h: int = 3000) -> None:
    """Solid-color image with a brighter rectangle in the middle as a 'subject'."""
    img = Image.new("RGB", (w, h), (40, 80, 160))
    for y in range(h // 3, 2 * h // 3):
        for x in range(w // 3, 2 * w // 3):
            img.putpixel((x, y), (240, 220, 80))
    img.save(path, "JPEG", quality=92)


# ---------------------------------------------------------------------------
# Cropper unit tests
# ---------------------------------------------------------------------------


def test_center_crop_exact_dims():
    img = Image.new("RGB", (4000, 3000), (10, 10, 10))
    out = center.crop_to(img, 1080, 1350)
    assert out.size == (1080, 1350)


def test_smart_crop_exact_dims_no_faces():
    # A flat image triggers smartcrop's saliency path (and likely the center
    # fallback inside it). Either way, the public contract is: exact target dims.
    img = Image.new("RGB", (4000, 3000), (128, 128, 128))
    for fmt, (w, h) in FORMAT_DIMENSIONS.items():
        out = smart.crop_to(img, w, h, faces=[])
        assert out.size == (w, h), f"format={fmt}"


def test_smart_crop_centers_on_explicit_face_box():
    """Given a 'face' box in the right half, the crop center should shift right."""
    img = Image.new("RGB", (4000, 4000), (50, 50, 50))
    face = (3000, 1500, 3500, 2000)  # subject on the right
    out_square = smart.crop_to(img, 1080, 1080, faces=[face])
    assert out_square.size == (1080, 1080)


# ---------------------------------------------------------------------------
# Pipeline tests — output layout
# ---------------------------------------------------------------------------


def test_process_one_writes_format_per_file(tmp_path: Path):
    src_dir = tmp_path / "src"
    out_dir = tmp_path / "out"
    assets = tmp_path / "assets"
    assets.mkdir()
    src_dir.mkdir()
    src_file = src_dir / "sample.jpg"
    _make_synthetic(src_file)
    _make_logo(assets / "logo_dark.png", (0, 0, 0, 255))
    _make_logo(assets / "logo_white.png", (255, 255, 255, 255))

    cfg = AppConfig(
        input_dir=src_dir,
        output_dir=out_dir,
        cache_dir=tmp_path / "cache",
        logo_dark=assets / "logo_dark.png",
        logo_white=assets / "logo_white.png",
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
    )
    logos = resolve_logos(cfg)
    assert logos is not None
    out_base = out_dir / src_file.stem
    outputs = process_one(src_file, cfg, out_base, logos=logos)

    assert len(outputs) == len(cfg.formats)
    for out_path, fmt in zip(outputs, cfg.formats, strict=True):
        expected = out_base / f"{fmt}.jpg"
        assert out_path == expected
        assert out_path.exists()
        loaded = iio.load(out_path)
        assert loaded.size == FORMAT_DIMENSIONS[fmt]

    assert (out_base / "manifest.json").exists()


def test_process_dir_mirrors_folder_structure(tmp_path: Path):
    """Folder layout: input/<sub>/<file>.jpg → output/<sub>/<stem>/<format>.jpg"""
    src_dir = tmp_path / "in"
    out_dir = tmp_path / "out"
    assets = tmp_path / "assets"
    assets.mkdir()
    _make_logo(assets / "logo_dark.png", (0, 0, 0, 255))
    _make_logo(assets / "logo_white.png", (255, 255, 255, 255))
    (src_dir / "Vacation2026").mkdir(parents=True)

    # One root-level image, two inside a subfolder.
    _make_synthetic(src_dir / "beach.jpg")
    _make_synthetic(src_dir / "Vacation2026" / "sunset.jpg")
    _make_synthetic(src_dir / "Vacation2026" / "boat.jpg")

    cfg = AppConfig(
        input_dir=src_dir,
        output_dir=out_dir,
        cache_dir=tmp_path / "cache",
        formats=["square", "portrait"],
        logo_dark=assets / "logo_dark.png",
        logo_white=assets / "logo_white.png",
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
    )
    n = process_dir(src_dir, cfg)
    assert n == 3

    # Root-level file → output/<stem>/<format>.jpg
    assert (out_dir / "beach" / "square.jpg").exists()
    assert (out_dir / "beach" / "portrait.jpg").exists()

    # Subfolder files → output/<sub>/<stem>/<format>.jpg
    for name in ("sunset", "boat"):
        for fmt in ("square", "portrait"):
            assert (out_dir / "Vacation2026" / name / f"{fmt}.jpg").exists()
