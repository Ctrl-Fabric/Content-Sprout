"""FastAPI web UI for managing input/ uploads and browsing output/ artifacts.

Three things this powers:

1. POST   /api/input            — upload files (preserves folder paths from drag-drop).
2. GET    /api/output/...       — list, preview, download (file or .zip), inspect manifest.
3. DELETE /api/input | /output  — wipe a folder back to empty (keeps `.gitkeep`).

The server is intentionally local-only by default; uploading runs the existing
pipeline automatically if `content-sprout watch` is also running.
"""

from __future__ import annotations

import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import BackgroundTasks, Body, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config as config_mod
from . import processing_state
from . import stock_quota
from .ai_layout import prune_unreferenced_media_layers, source_asset_from_target, validate_proposed_post
from .asset_describe import describe_asset, video_too_large_for_ai_describe
from . import asset_crypto
from .config import AppConfig
from .models import (
    CreateAssetGroupRequest,
    CreatePostRequest,
    CreateProjectRequest,
    CropAssetRequest,
    GenerateImageAssetRequest,
    GenerateTtsAssetRequest,
    GenerateVideoAssetRequest,
    GenerateVideoFromImageRequest,
    GenerateVideoThumbRequest,
    PhotoEditRequest,
    PreviewTtsRequest,
    ProjectMediaFolder,
    ProjectType,
    RenderRequest,
    StockUploadRequest,
    StockUploadSiteTestRequest,
    SynthesizeTtsRequest,
    UpdateAssetRequest,
    UpdatePostRequest,
    UpdateProjectLogosRequest,
    UpscaleAssetRequest,
    VideoEditRequest,
    AssetType,
    is_audio_asset,
    is_image_asset,
    is_processable_image,
    is_video_asset,
)
from .stock_media import (
    StockItem,
    fetch_remote_bytes,
    filename_for_stock_item,
    search_stock,
)
from .photo_ops import apply_photo_ops, image_to_jpeg_bytes
from .projects import EDITED_IMAGES_GROUP, EDITED_VIDEOS_GROUP, ProjectStore
from .global_assets import GlobalAssetStore
from .formats import export_variant_specs, normalize_video_format_key
from .render import (
    export_image,
    export_video,
    render_composition,
    resolve_export_size,
    scale_exported_video,
    using_global_assets,
)
from .script_store import (
    ActivateScriptRequest,
    CreateScriptRequest,
    ScriptStore,
    UpdateScriptRequest,
    document_to_api,
    summary_to_api,
)
from .instagram import auth as ig_auth
from .instagram import captions as ig_captions
from .instagram import publish as ig_publish
from .instagram import store as ig_store
from .instagram.client import InstagramApiError
from .llm import factory as llm_factory
from .llm.errors import format_llm_error
from .llm.prompts import (
    IMPROVE_PROMPT,
    LAYOUT_EDIT_PROMPT,
    PHOTO_OPS_PROMPT,
    SCRIPT_GENERATE_PROMPT,
    SCRIPT_REFINE_PROMPT,
    SCRIPT_VIDEO_PROMPT,
)
from PIL import Image

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

STATIC_DIR = Path(__file__).parent / "static"
# Packaged / production Angular build (copied next to the package or under ui/dist).
_UI_DIST_CANDIDATES = (
    Path(__file__).resolve().parent / "ui_dist",
    Path(__file__).resolve().parents[2] / "ui" / "dist" / "content-sprout-angular" / "browser",
)


def _resolve_ui_dist() -> Path | None:
    for candidate in _UI_DIST_CANDIDATES:
        if (candidate / "index.html").is_file():
            return candidate
    return None


