"""App-wide global asset library (shared across all projects and posts)."""

from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path

from pydantic import BaseModel, Field

from .models import (
    Asset,
    AssetStatus,
    AssetType,
    _now_iso,
    is_audio_asset,
    is_video_asset,
    new_id,
)
from .projects import (
    MODEL_EXT,
    MUSIC_EXT,
    PHOTO_EXT,
    SOUND_EXT,
    VECTOR_EXT,
    VIDEO_EXT,
    resolve_upload_asset_type,
)

_lock = threading.RLock()


def global_source_tag(global_asset_id: str) -> str:
    return f"global:{global_asset_id}"


def parse_global_source(source: str | None) -> str | None:
    raw = str(source or "").strip()
    if raw.startswith("global:"):
        gid = raw[7:].strip()
        return gid or None
    return None


def _safe_upload_basename(filename: str) -> str:
    raw = str(filename or "").replace("\\", "/").strip()
    name = Path(raw).name.strip() if raw else ""
    if not name or name in {".", ".."}:
        return "upload.bin"
    return name[:200]


def _apply_media_probe(asset: Asset, path: Path) -> None:
    if not (is_video_asset(asset.type) or is_audio_asset(asset.type)):
        return
    try:
        from .video_edit import ffmpeg_available, probe_video_info

        if not ffmpeg_available():
            asset.file_size_bytes = path.stat().st_size if path.exists() else asset.file_size_bytes
            return
        info = probe_video_info(path)
    except Exception:
        try:
            asset.file_size_bytes = path.stat().st_size if path.exists() else asset.file_size_bytes
        except OSError:
            pass
        return

    asset.duration_s = info.duration_s
    asset.has_audio = info.has_audio
    asset.file_size_bytes = info.file_size_bytes
    asset.bitrate_kbps = info.bitrate_kbps
    asset.container = info.container
    asset.audio_codec = info.audio_codec
    if is_video_asset(asset.type):
        asset.width = info.width
        asset.height = info.height
        asset.fps = info.fps
        asset.video_codec = info.video_codec


class GlobalLibrary(BaseModel):
    assets: list[Asset] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)
    updated_at: str = Field(default_factory=_now_iso)


