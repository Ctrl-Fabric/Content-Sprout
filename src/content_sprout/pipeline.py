"""End-to-end pipeline: source image -> N Instagram-formatted outputs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image
from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn

from . import compose, io
from .cache import DecisionCache
from .config import AppConfig, llm_provider_label
from .crop import blur_pad
from .crop import faces as faces_mod
from .crop import smart
from .formats import FORMAT_DIMENSIONS
from .manifest import ImageManifest, write as write_manifest
from .router import PlacementRouter

console = Console()

_PROBE_FORMAT = "portrait"


@dataclass
class LogoAssets:
    """Logo images for watermarking.

    ``dark`` / ``white`` are the placement defaults (usually short marks).
    Optional short/full slots enable length selection per output size.
    ``has_dark`` / ``has_light`` reflect whether true theme assets exist
    (vs a cross-theme fallback used only so placement can still run).
    """

    dark: Image.Image
    white: Image.Image
    aspect: float
    dark_short: Image.Image | None = None
    dark_full: Image.Image | None = None
    light_short: Image.Image | None = None
    light_full: Image.Image | None = None
    has_dark: bool = True
    has_light: bool = True


def resolve_logos(cfg: AppConfig) -> LogoAssets | None:
    return logos_from_paths(cfg.logo_dark, cfg.logo_white)


def logos_from_paths(dark: Path, white: Path) -> LogoAssets | None:
    if not dark.exists() or not white.exists():
        return None
    dark_img = compose.load_logo(dark)
    white_img = compose.load_logo(white)
    return LogoAssets(
        dark=dark_img,
        white=white_img,
        aspect=dark_img.width / dark_img.height,
        dark_short=dark_img,
        light_short=white_img,
        has_dark=True,
        has_light=True,
    )


def logos_from_variant_paths(
    *,
    dark_short: Path | None = None,
    dark_full: Path | None = None,
    light_short: Path | None = None,
    light_full: Path | None = None,
) -> LogoAssets | None:
    """Build LogoAssets from optional project logo paths (any subset)."""

    def _load(path: Path | None) -> Image.Image | None:
        if path is None or not path.exists():
            return None
        return compose.load_logo(path)

    ds = _load(dark_short)
    df = _load(dark_full)
    ls = _load(light_short)
    lf = _load(light_full)

    has_dark = ds is not None or df is not None
    has_light = ls is not None or lf is not None
    if not has_dark and not has_light:
        return None

    dark_place = ds or df or ls or lf
    light_place = ls or lf or ds or df
    if dark_place is None or light_place is None:
        return None

    return LogoAssets(
        dark=dark_place,
        white=light_place,
        aspect=dark_place.width / max(1, dark_place.height),
        dark_short=ds,
        dark_full=df,
        light_short=ls,
        light_full=lf,
        has_dark=has_dark,
        has_light=has_light,
    )


def _probe_format(cfg: AppConfig) -> str:
    if _PROBE_FORMAT in cfg.formats and _PROBE_FORMAT in FORMAT_DIMENSIONS:
        return _PROBE_FORMAT
    for fmt in cfg.formats:
        if fmt in FORMAT_DIMENSIONS:
            return fmt
    return "square"


def _placement_probe(
    img: Image.Image,
    faces: list[tuple[int, int, int, int]],
    cfg: AppConfig,
) -> Image.Image:
    fmt = _probe_format(cfg)
    w, h = FORMAT_DIMENSIONS[fmt]
    return render_format(img, fmt, w, h, faces, cfg)


def render_format(
    img: Image.Image,
    fmt: str,
    target_w: int,
    target_h: int,
    faces: list[tuple[int, int, int, int]],
    cfg: AppConfig,
) -> Image.Image:
    """Crop/resize (or blur-pad for story) to exact target dimensions."""
    if fmt == "story" and cfg.story.fit_mode == "blur_pad":
        return blur_pad.fit(
            img,
            target_w,
            target_h,
            blur_radius=cfg.story.blur_radius,
            faces=faces,
        )
    return smart.crop_to(img, target_w, target_h, faces=faces)


def process_one(
    src: Path,
    cfg: AppConfig,
    out_base: Path,
    logos: LogoAssets | None = None,
    router: PlacementRouter | None = None,
    *,
    source_sha: str | None = None,
    source_rel: str | None = None,
    quiet: bool = False,
    apply_logo: bool = True,
) -> list[Path]:
    """Process a single source image into every configured Instagram format."""
    if logos is None:
        logos = resolve_logos(cfg)
    if router is None:
        cache = DecisionCache(cfg.cache_dir / "decisions.jsonl")
        router = PlacementRouter(cfg, cache=cache)

    if source_sha is None:
        source_sha = io.file_sha256(src)

    img = io.load(src)
    faces = faces_mod.detect(img)

    placement_info: dict[str, str] | None = None
    placement: tuple[str, str] | None = None

    if apply_logo and logos is not None:
        probe = _placement_probe(img, faces, cfg)
        decision, decided_by = router.decide(
            probe, cfg.logo, logos.aspect, source_sha=source_sha
        )
        placement = (decision.corner, decision.logo_variant)
        placement_info = {
            "corner": decision.corner,
            "variant": decision.logo_variant,
            "decided_by": decided_by,
            "confidence": str(round(decision.confidence, 3)),
        }
        if not quiet:
            console.print(
                f"    logo [{decided_by}]: {decision.corner} / {decision.logo_variant}"
            )

    outputs: list[str] = []
    out_paths: list[Path] = []

    for fmt in cfg.formats:
        if fmt not in FORMAT_DIMENSIONS:
            if not quiet:
                console.print(f"  [yellow]skip[/yellow] unknown format '{fmt}'")
            continue
        target_w, target_h = FORMAT_DIMENSIONS[fmt]
        rendered = render_format(img, fmt, target_w, target_h, faces, cfg)

        if apply_logo and logos is not None and placement is not None:
            corner, variant = placement
            rendered = compose.apply_logo(
                rendered,
                corner=corner,  # type: ignore[arg-type]
                variant=variant,  # type: ignore[arg-type]
                logos=logos,
                logo_cfg=cfg.logo,
            )

        out_path = out_base / f"{fmt}.jpg"
        io.save(rendered, out_path, quality=cfg.jpeg_quality)
        out_paths.append(out_path)
        outputs.append(out_path.name)

    if cfg.write_manifest and outputs:
        rel_source = source_rel or src.name
        story_mode = cfg.story.fit_mode if "story" in cfg.formats else None
        write_manifest(
            out_base / "manifest.json",
            ImageManifest.now(
                source=rel_source,
                sha256=source_sha,
                formats=list(cfg.formats),
                outputs=outputs,
                placement=placement_info,
                story_fit_mode=story_mode,
            ),
        )

    return out_paths


def process_dir(input_dir: Path, cfg: AppConfig) -> int:
    """Recursively process every supported image under `input_dir`."""
    files = io.list_images(input_dir, recursive=True)
    if not files:
        console.print(f"[yellow]No images found in {input_dir}[/yellow]")
        return 0

    logos = resolve_logos(cfg)
    cache = DecisionCache(cfg.cache_dir / "decisions.jsonl")
    router = PlacementRouter(cfg, cache=cache)

    if logos is None:
        console.print(
            "[yellow]Logo files not found — outputs will have no watermark.[/yellow]\n"
            f"  Expected: [bold]{cfg.logo_dark}[/bold] and [bold]{cfg.logo_white}[/bold]"
        )
    else:
        console.print(
            f"Logos: [green]✓[/green] dark + white "
            f"({cfg.logo.width_pct:.0f}% width, {cfg.logo.padding_pct:.0f}% padding)"
        )
        llm_msg = llm_provider_label(cfg)
        console.print(
            f"Placement: heuristic + [bold]{llm_msg}[/bold] "
            f"(confidence ≥ {cfg.router.heuristic_confidence_min}, "
            f"gap ≥ {cfg.router.heuristic_gap_min})"
        )

    story_note = ""
    if "story" in cfg.formats:
        story_note = f" · story={cfg.story.fit_mode}"
    console.print(
        f"Processing [bold]{len(files)}[/bold] image(s) "
        f"→ [bold]{cfg.output_dir}[/bold] "
        f"({', '.join(cfg.formats)}){story_note}"
    )

    progress = Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
        transient=True,
    )

    with progress:
        task = progress.add_task("images", total=len(files))
        for f in files:
            rel_dir = f.relative_to(input_dir).parent
            out_base = cfg.output_dir / rel_dir / f.stem
            rel_display = str(f.relative_to(input_dir))
            progress.update(task, description=rel_display)
            process_one(
                f,
                cfg,
                out_base,
                logos=logos,
                router=router,
                source_rel=rel_display,
                quiet=True,
            )
            progress.advance(task)

    console.print(f"[bold green]Done.[/bold green] Processed {len(files)} image(s).")
    return len(files)