_API_ONLY_INDEX = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Content-Sprout API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    code { background: #f2f2f2; padding: 0.1em 0.35em; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Content-Sprout API</h1>
  <p>The REST API is running. The browser UI is the Angular app in <code>ui/</code>.</p>
  <p>Dev: run <code>./start-ui.sh</code> and open <code>http://127.0.0.1:4210</code>.</p>
  <p>Packaged builds serve the Angular production bundle from this server when present.</p>
</body>
</html>
"""
HIDDEN_PREFIXES = (".",)  # skip .DS_Store, .gitkeep, .done, .failed when listing


def _is_hidden(path: Path) -> bool:
    """True if any path component starts with a dot (e.g. `.done`, `.DS_Store`)."""
    return any(part.startswith(HIDDEN_PREFIXES) for part in path.parts)


def _safe_resolve(base: Path, rel: str) -> Path:
    """Resolve `rel` against `base`, refusing path traversal outside `base`."""
    base = base.resolve()
    candidate = (base / rel).resolve()
    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path escapes managed directory.") from exc
    return candidate


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


# Request bodies must be module-level. Nested models inside create_app break under
# ``from __future__ import annotations`` (FastAPI treats them as query params → 422).
class StorageSettingsUpdate(BaseModel):
    projects_dir: str | None = None
    cache_dir: str | None = None
    input_dir: str | None = None
    output_dir: str | None = None
    scripts_dir: str | None = None


class LlmSettingsUpdate(BaseModel):
    provider: Literal["ollama", "proxy", "gemini", "heuristic_only"] | None = None
    ollama_host: str | None = None
    ollama_model: str | None = None
    ollama_timeout_s: int | None = None
    proxy_base_url: str | None = None
    proxy_api_key: str | None = None
    proxy_model: str | None = None
    proxy_timeout_s: int | None = None
    proxy_portkey_provider: str | None = None
    proxy_portkey_virtual_key: str | None = None
    gemini_api_key: str | None = None
    gemini_model: str | None = None
    gemini_vision_model: str | None = None
    gemini_timeout_s: int | None = None
    gemini_image_model: str | None = None
    gemini_image_timeout_s: int | None = None
    image_gen_provider: Literal["off", "local", "proxy"] | None = None
    image_gen_enabled: bool | None = None
    image_gen_base_url: str | None = None
    image_gen_api_key: str | None = None
    image_gen_model: str | None = None
    image_gen_timeout_s: int | None = None
    image_gen_portkey_provider: str | None = None
    image_gen_portkey_virtual_key: str | None = None
    comfyui_provider: Literal["off", "local", "proxy"] | None = None
    comfyui_enabled: bool | None = None
    comfyui_base_url: str | None = None
    comfyui_api_key: str | None = None
    comfyui_timeout_s: int | None = None
    comfyui_poll_interval_s: float | None = None
    comfyui_workflow_path: str | None = None
    comfyui_workflows_dir: str | None = None
    comfyui_workflow_text_to_image: str | None = None
    comfyui_workflow_text_to_video: str | None = None
    comfyui_workflow_image_to_video: str | None = None
    comfyui_workflow_upscale_image: str | None = None
    comfyui_workflow_upscale_video: str | None = None
    comfyui_diffusion_model: str | None = None
    comfyui_clip_name: str | None = None
    comfyui_vae_name: str | None = None
    comfyui_width: int | None = None
    comfyui_height: int | None = None
    comfyui_frames: int | None = None
    comfyui_fps: float | None = None
    comfyui_steps: int | None = None
    comfyui_cfg: float | None = None
    comfyui_negative_prompt: str | None = None
    comfyui_gateway_base_url: str | None = None
    comfyui_gateway_api_key: str | None = None
    comfyui_gateway_model: str | None = None
    comfyui_gateway_timeout_s: int | None = None
    comfyui_portkey_provider: str | None = None
    comfyui_portkey_virtual_key: str | None = None
    media_gen_default_backend: Literal["comfyui", "gemini", "higgsfield"] | None = None
    media_gen_text_to_image: Literal["inherit", "comfyui", "gemini", "higgsfield"] | None = None
    media_gen_text_to_video: Literal["inherit", "comfyui", "gemini", "higgsfield"] | None = None
    media_gen_image_to_video: Literal["inherit", "comfyui", "gemini", "higgsfield"] | None = None
    media_gen_upscale_image: Literal["inherit", "comfyui", "gemini", "higgsfield"] | None = None
    media_gen_upscale_video: Literal["inherit", "comfyui", "gemini", "higgsfield"] | None = None
    higgsfield_api_key_id: str | None = None
    higgsfield_api_key_secret: str | None = None
    higgsfield_base_url: str | None = None
    higgsfield_endpoint_text_to_image: str | None = None
    higgsfield_endpoint_text_to_video: str | None = None
    higgsfield_endpoint_image_to_video: str | None = None
    higgsfield_endpoint_upscale_image: str | None = None
    higgsfield_endpoint_upscale_video: str | None = None
    higgsfield_timeout_s: int | None = None
    higgsfield_poll_interval_s: float | None = None


class AiPhotoEditRequest(BaseModel):
    instruction: str = Field(..., min_length=1, max_length=4000)
    asset_id: str | None = None
    use_background: bool = False
    layer_id: str | None = None
    use_local_ops: bool = True
    use_generative: bool = False
    set_as_background: bool = False
    replace_layer_id: str | None = None


class AiLayoutRequest(BaseModel):
    instruction: str = Field(..., min_length=1, max_length=8000)
    apply: bool = False
    include_preview: bool = True


class AiScriptVideoRequest(BaseModel):
    script: str = Field(..., min_length=1, max_length=50000)
    apply: bool = False
    include_preview: bool = False


class AiScriptGenerateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=2000)
    platforms: list[str] = Field(default_factory=list)
    platform: str = Field(default="", max_length=256)  # legacy single / comma-joined
    tone: str = Field(default="conversational", max_length=128)
    length: str = Field(default="medium", max_length=32)
    duration_s: float | None = Field(default=None, ge=1.0, le=600.0)
    format: str = Field(default="1080p", max_length=64)
    orientation: str = Field(default="portrait", max_length=32)
    audience: str = Field(default="", max_length=500)
    notes: str = Field(default="", max_length=4000)
    language: str = Field(default="English", max_length=64)
    ideation_notes: str = Field(default="", max_length=20000)


class AiScriptChatTurn(BaseModel):
    role: str = Field(..., min_length=1, max_length=16)
    content: str = Field(..., min_length=1, max_length=20000)


class AiScriptRefineRequest(BaseModel):
    script: str = Field(..., min_length=1, max_length=50000)
    message: str = Field(..., min_length=1, max_length=8000)
    history: list[AiScriptChatTurn] = Field(default_factory=list, max_length=24)
    topic: str = Field(default="", max_length=2000)
    platforms: list[str] = Field(default_factory=list)
    platform: str = Field(default="", max_length=256)
    format: str = Field(default="", max_length=64)
    orientation: str = Field(default="", max_length=32)
    tone: str = Field(default="", max_length=128)
    ideation_notes: str = Field(default="", max_length=20000)


class AiSuggestRequest(BaseModel):
    include_preview: bool = True


class ExportMediaRequest(BaseModel):
    """Optional size keys from the Export step (master + downscales)."""

    formats: list[str] = Field(default_factory=list)


class SuggestCaptionRequest(BaseModel):
    image_paths: list[str] = Field(..., min_length=1)


class PublishRequest(BaseModel):
    image_paths: list[str] = Field(..., min_length=1, max_length=10)
    title: str = ""
    description: str = ""
    caption: str = ""


class InstagramSettingsUpdate(BaseModel):
    enabled: bool | None = None
    app_id: str | None = None
    app_secret: str | None = None
    graph_api_version: str | None = None
    public_base_url: str | None = None
    oauth_redirect_uri: str | None = None
    default_publish_format: str | None = None


class MediaFolderCreate(BaseModel):
    label: str = "Folder"
    path: str = Field(..., min_length=1)
    enabled: bool = True


class MediaFolderUpdate(BaseModel):
    label: str | None = None
    path: str | None = None
    enabled: bool | None = None


class MediaImportRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    folder_id: str = Field(..., min_length=1)
    paths: list[str] = Field(..., min_length=1)
    group: str = ""
    post_id: str | None = None


class MediaRenameRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    folder_id: str = Field(..., min_length=1)
    path: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1, max_length=255)


class MediaPublishPackageCreate(BaseModel):
    folder_id: str = Field(..., min_length=1)
    paths: list[str] = Field(..., min_length=1)
    platform_ids: list[str] = Field(..., min_length=1)
    title: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)


class UpdateGlobalAssetRequest(BaseModel):
    name: str | None = None
    group: str | None = None
    description: str | None = None


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n:.1f} GB"


def _memory_snapshot() -> dict[str, int | float]:
    """Return basic memory stats in bytes."""
    try:
        # macOS: prefer vm_stat + sysctl (matches Activity Monitor more closely).
        if os.uname().sysname.lower() == "darwin":
            vm_out = subprocess.check_output(["vm_stat"], text=True, timeout=2.0)
            size_match = re.search(r"page size of\s+(\d+)\s+bytes", vm_out)
            page_size = int(size_match.group(1)) if size_match else 4096
            page_counts: dict[str, int] = {}
            for line in vm_out.splitlines():
                m = re.match(r"^Pages\s+(.+?):\s+([0-9.]+)\.$", line.strip())
                if not m:
                    continue
                key = m.group(1).strip().lower()
                value = int(m.group(2).replace(".", ""))
                page_counts[key] = value
            free_pages = (
                page_counts.get("free", 0)
                + page_counts.get("inactive", 0)
                + page_counts.get("speculative", 0)
                + page_counts.get("purgeable", 0)
            )
            available = max(0, free_pages * page_size)
            total = int(
                subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True, timeout=2.0).strip()
            )
        else:
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            total_pages = int(os.sysconf("SC_PHYS_PAGES"))
            avail_pages = int(os.sysconf("SC_AVPHYS_PAGES"))
            total = max(0, page_size * total_pages)
            available = max(0, page_size * avail_pages)
        used = max(0, total - available)
        used_pct = (float(used) / float(total) * 100.0) if total else 0.0
        return {
            "total_bytes": total,
            "available_bytes": available,
            "used_bytes": used,
            "used_percent": round(used_pct, 2),
        }
    except (AttributeError, OSError, ValueError, subprocess.SubprocessError):
        return {
            "total_bytes": 0,
            "available_bytes": 0,
            "used_bytes": 0,
            "used_percent": 0.0,
        }


def _list_tree(root: Path) -> list[dict]:
    """Flat list of every visible file under `root`, sorted by relative path."""
    if not root.exists():
        return []
    entries: list[dict] = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or _is_hidden(p.relative_to(root)):
            continue
        stat = p.stat()
        entries.append(
            {
                "path": str(p.relative_to(root)),
                "name": p.name,
                "size": stat.st_size,
                "size_human": _human_size(stat.st_size),
                "modified": _iso(stat.st_mtime),
                "suffix": p.suffix.lower(),
            }
        )
    return entries


def _group_outputs(root: Path) -> list[dict]:
    """Group output files by their containing image-folder (one folder per source image).

    Layout produced by the pipeline:
        output/<mirrored-rel-path>/<source-stem>/<format>.jpg + manifest.json
    """
    if not root.exists():
        return []
    groups: dict[str, dict] = {}
    for entry in _list_tree(root):
        rel = Path(entry["path"])
        folder = str(rel.parent) if rel.parent != Path(".") else ""
        g = groups.setdefault(
            folder,
            {"folder": folder, "files": [], "has_manifest": False, "total_bytes": 0},
        )
        g["files"].append(entry)
        g["total_bytes"] += entry["size"]
        if entry["name"] == "manifest.json":
            g["has_manifest"] = True
    for g in groups.values():
        g["total_bytes_human"] = _human_size(g["total_bytes"])
        g["count"] = len(g["files"])
    return sorted(groups.values(), key=lambda g: g["folder"])


def _clear_dir(root: Path) -> dict:
    """Remove every visible child of `root`, preserving `.gitkeep` and the dir itself."""
    if not root.exists():
        return {"removed_files": 0, "removed_dirs": 0}
    removed_files = 0
    removed_dirs = 0
    for child in root.iterdir():
        if child.name == ".gitkeep":
            continue
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
            removed_dirs += 1
        else:
            try:
                child.unlink()
                removed_files += 1
            except OSError:
                pass
    return {"removed_files": removed_files, "removed_dirs": removed_dirs}


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app(cfg: AppConfig | None = None, config_path: Path | None = None) -> FastAPI:
    resolved_path = (config_path or Path("config.yaml")).resolve()
    if cfg is None:
        initial = config_mod.load_or_create(resolved_path)
    else:
        if not resolved_path.exists():
            config_mod.write_config(resolved_path, cfg)
        initial = cfg

    state: dict = {"cfg": initial, "path": resolved_path}

    def get_cfg() -> AppConfig:
        return state["cfg"]

    def resolve_cfg_paths(c: AppConfig) -> AppConfig:
        """Resolve relative storage paths against the config file directory."""
        base = state["path"].parent
        updates: dict[str, Path] = {}
        for field in ("input_dir", "output_dir", "projects_dir", "cache_dir", "scripts_dir", "global_assets_dir", "logo_dark", "logo_white"):
            p = getattr(c, field)
            if not p.is_absolute():
                updates[field] = (base / p).resolve()
        return c.model_copy(update=updates) if updates else c

    def reload_cfg() -> AppConfig:
        disk = config_mod.load(state["path"])
        state["cfg"] = resolve_cfg_paths(disk)
        ensure_storage_dirs(state["cfg"])
        return state["cfg"]

    def ensure_storage_dirs(c: AppConfig) -> None:
        for field in ("input_dir", "output_dir", "projects_dir", "cache_dir", "scripts_dir", "global_assets_dir"):
            getattr(c, field).mkdir(parents=True, exist_ok=True)

    # Normalize any relative paths from the initial config against the config file dir.
    state["cfg"] = resolve_cfg_paths(get_cfg())
    ensure_storage_dirs(get_cfg())

    def project_store() -> ProjectStore:
        c = get_cfg()
        root = c.projects_dir.resolve()
        root.mkdir(parents=True, exist_ok=True)
        return ProjectStore(root, c)

    def global_asset_store() -> GlobalAssetStore:
        c = get_cfg()
        root = c.global_assets_dir.resolve()
        root.mkdir(parents=True, exist_ok=True)
        return GlobalAssetStore(root, c)

    def script_store_for(project_id: str, post_id: str) -> ScriptStore:
        store = project_store()
        try:
            store.get_project(project_id)
            store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        try:
            store.migrate_legacy_scripts_to_post(project_id, post_id)
        except FileNotFoundError:
            pass
        return ScriptStore(store.scripts_dir(project_id, post_id))

    def _post_active_script_id(project_id: str, post_id: str) -> str | None:
        try:
            return project_store().get_post(project_id, post_id).active_script_id
        except FileNotFoundError:
            return None

    def _script_api_payload(project_id: str, post_id: str, doc) -> dict:
        active_id = _post_active_script_id(project_id, post_id)
        return document_to_api(doc, active=(doc.id == active_id))

    def input_root() -> Path:
        p = get_cfg().input_dir.resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    def output_root() -> Path:
        p = get_cfg().output_dir.resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    app = FastAPI(title="Content-sprout", version="0.1.0")

    from .local_ai_lock import (
        LocalAiBusyError,
        current_local_ai_task,
        local_ai_busy,
        require_local_ai_available,
    )

    @app.exception_handler(LocalAiBusyError)
    async def local_ai_busy_handler(_request, exc: LocalAiBusyError) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={"detail": str(exc), "active_task": current_local_ai_task()},
        )

    _LOCAL_MEDIA_TASK_LABELS = {
        "text_to_video": "video generation",
        "text_to_image": "image generation",
        "image_to_video": "image-to-video generation",
        "upscale_image": "image upscale",
        "upscale_video": "video upscale",
    }

    def _uses_local_comfyui(op: str) -> bool:
        cfg = get_cfg()
        if not config_mod.comfyui_ready(cfg):
            return False
        resolved = config_mod.resolve_media_backend(cfg, op, config_dir=state["path"].parent)
        if resolved != "comfyui":
            return False
        if op == "text_to_video" and config_mod.video_gen_uses_gateway(cfg):
            return False
        return True

    def _guard_local_ai_for_media(op: str) -> None:
        if _uses_local_comfyui(op):
            require_local_ai_available(_LOCAL_MEDIA_TASK_LABELS.get(op, op))

    def _guard_local_ollama(task: str) -> None:
        if get_cfg().llm.provider == "ollama":
            require_local_ai_available(task)

    ui_dist = _resolve_ui_dist()

    # ---- Pages (Angular production build when present; else API-only stub) ----
    @app.get("/", response_class=HTMLResponse, response_model=None)
    def index():
        if ui_dist is not None:
            return FileResponse(ui_dist / "index.html")
        return HTMLResponse(_API_ONLY_INDEX)

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    if ui_dist is not None:
        # Hashed JS/CSS and other assets live beside index.html.
        assets_dir = ui_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="ui-assets")

    # ---- Meta -----------------------------------------------------------------
    @app.get("/api/config")
    def get_config() -> dict:
        c = get_cfg()
        return {
            "config_path": str(state["path"]),
            "input_dir": str(c.input_dir.resolve()),
            "output_dir": str(c.output_dir.resolve()),
            "projects_dir": str(c.projects_dir.resolve()),
            "cache_dir": str(c.cache_dir.resolve()),
            "scripts_dir": str(c.scripts_dir.resolve()),
            "formats": c.formats,
        }

    @app.get("/api/system/memory")
    def get_system_memory() -> dict:
        return _memory_snapshot()

    @app.get("/api/settings/storage")
    def storage_settings_get() -> dict:
        c = get_cfg()
        return {
            "config_path": str(state["path"]),
            "projects_dir": str(c.projects_dir),
            "cache_dir": str(c.cache_dir),
            "input_dir": str(c.input_dir),
            "output_dir": str(c.output_dir),
            "scripts_dir": str(c.scripts_dir),
            "projects_dir_resolved": str(c.projects_dir.resolve()),
            "cache_dir_resolved": str(c.cache_dir.resolve()),
            "scripts_dir_resolved": str(c.scripts_dir.resolve()),
        }

    @app.put("/api/settings/storage")
    def storage_settings_put(body: StorageSettingsUpdate) -> dict:
        updates = body.model_dump(exclude_unset=True)
        config_mod.save_storage_settings(state["path"], updates)
        c = reload_cfg()
        return {
            "saved": True,
            "config_path": str(state["path"]),
            "projects_dir": str(c.projects_dir),
            "cache_dir": str(c.cache_dir),
            "input_dir": str(c.input_dir),
            "output_dir": str(c.output_dir),
            "scripts_dir": str(c.scripts_dir),
        }

    # ---- LLM placement configuration ---------------------------------------
    @app.get("/api/llm/settings")
    def llm_settings_get() -> dict:
        cfg = get_cfg()
        proxy = cfg.llm_proxy
        ig = cfg.image_gen
        cu = cfg.comfyui
        gem = cfg.gemini
        hf = cfg.higgsfield
        mg = cfg.media_gen
        return {
            "provider": cfg.llm.provider,
            "ollama": {
                "host": cfg.ollama.host,
                "model": cfg.ollama.model,
                "timeout_s": cfg.ollama.timeout_s,
            },
            "proxy": {
                "base_url": proxy.base_url,
                "api_key_set": bool(proxy.api_key),
                "api_key_masked": config_mod.mask_secret(proxy.api_key) if proxy.api_key else "",
                "model": proxy.model,
                "timeout_s": proxy.timeout_s,
                "portkey_provider": proxy.portkey_provider,
                "portkey_virtual_key_set": bool(proxy.portkey_virtual_key),
                "portkey_virtual_key_masked": (
                    config_mod.mask_secret(proxy.portkey_virtual_key)
                    if proxy.portkey_virtual_key
                    else ""
                ),
            },
            "gemini": {
                "api_key_set": bool(config_mod.gemini_api_key(cfg)),
                "api_key_masked": (
                    config_mod.mask_secret(config_mod.gemini_api_key(cfg))
                    if config_mod.gemini_api_key(cfg)
                    else ""
                ),
                "model": gem.model,
                "vision_model": gem.vision_model,
                "timeout_s": gem.timeout_s,
                "image_model": gem.image_model,
                "image_timeout_s": gem.image_timeout_s,
                "ready": config_mod.gemini_llm_ready(cfg),
                "image_ready": config_mod.gemini_image_ready(cfg),
            },
            "image_gen": {
                "provider": ig.provider,
                "enabled": ig.enabled,
                "base_url": ig.base_url,
                "api_key_set": bool(ig.api_key),
                "api_key_masked": config_mod.mask_secret(ig.api_key) if ig.api_key else "",
                "model": ig.model,
                "timeout_s": ig.timeout_s,
                "portkey_provider": ig.portkey_provider,
                "portkey_virtual_key_set": bool(ig.portkey_virtual_key),
                "portkey_virtual_key_masked": (
                    config_mod.mask_secret(ig.portkey_virtual_key)
                    if ig.portkey_virtual_key
                    else ""
                ),
                "ready": config_mod.image_gen_ready(cfg),
            },
            "comfyui": {
                "provider": cu.provider,
                "enabled": cu.enabled,
                "base_url": cu.base_url,
                "api_key_set": bool(cu.api_key),
                "api_key_masked": config_mod.mask_secret(cu.api_key) if cu.api_key else "",
                "timeout_s": cu.timeout_s,
                "poll_interval_s": cu.poll_interval_s,
                "workflow_path": cu.workflow_path,
                "workflows_dir": cu.workflows_dir,
                "workflow_text_to_image": cu.workflow_text_to_image,
                "workflow_text_to_video": cu.workflow_text_to_video,
                "workflow_image_to_video": cu.workflow_image_to_video,
                "workflow_upscale_image": cu.workflow_upscale_image,
                "workflow_upscale_video": cu.workflow_upscale_video,
                "diffusion_model": cu.diffusion_model,
                "clip_name": cu.clip_name,
                "vae_name": cu.vae_name,
                "width": cu.width,
                "height": cu.height,
                "frames": cu.frames,
                "fps": cu.fps,
                "steps": cu.steps,
                "cfg": cu.cfg,
                "negative_prompt": cu.negative_prompt,
                "gateway_base_url": cu.gateway_base_url,
                "gateway_api_key_set": bool(cu.gateway_api_key),
                "gateway_api_key_masked": (
                    config_mod.mask_secret(cu.gateway_api_key) if cu.gateway_api_key else ""
                ),
                "gateway_model": cu.gateway_model,
                "gateway_timeout_s": cu.gateway_timeout_s,
                "portkey_provider": cu.portkey_provider,
                "portkey_virtual_key_set": bool(cu.portkey_virtual_key),
                "portkey_virtual_key_masked": (
                    config_mod.mask_secret(cu.portkey_virtual_key)
                    if cu.portkey_virtual_key
                    else ""
                ),
                "uses_gateway": config_mod.video_gen_uses_gateway(cfg),
                "ready": config_mod.comfyui_ready(cfg),
                "ops": config_mod.comfy_ops_ready_map(cfg, config_dir=state["path"].parent),
            },
            "media_gen": {
                "default_backend": mg.default_backend,
                "text_to_image": mg.text_to_image,
                "text_to_video": mg.text_to_video,
                "image_to_video": mg.image_to_video,
                "upscale_image": mg.upscale_image,
                "upscale_video": mg.upscale_video,
                "ops": config_mod.media_ops_ready_map(cfg, config_dir=state["path"].parent),
            },
            "higgsfield": {
                "api_key_id_set": bool(hf.api_key_id),
                "api_key_id_masked": (
                    config_mod.mask_secret(hf.api_key_id) if hf.api_key_id else ""
                ),
                "api_key_secret_set": bool(hf.api_key_secret),
                "api_key_secret_masked": (
                    config_mod.mask_secret(hf.api_key_secret) if hf.api_key_secret else ""
                ),
                "base_url": hf.base_url,
                "endpoint_text_to_image": hf.endpoint_text_to_image,
                "endpoint_text_to_video": hf.endpoint_text_to_video,
                "endpoint_image_to_video": hf.endpoint_image_to_video,
                "endpoint_upscale_image": hf.endpoint_upscale_image,
                "endpoint_upscale_video": hf.endpoint_upscale_video,
                "timeout_s": hf.timeout_s,
                "poll_interval_s": hf.poll_interval_s,
                "ready": config_mod.higgsfield_ready(cfg),
            },
        }

    def _maybe_clear_decisions_on_llm_change(old_cfg: AppConfig, new_updates: dict) -> None:
        """Clear placement decisions cache when LLM connectivity changes."""
        try:
            decisions = old_cfg.cache_dir / "decisions.jsonl"
            if not decisions.exists():
                return

            new_provider = new_updates.get("provider", old_cfg.llm.provider)
            new_host = new_updates.get("ollama.host", old_cfg.ollama.host)
            new_model = new_updates.get("ollama.model", old_cfg.ollama.model)
            new_proxy_base = new_updates.get("llm_proxy.base_url", old_cfg.llm_proxy.base_url)
            new_proxy_model = new_updates.get("llm_proxy.model", old_cfg.llm_proxy.model)
            new_proxy_provider = new_updates.get(
                "llm_proxy.portkey_provider", old_cfg.llm_proxy.portkey_provider
            )
            new_gemini_model = new_updates.get("gemini.model", old_cfg.gemini.model)

            old_provider = old_cfg.llm.provider
            old_host = old_cfg.ollama.host
            old_model = old_cfg.ollama.model
            old_proxy_base = old_cfg.llm_proxy.base_url
            old_proxy_model = old_cfg.llm_proxy.model
            old_proxy_provider = old_cfg.llm_proxy.portkey_provider
            old_gemini_model = old_cfg.gemini.model

            changed = (
                (new_provider != old_provider)
                or (new_host != old_host)
                or (new_model != old_model)
                or (new_proxy_base != old_proxy_base)
                or (new_proxy_model != old_proxy_model)
                or (new_proxy_provider != old_proxy_provider)
                or (new_gemini_model != old_gemini_model)
                or ("llm_proxy.api_key" in new_updates)
                or ("gemini.api_key" in new_updates)
            )
            if changed:
                decisions.unlink(missing_ok=True)
        except OSError:
            # Best-effort cache clear; never block UI.
            pass

    @app.put("/api/llm/settings")
    def llm_settings_put(body: LlmSettingsUpdate) -> dict:
        old_cfg = get_cfg()
        updates = body.model_dump(exclude_unset=True)

        mapped: dict[str, Any] = {}
        if "provider" in updates:
            mapped["provider"] = updates["provider"]
        if updates.get("ollama_host") is not None:
            mapped["ollama.host"] = updates["ollama_host"]
        if updates.get("ollama_model") is not None:
            mapped["ollama.model"] = updates["ollama_model"]
        if updates.get("ollama_timeout_s") is not None:
            mapped["ollama.timeout_s"] = updates["ollama_timeout_s"]
        if updates.get("proxy_base_url") is not None:
            mapped["llm_proxy.base_url"] = updates["proxy_base_url"]
        if updates.get("proxy_api_key") is not None:
            mapped["llm_proxy.api_key"] = updates["proxy_api_key"]
        if updates.get("proxy_model") is not None:
            mapped["llm_proxy.model"] = updates["proxy_model"]
        if updates.get("proxy_timeout_s") is not None:
            mapped["llm_proxy.timeout_s"] = updates["proxy_timeout_s"]
        if updates.get("proxy_portkey_provider") is not None:
            mapped["llm_proxy.portkey_provider"] = updates["proxy_portkey_provider"]
        if updates.get("proxy_portkey_virtual_key") is not None:
            mapped["llm_proxy.portkey_virtual_key"] = updates["proxy_portkey_virtual_key"]
        if updates.get("gemini_api_key") is not None:
            mapped["gemini.api_key"] = updates["gemini_api_key"]
        if updates.get("gemini_model") is not None:
            mapped["gemini.model"] = updates["gemini_model"]
        if updates.get("gemini_vision_model") is not None:
            mapped["gemini.vision_model"] = updates["gemini_vision_model"]
        if updates.get("gemini_timeout_s") is not None:
            mapped["gemini.timeout_s"] = updates["gemini_timeout_s"]
        if updates.get("gemini_image_model") is not None:
            mapped["gemini.image_model"] = updates["gemini_image_model"]
        if updates.get("gemini_image_timeout_s") is not None:
            mapped["gemini.image_timeout_s"] = updates["gemini_image_timeout_s"]

        _maybe_clear_decisions_on_llm_change(old_cfg, mapped)

        cfg_llm, cfg_ollama, cfg_proxy, cfg_gemini = config_mod.save_llm_settings(
            state["path"], mapped
        )

        ig_updates: dict[str, Any] = {}
        if updates.get("image_gen_provider") is not None:
            ig_updates["provider"] = updates["image_gen_provider"]
        if "image_gen_enabled" in updates and updates["image_gen_enabled"] is not None:
            ig_updates["enabled"] = updates["image_gen_enabled"]
        if updates.get("image_gen_base_url") is not None:
            ig_updates["base_url"] = updates["image_gen_base_url"]
        if updates.get("image_gen_api_key") is not None:
            ig_updates["api_key"] = updates["image_gen_api_key"]
        if updates.get("image_gen_model") is not None:
            ig_updates["model"] = updates["image_gen_model"]
        if updates.get("image_gen_timeout_s") is not None:
            ig_updates["timeout_s"] = updates["image_gen_timeout_s"]
        if updates.get("image_gen_portkey_provider") is not None:
            ig_updates["portkey_provider"] = updates["image_gen_portkey_provider"]
        if updates.get("image_gen_portkey_virtual_key") is not None:
            ig_updates["portkey_virtual_key"] = updates["image_gen_portkey_virtual_key"]
        cfg_ig = (
            config_mod.save_image_gen_settings(state["path"], ig_updates)
            if ig_updates
            else get_cfg().image_gen
        )

        cu_updates: dict[str, Any] = {}
        if updates.get("comfyui_provider") is not None:
            cu_updates["provider"] = updates["comfyui_provider"]
        if "comfyui_enabled" in updates and updates["comfyui_enabled"] is not None:
            cu_updates["enabled"] = updates["comfyui_enabled"]
        mapping = {
            "comfyui_base_url": "base_url",
            "comfyui_api_key": "api_key",
            "comfyui_timeout_s": "timeout_s",
            "comfyui_poll_interval_s": "poll_interval_s",
            "comfyui_workflow_path": "workflow_path",
            "comfyui_workflows_dir": "workflows_dir",
            "comfyui_workflow_text_to_image": "workflow_text_to_image",
            "comfyui_workflow_text_to_video": "workflow_text_to_video",
            "comfyui_workflow_image_to_video": "workflow_image_to_video",
            "comfyui_workflow_upscale_image": "workflow_upscale_image",
            "comfyui_workflow_upscale_video": "workflow_upscale_video",
            "comfyui_diffusion_model": "diffusion_model",
            "comfyui_clip_name": "clip_name",
            "comfyui_vae_name": "vae_name",
            "comfyui_width": "width",
            "comfyui_height": "height",
            "comfyui_frames": "frames",
            "comfyui_fps": "fps",
            "comfyui_steps": "steps",
            "comfyui_cfg": "cfg",
            "comfyui_negative_prompt": "negative_prompt",
            "comfyui_gateway_base_url": "gateway_base_url",
            "comfyui_gateway_api_key": "gateway_api_key",
            "comfyui_gateway_model": "gateway_model",
            "comfyui_gateway_timeout_s": "gateway_timeout_s",
            "comfyui_portkey_provider": "portkey_provider",
            "comfyui_portkey_virtual_key": "portkey_virtual_key",
        }
        for src, dst in mapping.items():
            if updates.get(src) is not None:
                cu_updates[dst] = updates[src]
        cfg_cu = (
            config_mod.save_comfyui_settings(state["path"], cu_updates)
            if cu_updates
            else get_cfg().comfyui
        )

        mg_updates: dict[str, Any] = {}
        if updates.get("media_gen_default_backend") is not None:
            mg_updates["default_backend"] = updates["media_gen_default_backend"]
        for op in (
            "text_to_image",
            "text_to_video",
            "image_to_video",
            "upscale_image",
            "upscale_video",
        ):
            key = f"media_gen_{op}"
            if updates.get(key) is not None:
                mg_updates[op] = updates[key]
        cfg_mg = (
            config_mod.save_media_gen_settings(state["path"], mg_updates)
            if mg_updates
            else get_cfg().media_gen
        )

        hf_updates: dict[str, Any] = {}
        hf_map = {
            "higgsfield_api_key_id": "api_key_id",
            "higgsfield_api_key_secret": "api_key_secret",
            "higgsfield_base_url": "base_url",
            "higgsfield_endpoint_text_to_image": "endpoint_text_to_image",
            "higgsfield_endpoint_text_to_video": "endpoint_text_to_video",
            "higgsfield_endpoint_image_to_video": "endpoint_image_to_video",
            "higgsfield_endpoint_upscale_image": "endpoint_upscale_image",
            "higgsfield_endpoint_upscale_video": "endpoint_upscale_video",
            "higgsfield_timeout_s": "timeout_s",
            "higgsfield_poll_interval_s": "poll_interval_s",
        }
        for src, dst in hf_map.items():
            if updates.get(src) is not None:
                hf_updates[dst] = updates[src]
        cfg_hf = (
            config_mod.save_higgsfield_settings(state["path"], hf_updates)
            if hf_updates
            else get_cfg().higgsfield
        )

        cfg = reload_cfg()
        return {
            "saved": True,
            "llm": cfg_llm.model_dump(),
            "ollama": cfg_ollama.model_dump(),
            "proxy": {
                "base_url": cfg_proxy.base_url,
                "api_key_set": bool(cfg_proxy.api_key),
                "model": cfg_proxy.model,
                "timeout_s": cfg_proxy.timeout_s,
                "portkey_provider": cfg_proxy.portkey_provider,
                "portkey_virtual_key_set": bool(cfg_proxy.portkey_virtual_key),
            },
            "gemini": {
                "api_key_set": bool(config_mod.gemini_api_key(cfg)),
                "model": cfg_gemini.model,
                "vision_model": cfg_gemini.vision_model,
                "timeout_s": cfg_gemini.timeout_s,
                "image_model": cfg_gemini.image_model,
                "image_timeout_s": cfg_gemini.image_timeout_s,
                "ready": config_mod.gemini_llm_ready(cfg),
                "image_ready": config_mod.gemini_image_ready(cfg),
            },
            "image_gen": {
                "provider": cfg_ig.provider,
                "enabled": cfg_ig.enabled,
                "base_url": cfg_ig.base_url,
                "api_key_set": bool(cfg_ig.api_key),
                "model": cfg_ig.model,
                "timeout_s": cfg_ig.timeout_s,
                "portkey_provider": cfg_ig.portkey_provider,
                "portkey_virtual_key_set": bool(cfg_ig.portkey_virtual_key),
                "ready": config_mod.image_gen_ready(cfg),
            },
            "comfyui": {
                "provider": cfg_cu.provider,
                "enabled": cfg_cu.enabled,
                "base_url": cfg_cu.base_url,
                "api_key_set": bool(cfg_cu.api_key),
                "timeout_s": cfg_cu.timeout_s,
                "poll_interval_s": cfg_cu.poll_interval_s,
                "workflow_path": cfg_cu.workflow_path,
                "workflows_dir": cfg_cu.workflows_dir,
                "workflow_text_to_image": cfg_cu.workflow_text_to_image,
                "workflow_text_to_video": cfg_cu.workflow_text_to_video,
                "workflow_image_to_video": cfg_cu.workflow_image_to_video,
                "workflow_upscale_image": cfg_cu.workflow_upscale_image,
                "workflow_upscale_video": cfg_cu.workflow_upscale_video,
                "diffusion_model": cfg_cu.diffusion_model,
                "clip_name": cfg_cu.clip_name,
                "vae_name": cfg_cu.vae_name,
                "width": cfg_cu.width,
                "height": cfg_cu.height,
                "frames": cfg_cu.frames,
                "fps": cfg_cu.fps,
                "steps": cfg_cu.steps,
                "cfg": cfg_cu.cfg,
                "negative_prompt": cfg_cu.negative_prompt,
                "gateway_base_url": cfg_cu.gateway_base_url,
                "gateway_api_key_set": bool(cfg_cu.gateway_api_key),
                "gateway_model": cfg_cu.gateway_model,
                "gateway_timeout_s": cfg_cu.gateway_timeout_s,
                "portkey_provider": cfg_cu.portkey_provider,
                "portkey_virtual_key_set": bool(cfg_cu.portkey_virtual_key),
                "uses_gateway": config_mod.video_gen_uses_gateway(cfg),
                "ready": config_mod.comfyui_ready(cfg),
                "ops": config_mod.comfy_ops_ready_map(cfg, config_dir=state["path"].parent),
            },
            "media_gen": {
                "default_backend": cfg_mg.default_backend,
                "text_to_image": cfg_mg.text_to_image,
                "text_to_video": cfg_mg.text_to_video,
                "image_to_video": cfg_mg.image_to_video,
                "upscale_image": cfg_mg.upscale_image,
                "upscale_video": cfg_mg.upscale_video,
                "ops": config_mod.media_ops_ready_map(cfg, config_dir=state["path"].parent),
            },
            "higgsfield": {
                "api_key_id_set": bool(cfg_hf.api_key_id),
                "api_key_secret_set": bool(cfg_hf.api_key_secret),
                "base_url": cfg_hf.base_url,
                "endpoint_text_to_image": cfg_hf.endpoint_text_to_image,
                "endpoint_text_to_video": cfg_hf.endpoint_text_to_video,
                "endpoint_image_to_video": cfg_hf.endpoint_image_to_video,
                "endpoint_upscale_image": cfg_hf.endpoint_upscale_image,
                "endpoint_upscale_video": cfg_hf.endpoint_upscale_video,
                "timeout_s": cfg_hf.timeout_s,
                "poll_interval_s": cfg_hf.poll_interval_s,
                "ready": config_mod.higgsfield_ready(cfg),
            },
        }

    @app.post("/api/llm/settings/test")
    def llm_settings_test() -> dict:
        effective = get_cfg()
        if effective.llm.provider == "heuristic_only":
            return {
                "ok": True,
                "provider": effective.llm.provider,
                "checks": [{"name": "Built-in placement", "ok": True, "detail": "No AI service required."}],
            }

        if effective.llm.provider == "proxy":
            from .llm.client import OpenAICompatibleVisionClient

            checks: list[dict[str, Any]] = []

            def add_check(name: str, ok: bool, detail: str) -> None:
                checks.append({"name": name, "ok": ok, "detail": detail})

            proxy = effective.llm_proxy
            if not proxy.api_key:
                add_check("API key", False, "Set an API key for the LLM proxy.")
                return {"ok": False, "provider": "proxy", "checks": checks}

            add_check("API key", True, "Configured")
            try:
                snippet = OpenAICompatibleVisionClient(proxy).test_connection()
                add_check("Proxy reachable", True, f"Connected to {proxy.base_url}")
                add_check("Model response", True, f"Sample: {snippet}")
                return {"ok": True, "provider": "proxy", "checks": checks}
            except Exception as exc:  # noqa: BLE001
                add_check("Proxy reachable", False, format_llm_error(exc, host=proxy.base_url, model=proxy.model))
                return {"ok": False, "provider": "proxy", "checks": checks}

        if effective.llm.provider == "gemini":
            from .llm.gemini_client import GeminiVisionClient

            checks: list[dict[str, Any]] = []

            def add_check(name: str, ok: bool, detail: str) -> None:
                checks.append({"name": name, "ok": ok, "detail": detail})

            if not config_mod.gemini_api_key(effective):
                add_check("API key", False, "Set a Gemini API key in Settings.")
                return {"ok": False, "provider": "gemini", "checks": checks}

            add_check("API key", True, "Configured")
            try:
                snippet = GeminiVisionClient(effective).test_connection()
                add_check("Gemini reachable", True, f"Model {effective.gemini.model}")
                add_check("Model response", True, f"Sample: {snippet}")
                return {"ok": True, "provider": "gemini", "checks": checks}
            except Exception as exc:  # noqa: BLE001
                add_check(
                    "Gemini reachable",
                    False,
                    format_llm_error(exc, host="generativelanguage.googleapis.com", model=effective.gemini.model),
                )
                return {"ok": False, "provider": "gemini", "checks": checks}

        try:
            import ollama  # type: ignore
        except ImportError:
            return {
                "ok": False,
                "provider": "ollama",
                "checks": [
                    {"name": "Ollama python package", "ok": False, "detail": "Not installed. Install with `uv sync` (or `pip install ollama`)."},
                ],
            }

        checks: list[dict[str, Any]] = []

        def add_check(name: str, ok: bool, detail: str) -> None:
            checks.append({"name": name, "ok": ok, "detail": detail})

        host = effective.ollama.host
        model = effective.ollama.model
        try:
            try:
                client = ollama.Client(host=host, timeout=float(effective.ollama.timeout_s))
            except TypeError:
                client = ollama.Client(host=host)
            listing = client.list()
            raw_models = getattr(listing, "models", None) or listing.get("models", [])
            names: list[str] = []
            for m in raw_models:
                name = getattr(m, "model", None) or (m.get("name") if isinstance(m, dict) else None)
                if name:
                    names.append(name)
            target_base = model.split(":")[0]
            ok_model = model in names or any(n.startswith(target_base) for n in names)
            add_check("Ollama reachable", True, f"Connected to {host}")
            add_check("Model available", ok_model, f"Target: {model}")
            return {"ok": bool(ok_model), "provider": "ollama", "checks": checks}
        except Exception as exc:  # noqa: BLE001
            add_check("Ollama reachable", False, format_llm_error(exc, host=host, model=model))
            return {"ok": False, "provider": "ollama", "checks": checks}

    # ---- Input ----------------------------------------------------------------
    @app.get("/api/input")
    def list_input() -> dict:
        active = processing_state.in_progress(get_cfg().cache_dir)
        files = _list_tree(input_root())
        for f in files:
            f["processing"] = f["path"] in active
        return {"files": files, "processing": sorted(active)}

    @app.post("/api/input")
    async def upload_input(
        file: list[UploadFile] = File(..., description="One or more files to upload."),
        rel_path: list[str] = Form(default=[], description="Destination paths under input/; aligned with file."),
    ) -> JSONResponse:
        """Save uploaded files into `input/`, preserving folder structure if `rel_path` is provided.

        Browsers using <input webkitdirectory> can supply each file's `webkitRelativePath`
        as the corresponding `rel_path` entry to keep the directory tree intact.
        """
        if not file:
            raise HTTPException(status_code=400, detail="No files uploaded.")

        saved: list[dict] = []
        for idx, uf in enumerate(file):
            rel = rel_path[idx] if idx < len(rel_path) and rel_path[idx] else (uf.filename or "")
            rel = rel.lstrip("/").replace("\\", "/")
            if not rel:
                continue
            dest = _safe_resolve(input_root(), rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("wb") as out:
                while True:
                    chunk = await uf.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            stat = dest.stat()
            saved.append(
                {
                    "path": str(dest.relative_to(input_root())),
                    "size": stat.st_size,
                    "size_human": _human_size(stat.st_size),
                }
            )
        return JSONResponse({"saved": saved, "count": len(saved)})

    @app.delete("/api/input")
    def clear_input() -> dict:
        return {"cleared": "input", **_clear_dir(input_root())}

    # ---- Output ---------------------------------------------------------------
    @app.get("/api/output")
    def list_output() -> dict:
        return {"groups": _group_outputs(output_root())}

    @app.get("/api/output/manifest")
    def output_manifest(path: str = Query(..., description="Relative folder path")) -> dict:
        folder = _safe_resolve(output_root(), path)
        manifest = folder / "manifest.json"
        if not manifest.exists():
            raise HTTPException(status_code=404, detail="manifest.json not found.")
        try:
            return json.loads(manifest.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=500, detail=f"Invalid manifest JSON: {exc}") from exc

    @app.get("/api/output/file")
    def output_file(
        path: str = Query(..., description="Relative file path"),
        download: bool = Query(False, description="Force browser download"),
    ) -> FileResponse:
        target = _safe_resolve(output_root(), path)
        if not target.is_file():
            raise HTTPException(status_code=404, detail="File not found.")
        media_type, _ = mimetypes.guess_type(target.name)
        headers = {}
        if download:
            headers["Content-Disposition"] = f'attachment; filename="{target.name}"'
        return FileResponse(
            target,
            media_type=media_type or "application/octet-stream",
            headers=headers,
        )

    @app.get("/api/output/zip")
    def output_zip(path: str = Query("", description="Relative folder path; empty = all")) -> StreamingResponse:
        folder = output_root() if not path else _safe_resolve(output_root(), path)
        if not folder.exists() or not folder.is_dir():
            raise HTTPException(status_code=404, detail="Folder not found.")

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in folder.rglob("*"):
                if not p.is_file() or _is_hidden(p.relative_to(folder)):
                    continue
                zf.write(p, arcname=str(p.relative_to(folder)))
        buf.seek(0)

        name = folder.name if folder != output_root() else "output"
        filename = f"{name or 'output'}.zip"
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.delete("/api/output")
    def clear_output() -> dict:
        return {"cleared": "output", **_clear_dir(output_root())}

    # ---- Projects -------------------------------------------------------------
    def _safe_project_path(store: ProjectStore, project_id: str, rel: str) -> Path:
        try:
            return store.resolve_asset_path(project_id, rel)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    def _quota_public(c: AppConfig | None = None) -> dict:
        cfg = c or get_cfg()
        status = stock_quota.get_status(
            Path(cfg.cache_dir),
            int(cfg.stock_media.daily_download_limit),
        )
        return {
            "daily_download_limit": status.limit,
            "downloads_used_today": status.used,
            "downloads_remaining_today": status.remaining,
            "quota_date": status.date,
        }

    _EXT_MEDIA_TYPES = {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
    }

    def _media_type_for_asset_path(path: Path, *, fallback_name: str = "") -> str:
        guess_name = fallback_name or path.name
        if Path(guess_name).suffix.lower() == ".csasset":
            guess_name = Path(guess_name).stem + ".bin"
        ext = Path(guess_name).suffix.lower()
        if ext in _EXT_MEDIA_TYPES:
            return _EXT_MEDIA_TYPES[ext]
        media_type, _ = mimetypes.guess_type(guess_name)
        return media_type or "application/octet-stream"

    def _media_type_for_asset(asset, path: Path, display_name: str) -> str:
        media_type = _media_type_for_asset_path(path, fallback_name=display_name)
        if media_type and media_type != "application/octet-stream":
            return media_type
        kind = str(getattr(asset, "type", "") or "").lower() if asset is not None else ""
        if kind == "video":
            return "video/mp4"
        if kind in {"audio", "music", "sound"}:
            return "audio/mpeg"
        if kind in {"image", "photo", "illustration", "vector"}:
            return "image/jpeg"
        return media_type or "application/octet-stream"

    def _serve_project_media(
        store: ProjectStore,
        project_id: str,
        rel: str,
        *,
        asset=None,
        download: bool = False,
        download_name: str | None = None,
    ) -> Response:
        """Serve project media; decrypt locked assets; never attach locked originals."""
        target = _safe_project_path(store, project_id, rel)
        if not target.is_file():
            raise HTTPException(status_code=404, detail="File not found.")
        locked = bool(getattr(asset, "locked", False)) if asset is not None else False
        if asset is None:
            # Infer lock from encrypted blob when asset context is missing.
            try:
                locked = asset_crypto.is_encrypted_file(target)
            except OSError:
                locked = False
        if download and locked:
            raise HTTPException(
                status_code=403,
                detail="This stock asset is locked and cannot be downloaded outside the app.",
            )
        display_name = download_name or (
            getattr(asset, "original_filename", None) if asset is not None else None
        ) or target.name
        if Path(rel).suffix.lower() == ".csasset" or asset_crypto.is_encrypted_file(target):
            try:
                if asset is not None:
                    data = store.read_media_bytes(project_id, rel)
                    suffix = store.media_suffix_for_asset(asset, rel)
                    if Path(display_name).suffix.lower() in {"", ".csasset"}:
                        display_name = f"{Path(display_name).stem or 'media'}{suffix}"
                else:
                    data = store.read_media_bytes(project_id, rel)
            except asset_crypto.AssetCryptoError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc
            media_type = _media_type_for_asset(asset, Path(display_name), display_name)
            headers = {"Cache-Control": "private, max-age=60"}
            if download:
                safe = "".join(
                    ch if ch.isalnum() or ch in "._- " else "_"
                    for ch in Path(display_name).name
                ).strip() or "download.bin"
                headers["Content-Disposition"] = f'attachment; filename="{safe}"'
            else:
                headers["Content-Disposition"] = "inline"
            return Response(content=data, media_type=media_type, headers=headers)

        media_type = _media_type_for_asset(asset, target, display_name)
        headers = {}
        if download:
            safe = "".join(
                ch if ch.isalnum() or ch in "._- " else "_"
                for ch in Path(display_name).name
            ).strip() or target.name
            headers["Content-Disposition"] = f'attachment; filename="{safe}"'
        return FileResponse(
            target,
            media_type=media_type or "application/octet-stream",
            headers=headers,
        )

    @app.get("/api/projects")
    def list_projects() -> dict:
        store = project_store()
        return {"projects": [p.model_dump() for p in store.list_projects()]}

    @app.post("/api/projects")
    def create_project(body: CreateProjectRequest) -> dict:
        store = project_store()
        project = store.create_project(body)
        return {"project": project.model_dump()}

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str) -> dict:
        store = project_store()
        try:
            project = store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"project": project.model_dump()}

    @app.delete("/api/projects/{project_id}")
    def delete_project(project_id: str) -> dict:
        store = project_store()
        try:
            store.delete_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"deleted": project_id}

    @app.get("/api/projects/{project_id}/posts")
    def list_project_posts(project_id: str) -> dict:
        store = project_store()
        try:
            posts = store.list_posts(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"posts": [p.model_dump() for p in posts]}

    @app.post("/api/projects/{project_id}/posts")
    def create_project_post(project_id: str, body: CreatePostRequest) -> dict:
        store = project_store()
        try:
            post = store.create_post(project_id, body)
            project = store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"post": post.model_dump(), "project": project.model_dump()}

    @app.get("/api/projects/{project_id}/posts/{post_id}")
    def get_project_post(project_id: str, post_id: str) -> dict:
        store = project_store()
        try:
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"post": post.model_dump()}

    @app.put("/api/projects/{project_id}/posts/{post_id}")
    def update_project_post(project_id: str, post_id: str, body: UpdatePostRequest) -> dict:
        store = project_store()
        try:
            post = store.update_post(project_id, post_id, body.post)
            project = store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"post": post.model_dump(), "project": project.model_dump()}

    @app.delete("/api/projects/{project_id}/posts/{post_id}")
    def delete_project_post(project_id: str, post_id: str) -> dict:
        store = project_store()
        try:
            store.delete_post(project_id, post_id)
            project = store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"deleted": post_id, "project": project.model_dump()}

    def _process_asset_bg(project_id: str, asset_id: str) -> None:
        store = project_store()
        try:
            store.process_asset(project_id, asset_id)
        except FileNotFoundError:
            pass

    def _video_thumb_bg(project_id: str, asset_id: str, time_s: float | None = None) -> None:
        store = project_store()
        try:
            store.generate_video_thumb(project_id, asset_id, time_s=time_s)
        except Exception:  # noqa: BLE001 — thumbs are best-effort
            pass

    def _queue_video_thumb(
        background_tasks: BackgroundTasks,
        project_id: str,
        asset_id: str,
        *,
        time_s: float | None = None,
    ) -> bool:
        """Queue ffmpeg still extraction for a video asset. Returns False if skipped."""
        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError:
            return False
        if not is_video_asset(asset.type):
            return False
        from .video_edit import ffmpeg_available

        if not ffmpeg_available():
            return False
        background_tasks.add_task(_video_thumb_bg, project_id, asset_id, time_s)
        return True

    def _describe_asset_bg(project_id: str, asset_id: str, *, force: bool = False) -> None:
        if not config_mod.vision_llm_ready(get_cfg()):
            return
        try:
            describe_asset(project_store(), get_cfg(), project_id, asset_id, force=force)
        except Exception:  # noqa: BLE001
            pass

    def _queue_asset_describe(
        background_tasks: BackgroundTasks,
        project_id: str,
        asset_id: str,
        *,
        force: bool = False,
    ) -> bool:
        """Queue AI catalog description when eligible. Returns False if skipped."""
        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError:
            return False
        if video_too_large_for_ai_describe(asset):
            return False
        if config_mod.vision_llm_ready(get_cfg()):
            background_tasks.add_task(_describe_asset_bg, project_id, asset_id, force=force)
            return True
        return False

    def _needs_manual_description(asset) -> bool:
        return video_too_large_for_ai_describe(asset) and not (asset.description or "").strip()

    @app.get("/api/projects/{project_id}/assets/zip")
    def download_project_assets_zip(project_id: str) -> StreamingResponse:
        """Zip downloadable asset originals (skips locked stock assets)."""
        store = project_store()
        try:
            project = store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        buf = io.BytesIO()
        used_names: set[str] = set()
        added = 0
        skipped_locked = 0
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for asset in project.assets:
                if not asset.original_path:
                    continue
                if asset.post_id:
                    # Post-private assets are downloaded from the post editor, not the hub zip.
                    continue
                if asset.locked:
                    skipped_locked += 1
                    continue
                try:
                    path = store.resolve_asset_path(project_id, asset.original_path)
                except ValueError:
                    continue
                if not path.is_file():
                    continue
                if asset_crypto.is_encrypted_file(path):
                    skipped_locked += 1
                    continue
                kind = asset.type.value if hasattr(asset.type, "value") else str(asset.type)
                scope = "shared"
                base_name = Path(asset.original_filename or path.name).name
                safe_base = "".join(
                    ch if ch.isalnum() or ch in "._- " else "_"
                    for ch in base_name
                ).strip() or path.name
                arc = f"{kind}/{scope}/{asset.id}_{safe_base}"
                if arc in used_names:
                    stem = Path(safe_base).stem
                    suffix = Path(safe_base).suffix
                    arc = f"{kind}/{scope}/{asset.id}_{stem}_{added}{suffix}"
                used_names.add(arc)
                zf.write(path, arcname=arc)
                added += 1

        if not added:
            detail = "No downloadable asset files found."
            if skipped_locked:
                detail = (
                    "No downloadable assets — locked stock media cannot be exported. "
                    f"({skipped_locked} locked skipped.)"
                )
            raise HTTPException(status_code=404, detail=detail)

        buf.seek(0)
        safe_project = "".join(
            ch if ch.isalnum() or ch in "._- " else "_"
            for ch in (project.name or project_id)
        ).strip() or project_id
        filename = f"{safe_project}-assets.zip"
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.post("/api/projects/{project_id}/assets")
    async def upload_project_asset(
        project_id: str,
        background_tasks: BackgroundTasks,
        file: UploadFile = File(...),
        apply_logo: bool = Form(False),
        group: str = Form(""),
        post_id: str = Form(""),
        asset_type: str = Form(""),
    ) -> JSONResponse:
        store = project_store()
        try:
            store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        filename = file.filename or "upload"
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty file.")

        owner_post = (post_id or "").strip() or None
        preferred = (asset_type or "").strip() or None
        try:
            asset = store.add_asset(
                project_id,
                filename,
                data,
                apply_logo=apply_logo,
                group=group,
                post_id=owner_post,
                asset_type=preferred,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if is_processable_image(asset.type):
            background_tasks.add_task(_process_asset_bg, project_id, asset.id)
        elif is_video_asset(asset.type):
            _queue_video_thumb(background_tasks, project_id, asset.id)
        queued = _queue_asset_describe(background_tasks, project_id, asset.id)

        project = store.get_project(project_id)
        updated = next(a for a in project.assets if a.id == asset.id)
        return JSONResponse(
            {
                "asset": updated.model_dump(),
                "project": project.model_dump(),
                "ai_describe_queued": queued,
                "needs_manual_description": _needs_manual_description(updated),
            }
        )

    # ---- Global asset library (cross-project) ---------------------------------
    @app.get("/api/global-assets")
    def list_global_assets() -> dict:
        store = global_asset_store()
        assets = store.list_assets()
        return {
            "assets": [a.model_dump(mode="json") for a in assets],
            "groups": store.list_groups(),
        }

    @app.post("/api/global-assets")
    async def upload_global_asset(
        file: UploadFile = File(...),
        group: str = Form(""),
        name: str = Form(""),
        asset_type: str = Form(""),
    ) -> JSONResponse:
        store = global_asset_store()
        filename = file.filename or "upload"
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty file.")
        preferred = (asset_type or "").strip() or None
        try:
            asset = store.add_asset(
                filename,
                data,
                group=group,
                name=name or None,
                asset_type=preferred,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return JSONResponse(
            {
                "asset": asset.model_dump(mode="json"),
                "assets": [a.model_dump(mode="json") for a in store.list_assets()],
                "groups": store.list_groups(),
            }
        )

    @app.patch("/api/global-assets/{asset_id}")
    def patch_global_asset(asset_id: str, body: UpdateGlobalAssetRequest) -> dict:
        store = global_asset_store()
        try:
            asset = store.update_asset(
                asset_id,
                name=body.name,
                group=body.group,
                description=body.description,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"asset": asset.model_dump(mode="json")}

    @app.delete("/api/global-assets/{asset_id}")
    def delete_global_asset(asset_id: str) -> dict:
        store = global_asset_store()
        try:
            store.delete_asset(asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "deleted": asset_id,
            "assets": [a.model_dump(mode="json") for a in store.list_assets()],
            "groups": store.list_groups(),
        }

    @app.get("/api/global-assets/{asset_id}/file")
    def get_global_asset_file(
        asset_id: str,
        path: str | None = Query(None),
        download: bool = Query(False),
    ) -> Response:
        store = global_asset_store()
        try:
            asset = store.get_asset(asset_id)
            disk = store.resolve_path(asset, path)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        display_name = asset.original_filename or disk.name
        media_type = _media_type_for_asset(asset, disk, display_name)
        headers = {}
        if download:
            headers["Content-Disposition"] = (
                f'attachment; filename="{display_name}"'
            )
        return FileResponse(disk, media_type=media_type or "application/octet-stream", headers=headers)

    @app.get("/api/global-assets/{asset_id}/download")
    def download_global_asset(asset_id: str) -> Response:
        store = global_asset_store()
        try:
            asset = store.get_asset(asset_id)
            disk = store.resolve_path(asset)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        media_type, _ = mimetypes.guess_type(str(disk))
        return FileResponse(
            disk,
            media_type=media_type or "application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{asset.original_filename or disk.name}"'
            },
        )

    @app.post("/api/projects/{project_id}/asset-groups")
    def create_asset_group(project_id: str, body: CreateAssetGroupRequest) -> dict:
        store = project_store()
        try:
            project = store.add_asset_group(project_id, body.name)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"project": project.model_dump(), "group": body.name.strip()[:80]}

    @app.delete("/api/projects/{project_id}/asset-groups/{group_name}")
    def delete_asset_group(project_id: str, group_name: str) -> dict:
        store = project_store()
        try:
            project = store.delete_asset_group(project_id, group_name, clear_assets=True)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"project": project.model_dump(mode="json"), "deleted": group_name}

    @app.post("/api/projects/{project_id}/logos/{kind}")
    async def upload_project_logo(
        project_id: str,
        kind: str,
        file: UploadFile = File(...),
    ) -> dict:
        """Upload a project logo (stored as an asset; path saved on project).
        kind: dark_short | dark_full | light_short | light_full
        """
        store = project_store()
        try:
            store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        data = await file.read()
        try:
            project = store.set_project_logo(
                project_id, kind, file.filename or f"logo_{kind}.png", data
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"project": project.model_dump(mode="json")}

    @app.patch("/api/projects/{project_id}/logos")
    def patch_project_logos(project_id: str, body: UpdateProjectLogosRequest) -> dict:
        store = project_store()
        try:
            project = store.clear_project_logos(
                project_id,
                clear_dark_short=body.clear_dark_short,
                clear_dark_full=body.clear_dark_full,
                clear_light_short=body.clear_light_short,
                clear_light_full=body.clear_light_full,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"project": project.model_dump(mode="json")}

    @app.patch("/api/projects/{project_id}/assets/{asset_id}")
    def patch_project_asset(
        project_id: str,
        asset_id: str,
        body: UpdateAssetRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        store = project_store()
        try:
            asset = store.update_asset(
                project_id,
                asset_id,
                apply_logo=body.apply_logo,
                group=body.group,
                name=body.name,
                description=body.description,
                post_id=body.post_id,
                set_post_id="post_id" in body.model_fields_set,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if body.apply_logo is not None and asset.type.value == "image":
            background_tasks.add_task(_process_asset_bg, project_id, asset_id)
            project = store.get_project(project_id)
            asset = next(a for a in project.assets if a.id == asset_id)

        return {"asset": asset.model_dump()}

    @app.post("/api/projects/{project_id}/assets/{asset_id}/process")
    def reprocess_asset(
        project_id: str,
        asset_id: str,
        background_tasks: BackgroundTasks,
    ) -> dict:
        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not is_image_asset(asset.type):
            raise HTTPException(status_code=400, detail="Only image assets can be processed.")
        background_tasks.add_task(_process_asset_bg, project_id, asset_id)
        return {"queued": asset_id}

    @app.post("/api/projects/{project_id}/assets/{asset_id}/thumb")
    def generate_project_video_thumb(
        project_id: str,
        asset_id: str,
        body: GenerateVideoThumbRequest | None = None,
    ) -> dict:
        """Extract a still frame from a video and save it as the library thumbnail."""
        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not is_video_asset(asset.type):
            raise HTTPException(status_code=400, detail="Only video assets support thumbnails.")
        from .video_edit import ffmpeg_available

        if not ffmpeg_available():
            raise HTTPException(status_code=400, detail="ffmpeg is required to generate video thumbnails.")
        req = body or GenerateVideoThumbRequest()
        try:
            updated = store.generate_video_thumb(project_id, asset_id, time_s=req.time_s)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Thumbnail generation failed: {exc}") from exc
        project = store.get_project(project_id)
        return {"asset": updated.model_dump(), "project": project.model_dump()}

    @app.post("/api/projects/{project_id}/assets/{asset_id}/crop")
    def crop_project_asset(
        project_id: str,
        asset_id: str,
        body: CropAssetRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Create a new image asset from a crop of an existing image (original unchanged)."""
        store = project_store()
        try:
            source = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if source.type.value != "image":
            raise HTTPException(status_code=400, detail="Only image assets can be cropped.")

        box = list(body.box or [])
        if len(box) != 4:
            raise HTTPException(status_code=400, detail="box must be [left, top, right, bottom].")
        try:
            left, top, right, bottom = (float(x) for x in box)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="box values must be numbers.") from exc
        left = max(0.0, min(1.0, left))
        top = max(0.0, min(1.0, top))
        right = max(0.0, min(1.0, right))
        bottom = max(0.0, min(1.0, bottom))
        if right - left < 0.02 or bottom - top < 0.02:
            raise HTTPException(status_code=400, detail="Crop region is too small.")

        try:
            src_path = store.materialize_asset(project_id, source)
            from .io import load as load_image

            img = load_image(src_path)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Could not open image: {exc}") from exc

        cropped, _ = apply_photo_ops(img, [{"op": "crop", "box": [left, top, right, bottom]}])
        if cropped.size[0] < 8 or cropped.size[1] < 8:
            raise HTTPException(status_code=400, detail="Crop region is too small.")

        jpeg = image_to_jpeg_bytes(cropped)
        stem = (body.name or "").strip() or f"{source.name} (crop)"
        stem = stem[:120]
        owner_post_id = source.post_id
        if body.set_post_id:
            owner_post_id = (body.post_id or "").strip() or None

        try:
            asset = store.add_asset(
                project_id,
                f"{stem}.jpg",
                jpeg,
                apply_logo=source.apply_logo,
                group=source.group or "",
                post_id=owner_post_id,
                locked=bool(source.locked),
                source=source.source or "",
            )
            store.update_asset(project_id, asset.id, name=stem, group=source.group or "")
            asset = store.get_asset(project_id, asset.id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        background_tasks.add_task(_process_asset_bg, project_id, asset.id)
        _queue_asset_describe(background_tasks, project_id, asset.id)
        project = store.get_project(project_id)
        return {
            "asset": asset.model_dump(),
            "project": project.model_dump(),
            "source_asset_id": asset_id,
        }

    @app.post("/api/projects/{project_id}/assets/{asset_id}/photo/edit")
    def edit_project_photo_asset(
        project_id: str,
        asset_id: str,
        body: PhotoEditRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Apply crop / resize / color / transform edits to an image asset.

        By default creates a new Edited images asset (source unchanged). When
        ``overwrite`` is true and the source is already an edited image, replaces
        that asset's file in place. There is no undo either way.
        """
        store = project_store()
        try:
            source = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if source.type.value != "image":
            raise HTTPException(status_code=400, detail="Only image assets can be photo-edited.")

        overwrite = bool(body.overwrite)
        is_edited = (source.group or "").strip().casefold() == EDITED_IMAGES_GROUP.casefold()
        if overwrite and not is_edited:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Only assets in the Edited images group can be overwritten. "
                    "Save as a new asset from the original instead."
                ),
            )

        ops = [op for op in (body.ops or []) if isinstance(op, dict) and op.get("op")]
        if not ops:
            raise HTTPException(status_code=400, detail="No photo edits requested.")

        try:
            src_path = store.materialize_asset(project_id, source)
            from .io import load as load_image

            img = load_image(src_path)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Could not open image: {exc}") from exc

        try:
            edited, logo_flag = apply_photo_ops(img, ops)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Photo edit failed: {exc}") from exc
        if edited.size[0] < 8 or edited.size[1] < 8:
            raise HTTPException(status_code=400, detail="Edited image is too small.")

        jpeg = image_to_jpeg_bytes(edited)
        tags: list[str] = []
        for raw in ops:
            op = str(raw.get("op", "")).strip().lower()
            if op and op not in tags and op != "apply_logo":
                tags.append(op)
        tag_suffix = ", ".join(tags[:4]) if tags else "edit"
        if overwrite:
            stem = (body.name or "").strip() or source.name
        else:
            stem = (body.name or "").strip() or f"{source.name} ({tag_suffix})"
        stem = stem[:120]

        owner_post_id = source.post_id
        if body.set_post_id:
            owner_post_id = (body.post_id or "").strip() or None

        apply_logo = source.apply_logo if logo_flag is None else bool(logo_flag)

        try:
            if overwrite:
                asset = store.replace_image_bytes(
                    project_id,
                    asset_id,
                    jpeg,
                    name=stem,
                    post_id=owner_post_id if body.set_post_id else None,
                    set_post_id=bool(body.set_post_id),
                    group=EDITED_IMAGES_GROUP,
                    apply_logo=apply_logo,
                    width=edited.size[0],
                    height=edited.size[1],
                )
            else:
                asset = store.add_asset(
                    project_id,
                    f"{stem}.jpg",
                    jpeg,
                    apply_logo=apply_logo,
                    group=EDITED_IMAGES_GROUP,
                    post_id=owner_post_id,
                    locked=bool(source.locked),
                    source=source.source or "",
                )
                store.update_asset(
                    project_id,
                    asset.id,
                    name=stem,
                    group=EDITED_IMAGES_GROUP,
                )
                asset = store.get_asset(project_id, asset.id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        background_tasks.add_task(_process_asset_bg, project_id, asset.id)
        _queue_asset_describe(background_tasks, project_id, asset.id)
        project = store.get_project(project_id)
        return {
            "asset": asset.model_dump(),
            "project": project.model_dump(),
            "source_asset_id": asset_id,
            "overwritten": overwrite,
            "width": edited.size[0],
            "height": edited.size[1],
        }

    @app.get("/api/projects/{project_id}/assets/{asset_id}/video/info")
    def video_asset_info(project_id: str, asset_id: str) -> dict:
        """Probe duration / audio / size for a video asset (read-only)."""
        from .video_edit import VideoEditError, ffmpeg_available, probe_video_info

        store = project_store()
        try:
            source = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if source.type.value != "video":
            raise HTTPException(status_code=400, detail="Only video assets can be probed.")
        if not ffmpeg_available():
            raise HTTPException(
                status_code=400,
                detail="ffmpeg/ffprobe is required. Install with: brew install ffmpeg",
            )
        try:
            path = store.materialize_asset(project_id, source)
            info = probe_video_info(path)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except VideoEditError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "asset_id": asset_id,
            "duration_s": info.duration_s,
            "has_audio": info.has_audio,
            "width": info.width,
            "height": info.height,
            "fps": info.fps,
            "container": info.container,
            "video_codec": info.video_codec,
            "audio_codec": info.audio_codec,
            "bitrate_kbps": info.bitrate_kbps,
            "file_size_bytes": info.file_size_bytes,
        }

    @app.post("/api/projects/{project_id}/assets/{asset_id}/video/edit")
    def edit_project_video_asset(
        project_id: str,
        asset_id: str,
        body: VideoEditRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Apply clip / speed / audio / aspect edits to a video asset.

        By default creates a new Edited videos asset (source unchanged). When
        ``overwrite`` is true and the source is already an edited video, replaces
        that asset's file in place. There is no undo either way.
        """
        from .video_edit import VideoEditError, edit_video, ffmpeg_available, probe_video_info

        store = project_store()
        try:
            source = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if source.type.value != "video":
            raise HTTPException(status_code=400, detail="Only video assets can be edited.")
        if not ffmpeg_available():
            raise HTTPException(
                status_code=400,
                detail="ffmpeg is required for video edits. Install with: brew install ffmpeg",
            )

        overwrite = bool(body.overwrite)
        is_edited = (source.group or "").strip().casefold() == EDITED_VIDEOS_GROUP.casefold()
        if overwrite and not is_edited:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Only assets in the Edited videos group can be overwritten. "
                    "Save as a new asset from the original instead."
                ),
            )

        mute = bool(body.mute)
        audio_asset_id = (body.audio_asset_id or "").strip() or None
        if mute and audio_asset_id:
            raise HTTPException(status_code=400, detail="Choose mute or add audio, not both.")

        audio_path: Path | None = None
        if audio_asset_id:
            try:
                audio_asset = store.get_asset(project_id, audio_asset_id)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            if not is_audio_asset(audio_asset.type):
                raise HTTPException(status_code=400, detail="audio_asset_id must be an audio asset.")
            try:
                audio_path = store.materialize_asset(project_id, audio_asset)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        start_s = body.start_s
        end_s = body.end_s
        speed = float(body.speed)
        remove_ranges = [
            (float(r.start_s), float(r.end_s))
            for r in (body.remove_ranges or [])
            if float(r.end_s) > float(r.start_s) + 0.05
        ]
        aspect_ratio = (body.aspect_ratio or "original").strip() or "original"
        rotate_deg = int(body.rotate_deg or 0) % 360
        if rotate_deg not in (0, 90, 180, 270):
            raise HTTPException(status_code=400, detail="rotate_deg must be 0, 90, 180, or 270.")

        crop_fields = (body.crop_x, body.crop_y, body.crop_w, body.crop_h)
        crop_set = [v is not None for v in crop_fields]
        if any(crop_set) and not all(crop_set):
            raise HTTPException(
                status_code=400,
                detail="crop_x, crop_y, crop_w, and crop_h must all be set together.",
            )
        crop: tuple[float, float, float, float] | None = None
        if all(crop_set):
            crop = (
                float(body.crop_x),  # type: ignore[arg-type]
                float(body.crop_y),  # type: ignore[arg-type]
                float(body.crop_w),  # type: ignore[arg-type]
                float(body.crop_h),  # type: ignore[arg-type]
            )

        has_geometry = bool(crop) or rotate_deg != 0 or aspect_ratio not in ("original",)
        identity = (
            start_s is None
            and end_s is None
            and not remove_ranges
            and abs(speed - 1.0) < 1e-6
            and not mute
            and audio_path is None
            and not has_geometry
        )
        if identity:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No edits requested. Set a clip range, cut-outs, speed, "
                    "crop/rotate/aspect, mute, or replacement audio."
                ),
            )

        try:
            src_path = store.materialize_asset(project_id, source)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        # Build a descriptive default name from the ops applied.
        tags: list[str] = []
        if start_s is not None or end_s is not None:
            tags.append("clip")
        if remove_ranges:
            tags.append(f"cut×{len(remove_ranges)}")
        if abs(speed - 1.0) >= 1e-3:
            tags.append(f"{speed:g}x")
        if rotate_deg:
            tags.append(f"rot{rotate_deg}")
        if crop is not None:
            tags.append("crop")
        elif aspect_ratio != "original":
            tags.append(aspect_ratio)
        if mute:
            tags.append("mute")
        if audio_path is not None:
            tags.append("audio")
        tag_suffix = ", ".join(tags) if tags else "edit"
        if overwrite:
            stem = (body.name or "").strip() or source.name
        else:
            stem = (body.name or "").strip() or f"{source.name} ({tag_suffix})"
        stem = stem[:120]

        owner_post_id = source.post_id
        if body.set_post_id:
            owner_post_id = (body.post_id or "").strip() or None

        with tempfile.TemporaryDirectory(prefix="cs-video-edit-") as tmp:
            out_path = Path(tmp) / "edited.mp4"
            try:
                edit_video(
                    src_path,
                    out_path,
                    start_s=start_s,
                    end_s=end_s,
                    remove_ranges=remove_ranges or None,
                    speed=speed,
                    mute=mute,
                    audio_path=audio_path,
                    audio_volume=float(body.audio_volume),
                    aspect_ratio=aspect_ratio,
                    rotate_deg=rotate_deg,
                    crop=crop,
                )
            except VideoEditError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if not out_path.exists() or out_path.stat().st_size < 32:
                raise HTTPException(status_code=500, detail="Video edit produced an empty file.")
            data = out_path.read_bytes()

        try:
            if overwrite:
                asset = store.replace_video_bytes(
                    project_id,
                    asset_id,
                    data,
                    name=stem,
                    post_id=owner_post_id if body.set_post_id else None,
                    set_post_id=bool(body.set_post_id),
                    group=EDITED_VIDEOS_GROUP,
                )
            else:
                asset = store.add_asset(
                    project_id,
                    f"{stem}.mp4",
                    data,
                    apply_logo=False,
                    group=EDITED_VIDEOS_GROUP,
                    post_id=owner_post_id,
                    locked=bool(source.locked),
                    source=source.source or "",
                )
                store.update_asset(project_id, asset.id, name=stem, group=EDITED_VIDEOS_GROUP)
                asset = store.get_asset(project_id, asset.id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        _queue_video_thumb(background_tasks, project_id, asset.id)
        _queue_asset_describe(background_tasks, project_id, asset.id)
        project = store.get_project(project_id)
        out_info = None
        try:
            out_info = probe_video_info(store.materialize_asset(project_id, asset))
        except (VideoEditError, FileNotFoundError, OSError):
            out_info = None
        return {
            "asset": asset.model_dump(),
            "project": project.model_dump(),
            "source_asset_id": asset_id,
            "overwritten": overwrite,
            "duration_s": out_info.duration_s if out_info else None,
            "has_audio": out_info.has_audio if out_info else None,
        }

    @app.post("/api/projects/{project_id}/assets/{asset_id}/describe")
    def describe_project_asset(
        project_id: str,
        asset_id: str,
        background_tasks: BackgroundTasks,
        force: bool = Query(True),
    ) -> dict:
        """Queue (or re-queue) AI catalog description for an asset."""
        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not config_mod.vision_llm_ready(get_cfg()):
            raise HTTPException(
                status_code=400,
                detail="Asset descriptions need Ollama, Gemini, or an LLM proxy enabled in Settings.",
            )
        if video_too_large_for_ai_describe(asset):
            size_mb = (asset.file_size_bytes or 0) / (1024 * 1024)
            raise HTTPException(
                status_code=400,
                detail=(
                    f"This video is {size_mb:.1f} MB — files larger than 20 MB are not "
                    "sent to AI for analysis. Add a manual description instead."
                ),
            )
        queued = _queue_asset_describe(background_tasks, project_id, asset_id, force=force)
        return {"queued": queued, "asset_id": asset.id}

    @app.delete("/api/projects/{project_id}/assets/{asset_id}")
    def delete_project_asset(project_id: str, asset_id: str) -> dict:
        store = project_store()
        try:
            project = store.delete_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"deleted": asset_id, "project": project.model_dump()}

    @app.get("/api/projects/{project_id}/assets/{asset_id}/download")
    def download_project_asset(project_id: str, asset_id: str) -> Response:
        """Download an asset original (image, video, or TTS/audio). Locked stock is blocked."""
        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not asset.original_path:
            raise HTTPException(status_code=404, detail="Asset has no file to download.")
        if asset.locked:
            raise HTTPException(
                status_code=403,
                detail="This stock asset is locked and cannot be downloaded outside the app.",
            )
        return _serve_project_media(
            store,
            project_id,
            asset.original_path,
            asset=asset,
            download=True,
            download_name=asset.original_filename,
        )

    @app.get("/api/projects/{project_id}/assets/{asset_id}/file")
    def get_project_asset_file(
        project_id: str,
        asset_id: str,
        path: str = Query(..., description="Relative path within project"),
        download: bool = Query(False),
    ) -> Response:
        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return _serve_project_media(
            store,
            project_id,
            path,
            asset=asset,
            download=download,
            download_name=asset.original_filename if path == asset.original_path else None,
        )

    @app.get("/api/projects/{project_id}/file")
    def get_project_file(
        project_id: str,
        path: str = Query(...),
        download: bool = Query(False),
    ) -> Response:
        store = project_store()
        try:
            project = store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        asset = None
        for a in project.assets:
            if path == a.original_path or path in (a.processed_formats or {}).values():
                asset = a
                break
        return _serve_project_media(
            store,
            project_id,
            path,
            asset=asset,
            download=download,
            download_name=(asset.original_filename if asset and path == asset.original_path else None),
        )

    @app.post("/api/projects/{project_id}/posts/{post_id}/render")
    def render_project_post(
        project_id: str,
        post_id: str,
        body: RenderRequest = Body(default_factory=lambda: RenderRequest(post_id="")),
    ) -> StreamingResponse:
        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        with using_global_assets(global_asset_store()):
            img = render_composition(
                store,
                project,
                post,
                scene_id=body.scene_id,
                time_s=body.time_s,
                abs_time_s=body.abs_time_s,
            )
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=92)
        out.seek(0)
        return StreamingResponse(out, media_type="image/jpeg")

    @app.get("/api/projects/{project_id}/posts/{post_id}/export-size")
    def get_export_size(project_id: str, post_id: str) -> dict:
        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        with using_global_assets(global_asset_store()):
            w, h = resolve_export_size(store, project, post)
        return {
            "width": w,
            "height": h,
            "target_format": post.target_format,
            "video_format": post.video_format,
        }

    @app.get("/api/projects/{project_id}/posts/{post_id}/export-variants")
    def get_export_variants(project_id: str, post_id: str) -> dict:
        store = project_store()
        try:
            store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        is_video = post.type.value == "video"
        variants = export_variant_specs(
            post.target_format,
            post.video_format,
            is_video=is_video,
        )
        return {
            "variants": variants,
            "target_format": post.target_format,
            "video_format": post.video_format,
            "type": post.type.value,
        }

    def _safe_export_stem(name: str) -> str:
        raw = "".join(c if c.isalnum() or c in "-_ " else "_" for c in (name or "post"))
        return (raw.strip().replace(" ", "_") or "post")[:80]

    @app.post("/api/projects/{project_id}/posts/{post_id}/export/image")
    def export_project_post_image(project_id: str, post_id: str) -> FileResponse:
        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        export_dir = store._post_dir(project_id, post_id) / "exports"  # noqa: SLF001
        export_dir.mkdir(parents=True, exist_ok=True)
        out_path = export_dir / "post.jpg"
        with using_global_assets(global_asset_store()):
            ok = export_image(store, project, post, out_path)
        if not ok:
            raise HTTPException(status_code=503, detail="Image export failed.")
        return FileResponse(
            out_path,
            media_type="image/jpeg",
            headers={"Content-Disposition": f'attachment; filename="{_safe_export_stem(post.name)}.jpg"'},
        )

    @app.post("/api/projects/{project_id}/posts/{post_id}/export/video")
    def export_project_post_video(
        project_id: str,
        post_id: str,
        body: ExportMediaRequest | None = Body(default=None),
    ) -> FileResponse:
        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        if post.type.value != "video":
            raise HTTPException(status_code=400, detail="Post is not a video post.")

        offered = export_variant_specs(post.target_format, post.video_format, is_video=True)
        by_key = {v["key"]: v for v in offered}
        requested = [
            normalize_video_format_key(k)
            for k in ((body.formats if body else None) or [])
            if str(k).strip()
        ]
        keys = [k for k in requested if k in by_key] or [offered[0]["key"]]

        export_dir = store._post_dir(project_id, post_id) / "exports"  # noqa: SLF001
        export_dir.mkdir(parents=True, exist_ok=True)
        stem = _safe_export_stem(post.name)
        master = offered[0]
        master_path = export_dir / f"{stem}_{master['key']}_{master['width']}x{master['height']}.mp4"
        with using_global_assets(global_asset_store()):
            ok = export_video(
                store,
                project,
                post,
                master_path,
                canvas_size=(int(master["width"]), int(master["height"])),
            )
        if not ok:
            raise HTTPException(
                status_code=503,
                detail="Video export failed. Ensure ffmpeg is installed and scenes are configured.",
            )

        files: dict[str, Path] = {str(master["key"]): master_path}
        for key in keys:
            spec = by_key[key]
            if spec["master"]:
                continue
            dest = export_dir / f"{stem}_{key}_{spec['width']}x{spec['height']}.mp4"
            if not scale_exported_video(master_path, dest, (int(spec["width"]), int(spec["height"]))):
                raise HTTPException(status_code=503, detail=f"Could not scale export to {spec['label']}.")
            files[key] = dest

        selected = [files[k] for k in keys if k in files]
        if len(selected) == 1:
            path = selected[0]
            return FileResponse(
                path,
                media_type="video/mp4",
                headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
            )

        zip_path = export_dir / f"{stem}_exports.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in selected:
                zf.write(path, path.name)
        return FileResponse(
            zip_path,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{zip_path.name}"'},
        )

    # ---- Editor AI assistant -------------------------------------------------
    def _preview_image(store: ProjectStore, project, post) -> Image.Image:
        try:
            with using_global_assets(global_asset_store()):
                return render_composition(store, project, post, canvas_size=(512, 640))
        except Exception:  # noqa: BLE001
            return Image.new("RGB", (512, 640), (30, 30, 40))

    @app.get("/api/ai/capabilities")
    def ai_capabilities() -> dict:
        cfg = get_cfg()
        media_ops = config_mod.media_ops_ready_map(cfg, config_dir=state["path"].parent)
        return {
            "vision_llm": config_mod.vision_llm_ready(cfg),
            "provider": cfg.llm.provider,
            "model": llm_factory.llm_model_name(cfg),
            "photo_ops": config_mod.vision_llm_ready(cfg),
            "layout_edit": config_mod.vision_llm_ready(cfg),
            "script_video": config_mod.vision_llm_ready(cfg),
            "script_generate": config_mod.vision_llm_ready(cfg),
            "suggestions": config_mod.vision_llm_ready(cfg),
            "asset_describe": config_mod.vision_llm_ready(cfg),
            "local_ai_busy": local_ai_busy(),
            "local_ai_task": current_local_ai_task(),
            "image_gen": config_mod.image_gen_ready(cfg),
            "image_gen_model": cfg.image_gen.model if cfg.image_gen.provider != "off" else None,
            "image_gen_provider": cfg.image_gen.provider,
            "video_gen": media_ops.get("text_to_video", False) or media_ops.get("image_to_video", False),
            "video_gen_model": (
                cfg.comfyui.gateway_model
                if config_mod.video_gen_uses_gateway(cfg)
                else (cfg.comfyui.diffusion_model if cfg.comfyui.provider != "off" else None)
            ),
            "video_gen_provider": cfg.media_gen.default_backend,
            "comfyui_ops": config_mod.comfy_ops_ready_map(
                cfg, config_dir=state["path"].parent
            ),
            "media_ops": media_ops,
            "media_gen_default_backend": cfg.media_gen.default_backend,
            "text_to_image": media_ops.get("text_to_image", False),
            "text_to_video": media_ops.get("text_to_video", False),
            "image_to_video": media_ops.get("image_to_video", False),
            "upscale_image": media_ops.get("upscale_image", False),
            "upscale_video": media_ops.get("upscale_video", False),
        }

    @app.post("/api/projects/{project_id}/posts/{post_id}/ai/photo-edit")
    def ai_photo_edit(
        project_id: str,
        post_id: str,
        body: AiPhotoEditRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        if not body.use_local_ops and not body.use_generative:
            raise HTTPException(status_code=400, detail="Enable local ops and/or generative edit.")
        if body.use_local_ops and not config_mod.vision_llm_ready(get_cfg()):
            raise HTTPException(
                status_code=400,
                detail="Local photo ops need Ollama, Gemini, or an LLM proxy enabled in Settings.",
            )
        if body.use_generative and not config_mod.image_gen_ready(get_cfg()):
            raise HTTPException(
                status_code=501,
                detail="Image generation is not configured. Enable it in Settings.",
            )

        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
            source = source_asset_from_target(
                project,
                post,
                asset_id=body.asset_id,
                use_background=body.use_background,
                layer_id=body.layer_id,
            )
            src_path = store.materialize_asset(project_id, source)
            img = Image.open(src_path)
            img.load()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        summary_parts: list[str] = []
        ops: list[dict] = []
        apply_logo_flag: bool | None = None
        working = img

        if body.use_generative:
            try:
                gen_client = llm_factory.create_image_gen_client(get_cfg())
                edited_bytes = gen_client.edit_image(working, body.instruction)
                working = Image.open(io.BytesIO(edited_bytes))
                working.load()
                summary_parts.append("Applied generative edit")
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=502, detail=f"Generative edit failed: {exc}") from exc

        if body.use_local_ops:
            _guard_local_ollama("photo edit")
            try:
                client = llm_factory.create_json_client(get_cfg())
                prompt = (
                    f"{PHOTO_OPS_PROMPT}\n\nUser instruction:\n{body.instruction.strip()}"
                )
                data = client.complete_json(prompt, images=[working.convert("RGB")])
                ops = data.get("ops") if isinstance(data.get("ops"), list) else []
                if data.get("summary"):
                    summary_parts.append(str(data["summary"]))
                working, apply_logo_flag = apply_photo_ops(working, ops)
            except LocalAiBusyError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=502,
                    detail=f"Photo ops planning failed: {format_llm_error(exc)}",
                ) from exc

        jpeg = image_to_jpeg_bytes(working)
        stem = f"{source.name} (AI edit)"
        filename = f"{stem}.jpg"
        try:
            asset = store.add_asset(
                project_id,
                filename,
                jpeg,
                apply_logo=apply_logo_flag if apply_logo_flag is not None else source.apply_logo,
                post_id=post_id,
                locked=bool(source.locked),
                source=source.source or "",
            )
            store.update_asset(
                project_id,
                asset.id,
                name=stem[:120],
                group=source.group or "",
            )
            asset = store.get_asset(project_id, asset.id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        background_tasks.add_task(_process_asset_bg, project_id, asset.id)
        _queue_asset_describe(background_tasks, project_id, asset.id)

        updated_post = None
        if body.set_as_background or body.replace_layer_id:
            post = store.get_post(project_id, post_id)
            if body.set_as_background:
                if post.type.value == "video" and post.scenes:
                    post.scenes[0].background_asset_id = asset.id
                else:
                    post.background_asset_id = asset.id
            if body.replace_layer_id:
                replaced = False
                for layer in post.layers:
                    if layer.id == body.replace_layer_id:
                        layer.asset_id = asset.id
                        replaced = True
                for scene in post.scenes:
                    for layer in scene.layers:
                        if layer.id == body.replace_layer_id:
                            layer.asset_id = asset.id
                            replaced = True
                if not replaced:
                    raise HTTPException(status_code=400, detail="replace_layer_id not found")
            updated_post = store.update_post(project_id, post_id, post)

        return {
            "asset": asset.model_dump(),
            "ops": ops,
            "summary": "; ".join(summary_parts) or "Photo edit complete",
            "post": updated_post.model_dump() if updated_post else None,
        }

    @app.post("/api/projects/{project_id}/posts/{post_id}/ai/layout")
    def ai_layout_edit(project_id: str, post_id: str, body: AiLayoutRequest) -> dict:
        if not config_mod.vision_llm_ready(get_cfg()):
            raise HTTPException(
                status_code=400,
                detail="Layout AI needs Ollama, Gemini, or an LLM proxy enabled in Settings.",
            )
        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        images = []
        if body.include_preview:
            images.append(_preview_image(store, project, post))

        asset_ids = [a.id for a in store.visible_assets(project, post_id)]
        available_assets = [
            {
                "id": a.id,
                "name": a.name,
                "type": a.type.value,
                "description": (a.description or "").strip() or None,
            }
            for a in store.visible_assets(project, post_id)
        ]
        prompt = (
            f"{LAYOUT_EDIT_PROMPT}\n\n"
            f"available_asset_ids: {json.dumps(asset_ids)}\n"
            f"available_assets: {json.dumps(available_assets, indent=2)}\n\n"
            f"current_post:\n{json.dumps(post.model_dump(), indent=2)}\n\n"
            f"User instruction:\n{body.instruction.strip()}"
        )
        _guard_local_ollama("layout AI")
        try:
            client = llm_factory.create_json_client(get_cfg())
            data = client.complete_json(prompt, images=images or None)
        except LocalAiBusyError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"Layout AI failed: {format_llm_error(exc)}") from exc

        proposed_raw = data.get("post")
        if not isinstance(proposed_raw, dict):
            raise HTTPException(status_code=502, detail="Model did not return a post object")
        try:
            proposed = validate_proposed_post(proposed_raw, project=project, current=post)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        summary = str(data.get("summary") or "Layout proposal ready")
        if body.apply:
            saved = store.update_post(project_id, post_id, proposed)
            return {
                "applied": True,
                "summary": summary,
                "post": saved.model_dump(),
            }
        return {
            "applied": False,
            "summary": summary,
            "post": proposed.model_dump(),
        }

    @app.post("/api/projects/{project_id}/posts/{post_id}/ai/script-video")
    def ai_script_video(project_id: str, post_id: str, body: AiScriptVideoRequest) -> dict:
        if not config_mod.vision_llm_ready(get_cfg()):
            raise HTTPException(
                status_code=400,
                detail="Script-to-video needs Ollama, Gemini, or an LLM proxy enabled in Settings.",
            )
        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        if post.type != ProjectType.VIDEO:
            raise HTTPException(
                status_code=400,
                detail="Script-to-video is only available for video posts.",
            )

        script = body.script.strip()
        if not script:
            raise HTTPException(status_code=400, detail="Script is empty")

        images = []
        if body.include_preview:
            images.append(_preview_image(store, project, post))

        visible = store.visible_assets(project, post_id)
        asset_ids = [a.id for a in visible]
        available_assets = [
            {
                "id": a.id,
                "name": a.name,
                "type": a.type.value,
                "description": (a.description or "").strip() or None,
            }
            for a in visible
        ]
        prompt = (
            f"{SCRIPT_VIDEO_PROMPT}\n\n"
            f"available_asset_ids: {json.dumps(asset_ids)}\n"
            f"available_assets: {json.dumps(available_assets, indent=2)}\n\n"
            f"current_post:\n{json.dumps(post.model_dump(), indent=2)}\n\n"
            f"User script:\n{script}"
        )
        _guard_local_ollama("script-to-video AI")
        try:
            client = llm_factory.create_json_client(get_cfg())
            data = client.complete_json(prompt, images=images or None)
        except LocalAiBusyError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"Script-to-video failed: {format_llm_error(exc)}",
            ) from exc

        proposed_raw = data.get("post")
        if not isinstance(proposed_raw, dict):
            raise HTTPException(status_code=502, detail="Model did not return a post object")
        try:
            proposed = validate_proposed_post(proposed_raw, project=project, current=post)
            proposed = prune_unreferenced_media_layers(proposed)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        summary = str(data.get("summary") or "Script video proposal ready")
        if body.apply:
            saved = store.update_post(project_id, post_id, proposed)
            return {
                "applied": True,
                "summary": summary,
                "post": saved.model_dump(),
            }
        return {
            "applied": False,
            "summary": summary,
            "post": proposed.model_dump(),
        }

    @app.get("/api/projects/{project_id}/posts/{post_id}/scripts")
    def scripts_list(project_id: str, post_id: str) -> dict:
        store = project_store()
        try:
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        ss = script_store_for(project_id, post_id)
        # Re-read post in case migration set active_script_id.
        try:
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        active_id = post.active_script_id
        items = []
        for s in ss.list_scripts():
            s.active = s.id == active_id
            items.append(summary_to_api(s))
        return {
            "scripts": items,
            "active_script_id": active_id,
            "post": post.model_dump(),
        }

    @app.post("/api/projects/{project_id}/posts/{post_id}/scripts")
    def scripts_create(project_id: str, post_id: str, body: CreateScriptRequest) -> dict:
        store = project_store()
        ss = script_store_for(project_id, post_id)
        try:
            doc = ss.create_script(body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        post = store.get_post(project_id, post_id)
        should_activate = bool(body.activate) or not post.active_script_id
        if should_activate:
            try:
                post = store.set_active_script(project_id, post_id, doc.id)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "script": _script_api_payload(project_id, post_id, doc),
            "active_script_id": post.active_script_id,
            "post": post.model_dump(),
        }

    @app.get("/api/projects/{project_id}/posts/{post_id}/scripts/{script_id}")
    def scripts_get(project_id: str, post_id: str, script_id: str) -> dict:
        try:
            doc = script_store_for(project_id, post_id).get_script(script_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        post = project_store().get_post(project_id, post_id)
        return {
            "script": _script_api_payload(project_id, post_id, doc),
            "active_script_id": post.active_script_id,
        }

    @app.put("/api/projects/{project_id}/posts/{post_id}/scripts/{script_id}")
    def scripts_update(project_id: str, post_id: str, script_id: str, body: UpdateScriptRequest) -> dict:
        store = project_store()
        ss = script_store_for(project_id, post_id)
        try:
            doc = ss.update_script(script_id, body)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        post = store.get_post(project_id, post_id)
        if body.activate is True:
            try:
                post = store.set_active_script(project_id, post_id, script_id)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "script": _script_api_payload(project_id, post_id, doc),
            "active_script_id": post.active_script_id,
            "post": post.model_dump(),
        }

    @app.post("/api/projects/{project_id}/posts/{post_id}/scripts/{script_id}/activate")
    def scripts_activate(
        project_id: str,
        post_id: str,
        script_id: str,
        body: ActivateScriptRequest = Body(default_factory=ActivateScriptRequest),
    ) -> dict:
        store = project_store()
        ss = script_store_for(project_id, post_id)
        try:
            doc = ss.get_script(script_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        activate = bool(body.active)
        try:
            if activate:
                post = store.set_active_script(project_id, post_id, script_id)
            else:
                post = store.get_post(project_id, post_id)
                if post.active_script_id == script_id:
                    post = store.set_active_script(project_id, post_id, None)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "script": _script_api_payload(project_id, post_id, doc),
            "active_script_id": post.active_script_id,
            "post": post.model_dump(),
        }

    @app.delete("/api/projects/{project_id}/posts/{post_id}/scripts/{script_id}")
    def scripts_delete(project_id: str, post_id: str, script_id: str) -> dict:
        store = project_store()
        ss = script_store_for(project_id, post_id)
        try:
            deleted = ss.delete_script(script_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        post = store.clear_active_script_if_matches(project_id, post_id, script_id)
        if post is None:
            post = store.get_post(project_id, post_id)
        return {
            "deleted": deleted,
            "active_script_id": post.active_script_id,
            "post": post.model_dump(),
        }

    @app.delete("/api/projects/{project_id}/posts/{post_id}/scripts")
    def scripts_clear(project_id: str, post_id: str) -> dict:
        store = project_store()
        deleted = script_store_for(project_id, post_id).clear_all()
        post = store.set_active_script(project_id, post_id, None)
        return {"deleted": deleted, "active_script_id": None, "post": post.model_dump()}

    @app.post("/api/ai/script/generate")
    def ai_script_generate(body: AiScriptGenerateRequest) -> dict:
        if not config_mod.vision_llm_ready(get_cfg()):
            raise HTTPException(
                status_code=400,
                detail="Script generation needs Ollama, Gemini, or an LLM proxy enabled in Settings.",
            )
        topic = body.topic.strip()
        if not topic:
            raise HTTPException(status_code=400, detail="Topic is required")

        duration_s = body.duration_s
        if duration_s is None:
            length_key = (body.length or "medium").strip().lower()
            duration_s = {"short": 25.0, "medium": 60.0, "long": 120.0}.get(length_key, 60.0)
        brief = {
            "topic": topic,
            "tone": body.tone.strip() or "conversational",
            "duration_s": float(duration_s),
            "length": body.length.strip() or "medium",
            "audience": body.audience.strip(),
            "notes": body.notes.strip(),
            "language": body.language.strip() or "English",
        }
        ideation_notes = body.ideation_notes.strip()
        prompt_parts = [
            SCRIPT_GENERATE_PROMPT,
            "",
            f"Brief:\n{json.dumps(brief, indent=2)}",
        ]
        if ideation_notes:
            prompt_parts.extend([
                "",
                "Post ideation notes (use these ideas, talking points, and constraints):\n"
                f"{ideation_notes}",
            ])
        prompt = "\n".join(prompt_parts)
        _guard_local_ollama("script generation")
        try:
            client = llm_factory.create_json_client(get_cfg())
            data = client.complete_json(prompt)
        except LocalAiBusyError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"Script generation failed: {format_llm_error(exc)}",
            ) from exc

        script = str(data.get("script") or "").strip()
        if not script:
            raise HTTPException(status_code=502, detail="Model did not return a script")
        return {
            "title": str(data.get("title") or "").strip() or "Untitled script",
            "summary": str(data.get("summary") or "").strip(),
            "script": script,
        }

    @app.post("/api/ai/script/refine")
    def ai_script_refine(body: AiScriptRefineRequest) -> dict:
        if not config_mod.vision_llm_ready(get_cfg()):
            raise HTTPException(
                status_code=400,
                detail="Script refinement needs Ollama, Gemini, or an LLM proxy enabled in Settings.",
            )
        script = body.script.strip()
        message = body.message.strip()
        if not script:
            raise HTTPException(status_code=400, detail="Script is empty")
        if not message:
            raise HTTPException(status_code=400, detail="Message is empty")

        history = []
        for turn in body.history[-20:]:
            role = (turn.role or "").strip().lower()
            if role not in ("user", "assistant"):
                continue
            content = (turn.content or "").strip()
            if not content:
                continue
            history.append({"role": role, "content": content[:8000]})

        context = {
            "topic": body.topic.strip(),
            "tone": body.tone.strip(),
        }
        ideation_notes = body.ideation_notes.strip()
        prompt_parts = [
            SCRIPT_REFINE_PROMPT,
            "",
            f"Brief context:\n{json.dumps(context, indent=2)}",
        ]
        if ideation_notes:
            prompt_parts.extend([
                "",
                "Post ideation notes (honor these unless the user asks otherwise):\n"
                f"{ideation_notes}",
            ])
        prompt_parts.extend([
            "",
            f"Current script:\n{script}",
            "",
            f"Recent chat history:\n{json.dumps(history, indent=2)}",
            "",
            f"User message:\n{message}",
        ])
        prompt = "\n".join(prompt_parts)
        _guard_local_ollama("script refinement")
        try:
            client = llm_factory.create_json_client(get_cfg())
            data = client.complete_json(prompt)
        except LocalAiBusyError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"Script refinement failed: {format_llm_error(exc)}",
            ) from exc

        next_script = str(data.get("script") or "").strip() or script
        reply = str(data.get("reply") or "").strip() or "Updated the script."
        return {
            "reply": reply,
            "summary": str(data.get("summary") or "").strip(),
            "script": next_script,
        }

    @app.post("/api/projects/{project_id}/posts/{post_id}/ai/suggest")
    def ai_suggest(project_id: str, post_id: str, body: AiSuggestRequest) -> dict:
        if not config_mod.vision_llm_ready(get_cfg()):
            raise HTTPException(
                status_code=400,
                detail="Suggestions need Ollama, Gemini, or an LLM proxy enabled in Settings.",
            )
        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        images = []
        if body.include_preview:
            images.append(_preview_image(store, project, post))

        asset_ids = [a.id for a in store.visible_assets(project, post_id)]
        available_assets = [
            {
                "id": a.id,
                "name": a.name,
                "type": a.type.value,
                "description": (a.description or "").strip() or None,
            }
            for a in store.visible_assets(project, post_id)
        ]
        prompt = (
            f"{IMPROVE_PROMPT}\n\n"
            f"available_asset_ids: {json.dumps(asset_ids)}\n"
            f"available_assets: {json.dumps(available_assets, indent=2)}\n\n"
            f"current_post:\n{json.dumps(post.model_dump(), indent=2)}"
        )
        _guard_local_ollama("suggestions")
        try:
            client = llm_factory.create_json_client(get_cfg())
            data = client.complete_json(prompt, images=images or None)
        except LocalAiBusyError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"Suggestions failed: {format_llm_error(exc)}",
            ) from exc

        suggestions_raw = data.get("suggestions") if isinstance(data.get("suggestions"), list) else []
        suggestions: list[dict] = []
        for i, item in enumerate(suggestions_raw):
            if not isinstance(item, dict):
                continue
            action = item.get("action")
            action_out = None
            if isinstance(action, dict) and isinstance(action.get("post"), dict):
                try:
                    fixed = validate_proposed_post(action["post"], project=project, current=post)
                    action_out = {
                        "summary": str(action.get("summary") or item.get("title") or "Apply fix"),
                        "post": fixed.model_dump(),
                    }
                except ValueError:
                    action_out = None
            suggestions.append(
                {
                    "id": str(item.get("id") or f"s{i + 1}"),
                    "category": str(item.get("category") or "design"),
                    "severity": str(item.get("severity") or "info"),
                    "title": str(item.get("title") or "Suggestion"),
                    "detail": str(item.get("detail") or ""),
                    "action": action_out,
                }
            )

        return {
            "disclaimer": str(
                data.get("disclaimer")
                or "Assistive tips only — not legal advice."
            ),
            "suggestions": suggestions,
        }

    # ---- Free / stock media (open licenses) ----------------------------------
    @app.get("/api/stock/capabilities")
    def stock_capabilities() -> dict:
        c = get_cfg()
        key = config_mod.stock_pixabay_key(c)
        return {
            "openverse": {
                "enabled": True,
                "media_types": ["image", "audio", "music", "sound"],
                "note": "Creative Commons images & audio via Openverse (WordPress).",
            },
            "pixabay": {
                "enabled": bool(key),
                "media_types": (
                    ["photo", "illustration", "vector", "image", "video", "film", "animation"]
                    if key
                    else []
                ),
                "unsupported_via_api": ["music", "sound", "3d"],
                "note": (
                    "Photos, illustrations, vectors, and videos via Pixabay Content License. "
                    "Music, SFX, and 3D models are not in the public API (audio uses Openverse)."
                    if key
                    else "Add a free Pixabay API key in Settings for photos, illustrations, vectors, and videos."
                ),
            },
            "timeout_s": int(c.stock_media.timeout_s),
            "browser_download_allowed": False,
            "pixabay_cache_ttl_hours": float(c.stock_media.pixabay_cache_ttl_hours),
            **_quota_public(c),
        }

    @app.get("/api/stock/settings")
    def get_stock_settings() -> dict:
        c = get_cfg()
        sm = c.stock_media
        key = config_mod.stock_pixabay_key(c)
        return {
            "timeout_s": sm.timeout_s,
            "daily_download_limit": int(sm.daily_download_limit),
            "pixabay_configured": bool(key),
            "pixabay_api_key_set": bool(key),
            "pixabay_api_key_masked": config_mod.mask_secret(key) if key else "",
            "upload_sites": config_mod.stock_upload_sites_public(c),
            "provider_presets": {
                p: config_mod.provider_defaults(p)
                for p in (
                    "shutterstock_ftps",
                    "adobe_stock_sftp",
                    "generic_ftps",
                    "generic_sftp",
                    "webhook",
                    "package",
                )
            },
            **_quota_public(c),
        }

    @app.put("/api/stock/settings")
    def put_stock_settings(body: dict = Body(...)) -> dict:
        updated = config_mod.save_stock_media_settings(state["path"], body or {})
        c = reload_cfg()
        key = config_mod.stock_pixabay_key(c)
        return {
            "timeout_s": updated.timeout_s,
            "daily_download_limit": int(updated.daily_download_limit),
            "pixabay_configured": bool(key),
            "pixabay_api_key_set": bool(key),
            "pixabay_api_key_masked": config_mod.mask_secret(key) if key else "",
            "upload_sites": config_mod.stock_upload_sites_public(c),
            "provider_presets": {
                p: config_mod.provider_defaults(p)
                for p in (
                    "shutterstock_ftps",
                    "adobe_stock_sftp",
                    "generic_ftps",
                    "generic_sftp",
                    "webhook",
                    "package",
                )
            },
            **_quota_public(c),
        }

    @app.post("/api/stock/upload-sites/test")
    def test_stock_upload_site(body: StockUploadSiteTestRequest) -> dict:
        """Login / reachability check for a stock upload destination."""
        from .config import StockUploadSite
        from .stock_upload import check_site_connection

        c = get_cfg()
        site: StockUploadSite | None = None
        if body.site_id:
            site = next((s for s in c.stock_media.upload_sites if s.id == body.site_id), None)
            if site is None:
                raise HTTPException(status_code=404, detail="Upload site not found.")
        elif body.site:
            try:
                # Merge with existing secrets when drafting an edit of a known id.
                draft = dict(body.site)
                existing = next(
                    (s for s in c.stock_media.upload_sites if s.id == draft.get("id")),
                    None,
                )
                if existing:
                    if not draft.get("password"):
                        draft["password"] = existing.password
                    if not draft.get("webhook_token"):
                        draft["webhook_token"] = existing.webhook_token
                site = StockUploadSite(**draft)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=400, detail=f"Invalid site: {exc}") from exc
        else:
            raise HTTPException(status_code=400, detail="Provide site_id or site.")

        result = check_site_connection(site)
        return {"site_id": site.id, "site_name": site.name, **result}

    @app.post("/api/projects/{project_id}/assets/{asset_id}/stock/upload")
    def upload_asset_to_stock(
        project_id: str,
        asset_id: str,
        body: StockUploadRequest,
    ) -> dict:
        """Upload a video asset to one or more configured stock destinations."""
        from .stock_upload import UploadMeta, upload_to_site

        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not is_video_asset(asset.type):
            raise HTTPException(status_code=400, detail="Only video assets can be uploaded to stock sites.")
        if asset.locked:
            raise HTTPException(
                status_code=403,
                detail="Locked stock assets cannot be re-uploaded to stock sites.",
            )

        c = get_cfg()
        sites_by_id = {s.id: s for s in c.stock_media.upload_sites}
        selected = []
        for sid in body.site_ids:
            site = sites_by_id.get(sid)
            if site is None:
                raise HTTPException(status_code=404, detail=f"Upload site not found: {sid}")
            selected.append(site)
        if not selected:
            raise HTTPException(status_code=400, detail="No upload sites selected.")

        try:
            video_path = store.materialize_asset(project_id, asset)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        keywords = [str(k).strip() for k in (body.keywords or []) if str(k).strip()]
        meta = UploadMeta(
            title=(body.title or asset.name or "Untitled").strip()[:200],
            description=(body.description or "").strip()[:2000],
            keywords=keywords,
            category=(body.category or "").strip()[:120],
            filename=(body.filename or "").strip() or f"{asset.name or 'clip'}.mp4",
        )
        package_root = Path(c.cache_dir).resolve() / "stock_submissions"
        package_root.mkdir(parents=True, exist_ok=True)

        results = [
            upload_to_site(
                site,
                video_path,
                meta,
                package_root=package_root,
                timeout_s=float(c.stock_media.timeout_s or 120),
            )
            for site in selected
        ]
        return {
            "asset_id": asset_id,
            "results": [
                {
                    "site_id": r.site_id,
                    "site_name": r.site_name,
                    "provider": r.provider,
                    "ok": r.ok,
                    "message": r.message,
                    "remote_name": r.remote_name,
                    "package_dir": r.package_dir,
                    "portal_url": r.portal_url,
                    "csv_path": r.csv_path,
                }
                for r in results
            ],
            "ok_count": sum(1 for r in results if r.ok),
            "fail_count": sum(1 for r in results if not r.ok),
        }

    @app.get("/api/stock/search")
    def stock_search(
        q: str = Query("", description="Search query"),
        media_type: str = Query(
            "all",
            description=(
                "all | photo | illustration | vector | image | video | film | "
                "animation | audio | music | sound | 3d"
            ),
        ),
        page: int = Query(1, ge=1),
        page_size: int = Query(24, ge=1, le=48),
    ) -> dict:
        from .stock_media import normalize_search_type

        try:
            mt = normalize_search_type(media_type)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        c = get_cfg()
        try:
            result = search_stock(
                media_type=mt,
                query=q,
                page=page,
                page_size=page_size,
                pixabay_api_key=config_mod.stock_pixabay_key(c),
                timeout_s=float(c.stock_media.timeout_s),
                cache_dir=Path(c.cache_dir),
                pixabay_cache_ttl_hours=float(c.stock_media.pixabay_cache_ttl_hours),
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        except Exception as e:
            raise HTTPException(502, f"Stock search failed: {e}") from e
        return {
            "query": result.query,
            "media_type": mt,
            "page": result.page,
            "page_size": result.page_size,
            "approximate_total": result.total,
            "sources_used": result.sources,
            "results": [it.to_dict() for it in result.items],
            "note": result.note,
            "capabilities": stock_capabilities(),
        }

    @app.get("/api/stock/download")
    def stock_download(
        url: str = Query(..., min_length=8),
        title: str = Query(""),
        media_type: str = Query("image"),
        filename: str | None = Query(None),
    ):
        """Browser downloads of remote stock bytes are disabled (abuse lock-down)."""
        raise HTTPException(
            status_code=403,
            detail=(
                "Direct stock downloads are disabled. Use “Add to project” — "
                "imported assets stay locked inside the app."
            ),
        )

    @app.post("/api/projects/{project_id}/assets/from-stock")
    def import_stock_asset(
        project_id: str,
        background_tasks: BackgroundTasks,
        body: dict = Body(...),
    ) -> dict:
        """Download a stock item and add it to the project asset library (locked)."""
        store = project_store()
        try:
            store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        url = str(body.get("download_url") or body.get("url") or "").strip()
        if not url:
            raise HTTPException(400, "download_url is required")
        title = str(body.get("title") or "Stock media").strip() or "Stock media"
        media_type = str(body.get("type") or body.get("media_type") or "image").strip().lower()
        if media_type not in {"image", "video", "audio"}:
            media_type = "image"
        source = str(body.get("source") or "stock").strip()
        license_name = str(body.get("license") or "").strip()
        creator = str(body.get("creator") or "").strip()
        attribution = str(body.get("attribution") or "").strip()
        page_url = str(body.get("page_url") or "").strip()

        c = get_cfg()
        status = stock_quota.check_allowed(
            Path(c.cache_dir),
            int(c.stock_media.daily_download_limit),
        )
        if not status.allowed:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Daily stock download limit reached ({status.used}/{status.limit}). "
                    "Resets at midnight."
                ),
            )

        try:
            data, content_type = fetch_remote_bytes(
                url, timeout_s=float(c.stock_media.timeout_s)
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        except Exception as e:
            raise HTTPException(502, f"Download failed: {e}") from e

        try:
            stock_quota.consume(
                Path(c.cache_dir),
                int(c.stock_media.daily_download_limit),
            )
        except stock_quota.QuotaExceeded as exc:
            raise HTTPException(status_code=429, detail=exc.message) from exc

        stub = StockItem(
            id="import",
            source=source or "stock",
            type=media_type,  # type: ignore[arg-type]
            title=title,
            thumb_url=None,
            preview_url=None,
            download_url=url,
            page_url=page_url or url,
            license=license_name,
            creator=creator or None,
            attribution=attribution,
        )
        fname = filename_for_stock_item(stub, content_type)
        desc_bits = [
            f"Imported from {source}",
            f"License: {license_name}" if license_name else "",
            f"Creator: {creator}" if creator else "",
            attribution,
            f"Source: {page_url}" if page_url else "",
        ]
        description = " · ".join(b for b in desc_bits if b)[:500]

        raw_post_id = body.get("post_id")
        post_id = str(raw_post_id).strip() if raw_post_id not in (None, "") else None
        if post_id:
            try:
                store.get_post(project_id, post_id)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        # Prefer stock "kind" (photo/illustration/vector/music/sound) when provided.
        preferred_type = str(body.get("asset_type") or body.get("kind") or "").strip() or None
        if not preferred_type and media_type == "audio":
            preferred_type = "music"
        if not preferred_type and media_type == "image":
            preferred_type = "photo"

        try:
            asset = store.add_asset(
                project_id,
                fname,
                data,
                apply_logo=False,
                group="",
                post_id=post_id,
                locked=True,
                source=source or "stock",
                asset_type=preferred_type,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if description:
            try:
                store.update_asset(project_id, asset.id, description=description)
            except Exception:
                pass

        if is_processable_image(asset.type):
            background_tasks.add_task(_process_asset_bg, project_id, asset.id)
        elif is_video_asset(asset.type):
            _queue_video_thumb(background_tasks, project_id, asset.id)
        _queue_asset_describe(background_tasks, project_id, asset.id)

        project = store.get_project(project_id)
        updated = next(a for a in project.assets if a.id == asset.id)
        return {
            "ok": True,
            "asset": updated.model_dump(),
            "project": project.model_dump(),
            "quota": _quota_public(),
        }

    # ---- Text to speech ------------------------------------------------------
    @app.get("/api/tts/voices")
    def tts_voices() -> dict:
        from . import tts as tts_mod

        engines = tts_mod.available_engines()
        voice_objs = tts_mod.list_voices()
        voices = [
            {
                "id": v.id,
                "name": v.name,
                "locale": v.locale,
                "region": v.region,
                "region_label": v.region_label,
                "engine": v.engine,
                "sample": v.sample,
            }
            for v in voice_objs
        ]
        return {
            "engines": engines,
            "default_voice": tts_mod.default_voice_id(),
            "voices": voices,
            "regions": tts_mod.list_regions(voice_objs),
            "moods": tts_mod.list_moods(),
            "pacings": tts_mod.list_pacings(),
            "available": bool(engines),
        }

    @app.post("/api/projects/{project_id}/posts/{post_id}/tts/synthesize")
    def synthesize_project_tts(project_id: str, post_id: str, body: SynthesizeTtsRequest) -> dict:
        from . import tts as tts_mod

        store = project_store()
        try:
            project = store.get_project(project_id)
            post = store.get_post(project_id, post_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        if post.type.value != "video":
            raise HTTPException(status_code=400, detail="Text-to-audio layers are for video posts.")

        scene = next((s for s in post.scenes if s.id == body.scene_id), None)
        if scene is None:
            raise HTTPException(status_code=404, detail="Scene not found.")
        layer = next((l for l in scene.layers if l.id == body.layer_id), None)
        if layer is None:
            raise HTTPException(status_code=404, detail="Layer not found.")
        if layer.type != "tts":
            raise HTTPException(status_code=400, detail="Layer is not a text-to-audio layer.")

        text = (body.text if body.text is not None else layer.text) or ""
        text = text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="Enter text to speak before generating audio.")

        voice = body.voice or layer.tts_voice or post.default_tts_voice or tts_mod.default_voice_id()
        mood = tts_mod.normalize_mood(body.mood if body.mood is not None else layer.tts_mood)
        pacing = tts_mod.normalize_pacing(
            body.pacing if body.pacing is not None else getattr(layer, "tts_pacing", None)
        )
        if body.volume is not None:
            layer.tts_volume = max(0.0, min(2.0, float(body.volume)))

        plain = tts_mod.plain_speech_text(text)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                tmp_out = Path(tmp) / "speech.wav"
                produced = tts_mod.synthesize_to_file(
                    text, tmp_out, voice_id=voice, mood=mood, pacing=pacing
                )
                data = produced.read_bytes()
                duration = tts_mod.probe_duration_s(produced)
                out_suffix = produced.suffix or ".wav"
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Speech generation failed: {exc}") from exc

        previous_asset_id = layer.asset_id
        asset = store.add_generated_audio(
            project_id,
            name=f"TTS {(plain or text)[:32]}",
            data=data,
            filename=f"tts-{layer.id}{out_suffix}",
            post_id=post_id,
        )
        try:
            store.set_asset_description(
                project_id,
                asset.id,
                f"Spoken audio ({mood}, {pacing}): {(plain or text)}"[:500],
            )
        except FileNotFoundError:
            pass
        post = store.get_post(project_id, post_id)
        scene = next(s for s in post.scenes if s.id == body.scene_id)
        layer = next(l for l in scene.layers if l.id == body.layer_id)
        layer.text = text
        layer.tts_voice = voice
        layer.tts_mood = mood
        layer.tts_pacing = pacing
        layer.asset_id = asset.id
        if voice:
            post.default_tts_voice = voice
        if duration is not None:
            # Clip length follows the generated speech — do not stretch/pad to a
            # pre-set layer duration. Grow the scene if speech runs past its end.
            from .render import apply_speech_duration

            apply_speech_duration(scene, layer, duration)
        post = store.update_post(project_id, post_id, post)
        if previous_asset_id and previous_asset_id != asset.id:
            try:
                store.delete_asset(project_id, previous_asset_id)
            except FileNotFoundError:
                pass
        project = store.get_project(project_id)
        return {
            "project": project.model_dump(),
            "post": post.model_dump(),
            "asset_id": asset.id,
            "duration_s": duration,
            "mood": mood,
            "pacing": pacing,
        }

    @app.post("/api/projects/{project_id}/tts/preview")
    def preview_project_tts(project_id: str, body: PreviewTtsRequest) -> Response:
        """Synthesize speech for preview — does not create or store an asset."""
        from . import tts as tts_mod

        store = project_store()
        try:
            store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        text = (body.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="Enter text to speak before previewing.")

        voice = body.voice or tts_mod.default_voice_id()
        mood = tts_mod.normalize_mood(body.mood)
        pacing = tts_mod.normalize_pacing(body.pacing)

        try:
            with tempfile.TemporaryDirectory() as tmp:
                tmp_out = Path(tmp) / "speech.wav"
                produced = tts_mod.synthesize_to_file(
                    text, tmp_out, voice_id=voice, mood=mood, pacing=pacing
                )
                data = produced.read_bytes()
                duration = tts_mod.probe_duration_s(produced)
                suffix = (produced.suffix or ".wav").lower()
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Speech preview failed: {exc}") from exc

        media = "audio/wav" if suffix == ".wav" else "audio/aiff" if suffix == ".aiff" else "application/octet-stream"
        headers = {"Cache-Control": "no-store"}
        if duration is not None:
            headers["X-Duration-S"] = f"{float(duration):.3f}"
        headers["X-Tts-Mood"] = mood
        headers["X-Tts-Pacing"] = pacing
        return Response(content=data, media_type=media, headers=headers)

    @app.post("/api/projects/{project_id}/tts/generate")
    def generate_project_tts_asset(project_id: str, body: GenerateTtsAssetRequest) -> dict:
        """Create a standalone text-to-audio asset (project-shared or post-private)."""
        from . import tts as tts_mod

        store = project_store()
        try:
            store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        text = (body.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="Enter text to speak before generating audio.")

        owner_post_id = (body.post_id or "").strip() or None
        if owner_post_id:
            try:
                store.get_post(project_id, owner_post_id)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        voice = body.voice or tts_mod.default_voice_id()
        mood = tts_mod.normalize_mood(body.mood)
        pacing = tts_mod.normalize_pacing(body.pacing)
        plain = tts_mod.plain_speech_text(text)
        name = (body.name or "").strip() or f"TTS {(plain or text)[:32]}"

        try:
            with tempfile.TemporaryDirectory() as tmp:
                tmp_out = Path(tmp) / "speech.wav"
                produced = tts_mod.synthesize_to_file(
                    text, tmp_out, voice_id=voice, mood=mood, pacing=pacing
                )
                data = produced.read_bytes()
                duration = tts_mod.probe_duration_s(produced)
                out_suffix = produced.suffix or ".wav"
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Speech generation failed: {exc}") from exc

        asset = store.add_generated_audio(
            project_id,
            name=name[:120],
            data=data,
            filename=f"tts-asset{out_suffix}",
            post_id=owner_post_id,
        )
        try:
            store.set_asset_description(
                project_id,
                asset.id,
                f"Spoken audio ({mood}): {(plain or text)}"[:500],
            )
        except FileNotFoundError:
            pass
        project = store.get_project(project_id)
        return {
            "project": project.model_dump(),
            "asset": asset.model_dump(),
            "duration_s": duration,
            "mood": mood,
        }

    @app.get("/api/comfyui/workflows")
    def comfyui_list_workflows() -> dict:
        from .comfyui import list_stored_workflows, resolve_workflows_dir

        cfg = get_cfg()
        folder = resolve_workflows_dir(cfg.comfyui, config_dir=state["path"].parent)
        workflows = list_stored_workflows(cfg.comfyui, config_dir=state["path"].parent)
        return {"workflows_dir": str(folder), "workflows": workflows}

    @app.post("/api/comfyui/workflows")
    async def comfyui_upload_workflow(
        file: UploadFile = File(...),
        assign_op: str = Form(""),
    ) -> dict:
        from .comfyui import list_stored_workflows, save_workflow_upload

        cfg = get_cfg()
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="Empty workflow file.")
        try:
            saved = save_workflow_upload(
                cfg.comfyui,
                config_dir=state["path"].parent,
                filename=file.filename or "workflow.json",
                raw_bytes=raw,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        assign = (assign_op or "").strip()
        op_map = {
            "text_to_image": "workflow_text_to_image",
            "text_to_video": "workflow_text_to_video",
            "image_to_video": "workflow_image_to_video",
            "upscale_image": "workflow_upscale_image",
            "upscale_video": "workflow_upscale_video",
        }
        if assign in op_map:
            config_mod.save_comfyui_settings(
                state["path"],
                {op_map[assign]: saved["stem"]},
            )

        workflows = list_stored_workflows(cfg.comfyui, config_dir=state["path"].parent)
        folder = resolve_workflows_dir(cfg.comfyui, config_dir=state["path"].parent)
        return {"workflow": saved, "workflows_dir": str(folder), "workflows": workflows}

    @app.delete("/api/comfyui/workflows/{filename}")
    def comfyui_delete_workflow(filename: str) -> dict:
        from .comfyui import list_stored_workflows, resolve_workflows_dir

        name = Path(filename).name
        if not name.lower().endswith(".json") or ".." in name or "/" in name or "\\" in name:
            raise HTTPException(status_code=400, detail="Invalid workflow filename.")
        cfg = get_cfg()
        path = resolve_workflows_dir(cfg.comfyui, config_dir=state["path"].parent) / name
        if not path.is_file():
            raise HTTPException(status_code=404, detail=f"Workflow not found: {name}")
        path.unlink()
        workflows = list_stored_workflows(cfg.comfyui, config_dir=state["path"].parent)
        return {"deleted": name, "workflows": workflows}

    @app.post("/api/comfyui/settings/test")
    def comfyui_settings_test() -> dict:
        cfg = get_cfg()
        if not config_mod.comfyui_ready(cfg):
            return {
                "ok": False,
                "detail": "Enable ComfyUI in Settings and set a base URL (e.g. http://127.0.0.1:8188).",
            }
        from .comfyui import ComfyUIClient, resolve_workflow_for_op

        try:
            client = ComfyUIClient(cfg.comfyui, config_dir=state["path"].parent)
            stats = client.ping()
            ops = config_mod.comfy_ops_ready_map(cfg, config_dir=state["path"].parent)
            workflow = None
            if config_mod.comfy_workflow_name_for_op(cfg, "text_to_video"):
                workflow = str(
                    resolve_workflow_for_op(
                        cfg.comfyui, "text_to_video", config_dir=state["path"].parent
                    )
                )
            return {
                "ok": True,
                "base_url": cfg.comfyui.base_url,
                "workflow": workflow,
                "ops": ops,
                "system_stats": stats,
            }
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "detail": str(exc)}

    def _require_media_op(op: str) -> str:
        """Ensure ``op`` can run; return the resolved backend name."""
        cfg = get_cfg()
        if not config_mod.media_op_ready(cfg, op, config_dir=state["path"].parent):
            raise HTTPException(
                status_code=501,
                detail=(
                    f"“{op}” is not ready. Configure ComfyUI, Gemini, or Higgsfield in Settings "
                    "and set a backend that supports this operation."
                ),
            )
        return config_mod.resolve_media_backend(cfg, op, config_dir=state["path"].parent)

    def _require_comfy_op(op: str) -> None:
        # Backward-compatible alias used by older call sites / tests.
        _require_media_op(op)

    def _validate_owner_post(store: ProjectStore, project_id: str, post_id: str | None) -> str | None:
        owner = (post_id or "").strip() or None
        if owner:
            try:
                store.get_post(project_id, owner)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return owner

    def _asset_progress(store: ProjectStore, project_id: str, asset_id: str, message: str) -> None:
        try:
            store.set_asset_job_message(project_id, asset_id, message)
        except Exception:  # noqa: BLE001
            pass

    @app.get("/api/projects/{project_id}/assets/{asset_id}/job")
    def get_asset_job_status(project_id: str, asset_id: str) -> dict:
        """Poll status for a long-running generate/upscale job."""
        store = project_store()
        try:
            asset = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        status = str(asset.status.value if hasattr(asset.status, "value") else asset.status)
        return {
            "asset_id": asset.id,
            "name": asset.name,
            "status": status,
            "job_message": asset.job_message,
            "error": asset.error,
            "updated_at": asset.updated_at,
            "done": status in {"ready", "failed"},
        }

    @app.post("/api/projects/{project_id}/video/generate")
    def generate_project_video_asset(
        project_id: str,
        body: GenerateVideoAssetRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Queue text-to-video via the resolved media backend."""
        backend = _require_media_op("text_to_video")
        from .gen_presets import validate_video_size

        try:
            width, height = validate_video_size(body.width, body.height)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        store = project_store()
        try:
            store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        prompt = (body.prompt or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="Enter a prompt before generating video.")

        _guard_local_ai_for_media("text_to_video")

        owner_post_id = _validate_owner_post(store, project_id, body.post_id)
        name = (body.name or "").strip() or f"Video {prompt[:40]}"
        asset = store.begin_generated_video(
            project_id,
            name=name[:120],
            post_id=owner_post_id,
            filename="generated.mp4",
        )

        def _run_video_job() -> None:
            from .comfyui import ComfyUIClient
            from .llm.higgsfield import HiggsfieldClient
            from .llm.video_gen import OpenAICompatibleVideoGenClient

            try:
                cfg = get_cfg()
                resolved = config_mod.resolve_media_backend(
                    cfg, "text_to_video", config_dir=state["path"].parent
                )
                _asset_progress(
                    store,
                    project_id,
                    asset.id,
                    f"Starting via {resolved}…",
                )
                if resolved == "higgsfield":
                    client = HiggsfieldClient(cfg)
                    result = client.run_job(
                        "text_to_video",
                        prompt=prompt,
                        negative_prompt=body.negative_prompt,
                        width=width,
                        height=height,
                        expect="video",
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                    store.finalize_generated_asset(
                        project_id,
                        asset.id,
                        result["data"],
                        filename=f"gen-{asset.id[:8]}-{Path(result['filename']).name}",
                        expect="video",
                    )
                elif config_mod.video_gen_uses_gateway(cfg) and resolved == "comfyui":
                    _asset_progress(store, project_id, asset.id, "Running video gateway…")
                    client = OpenAICompatibleVideoGenClient(cfg.comfyui)
                    data = client.generate_video(prompt, width=width, height=height)
                    suffix = ".mp4"
                    if data[:4] == b"RIFF" and b"WEBP" in data[:16]:
                        suffix = ".webp"
                    _asset_progress(store, project_id, asset.id, "Saving…")
                    store.finalize_generated_video(
                        project_id,
                        asset.id,
                        data,
                        filename=f"gen-{asset.id[:8]}{suffix}",
                    )
                else:
                    client = ComfyUIClient(cfg.comfyui, config_dir=state["path"].parent)
                    result = client.run_job(
                        "text_to_video",
                        prompt=prompt,
                        negative_prompt=body.negative_prompt,
                        width=width,
                        height=height,
                        frames=body.frames,
                        fps=body.fps,
                        steps=body.steps,
                        cfg=body.cfg,
                        seed=body.seed,
                        expect="video",
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                    store.finalize_generated_asset(
                        project_id,
                        asset.id,
                        result["data"],
                        filename=f"gen-{asset.id[:8]}-{Path(result['filename']).name}",
                        expect="video",
                    )
                if config_mod.vision_llm_ready(get_cfg()):
                    try:
                        describe_asset(store, get_cfg(), project_id, asset.id, force=True)
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as exc:  # noqa: BLE001
                try:
                    store.fail_asset(project_id, asset.id, str(exc))
                except Exception:  # noqa: BLE001
                    pass

        background_tasks.add_task(_run_video_job)
        project = store.get_project(project_id)
        return {
            "project": project.model_dump(),
            "asset": asset.model_dump(),
            "queued": True,
            "backend": backend,
        }

    @app.post("/api/projects/{project_id}/image/generate")
    def generate_project_image_asset(
        project_id: str,
        body: GenerateImageAssetRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Queue text-to-image via the resolved media backend."""
        backend = _require_media_op("text_to_image")
        from .gen_presets import validate_image_size

        try:
            width, height = validate_image_size(body.width, body.height)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        store = project_store()
        try:
            store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        prompt = (body.prompt or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="Enter a prompt before generating an image.")

        _guard_local_ai_for_media("text_to_image")

        owner_post_id = _validate_owner_post(store, project_id, body.post_id)
        name = (body.name or "").strip() or f"Image {prompt[:40]}"
        asset = store.begin_generated_asset(
            project_id,
            name=name[:120],
            post_id=owner_post_id,
            filename="generated.png",
            asset_type=AssetType.PHOTO,
        )

        def _run_image_job() -> None:
            from .comfyui import ComfyUIClient
            from .llm.gemini_client import GeminiImageClient
            from .llm.higgsfield import HiggsfieldClient

            try:
                cfg = get_cfg()
                resolved = config_mod.resolve_media_backend(
                    cfg, "text_to_image", config_dir=state["path"].parent
                )
                _asset_progress(
                    store,
                    project_id,
                    asset.id,
                    f"Starting via {resolved}…",
                )
                if resolved == "gemini":
                    client = GeminiImageClient(cfg)
                    result = client.text_to_image(
                        prompt,
                        width=width,
                        height=height,
                        negative_prompt=body.negative_prompt,
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                elif resolved == "higgsfield":
                    client = HiggsfieldClient(cfg)
                    result = client.run_job(
                        "text_to_image",
                        prompt=prompt,
                        negative_prompt=body.negative_prompt,
                        width=width,
                        height=height,
                        expect="image",
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                else:
                    client = ComfyUIClient(cfg.comfyui, config_dir=state["path"].parent)
                    result = client.run_job(
                        "text_to_image",
                        prompt=prompt,
                        negative_prompt=body.negative_prompt,
                        width=width,
                        height=height,
                        steps=body.steps,
                        cfg=body.cfg,
                        seed=body.seed,
                        expect="image",
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                store.finalize_generated_asset(
                    project_id,
                    asset.id,
                    result["data"],
                    filename=f"gen-{asset.id[:8]}-{Path(result['filename']).name}",
                    expect="image",
                )
                if config_mod.vision_llm_ready(get_cfg()):
                    try:
                        describe_asset(store, get_cfg(), project_id, asset.id, force=True)
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as exc:  # noqa: BLE001
                try:
                    store.fail_asset(project_id, asset.id, str(exc))
                except Exception:  # noqa: BLE001
                    pass

        background_tasks.add_task(_run_image_job)
        return {
            "project": store.get_project(project_id).model_dump(),
            "asset": asset.model_dump(),
            "queued": True,
            "backend": backend,
        }

    @app.post("/api/projects/{project_id}/video/generate-from-image")
    def generate_project_video_from_image(
        project_id: str,
        body: GenerateVideoFromImageRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Queue image + text → video via the resolved media backend."""
        backend = _require_media_op("image_to_video")
        from .gen_presets import validate_video_size

        try:
            width, height = validate_video_size(body.width, body.height)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        store = project_store()
        try:
            store.get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        prompt = (body.prompt or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="Enter a prompt before generating video.")

        try:
            source = store.get_asset(project_id, body.image_asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not is_image_asset(source.type):
            raise HTTPException(status_code=400, detail="image_asset_id must be an image asset.")

        _guard_local_ai_for_media("image_to_video")

        owner_post_id = _validate_owner_post(store, project_id, body.post_id)
        name = (body.name or "").strip() or f"Video {prompt[:40]}"
        asset = store.begin_generated_video(
            project_id,
            name=name[:120],
            post_id=owner_post_id,
            filename="generated.mp4",
        )
        source_path = store.materialize_asset(project_id, source)

        def _run_i2v_job() -> None:
            from .comfyui import ComfyUIClient
            from .llm.higgsfield import HiggsfieldClient

            try:
                cfg = get_cfg()
                resolved = config_mod.resolve_media_backend(
                    cfg, "image_to_video", config_dir=state["path"].parent
                )
                _asset_progress(
                    store,
                    project_id,
                    asset.id,
                    f"Starting via {resolved}…",
                )
                if resolved == "higgsfield":
                    client = HiggsfieldClient(cfg)
                    result = client.run_job(
                        "image_to_video",
                        prompt=prompt,
                        negative_prompt=body.negative_prompt,
                        width=width,
                        height=height,
                        input_path=source_path,
                        expect="video",
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                else:
                    client = ComfyUIClient(cfg.comfyui, config_dir=state["path"].parent)
                    result = client.run_job(
                        "image_to_video",
                        prompt=prompt,
                        negative_prompt=body.negative_prompt,
                        width=width,
                        height=height,
                        frames=body.frames,
                        fps=body.fps,
                        steps=body.steps,
                        cfg=body.cfg,
                        seed=body.seed,
                        input_path=source_path,
                        expect="video",
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                store.finalize_generated_asset(
                    project_id,
                    asset.id,
                    result["data"],
                    filename=f"gen-{asset.id[:8]}-{Path(result['filename']).name}",
                    expect="video",
                )
                if config_mod.vision_llm_ready(get_cfg()):
                    try:
                        describe_asset(store, get_cfg(), project_id, asset.id, force=True)
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as exc:  # noqa: BLE001
                try:
                    store.fail_asset(project_id, asset.id, str(exc))
                except Exception:  # noqa: BLE001
                    pass

        background_tasks.add_task(_run_i2v_job)
        return {
            "project": store.get_project(project_id).model_dump(),
            "asset": asset.model_dump(),
            "queued": True,
            "backend": backend,
        }

    @app.post("/api/projects/{project_id}/assets/{asset_id}/upscale")
    def upscale_project_asset(
        project_id: str,
        asset_id: str,
        body: UpscaleAssetRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Queue image or video upscale via the resolved media backend."""
        from .gen_presets import validate_upscale_scale

        store = project_store()
        try:
            store.get_project(project_id)
            source = store.get_asset(project_id, asset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        if is_image_asset(source.type):
            op = "upscale_image"
            kind = "image"
            group = EDITED_IMAGES_GROUP
            asset_type = AssetType.PHOTO
            placeholder = "upscaled.png"
            expect = "image"
        elif is_video_asset(source.type):
            op = "upscale_video"
            kind = "video"
            group = EDITED_VIDEOS_GROUP
            asset_type = AssetType.VIDEO
            placeholder = "upscaled.mp4"
            expect = "video"
        else:
            raise HTTPException(status_code=400, detail="Only image or video assets can be upscaled.")

        backend = _require_media_op(op)
        try:
            scale = validate_upscale_scale(body.scale, kind=kind)  # type: ignore[arg-type]
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        _guard_local_ai_for_media(op)

        owner_post_id = source.post_id
        if body.set_post_id:
            owner_post_id = _validate_owner_post(store, project_id, body.post_id)
        elif body.post_id:
            owner_post_id = _validate_owner_post(store, project_id, body.post_id)

        name = (body.name or "").strip() or f"{source.name} {scale:g}x"
        asset = store.begin_generated_asset(
            project_id,
            name=name[:120],
            post_id=owner_post_id,
            filename=placeholder,
            asset_type=asset_type,
            group=group,
        )
        source_path = store.materialize_asset(project_id, source)

        out_w = out_h = None
        if source.width and source.height:
            out_w = max(1, int(round(float(source.width) * scale)))
            out_h = max(1, int(round(float(source.height) * scale)))

        def _run_upscale_job() -> None:
            from .comfyui import ComfyUIClient
            from .llm.gemini_client import GeminiImageClient
            from .llm.higgsfield import HiggsfieldClient

            try:
                cfg = get_cfg()
                resolved = config_mod.resolve_media_backend(
                    cfg, op, config_dir=state["path"].parent
                )
                _asset_progress(
                    store,
                    project_id,
                    asset.id,
                    f"Starting via {resolved}…",
                )
                if resolved == "gemini" and op == "upscale_image":
                    client = GeminiImageClient(cfg)
                    result = client.enhance_image(
                        source_path,
                        scale=scale,
                        width=out_w,
                        height=out_h,
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                elif resolved == "higgsfield":
                    client = HiggsfieldClient(cfg)
                    result = client.run_job(
                        op,
                        input_path=source_path,
                        scale=scale,
                        width=out_w,
                        height=out_h,
                        expect=expect,  # type: ignore[arg-type]
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                else:
                    client = ComfyUIClient(cfg.comfyui, config_dir=state["path"].parent)
                    result = client.run_job(
                        op,
                        input_path=source_path,
                        scale=scale,
                        width=out_w,
                        height=out_h,
                        expect=expect,  # type: ignore[arg-type]
                        on_progress=lambda msg: _asset_progress(store, project_id, asset.id, msg),
                    )
                store.finalize_generated_asset(
                    project_id,
                    asset.id,
                    result["data"],
                    filename=f"upscale-{asset.id[:8]}-{Path(result['filename']).name}",
                    expect=expect,
                )
                if config_mod.vision_llm_ready(get_cfg()):
                    try:
                        describe_asset(store, get_cfg(), project_id, asset.id, force=True)
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as exc:  # noqa: BLE001
                try:
                    store.fail_asset(project_id, asset.id, str(exc))
                except Exception:  # noqa: BLE001
                    pass

        background_tasks.add_task(_run_upscale_job)
        return {
            "project": store.get_project(project_id).model_dump(),
            "asset": asset.model_dump(),
            "queued": True,
            "backend": backend,
        }

    # ---- Instagram ------------------------------------------------------------
    def _instagram_cfg():
        return get_cfg().instagram

    def _instagram_publishable_files(group: dict) -> list[dict]:
        allowed = set(_instagram_cfg().publishable_formats)
        return [
            f
            for f in group["files"]
            if f["suffix"] in {".jpg", ".jpeg", ".png", ".webp"}
            and Path(f["name"]).stem in allowed
        ]

    @app.get("/api/instagram/status")
    def instagram_status() -> dict:
        ig_cfg = _instagram_cfg()
        session = ig_store.load_session(get_cfg().cache_dir)
        return {
            "enabled": ig_cfg.enabled,
            "configured": bool(ig_cfg.app_id and ig_cfg.app_secret),
            "connected": session is not None,
            "public_base_url": ig_cfg.public_base_url or None,
            "account": (
                {
                    "ig_username": session.ig_username,
                    "page_name": session.page_name,
                    "ig_user_id": session.ig_user_id,
                    "connected_at": session.connected_at,
                }
                if session
                else None
            ),
        }

    @app.get("/api/instagram/settings")
    def instagram_settings_get() -> dict:
        ig_cfg = _instagram_cfg()
        env = config_mod.instagram_env_overrides()
        session = ig_store.load_session(get_cfg().cache_dir)
        app_id = ig_cfg.app_id
        return {
            "config_path": str(state["path"]),
            "enabled": ig_cfg.enabled,
            "app_id": app_id,
            "app_secret_set": bool(ig_cfg.app_secret),
            "app_secret_masked": config_mod.mask_secret(ig_cfg.app_secret) if ig_cfg.app_secret else "",
            "graph_api_version": ig_cfg.graph_api_version,
            "public_base_url": ig_cfg.public_base_url,
            "oauth_redirect_uri": ig_cfg.oauth_redirect_uri,
            "default_publish_format": ig_cfg.default_publish_format,
            "publishable_formats": ig_cfg.publishable_formats,
            "env_overrides": env,
            "connected": session is not None,
            "account": (
                {
                    "ig_username": session.ig_username,
                    "page_name": session.page_name,
                    "connected_at": session.connected_at,
                }
                if session
                else None
            ),
            "oauth_scopes": ig_auth.OAUTH_SCOPES,
            "meta_app_url": (
                f"https://developers.facebook.com/apps/{app_id}/instagram-business/API-Setup/"
                if app_id
                else "https://developers.facebook.com/apps/"
            ),
            "setup_doc": "INSTAGRAM_SETUP.md",
        }

    @app.put("/api/instagram/settings")
    def instagram_settings_put(body: InstagramSettingsUpdate) -> dict:
        updates = body.model_dump(exclude_unset=True)
        if not updates:
            raise HTTPException(status_code=400, detail="No settings provided.")
        env = config_mod.instagram_env_overrides()
        blocked = [k for k in updates if env.get(k)]
        if blocked:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot save {', '.join(blocked)} — overridden by environment variables.",
            )
        ig_cfg = config_mod.save_instagram_settings(state["path"], updates)
        reload_cfg()
        return {
            "saved": True,
            "settings": {
                "enabled": ig_cfg.enabled,
                "app_id": ig_cfg.app_id,
                "app_secret_set": bool(ig_cfg.app_secret),
                "public_base_url": ig_cfg.public_base_url,
                "oauth_redirect_uri": ig_cfg.oauth_redirect_uri,
                "configured": bool(ig_cfg.app_id and ig_cfg.app_secret),
            },
        }

    @app.post("/api/instagram/settings/test")
    async def instagram_settings_test() -> dict:
        ig_cfg = _instagram_cfg()
        issues: list[str] = []
        warnings: list[str] = []
        checks: list[dict[str, Any]] = []

        def add_check(name: str, ok: bool, detail: str) -> None:
            checks.append({"name": name, "ok": ok, "detail": detail})
            if not ok:
                issues.append(f"{name}: {detail}")

        add_check("Publishing enabled", ig_cfg.enabled, "Turn on in settings" if not ig_cfg.enabled else "OK")
        add_check(
            "Meta App ID",
            bool(ig_cfg.app_id),
            "Set your App ID from developers.facebook.com" if not ig_cfg.app_id else ig_cfg.app_id,
        )
        add_check(
            "Meta App Secret",
            bool(ig_cfg.app_secret),
            "Set your App Secret" if not ig_cfg.app_secret else "Configured",
        )
        add_check(
            "OAuth redirect URI",
            bool(ig_cfg.oauth_redirect_uri),
            ig_cfg.oauth_redirect_uri or "Missing",
        )
        if ig_cfg.public_base_url:
            base = ig_cfg.public_base_url.rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                    resp = await client.get(f"{base}/api/config")
                reachable = resp.is_success
                add_check(
                    "Public image URL (tunnel)",
                    reachable,
                    f"{base} responded HTTP {resp.status_code}"
                    if reachable
                    else f"Could not reach {base}/api/config (HTTP {resp.status_code})",
                )
            except httpx.HTTPError as exc:
                add_check("Public image URL (tunnel)", False, str(exc))
        else:
            checks.append(
                {
                    "name": "Public image URL (tunnel)",
                    "ok": False,
                    "detail": "Set public_base_url (e.g. ngrok HTTPS URL) so Meta can download images",
                }
            )
            issues.append("Public image URL: not configured")

        session = ig_store.load_session(get_cfg().cache_dir)
        add_check(
            "Instagram account connected",
            session is not None,
            f"Connected as @{session.ig_username}" if session and session.ig_username else (
                "Connected" if session else "Click Connect Instagram after saving API credentials"
            ),
        )

        if config_mod.instagram_env_overrides():
            warnings.append("Some values are overridden by environment variables (META_APP_ID, etc.).")

        return {"ok": len(issues) == 0, "issues": issues, "warnings": warnings, "checks": checks}

    @app.get("/api/instagram/auth")
    def instagram_auth() -> RedirectResponse:
        ig_cfg = _instagram_cfg()
        if not ig_cfg.enabled:
            raise HTTPException(status_code=400, detail="Instagram publishing is disabled in config.")
        if not ig_cfg.app_id:
            raise HTTPException(status_code=400, detail="Set instagram.app_id or META_APP_ID.")
        oauth_state = ig_store.new_oauth_state()
        ig_store.save_oauth_state(get_cfg().cache_dir, oauth_state)
        return RedirectResponse(ig_auth.oauth_authorize_url(ig_cfg, oauth_state))

    @app.get("/api/instagram/callback")
    async def instagram_callback(
        code: str | None = None,
        state: str | None = None,
        error: str | None = None,
        error_description: str | None = None,
    ) -> RedirectResponse:
        if error:
            msg = error_description or error
            return RedirectResponse(f"/?instagram_error={msg}")
        if not code or not state or not ig_store.pop_oauth_state(get_cfg().cache_dir, state):
            return RedirectResponse("/?instagram_error=Invalid+OAuth+state")
        try:
            session = await ig_auth.exchange_code_for_session(_instagram_cfg(), code)
            ig_store.save_session(get_cfg().cache_dir, session)
        except (ValueError, InstagramApiError) as exc:
            return RedirectResponse(f"/?instagram_error={str(exc).replace(' ', '+')}")
        return RedirectResponse("/?instagram_connected=1")

    @app.post("/api/instagram/disconnect")
    def instagram_disconnect() -> dict:
        ig_store.clear_session(get_cfg().cache_dir)
        return {"disconnected": True}

    @app.get("/api/instagram/publishable")
    def instagram_publishable() -> dict:
        """Output images eligible for feed posts (excludes story format)."""
        groups = _group_outputs(output_root())
        items: list[dict] = []
        for g in groups:
            for f in _instagram_publishable_files(g):
                rel = f"{g['folder']}/{f['name']}" if g["folder"] else f["name"]
                items.append(
                    {
                        "path": rel,
                        "folder": g["folder"],
                        "name": f["name"],
                        "format": Path(f["name"]).stem,
                        "size_human": f["size_human"],
                        "modified": f["modified"],
                    }
                )
        return {"items": items, "default_format": _instagram_cfg().default_publish_format}

    @app.post("/api/instagram/suggest-caption")
    def instagram_suggest_caption(body: SuggestCaptionRequest) -> dict:
        for rel in body.image_paths:
            target = _safe_resolve(output_root(), rel)
            if not target.is_file():
                raise HTTPException(status_code=404, detail=f"Output file not found: {rel}")
        return ig_captions.suggest_post_text(image_paths=body.image_paths, output_root=output_root())

    @app.post("/api/instagram/publish")
    async def instagram_publish(body: PublishRequest) -> dict:
        ig_cfg = _instagram_cfg()
        if not ig_cfg.enabled:
            raise HTTPException(status_code=400, detail="Instagram publishing is disabled.")
        session = ig_store.load_session(get_cfg().cache_dir)
        if not session:
            raise HTTPException(status_code=401, detail="Connect Instagram first.")

        allowed_formats = set(ig_cfg.publishable_formats)
        for rel in body.image_paths:
            target = _safe_resolve(output_root(), rel)
            if not target.is_file():
                raise HTTPException(status_code=404, detail=f"Output file not found: {rel}")
            if target.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
                raise HTTPException(status_code=400, detail=f"Unsupported file type: {rel}")
            if target.stem not in allowed_formats:
                raise HTTPException(
                    status_code=400,
                    detail=f"'{target.stem}' is not a feed format. Use portrait, square, or landscape.",
                )

        caption = body.caption.strip() or ig_captions.build_caption(body.title, body.description)
        if not caption:
            raise HTTPException(status_code=400, detail="Caption is required.")

        try:
            result = await ig_publish.publish_post(
                ig_cfg,
                session,
                image_paths=body.image_paths,
                caption=caption,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except InstagramApiError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        return {"ok": True, **result, "caption": caption}

    # ---- Media Manager (per-project monitored folders + assisted stock publish) ----------
    def _mm_folder_or_404(project_id: str, folder_id: str):
        store = project_store()
        try:
            folder = store.get_monitored_folder(project_id, folder_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return folder, get_cfg()

    def _mm_find_folder_any(folder_id: str):
        """Resolve a monitored folder when only folder_id is known (legacy callers)."""
        store = project_store()
        for summary in store.list_projects():
            try:
                return store.get_monitored_folder(summary.id, folder_id), get_cfg()
            except FileNotFoundError:
                continue
        raise HTTPException(status_code=404, detail=f"Monitored folder not found: {folder_id}")

    def _mm_resolve_folder(folder) -> Path:
        from . import media_manager as mm

        try:
            return mm.resolve_folder_root(folder, base_dir=state["path"].parent)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    def _mm_seed_folders_from_global(project_id: str) -> list[ProjectMediaFolder]:
        """One-time copy of legacy global bookmarks into an empty project."""
        store = project_store()
        existing = store.list_monitored_folders(project_id)
        if existing:
            return existing
        global_folders = get_cfg().media_manager.monitored_folders
        if not global_folders:
            return []
        seeded = [
            ProjectMediaFolder(
                id=f.id,
                label=f.label,
                path=f.path,
                enabled=bool(f.enabled),
            )
            for f in global_folders
        ]
        return store.set_monitored_folders(project_id, seeded)

    @app.get("/api/projects/{project_id}/media/folders")
    def list_media_folders(project_id: str) -> dict:
        try:
            project_store().get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        folders = _mm_seed_folders_from_global(project_id)
        return {"folders": [f.model_dump() for f in folders]}

    @app.get("/api/media/browse")
    def browse_media_directories(
        path: str = Query("", description="Absolute directory to list; empty = home"),
    ) -> dict:
        """List child directories for the Media Manager folder picker."""
        from . import media_manager as mm

        try:
            return mm.browse_directories(path or None)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/media/pick-folder")
    def pick_media_folder(
        title: str = Query("Select a folder", description="Native dialog title"),
    ) -> dict:
        """Open a native OS folder dialog on this machine and return the path.

        Intended for the local UI server (same host as the browser). Returns
        ``{"path": null, "cancelled": true}`` when the user dismisses the dialog.
        """
        from . import media_manager as mm

        path = mm.pick_directory_native(title=(title or "Select a folder").strip() or "Select a folder")
        if not path:
            return {"path": None, "cancelled": True}
        return {"path": path, "cancelled": False, "name": Path(path).name}

    @app.post("/api/projects/{project_id}/media/folders")
    def add_media_folder(project_id: str, body: MediaFolderCreate) -> dict:
        from . import media_manager as mm

        try:
            project_store().get_project(project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        draft = ProjectMediaFolder(
            label=(body.label or "Folder").strip()[:80] or "Folder",
            path=body.path.strip(),
            enabled=bool(body.enabled),
        )
        try:
            mm.resolve_folder_root(draft, base_dir=state["path"].parent)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        store = project_store()
        folders = store.list_monitored_folders(project_id)
        folders.append(draft)
        saved = store.set_monitored_folders(project_id, folders)
        created = next(f for f in saved if f.id == draft.id)
        return {"folder": created.model_dump()}

    @app.put("/api/projects/{project_id}/media/folders/{folder_id}")
    def update_media_folder(project_id: str, folder_id: str, body: MediaFolderUpdate) -> dict:
        from . import media_manager as mm

        folder, _c = _mm_folder_or_404(project_id, folder_id)
        data = folder.model_dump()
        if body.label is not None:
            data["label"] = (body.label or "Folder").strip()[:80] or "Folder"
        if body.path is not None:
            data["path"] = body.path.strip()
        if body.enabled is not None:
            data["enabled"] = bool(body.enabled)
        updated_folder = ProjectMediaFolder(**data)
        try:
            mm.resolve_folder_root(updated_folder, base_dir=state["path"].parent)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        store = project_store()
        folders = []
        for f in store.list_monitored_folders(project_id):
            folders.append(updated_folder if f.id == folder_id else f)
        saved = store.set_monitored_folders(project_id, folders)
        out = next(f for f in saved if f.id == folder_id)
        return {"folder": out.model_dump()}

    @app.delete("/api/projects/{project_id}/media/folders/{folder_id}")
    def delete_media_folder(project_id: str, folder_id: str) -> dict:
        _mm_folder_or_404(project_id, folder_id)
        store = project_store()
        folders = [f for f in store.list_monitored_folders(project_id) if f.id != folder_id]
        store.set_monitored_folders(project_id, folders)
        return {"ok": True, "id": folder_id}

    @app.get("/api/projects/{project_id}/media/folders/{folder_id}/files")
    def list_media_folder_files(
        project_id: str,
        folder_id: str,
        q: str = Query(""),
        media_type: str = Query("all"),
    ) -> dict:
        from . import media_manager as mm

        folder, _c = _mm_folder_or_404(project_id, folder_id)
        if not folder.enabled:
            raise HTTPException(status_code=400, detail="Folder is disabled.")
        root = _mm_resolve_folder(folder)
        files = mm.list_media_files(root, query=q, media_type=media_type)
        return {
            "folder_id": folder_id,
            "root": str(root),
            "count": len(files),
            "files": files,
        }

    @app.get("/api/media/file")
    def get_media_file(
        folder_id: str = Query(...),
        path: str = Query(..., description="Relative path within the monitored folder"),
        project_id: str | None = Query(
            None, description="Owning project id (preferred; falls back to folder lookup)"
        ),
    ):
        from . import media_manager as mm

        if project_id:
            folder, _c = _mm_folder_or_404(project_id, folder_id)
        else:
            folder, _c = _mm_find_folder_any(folder_id)
        root = _mm_resolve_folder(folder)
        try:
            target = mm.safe_resolve_under(root, path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not target.is_file():
            raise HTTPException(status_code=404, detail="File not found.")
        mime = _media_type_for_asset_path(target, fallback_name=target.name)
        return FileResponse(
            target,
            media_type=mime or "application/octet-stream",
        )

    @app.post("/api/media/rename")
    def rename_media_file(body: MediaRenameRequest) -> dict:
        from . import media_manager as mm

        folder, _c = _mm_folder_or_404(body.project_id, body.folder_id)
        root = _mm_resolve_folder(folder)
        try:
            src = mm.safe_resolve_under(root, body.path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not src.is_file():
            raise HTTPException(status_code=404, detail="File not found.")
        raw = Path(body.name.strip()).name
        if not raw or raw in {".", ".."} or "/" in raw or "\\" in raw:
            raise HTTPException(status_code=400, detail="Invalid file name.")
        if not Path(raw).suffix and src.suffix:
            raw = f"{raw}{src.suffix}"
        try:
            dest = mm.safe_resolve_under(root, str((src.parent / raw).relative_to(root)))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if dest == src:
            return {"ok": True, "path": body.path, "name": src.name}
        if dest.exists():
            raise HTTPException(status_code=409, detail="A file with that name already exists.")
        src.rename(dest)
        return {
            "ok": True,
            "path": str(dest.relative_to(root)),
            "name": dest.name,
        }

    @app.post("/api/media/import")
    def import_media_to_project(
        body: MediaImportRequest,
        background_tasks: BackgroundTasks,
    ) -> dict:
        from . import media_manager as mm

        folder, _c = _mm_folder_or_404(body.project_id, body.folder_id)
        root = _mm_resolve_folder(folder)
        store = project_store()
        try:
            project = store.get_project(body.project_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        post_id = (body.post_id or "").strip() or None
        if post_id:
            try:
                store.get_post(body.project_id, post_id)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        imported = []
        errors = []
        for rel in body.paths:
            try:
                target = mm.safe_resolve_under(root, rel)
            except ValueError as exc:
                errors.append({"path": rel, "error": str(exc)})
                continue
            if not target.is_file():
                errors.append({"path": rel, "error": "File not found."})
                continue
            try:
                data = target.read_bytes()
                asset = store.add_asset(
                    body.project_id,
                    target.name,
                    data,
                    group=(body.group or "").strip(),
                    post_id=post_id,
                )
                if is_processable_image(asset.type):
                    background_tasks.add_task(_process_asset_bg, body.project_id, asset.id)
                elif is_video_asset(asset.type):
                    _queue_video_thumb(background_tasks, body.project_id, asset.id)
                imported.append(asset.model_dump(mode="json"))
            except ValueError as exc:
                errors.append({"path": rel, "error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                errors.append({"path": rel, "error": str(exc)})

        return {
            "ok": len(errors) == 0,
            "imported": imported,
            "imported_count": len(imported),
            "errors": errors,
            "project": store.get_project(body.project_id).model_dump(mode="json"),
        }

    @app.get("/api/media/publish/platforms")
    def get_publish_platforms() -> dict:
        return {"platforms": config_mod.media_manager_public(get_cfg())["publish_platforms"]}

    @app.put("/api/media/publish/platforms")
    def put_publish_platforms(body: dict = Body(...)) -> dict:
        platforms = body.get("platforms") if isinstance(body, dict) else None
        if not isinstance(platforms, list):
            raise HTTPException(status_code=400, detail="Body must include platforms: [].")
        updated = config_mod.save_media_manager_platforms(state["path"], platforms)
        reload_cfg()
        return {"platforms": [p.model_dump() for p in updated.publish_platforms]}

    @app.get("/api/media/publish/packages")
    def list_publish_packages() -> dict:
        from . import media_manager as mm

        c = get_cfg()
        items = mm.load_package_index(c.cache_dir)
        return {"packages": items}

    @app.post("/api/media/publish/packages")
    def create_publish_package(body: MediaPublishPackageCreate) -> dict:
        from . import media_manager as mm
        from .config import PublishPlatform

        folder, c = _mm_find_folder_any(body.folder_id)
        root = _mm_resolve_folder(folder)
        by_id = {p.id: p for p in c.media_manager.publish_platforms}
        platforms: list[PublishPlatform] = []
        for pid in body.platform_ids:
            p = by_id.get(pid)
            if p is None:
                raise HTTPException(status_code=404, detail=f"Platform not found: {pid}")
            if not p.enabled:
                raise HTTPException(status_code=400, detail=f"Platform is disabled: {p.label}")
            platforms.append(p)

        sources = []
        for rel in body.paths:
            try:
                target = mm.safe_resolve_under(root, rel)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if not target.is_file():
                raise HTTPException(status_code=404, detail=f"File not found: {rel}")
            sources.append((target, rel))

        try:
            package = mm.create_publish_package(
                c.cache_dir,
                sources=sources,
                platforms=platforms,
                title=body.title,
                description=body.description,
                tags=body.tags,
                folder_id=body.folder_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"package": package}

    @app.post("/api/media/publish/packages/{package_id}/open")
    def open_publish_package(package_id: str) -> dict:
        from . import media_manager as mm

        c = get_cfg()
        try:
            package = mm.update_package(c.cache_dir, package_id, status="opened")
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        urls = [
            {
                "id": p.get("id"),
                "label": p.get("label"),
                "contributor_url": p.get("contributor_url") or "",
            }
            for p in (package.get("platforms") or [])
            if isinstance(p, dict)
        ]
        return {"package": package, "contributor_urls": urls}

    @app.post("/api/media/publish/packages/{package_id}/mark-submitted")
    def mark_publish_package_submitted(package_id: str) -> dict:
        from . import media_manager as mm

        c = get_cfg()
        try:
            package = mm.update_package(c.cache_dir, package_id, status="submitted")
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"package": package}

    # SPA fallback for Angular client-side routes (must be registered last).
    if ui_dist is not None:

        @app.get("/{full_path:path}", response_model=None)
        def spa_fallback(full_path: str):
            if full_path.startswith("api/") or full_path == "api":
                raise HTTPException(status_code=404, detail="Not Found")
            candidate = (ui_dist / full_path).resolve()
            try:
                candidate.relative_to(ui_dist.resolve())
            except ValueError as exc:
                raise HTTPException(status_code=404, detail="Not Found") from exc
            if candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(ui_dist / "index.html")

    return app


# Module-level app for `uvicorn content_sprout.web:app` users.
app = create_app()