class GlobalAssetStore:
    """Filesystem catalog of assets usable from any project."""

    def __init__(self, root: Path, cfg=None):
        self.root = Path(root).resolve()
        self.cfg = cfg
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "assets").mkdir(parents=True, exist_ok=True)

    def _catalog_path(self) -> Path:
        return self.root / "library.json"

    def _asset_dir(self, asset_id: str) -> Path:
        return self.root / "assets" / asset_id

    def _load(self) -> GlobalLibrary:
        path = self._catalog_path()
        if not path.exists():
            return GlobalLibrary()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return GlobalLibrary()
        if not isinstance(raw, dict):
            return GlobalLibrary()
        try:
            return GlobalLibrary.model_validate(raw)
        except Exception:
            return GlobalLibrary()

    def _save(self, library: GlobalLibrary) -> None:
        library.updated_at = _now_iso()
        path = self._catalog_path()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(library.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        tmp.replace(path)

    def list_assets(self) -> list[Asset]:
        with _lock:
            return list(self._load().assets)

    def list_groups(self) -> list[str]:
        with _lock:
            return list(self._load().groups)

    def get_asset(self, asset_id: str) -> Asset:
        with _lock:
            for a in self._load().assets:
                if a.id == asset_id:
                    return a
        raise FileNotFoundError(f"Global asset not found: {asset_id}")

    def resolve_path(self, asset: Asset, rel: str | None = None) -> Path:
        rel_path = (rel or asset.original_path or "").replace("\\", "/").lstrip("/")
        if not rel_path or ".." in rel_path.split("/"):
            raise ValueError("Invalid asset path")
        full = (self.root / rel_path).resolve()
        if not str(full).startswith(str(self.root)):
            raise ValueError("Path escapes global assets root")
        if not full.is_file():
            raise FileNotFoundError(f"File not found: {rel_path}")
        return full

    def add_asset(
        self,
        filename: str,
        data: bytes,
        *,
        group: str = "",
        name: str | None = None,
        asset_type: AssetType | str | None = None,
    ) -> Asset:
        safe_name = _safe_upload_basename(filename)
        resolved = resolve_upload_asset_type(safe_name, preferred=asset_type)
        if not data:
            raise ValueError("Empty file")

        with _lock:
            library = self._load()
            asset_id = new_id()
            ext = Path(safe_name).suffix.lower() or ".bin"
            asset_dir = self._asset_dir(asset_id)
            asset_dir.mkdir(parents=True, exist_ok=True)
            original_name = f"original{ext}"
            original_disk = asset_dir / original_name
            original_disk.write_bytes(data)

            group_name = str(group or "").strip()[:80]
            display = (name or Path(safe_name).stem).strip()[:120] or Path(safe_name).stem
            asset = Asset(
                id=asset_id,
                name=display,
                type=resolved,
                group=group_name,
                post_id=None,
                apply_logo=False,
                status=AssetStatus.READY,
                original_filename=safe_name,
                original_path=str(Path("assets") / asset_id / original_name),
                locked=False,
                source="global",
            )
            if is_video_asset(resolved) or is_audio_asset(resolved):
                _apply_media_probe(asset, original_disk)
            else:
                try:
                    asset.file_size_bytes = len(data)
                except Exception:
                    pass

            library.assets.append(asset)
            if group_name:
                existing = {g.casefold(): g for g in library.groups}
                if group_name.casefold() not in existing:
                    library.groups = sorted(
                        [*library.groups, group_name],
                        key=lambda g: g.casefold(),
                    )
            self._save(library)
            return asset

    def update_asset(
        self,
        asset_id: str,
        *,
        name: str | None = None,
        group: str | None = None,
        description: str | None = None,
        tags: list[str] | None = None,
    ) -> Asset:
        from .models import normalize_asset_tags

        with _lock:
            library = self._load()
            asset = next((a for a in library.assets if a.id == asset_id), None)
            if asset is None:
                raise FileNotFoundError(f"Global asset not found: {asset_id}")
            if name is not None:
                cleaned = str(name).strip()[:120]
                if cleaned:
                    asset.name = cleaned
            if group is not None:
                asset.group = str(group).strip()[:80]
                if asset.group:
                    existing = {g.casefold(): g for g in library.groups}
                    if asset.group.casefold() not in existing:
                        library.groups = sorted(
                            [*library.groups, asset.group],
                            key=lambda g: g.casefold(),
                        )
            if description is not None:
                asset.description = str(description).strip()[:4000]
            if tags is not None:
                asset.tags = normalize_asset_tags(tags)
            asset.updated_at = _now_iso()
            self._save(library)
            return asset

    def ensure_video_preview(self, asset_id: str) -> tuple[Asset, str]:
        """Ensure a small H.264 preview proxy for in-app playback."""
        from .video_edit import (
            VideoEditError,
            ffmpeg_available,
            preview_proxy_needed,
            probe_video_info,
            write_preview_proxy,
        )

        asset = self.get_asset(asset_id)
        if not is_video_asset(asset.type):
            raise ValueError("Only video assets can generate a preview proxy")
        formats = dict(asset.processed_formats or {})
        existing = str(formats.get("preview") or "").strip()
        if existing:
            try:
                path = self.resolve_path(asset, existing)
                if path.is_file() and path.stat().st_size > 32:
                    return asset, "ready"
            except (ValueError, FileNotFoundError, OSError):
                pass

        src = self.resolve_path(asset)
        if not ffmpeg_available():
            return asset, "skipped"
        try:
            info = probe_video_info(src)
        except Exception:
            info = None
        if not preview_proxy_needed(info):
            with _lock:
                library = self._load()
                stored = next((a for a in library.assets if a.id == asset_id), None)
                if stored is None:
                    raise FileNotFoundError(f"Global asset not found: {asset_id}")
                stored.processed_formats = {**(stored.processed_formats or {}), "preview": stored.original_path}
                stored.updated_at = _now_iso()
                self._save(library)
                return stored.model_copy(deep=True), "ready"

        processed = self._asset_dir(asset_id) / "processed"
        processed.mkdir(parents=True, exist_ok=True)
        out = processed / "preview.mp4"
        rel = str(Path("assets") / asset_id / "processed" / "preview.mp4")
        try:
            write_preview_proxy(src, out, info=info)
        except VideoEditError:
            return asset, "error"
        with _lock:
            library = self._load()
            stored = next((a for a in library.assets if a.id == asset_id), None)
            if stored is None:
                raise FileNotFoundError(f"Global asset not found: {asset_id}")
            stored.processed_formats = {**(stored.processed_formats or {}), "preview": rel}
            stored.updated_at = _now_iso()
            self._save(library)
            return stored.model_copy(deep=True), "ready"

    def delete_asset(self, asset_id: str) -> None:
        with _lock:
            library = self._load()
            before = len(library.assets)
            library.assets = [a for a in library.assets if a.id != asset_id]
            if len(library.assets) == before:
                raise FileNotFoundError(f"Global asset not found: {asset_id}")
            self._save(library)
        asset_dir = self._asset_dir(asset_id)
        if asset_dir.exists():
            shutil.rmtree(asset_dir, ignore_errors=True)

    def read_bytes(self, asset_id: str) -> tuple[Asset, bytes, str]:
        asset = self.get_asset(asset_id)
        path = self.resolve_path(asset)
        return asset, path.read_bytes(), asset.original_filename


# Keep extension sets importable for accept= attributes / docs.
SUPPORTED_UPLOAD_EXT = sorted(PHOTO_EXT | VECTOR_EXT | VIDEO_EXT | MUSIC_EXT | SOUND_EXT | MODEL_EXT)
