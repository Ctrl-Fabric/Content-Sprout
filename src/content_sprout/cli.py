"""`content-sprout` command-line entry point."""

from pathlib import Path

import typer
from rich.console import Console

from . import config as config_mod
from . import pipeline
from . import watcher

app = typer.Typer(
    help="Content-sprout — AI-assisted social media post generator. Cropping, resizing, and logo "
    "placement powered by a local Gemma 4 model via Ollama."
)
console = Console()


@app.command()
def run(
    input_dir: Path = typer.Argument(
        None, help="Directory of source images. Defaults to config.input_dir."
    ),
    config_path: Path = typer.Option(
        Path("config.yaml"), "--config", "-c", help="Path to config.yaml."
    ),
) -> None:
    """Process every image in INPUT_DIR through the pipeline."""
    cfg = config_mod.load(config_path)
    src = input_dir or cfg.input_dir
    n = pipeline.process_dir(src, cfg)
    console.print(f"[bold green]Done.[/bold green] Processed {n} image(s).")


@app.command()
def watch(
    config_path: Path = typer.Option(Path("config.yaml"), "--config", "-c"),
) -> None:
    """Watch the input directory and auto-process new files as they arrive."""
    cfg = config_mod.load(config_path)
    watcher.run_watch(cfg)


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host", "-h", help="Bind address."),
    port: int = typer.Option(8000, "--port", "-p", help="Bind port."),
    config_path: Path = typer.Option(Path("config.yaml"), "--config", "-c"),
    reload: bool = typer.Option(False, "--reload", help="Auto-reload on code changes (dev)."),
) -> None:
    """Run the local web UI for uploading inputs and browsing outputs."""
    import uvicorn

    from . import web as web_mod

    cfg = config_mod.load_or_create(config_path)
    console.print(
        f"[bold]Content-sprout[/bold]  →  [cyan]http://{host}:{port}[/cyan]"
    )
    console.print(f"  config     {config_path.resolve()}")
    console.print(f"  projects   {cfg.projects_dir}")
    console.print(f"  scripts    {cfg.scripts_dir}")
    console.print(f"  cache      {cfg.cache_dir}")
    console.print(f"  input_dir  {cfg.input_dir}")
    console.print(f"  output_dir {cfg.output_dir}")
    if reload:
        uvicorn.run("content_sprout.web:app", host=host, port=port, reload=True)
    else:
        uvicorn.run(
            web_mod.create_app(cfg=cfg, config_path=config_path.resolve()),
            host=host,
            port=port,
        )


@app.command()
def doctor(
    config_path: Path = typer.Option(Path("config.yaml"), "--config", "-c"),
) -> None:
    """Verify config, Ollama reachability, and that the configured model is pulled."""
    cfg = config_mod.load(config_path)
    console.print(f"Config:        [bold]{config_path}[/bold]")
    console.print(f"  input_dir    {cfg.input_dir}")
    console.print(f"  output_dir   {cfg.output_dir}")
    console.print(f"  formats      {', '.join(cfg.formats)}")
    console.print(f"  ollama.host  {cfg.ollama.host}")
    console.print(f"  ollama.model {cfg.ollama.model}")

    if cfg.logo_dark.exists() and cfg.logo_white.exists():
        console.print(f"  [green]✓[/green] Logos found ({cfg.logo_dark.name}, {cfg.logo_white.name})")
    else:
        console.print("  [yellow]![/yellow] Logo PNGs missing — pipeline runs without watermark.")
        if not cfg.logo_dark.exists():
            console.print(f"    Missing: {cfg.logo_dark}")
        if not cfg.logo_white.exists():
            console.print(f"    Missing: {cfg.logo_white}")

    try:
        import ollama
    except ImportError:
        console.print(
            "  [yellow]![/yellow] 'ollama' package not installed. "
            "Run [bold]uv sync[/bold] (or pip install -e .)."
        )
        raise typer.Exit(code=1) from None

    try:
        client = ollama.Client(host=cfg.ollama.host)
        listing = client.list()
    except Exception as e:
        console.print(f"  [red]✗[/red] Cannot reach Ollama at {cfg.ollama.host}: {e}")
        console.print("    Start it with: [bold]ollama serve[/bold]")
        raise typer.Exit(code=1) from e

    # Tolerate both pydantic-model and dict shapes across ollama-python versions.
    raw_models = getattr(listing, "models", None) or listing.get("models", [])
    names: list[str] = []
    for m in raw_models:
        name = getattr(m, "model", None) or (m.get("name") if isinstance(m, dict) else None)
        if name:
            names.append(name)

    target = cfg.ollama.model
    target_base = target.split(":")[0]
    if target in names or any(n.startswith(target_base) for n in names):
        console.print(f"  [green]✓[/green] Ollama reachable, '{target}' available.")
    else:
        console.print(f"  [yellow]![/yellow] '{target}' not pulled yet.")
        console.print(f"    Run: [bold]ollama pull {target}[/bold]")
        raise typer.Exit(code=1)
