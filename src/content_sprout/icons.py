"""Rasterize built-in icon packs (Material Symbols, Lucide) for export."""

from __future__ import annotations

import contextlib
import logging
import re
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)

_MATERIAL_FONT_URL = (
    "https://github.com/google/material-design-icons/raw/master/variablefont/"
    "MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf"
)
_MATERIAL_CODEPOINTS_URL = (
    "https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/"
    "MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.codepoints"
)
_LUCIDE_SVG_TMPL = "https://cdn.jsdelivr.net/npm/lucide-static@0.469.0/icons/{name}.svg"

_HEX_RE = re.compile(r"^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$")


def _hex_to_rgb(color: str) -> tuple[int, int, int]:
    raw = (color or "#ffffff").strip().lstrip("#")
    if len(raw) == 3:
        raw = "".join(c * 2 for c in raw)
    if len(raw) != 6:
        return (255, 255, 255)
    try:
        return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)
    except ValueError:
        return (255, 255, 255)


def _cache_root(cache_dir: Path | None) -> Path:
    root = Path(cache_dir or "cache").resolve() / "icons"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _download(url: str, dest: Path, timeout: float = 60.0) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=timeout) as resp:
            resp.raise_for_status()
            with tmp.open("wb") as fh:
                for chunk in resp.iter_bytes():
                    fh.write(chunk)
        tmp.replace(dest)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Icon download failed (%s): %s", url, exc)
        with contextlib.suppress(Exception):
            tmp.unlink(missing_ok=True)
        return False


@lru_cache(maxsize=1)
def _material_codepoints(cache_dir: str) -> dict[str, str]:
    path = _cache_root(Path(cache_dir)) / "MaterialSymbolsOutlined.codepoints"
    if not _download(_MATERIAL_CODEPOINTS_URL, path):
        return {}
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.strip().split()
        if len(parts) >= 2:
            out[parts[0]] = parts[1]
    return out


def _material_font_path(cache_dir: Path | None) -> Path | None:
    path = _cache_root(cache_dir) / "MaterialSymbolsOutlined.ttf"
    if _download(_MATERIAL_FONT_URL, path):
        return path
    return None


def _glyph_for_material(name: str, cache_dir: Path | None) -> str:
    cps = _material_codepoints(str(Path(cache_dir or "cache").resolve()))
    hex_cp = cps.get(name) or cps.get(name.replace("-", "_"))
    if not hex_cp:
        return ""
    try:
        return chr(int(hex_cp, 16))
    except ValueError:
        return ""


def _render_material(
    name: str,
    size: int,
    color: str,
    cache_dir: Path | None,
) -> Image.Image | None:
    font_path = _material_font_path(cache_dir)
    if not font_path:
        return None
    glyph = _glyph_for_material(name, cache_dir)
    if not glyph:
        # Ligature fallback — works when FreeType/RAQM applies GSUB.
        glyph = name
    box = max(16, int(size))
    img = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font_size = max(12, int(box * 0.82))
    try:
        font = ImageFont.truetype(str(font_path), font_size)
    except OSError:
        return None
    fill = _hex_to_rgb(color) + (255,)
    try:
        bbox = draw.textbbox((0, 0), glyph, font=font)
    except Exception:  # noqa: BLE001
        bbox = (0, 0, font_size, font_size)
    tw = max(1, bbox[2] - bbox[0])
    th = max(1, bbox[3] - bbox[1])
    x = (box - tw) / 2 - bbox[0]
    y = (box - th) / 2 - bbox[1]
    draw.text((x, y), glyph, font=font, fill=fill)
    return img


def _colorize_lucide_svg(svg: str, color: str) -> str:
    hex_color = color if color.startswith("#") else f"#{color}"
    if not _HEX_RE.match(hex_color):
        hex_color = "#ffffff"
    out = svg.replace('stroke="currentColor"', f'stroke="{hex_color}"')
    out = out.replace('fill="currentColor"', f'fill="{hex_color}"')
    if "stroke=" not in out and "fill=" not in out:
        out = out.replace("<svg ", f'<svg stroke="{hex_color}" fill="none" ', 1)
    return out


