#!/usr/bin/env python3
"""Desktop entry point for the Content-sprout macOS app.

Starts the local UI server, opens the default browser, and keeps running
until the process is stopped (Cmd+Q / kill).
"""

from __future__ import annotations

import os
import shutil
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path


APP_NAME = "Content-sprout"
DEFAULT_PORT = 17829


def _bundle_resources() -> Path:
    """Return the directory that contains config.yaml, assets/, and src/."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        meipass = Path(sys._MEIPASS)
        candidates = [
            meipass,
            Path(sys.executable).resolve().parent.parent / "Resources" / "app",
            Path(sys.executable).resolve().parent.parent / "Resources",
        ]
        for c in candidates:
            if (c / "config.yaml").exists():
                return c
        return meipass

    here = Path(__file__).resolve()
    # Packaged: Contents/Resources/launcher.py → Contents/Resources/app
    sibling_app = here.parent / "app"
    if (sibling_app / "config.yaml").exists():
        return sibling_app
    # Dev: packaging/macos/launcher.py → project root
    if here.parent.name == "macos" and here.parent.parent.name == "packaging":
        return here.parents[2]
    return here.parent


def _data_dir() -> Path:
    """Writable Application Support directory for projects, cache, config."""
    home = Path.home()
    base = home / "Library" / "Application Support" / "CtrlFabric" / "SocialMediaPostGenerator"
    base.mkdir(parents=True, exist_ok=True)
    for name in ("projects", "cache", "input", "output", "assets"):
        (base / name).mkdir(exist_ok=True)
    return base


def _ensure_config(resources: Path, data: Path) -> Path:
    """Copy default config/logos into Application Support on first launch."""
    cfg_path = data / "config.yaml"
    if not cfg_path.exists():
        src = resources / "config.yaml"
        if src.exists():
            text = src.read_text(encoding="utf-8")
            # Force relative paths under the data dir
            text = text.replace("input_dir: input", "input_dir: input")
            cfg_path.write_text(text, encoding="utf-8")
        else:
            cfg_path.write_text(
                "\n".join(
                    [
                        "input_dir: input",
                        "output_dir: output",
                        "projects_dir: projects",
                        "cache_dir: cache",
                        "scripts_dir: scripts",
                        "logo_dark: assets/logo_dark.png",
                        "logo_white: assets/logo_white.png",
                        "llm:",
                        "  provider: heuristic_only",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

    for logo in ("logo_dark.png", "logo_white.png"):
        dest = data / "assets" / logo
        if not dest.exists():
            src = resources / "assets" / logo
            if src.exists():
                shutil.copy2(src, dest)
    return cfg_path


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port(preferred: int = DEFAULT_PORT) -> int:
    if _port_free(preferred):
        return preferred
    for p in range(preferred + 1, preferred + 40):
        if _port_free(p):
            return p
    return preferred


def _wait_ready(url: str, timeout_s: float = 45.0) -> bool:
    import urllib.request

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if 200 <= getattr(resp, "status", 200) < 500:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def main() -> int:
    resources = _bundle_resources()
    data = _data_dir()
    cfg_path = _ensure_config(resources, data)

    # Make bundled package importable when not using PyInstaller
    src = resources / "src"
    if src.is_dir():
        sys.path.insert(0, str(src))

    os.chdir(data)
    os.environ.setdefault("CONTENT_SPROUT_PORT", str(DEFAULT_PORT))

    from content_sprout import config as config_mod
    from content_sprout import web as web_mod

    cfg = config_mod.load_or_create(cfg_path)
    # Resolve relative paths against Application Support
    for field in ("input_dir", "output_dir", "projects_dir", "cache_dir", "scripts_dir", "logo_dark", "logo_white"):
        p = getattr(cfg, field)
        if not p.is_absolute():
            cfg = cfg.model_copy(update={field: (data / p).resolve()})

    port = _pick_port(int(os.environ.get("CONTENT_SPROUT_PORT", DEFAULT_PORT)))
    host = "127.0.0.1"
    url = f"http://{host}:{port}"

    app = web_mod.create_app(cfg=cfg, config_path=cfg_path)

    def _open_browser() -> None:
        if _wait_ready(f"{url}/api/config"):
            webbrowser.open(url)

    threading.Thread(target=_open_browser, daemon=True).start()

    import uvicorn

    print(f"{APP_NAME} → {url}")
    print(f"Data directory: {data}")
    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