def _rasterize_svg_bytes(svg_bytes: bytes, size: int, cache_dir: Path | None) -> Image.Image | None:
    root = _cache_root(cache_dir)
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        svg_path = Path(tmp) / "icon.svg"
        png_path = Path(tmp) / "icon.png"
        svg_path.write_bytes(svg_bytes)
        box = max(16, int(size))
        converters: list[list[str]] = []
        if shutil.which("rsvg-convert"):
            converters.append(
                ["rsvg-convert", "-w", str(box), "-h", str(box), "-o", str(png_path), str(svg_path)]
            )
        if shutil.which("magick"):
            converters.append(
                [
                    "magick",
                    "-background",
                    "none",
                    str(svg_path),
                    "-resize",
                    f"{box}x{box}",
                    str(png_path),
                ]
            )
        if shutil.which("convert"):
            converters.append(
                [
                    "convert",
                    "-background",
                    "none",
                    str(svg_path),
                    "-resize",
                    f"{box}x{box}",
                    str(png_path),
                ]
            )
        if shutil.which("qlmanage"):
            converters.append(
                ["qlmanage", "-t", "-s", str(box), "-o", str(tmp), str(svg_path)]
            )
        for cmd in converters:
            try:
                subprocess.run(cmd, check=True, capture_output=True, timeout=20)
                candidate = png_path
                if not candidate.exists():
                    # qlmanage writes icon.svg.png beside the svg
                    alt = Path(tmp) / "icon.svg.png"
                    if alt.exists():
                        candidate = alt
                if candidate.exists():
                    img = Image.open(candidate).convert("RGBA")
                    if img.size != (box, box):
                        img = img.resize((box, box), Image.Resampling.LANCZOS)
                    return img
            except Exception as exc:  # noqa: BLE001
                logger.debug("SVG convert failed (%s): %s", cmd[0], exc)
    return None


def _render_lucide(name: str, size: int, color: str, cache_dir: Path | None) -> Image.Image | None:
    safe = re.sub(r"[^a-z0-9_-]", "", name.lower())
    if not safe:
        return None
    cache_svg = _cache_root(cache_dir) / "lucide" / f"{safe}.svg"
    if not cache_svg.exists():
        url = _LUCIDE_SVG_TMPL.format(name=safe)
        if not _download(url, cache_svg):
            return None
    try:
        svg = cache_svg.read_text(encoding="utf-8")
    except OSError:
        return None
    colored = _colorize_lucide_svg(svg, color)
    return _rasterize_svg_bytes(colored.encode("utf-8"), size, cache_dir)


def _placeholder(size: int, color: str, label: str) -> Image.Image:
    box = max(16, int(size))
    img = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    rgb = _hex_to_rgb(color)
    pad = max(1, box // 12)
    draw.ellipse((pad, pad, box - pad, box - pad), outline=rgb + (220,), width=max(1, box // 24))
    letter = (label or "?").strip()[:1].upper() or "?"
    try:
        font = ImageFont.load_default()
    except Exception:  # noqa: BLE001
        font = None
    if font is not None:
        bbox = draw.textbbox((0, 0), letter, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text(((box - tw) / 2, (box - th) / 2), letter, fill=rgb + (230,), font=font)
    return img


def render_icon_image(
    *,
    icon_set: str,
    icon_name: str,
    size: int,
    color: str = "#ffffff",
    cache_dir: Path | None = None,
) -> Image.Image:
    """Return an RGBA icon image sized to ``size``×``size``."""
    set_id = (icon_set or "material").strip().lower()
    name = (icon_name or "").strip()
    if set_id in {"material", "material_symbols", "material-symbols"}:
        img = _render_material(name, size, color, cache_dir)
        if img is not None:
            return img
    elif set_id == "lucide":
        img = _render_lucide(name, size, color, cache_dir)
        if img is not None:
            return img
    return _placeholder(size, color, name)
