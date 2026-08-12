"""Project, post, and asset storage on the local filesystem."""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

from PIL import Image

from . import asset_crypto
from .config import AppConfig
from .models import (
    Asset,
    AssetStatus,
    AssetType,
    CreatePostRequest,
    CreateProjectRequest,
    Layer,
    Post,
    PostSummary,
    Project,
    ProjectMediaFolder,
    ProjectSummary,
    ProjectType,
    Scene,
    _now_iso,
    asset_family,
    is_audio_asset,
    is_image_asset,
    is_processable_image,
    is_video_asset,
    new_id,
    parse_asset_type,
)

PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff", ".tif"}
VECTOR_EXT = {".svg", ".eps", ".ai"}
IMAGE_EXT = PHOTO_EXT | VECTOR_EXT
# Containers ffmpeg can typically demux; HD / broadcast / camera originals included.
VIDEO_EXT = {
    ".mp4",
    ".mov",
    ".webm",
    ".avi",
    ".mkv",
    ".m4v",
    ".mts",
    ".m2ts",
    ".ts",
    ".3gp",
    ".3g2",
    ".wmv",
    ".flv",
    ".mpg",
    ".mpeg",
    ".ogv",
    ".mxf",
}
MUSIC_EXT = {".mp3", ".m4a", ".aac", ".ogg", ".flac"}
SOUND_EXT = {".wav"}
AUDIO_EXT = MUSIC_EXT | SOUND_EXT
MODEL_EXT = {".glb", ".gltf", ".obj", ".fbx", ".stl", ".usdz", ".blend", ".dae"}

# Project logo slots: theme × length. Values match API kind and Project field prefixes.
LOGO_KINDS = ("dark_short", "dark_full", "light_short", "light_full")
LOGO_KIND_LABELS = {
    "dark_short": "Dark short logo",
    "dark_full": "Dark full logo",
    "light_short": "Light short logo",
    "light_full": "Light full logo",
}

_THUMB_MAX_EDGE = 320


def _safe_upload_basename(filename: str) -> str:
    """Basename only — never keep a client machine path in asset metadata."""
    raw = str(filename or "").replace("\\", "/").strip()
    name = Path(raw).name.strip() if raw else ""
    if not name or name in {".", ".."}:
        return "upload.bin"
    return name[:200]


def _logo_asset_id_attr(kind: str) -> str:
    return f"logo_{kind}_asset_id"


def _logo_path_attr(kind: str) -> str:
    return f"logo_{kind}_path"


def _project_logo_paths(project: Project) -> list[str]:
    paths: list[str] = []
    for kind in LOGO_KINDS:
        path = getattr(project, _logo_path_attr(kind), None)
        if path:
            paths.append(path)
    return paths

# Serialize project.json read-modify-write across upload + background processing.
_PROJECT_LOCKS: dict[str, threading.RLock] = {}
_PROJECT_LOCKS_GUARD = threading.Lock()


def _project_lock(project_id: str) -> threading.RLock:
    with _PROJECT_LOCKS_GUARD:
        lock = _PROJECT_LOCKS.get(project_id)
        if lock is None:
            lock = threading.RLock()
            _PROJECT_LOCKS[project_id] = lock
        return lock


@contextmanager
def _locked_project(project_id: str):
    lock = _project_lock(project_id)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


def detect_asset_type(filename: str) -> AssetType | None:
    ext = Path(filename).suffix.lower()
    if ext in VECTOR_EXT:
        return AssetType.VECTOR
    if ext in PHOTO_EXT:
        return AssetType.PHOTO
    if ext in VIDEO_EXT:
        return AssetType.VIDEO
    if ext in SOUND_EXT:
        return AssetType.SOUND
    if ext in MUSIC_EXT:
        return AssetType.MUSIC
    if ext in MODEL_EXT:
        return AssetType.MODEL
    return None


def resolve_upload_asset_type(
    filename: str,
    preferred: AssetType | str | None = None,
) -> AssetType:
    """Pick an asset type from optional user preference + file extension."""
    detected = detect_asset_type(filename)
    preferred_type = parse_asset_type(preferred)
    if preferred_type is None:
        if detected is None:
            raise ValueError(f"Unsupported file type: {filename}")
        return detected
    # Preference must stay in the same media family as the file (when known).
    if detected is not None and asset_family(preferred_type) != asset_family(detected):
        raise ValueError(
            f"File looks like {asset_family(detected)}, but type was set to {preferred_type.value}"
        )
    if detected is None and preferred_type is not None:
        # Allow explicit type only when extension is known for that family.
        ext = Path(filename).suffix.lower()
        family = asset_family(preferred_type)
        if family == "image" and ext not in IMAGE_EXT:
            raise ValueError(f"Unsupported image file type: {filename}")
        if family == "video" and ext not in VIDEO_EXT:
            raise ValueError(f"Unsupported video file type: {filename}")
        if family == "audio" and ext not in AUDIO_EXT:
            raise ValueError(f"Unsupported audio file type: {filename}")
        if family == "model" and ext not in MODEL_EXT:
            raise ValueError(f"Unsupported 3D file type: {filename}")
    return preferred_type


def _apply_media_probe(asset: Asset, path: Path) -> None:
    """Fill Asset media fields from ffprobe when available (best-effort)."""
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
    asset.updated_at = _now_iso()


def _slugify(name: str) -> str:
    raw = name.strip().lower().replace(" ", "-")
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in raw)
    while "--" in safe:
        safe = safe.replace("--", "-")
    return safe.strip("-_") or "project"


def _write_thumb(processed_dir: Path, asset_id: str) -> str | None:
    """Write thumb.jpg from portrait (preferred) or any available format."""
    candidates = ["portrait", "square", "landscape", "story"]
    src: Path | None = None
    for fmt in candidates:
        p = processed_dir / f"{fmt}.jpg"
        if p.exists():
            src = p
            break
    if src is None:
        return None
    try:
        img = Image.open(src).convert("RGB")
        img.thumbnail((_THUMB_MAX_EDGE, _THUMB_MAX_EDGE), Image.Resampling.LANCZOS)
        out = processed_dir / "thumb.jpg"
        img.save(out, "JPEG", quality=85)
        return str(Path("assets") / asset_id / "processed" / "thumb.jpg")
    except OSError:
        return None


def _write_thumb_from_original(asset_dir: Path, asset_id: str, original: Path) -> str | None:
    """Write a library thumb from an original image (e.g. branding logos)."""
    processed_dir = asset_dir / "processed"
    processed_dir.mkdir(parents=True, exist_ok=True)
    try:
        img = Image.open(original)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            rgba = img.convert("RGBA")
            background = Image.new("RGB", rgba.size, (20, 26, 40))
            background.paste(rgba, mask=rgba.split()[-1])
            img = background
        else:
            img = img.convert("RGB")
        img.thumbnail((_THUMB_MAX_EDGE, _THUMB_MAX_EDGE), Image.Resampling.LANCZOS)
        out = processed_dir / "thumb.jpg"
        img.save(out, "JPEG", quality=85)
        return str(Path("assets") / asset_id / "processed" / "thumb.jpg")
    except OSError:
        return None


def _default_video_thumb_time_s(duration_s: float | None) -> float:
    """Prefer a moment slightly into the clip to avoid black opener frames."""
    if duration_s and duration_s > 0:
        return min(1.0, max(0.0, float(duration_s) * 0.1))
    return 0.0


def _save_video_thumb_image(
    asset_dir: Path,
    asset_id: str,
    frame: Image.Image,
    *,
    locked: bool,
    crypto_key: bytes | None,
) -> str:
    """Write ``processed/thumb.jpg`` (or encrypted ``thumb.csasset``) and return rel path."""
    processed_dir = asset_dir / "processed"
    processed_dir.mkdir(parents=True, exist_ok=True)
    # Drop any previous thumb variants so serving stays consistent.
    for old in processed_dir.glob("thumb.*"):
        old.unlink(missing_ok=True)
    img = frame.convert("RGB")
    img.thumbnail((_THUMB_MAX_EDGE, _THUMB_MAX_EDGE), Image.Resampling.LANCZOS)
    out = processed_dir / "thumb.jpg"
    img.save(out, "JPEG", quality=85)
    if locked and crypto_key is not None:
        enc_path = processed_dir / "thumb.csasset"
        asset_crypto.write_encrypted(enc_path, out.read_bytes(), crypto_key)
        out.unlink(missing_ok=True)
        return str(Path("assets") / asset_id / "processed" / "thumb.csasset")
    return str(Path("assets") / asset_id / "processed" / "thumb.jpg")


BRANDING_GROUP = "Branding"
EDITED_VIDEOS_GROUP = "Edited videos"
EDITED_IMAGES_GROUP = "Edited images"


class ProjectStore:
    """Filesystem-backed project store under ``projects_dir``."""

    def __init__(self, root: Path, cfg: AppConfig) -> None:
        self.root = root.resolve()
        self.cfg = cfg
        self.root.mkdir(parents=True, exist_ok=True)

    def _project_dir(self, project_id: str) -> Path:
        return self.root / project_id

    def _project_file(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "project.json"

    def _posts_dir(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "posts"

    def _post_dir(self, project_id: str, post_id: str) -> Path:
        return self._posts_dir(project_id) / post_id

    def _post_file(self, project_id: str, post_id: str) -> Path:
        return self._post_dir(project_id, post_id) / "post.json"

    def _asset_dir(self, project_id: str, asset_id: str) -> Path:
        return self._project_dir(project_id) / "assets" / asset_id

    def scripts_dir(self, project_id: str, post_id: str) -> Path:
        """Per-post Script Generator drafts: ``{project}/posts/{post}/scripts/{id}/script.json``."""
        path = self._post_dir(project_id, post_id) / "scripts"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def legacy_project_scripts_dir(self, project_id: str) -> Path:
        """Pre-migration project-level scripts root (``{project}/scripts/``)."""
        return self._project_dir(project_id) / "scripts"

    def migrate_legacy_scripts_to_post(self, project_id: str, post_id: str) -> int:
        """Move leftover project-level scripts into this post. Returns count moved."""
        if not self._post_file(project_id, post_id).exists():
            raise FileNotFoundError(f"Post not found: {post_id}")
        legacy = self.legacy_project_scripts_dir(project_id)
        if not legacy.exists():
            return 0
        dest = self.scripts_dir(project_id, post_id)
        moved = 0
        for sdir in list(legacy.iterdir()):
            if not sdir.is_dir() or not (sdir / "script.json").exists():
                continue
            target = dest / sdir.name
            if target.exists():
                shutil.rmtree(sdir)
            else:
                shutil.move(str(sdir), str(target))
            moved += 1
        try:
            if legacy.exists() and not any(legacy.iterdir()):
                legacy.rmdir()
        except OSError:
            pass
        if moved:
            from .script_store import ScriptStore

            store = ScriptStore(dest)
            scripts = store.list_scripts()
            post = self.get_post(project_id, post_id)
            if scripts and not post.active_script_id:
                post.active_script_id = scripts[0].id
                post.updated_at = _now_iso()
                self._save_post(project_id, post)
        return moved

    def set_active_script(self, project_id: str, post_id: str, script_id: str | None) -> Post:
        """Mark exactly one script as active for the post (or clear)."""
        post = self.get_post(project_id, post_id)
        if script_id:
            from .script_store import ScriptStore

            store = ScriptStore(self.scripts_dir(project_id, post_id))
            store.get_script(script_id)  # raises FileNotFoundError if missing
            post.active_script_id = script_id
        else:
            post.active_script_id = None
        post.updated_at = _now_iso()
        self._save_post(project_id, post)
        project = self.get_project(project_id)
        project.updated_at = _now_iso()
        self._save_project_meta(project)
        return post

    def clear_active_script_if_matches(self, project_id: str, post_id: str, script_id: str) -> Post | None:
        post = self.get_post(project_id, post_id)
        if post.active_script_id != script_id:
            return None
        post.active_script_id = None
        # Promote newest remaining script if any.
        from .script_store import ScriptStore

        remaining = ScriptStore(self.scripts_dir(project_id, post_id)).list_scripts()
        if remaining:
            post.active_script_id = remaining[0].id
        post.updated_at = _now_iso()
        self._save_post(project_id, post)
        return post

    def list_projects(self) -> list[ProjectSummary]:
        summaries: list[ProjectSummary] = []
        if not self.root.exists():
            return summaries
        for pdir in sorted(self.root.iterdir()):
            if not pdir.is_dir():
                continue
            pfile = pdir / "project.json"
            if not pfile.exists():
                continue
            try:
                project = self._load_project_file(pfile)
                summaries.append(
                    ProjectSummary(
                        id=project.id,
                        name=project.name,
                        created_at=project.created_at,
                        updated_at=project.updated_at,
                        asset_count=len(project.assets),
                        post_count=len(project.posts),
                        has_project_logos=any(
                            (pdir / path).exists() for path in _project_logo_paths(project)
                        ),
                    )
                )
            except (json.JSONDecodeError, OSError, ValueError):
                continue
        return sorted(summaries, key=lambda s: s.updated_at, reverse=True)

    def create_project(self, req: CreateProjectRequest) -> Project:
        base_id = _slugify(req.name)
        project_id = base_id
        counter = 1
        while self._project_dir(project_id).exists():
            project_id = f"{base_id}-{counter}"
            counter += 1

        project = Project(
            id=project_id,
            name=req.name.strip(),
            asset_groups=[BRANDING_GROUP],
        )
        pdir = self._project_dir(project_id)
        pdir.mkdir(parents=True)
        (pdir / "assets").mkdir()
        (pdir / "posts").mkdir()
        self._save_project_meta(project)
        return project

    def create_post(self, project_id: str, req: CreatePostRequest) -> Post:
        project = self.get_project(project_id)
        from .script_store import (
            normalize_script_orientation,
            normalize_script_platforms,
            normalize_script_video_format,
        )
        fmt = normalize_script_orientation(req.target_format)
        platforms = normalize_script_platforms(getattr(req, "platforms", None) or ["youtube"])
        video_format = normalize_script_video_format(getattr(req, "video_format", None) or "1080p")

        post = Post(
            name=req.name.strip(),
            type=req.type,
            target_format=fmt,
            background_format=fmt,
            platforms=platforms,
            video_format=video_format,
            is_reusable=bool(req.is_reusable) and req.type == ProjectType.VIDEO,
        )
        if post.type == ProjectType.VIDEO:
            post.scenes = [Scene(name="Scene 1", background_format=fmt)]

        self._save_post(project_id, post)
        project.updated_at = _now_iso()
        self._save_project_meta(project)
        return post

    def list_posts(self, project_id: str) -> list[PostSummary]:
        project = self.get_project(project_id)
        return [
            PostSummary(
                id=p.id,
                name=p.name,
                type=p.type,
                created_at=p.created_at,
                updated_at=p.updated_at,
                target_format=p.target_format,
                is_reusable=bool(getattr(p, "is_reusable", False)),
            )
            for p in project.posts
        ]

    def get_post(self, project_id: str, post_id: str) -> Post:
        pfile = self._post_file(project_id, post_id)
        if not pfile.exists():
            raise FileNotFoundError(f"Post not found: {post_id}")
        post = Post.model_validate(json.loads(pfile.read_text(encoding="utf-8")))
        changed = self._migrate_legacy_music(post)
        if post.type == ProjectType.VIDEO and post.layers:
            self._normalize_video_layer_ownership(post)
            changed = True
        elif post.type == ProjectType.VIDEO:
            self._normalize_video_layer_ownership(post)
        if changed:
            self._save_post(project_id, post)
        from .render import sync_ref_scene_metadata

        sync_ref_scene_metadata(self, project_id, post)
        return post

    def _migrate_legacy_music(self, post: Post) -> bool:
        """Move post.music_asset_id into a scene audio layer once."""
        if not post.music_asset_id or post.type != ProjectType.VIDEO:
            return False
        if not post.scenes:
            return False
        # Already has an audio layer with this asset
        for scene in post.scenes:
            for layer in scene.layers:
                if layer.type == "audio" and layer.asset_id == post.music_asset_id:
                    post.music_asset_id = None
                    return True
        scene = post.scenes[0]
        scene.layers.append(
            Layer(
                type="audio",
                asset_id=post.music_asset_id,
                start_s=0.0,
                duration_s=scene.duration_s,
                tts_volume=float(post.music_volume or 0.8),
                z_index=len(scene.layers),
                x=0,
                y=0,
                width=0,
                height=0,
            )
        )
        post.music_asset_id = None
        post.updated_at = _now_iso()
        return True

    def update_post(self, project_id: str, post_id: str, post: Post) -> Post:
        if not self._project_file(project_id).exists():
            raise FileNotFoundError(f"Project not found: {project_id}")
        existing = self.get_post(project_id, post_id)
        post.id = existing.id
        post.created_at = existing.created_at
        post.updated_at = _now_iso()
        if post.type != ProjectType.VIDEO:
            post.is_reusable = False
        self._normalize_video_layer_ownership(post)
        from .render import sync_ref_scene_metadata

        sync_ref_scene_metadata(self, project_id, post)
        self._validate_reusable_refs(project_id, post)
        self._save_post(project_id, post)
        project = self.get_project(project_id)
        project.updated_at = _now_iso()
        self._save_project_meta(project)
        return post

    def _validate_reusable_refs(self, project_id: str, post: Post) -> None:
        """Ensure ref slots point at video posts and do not create cycles."""
        if post.type != ProjectType.VIDEO:
            return
        for scene in post.scenes or []:
            ref_id = (scene.ref_post_id or "").strip() or None
            if not ref_id:
                continue
            if ref_id == post.id:
                raise ValueError("A post cannot embed itself as a reusable clip.")
            try:
                src = self.get_post(project_id, ref_id)
            except FileNotFoundError as exc:
                raise ValueError(f"Reusable post not found: {ref_id}") from exc
            if src.type != ProjectType.VIDEO:
                raise ValueError("Only video posts can be inserted as reusable clips.")
            if self._ref_cycle_exists(project_id, post.id, ref_id, stack=set()):
                raise ValueError("Circular reusable post reference.")

    def _ref_cycle_exists(
        self,
        project_id: str,
        host_id: str,
        from_id: str,
        *,
        stack: set[str],
    ) -> bool:
        if from_id == host_id or from_id in stack:
            return True
        stack.add(from_id)
        try:
            src = self.get_post(project_id, from_id)
        except FileNotFoundError:
            return False
        for scene in src.scenes or []:
            ref_id = (scene.ref_post_id or "").strip() or None
            if not ref_id:
                continue
            if self._ref_cycle_exists(project_id, host_id, ref_id, stack=stack):
                return True
        stack.discard(from_id)
        return False

    @staticmethod
    def _normalize_video_layer_ownership(post: Post) -> None:
        """Video layers belong on scenes; migrate stray post.layers if present."""
        if post.type != ProjectType.VIDEO:
            return
        if not post.scenes:
            post.scenes = [Scene(name="Scene 1", background_format=post.target_format or "portrait")]
        if post.layers:
            post.scenes[0].layers.extend(post.layers)
            post.layers = []

    def delete_post(self, project_id: str, post_id: str) -> None:
        pdir = self._post_dir(project_id, post_id)
        if not pdir.exists():
            raise FileNotFoundError(f"Post not found: {post_id}")
        # Remove timeline slots in other posts that referenced this reusable clip.
        for other in self._load_posts(project_id):
            if other.id == post_id or other.type != ProjectType.VIDEO:
                continue
            kept = [s for s in (other.scenes or []) if (s.ref_post_id or "") != post_id]
            if len(kept) == len(other.scenes or []):
                continue
            if not kept:
                kept = [
                    Scene(
                        name="Scene 1",
                        background_format=other.target_format or "portrait",
                    )
                ]
            other.scenes = kept
            other.updated_at = _now_iso()
            self._save_post(project_id, other)
        shutil.rmtree(pdir)
        # Drop post-scoped assets so they cannot leak into other posts' libraries.
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            remove_ids = {a.id for a in project.assets if a.post_id == post_id}
            if remove_ids:
                project.assets = [a for a in project.assets if a.id not in remove_ids]
                for asset_id in remove_ids:
                    asset_dir = self._asset_dir(project_id, asset_id)
                    if asset_dir.exists():
                        shutil.rmtree(asset_dir)
            project.updated_at = _now_iso()
            self._save_project_meta(project)

    @staticmethod
    def visible_assets(project: Project, post_id: str | None = None) -> list[Asset]:
        """Project-level assets plus assets owned by ``post_id`` (if given)."""
        out: list[Asset] = []
        for asset in project.assets:
            if not asset.post_id:
                out.append(asset)
            elif post_id and asset.post_id == post_id:
                out.append(asset)
        return out

    def asset_visible_to_post(self, project_id: str, asset_id: str, post_id: str) -> bool:
        asset = self.get_asset(project_id, asset_id)
        return (not asset.post_id) or asset.post_id == post_id

    def get_project(self, project_id: str) -> Project:
        pfile = self._project_file(project_id)
        if not pfile.exists():
            raise FileNotFoundError(f"Project not found: {project_id}")
        with _locked_project(project_id):
            project = self._load_project_file(pfile)
            # Housekeeping must not bump updated_at — that reordered the project
            # list whenever a project was merely opened.
            dirty = False
            if self._recover_orphan_assets(project):
                dirty = True
            if self._sync_logo_assets_into_branding(project):
                dirty = True
            if dirty:
                self._save_project_meta(project)
            return project

    def delete_project(self, project_id: str) -> None:
        pdir = self._project_dir(project_id)
        if not pdir.exists():
            raise FileNotFoundError(f"Project not found: {project_id}")
        shutil.rmtree(pdir)

    def _recover_orphan_assets(self, project: Project) -> bool:
        """Re-attach asset folders that exist on disk but are missing from project.json.

        Concurrent upload/process races used to drop assets from the meta file while
        leaving originals + processed variants on disk.
        """
        assets_root = self._project_dir(project.id) / "assets"
        if not assets_root.is_dir():
            return False
        known = {a.id for a in project.assets}
        changed = False
        for folder in sorted(assets_root.iterdir(), key=lambda p: p.name):
            if not folder.is_dir() or folder.name in known:
                continue
            originals = sorted(folder.glob("original.*"))
            if not originals:
                continue
            original = originals[0]
            asset_type = detect_asset_type(f"file{original.suffix}")
            if asset_type is None:
                continue
            processed_dir = folder / "processed"
            formats: dict[str, str] = {}
            if processed_dir.is_dir():
                for fmt in list(self.cfg.formats) + ["thumb"]:
                    candidate = processed_dir / f"{fmt}.jpg"
                    if candidate.exists():
                        formats[fmt] = str(Path("assets") / folder.name / "processed" / f"{fmt}.jpg")
            if not is_processable_image(asset_type):
                status = AssetStatus.READY
                error = None
            elif any(k != "thumb" for k in formats):
                status = AssetStatus.READY
                error = None
            else:
                status = AssetStatus.FAILED
                error = "Recovered from disk; re-process if needed"
            asset = Asset(
                id=folder.name,
                name=folder.name,
                type=asset_type,
                apply_logo=False,
                status=status,
                original_filename=original.name,
                original_path=str(Path("assets") / folder.name / original.name),
                processed_formats=formats,
                error=error,
            )
            # Prefer a friendlier name from processed manifest if present
            manifest = processed_dir / "manifest.json"
            if manifest.exists():
                try:
                    meta = json.loads(manifest.read_text(encoding="utf-8"))
                    stem = str(meta.get("source") or meta.get("name") or "").strip()
                    if stem:
                        asset.name = Path(stem).stem[:120] or asset.name
                        asset.original_filename = Path(stem).name or asset.original_filename
                except (OSError, json.JSONDecodeError, TypeError):
                    pass
            # Logo-style originals (no IG formats) stay usable library assets.
            stem_l = asset.original_filename.lower()
            if is_image_asset(asset_type) and stem_l.startswith("logo_"):
                asset.group = BRANDING_GROUP
                asset.status = AssetStatus.READY
                asset.error = None
                asset.apply_logo = False
                if "thumb" not in asset.processed_formats:
                    thumb = _write_thumb_from_original(folder, folder.name, original)
                    if thumb:
                        asset.processed_formats["thumb"] = thumb
                self._ensure_group_name(project, BRANDING_GROUP)
            project.assets.append(asset)
            known.add(asset.id)
            changed = True
        return changed

    def _sync_logo_assets_into_branding(self, project: Project) -> bool:
        """Ensure configured project logos live in the Branding group as library assets."""
        changed = False
        has_logo_refs = any(
            getattr(project, _logo_asset_id_attr(kind), None) for kind in LOGO_KINDS
        )
        has_logo_files = any(
            (a.original_filename or "").lower().startswith("logo_") for a in project.assets
        )
        if not has_logo_refs and not has_logo_files:
            return False

        self._ensure_group_name(project, BRANDING_GROUP)
        by_id = {a.id: a for a in project.assets}
        for kind in LOGO_KINDS:
            asset_id = getattr(project, _logo_asset_id_attr(kind), None)
            if not asset_id:
                continue
            asset = by_id.get(asset_id)
            if asset is None:
                continue
            asset_changed = False
            if (asset.group or "").strip() != BRANDING_GROUP:
                asset.group = BRANDING_GROUP
                asset_changed = True
            if asset.apply_logo:
                asset.apply_logo = False
                asset_changed = True
            if asset.status != AssetStatus.READY:
                asset.status = AssetStatus.READY
                asset.error = None
                asset_changed = True
            if asset.name != LOGO_KIND_LABELS[kind]:
                asset.name = LOGO_KIND_LABELS[kind]
                asset_changed = True
            if "thumb" not in (asset.processed_formats or {}):
                original = self._project_dir(project.id) / asset.original_path
                if original.exists():
                    thumb = _write_thumb_from_original(
                        self._asset_dir(project.id, asset.id), asset.id, original
                    )
                    if thumb:
                        asset.processed_formats = {
                            **(asset.processed_formats or {}),
                            "thumb": thumb,
                        }
                        asset_changed = True
            if asset_changed:
                asset.updated_at = _now_iso()
                changed = True

        for asset in project.assets:
            if not is_image_asset(asset.type):
                continue
            if not (asset.original_filename or "").lower().startswith("logo_"):
                continue
            if (asset.group or "").strip() != BRANDING_GROUP:
                asset.group = BRANDING_GROUP
                asset.updated_at = _now_iso()
                changed = True
        if changed:
            self._ensure_group_name(project, BRANDING_GROUP)
        return changed

    def add_asset(
        self,
        project_id: str,
        filename: str,
        data: bytes,
        *,
        apply_logo: bool = False,
        group: str = "",
        post_id: str | None = None,
        locked: bool = False,
        source: str = "",
        asset_type: AssetType | str | None = None,
    ) -> Asset:
        """Copy upload bytes into the project and register a new asset.

        The project always owns an independent copy under
        ``assets/<asset_id>/original.<ext>`` (or ``original.csasset`` when locked).
        ``original_path`` is project-relative only — never an absolute path on the
        user's machine. Callers must pass the file contents (``data``); there is no
        path-based import that links to the source file. Edits (crop, AI, processing)
        read/write only under this tree.
        """
        safe_name = _safe_upload_basename(filename)
        try:
            resolved_type = resolve_upload_asset_type(safe_name, preferred=asset_type)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc

        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            self._recover_orphan_assets(project)

            owner_post_id = (post_id or "").strip() or None
            if owner_post_id:
                # Validate the post exists without requiring it in project.posts
                # (summaries may be stale); look up the post file.
                if not self._post_file(project_id, owner_post_id).exists():
                    raise ValueError(f"Post not found: {owner_post_id}")

            asset_id = new_id()
            ext = Path(safe_name).suffix.lower() or ".bin"
            asset_dir = self._asset_dir(project_id, asset_id)
            asset_dir.mkdir(parents=True)
            locked_flag = bool(locked)
            if locked_flag:
                original_name = "original.csasset"
                original_disk = asset_dir / original_name
                # Probe video/audio on plaintext before encrypting.
                if is_video_asset(resolved_type) or is_audio_asset(resolved_type):
                    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                        tmp_path = Path(tmp.name)
                        tmp.write(data)
                    try:
                        probe_asset = Asset(
                            id=asset_id,
                            name=Path(safe_name).stem,
                            type=resolved_type,
                            original_filename=safe_name,
                            original_path=str(Path("assets") / asset_id / original_name),
                        )
                        _apply_media_probe(probe_asset, tmp_path)
                        probed = probe_asset
                    finally:
                        tmp_path.unlink(missing_ok=True)
                else:
                    probed = None
                key = asset_crypto.load_or_create_key(self.cfg.cache_dir)
                asset_crypto.write_encrypted(original_disk, data, key)
            else:
                original_name = f"original{ext}"
                original_disk = asset_dir / original_name
                # Independent copy — do not symlink/hardlink to the caller's file.
                original_disk.write_bytes(data)
                probed = None

            group_name = str(group or "").strip()[:80]
            processable = is_processable_image(resolved_type)
            asset = Asset(
                id=asset_id,
                name=Path(safe_name).stem,
                type=resolved_type,
                group=group_name,
                post_id=owner_post_id,
                apply_logo=apply_logo if processable else False,
                status=AssetStatus.PENDING if processable else AssetStatus.READY,
                original_filename=safe_name,
                original_path=str(Path("assets") / asset_id / original_name),
                locked=locked_flag,
                source=str(source or "").strip()[:80],
            )
            if probed is not None:
                asset.duration_s = probed.duration_s
                asset.width = probed.width
                asset.height = probed.height
                asset.fps = probed.fps
                asset.has_audio = probed.has_audio
                asset.container = probed.container
                asset.video_codec = probed.video_codec
                asset.audio_codec = probed.audio_codec
                asset.bitrate_kbps = probed.bitrate_kbps
                asset.file_size_bytes = probed.file_size_bytes
            elif is_video_asset(resolved_type) or is_audio_asset(resolved_type):
                _apply_media_probe(asset, original_disk)
            elif locked_flag:
                asset.file_size_bytes = len(data)
            project.assets.append(asset)
            if group_name:
                self._ensure_group_name(project, group_name)
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset

    def _ensure_group_name(self, project: Project, name: str) -> None:
        cleaned = str(name).strip()[:80]
        if not cleaned:
            return
        existing = {g.casefold(): g for g in project.asset_groups}
        if cleaned.casefold() not in existing:
            project.asset_groups = sorted(
                [*project.asset_groups, cleaned],
                key=lambda g: g.casefold(),
            )

    def add_asset_group(self, project_id: str, name: str) -> Project:
        project = self.get_project(project_id)
        cleaned = str(name).strip()[:80]
        if not cleaned:
            raise ValueError("Group name cannot be empty")
        existing = {g.casefold(): g for g in project.asset_groups}
        if cleaned.casefold() in existing:
            return project
        # Also pick up groups already used on assets
        for a in project.assets:
            g = (a.group or "").strip()
            if g:
                self._ensure_group_name(project, g)
        self._ensure_group_name(project, cleaned)
        project.updated_at = _now_iso()
        self._save_project_meta(project)
        return self.get_project(project_id)

    def delete_asset_group(self, project_id: str, name: str, *, clear_assets: bool = True) -> Project:
        project = self.get_project(project_id)
        cleaned = str(name).strip()
        project.asset_groups = [g for g in project.asset_groups if g.casefold() != cleaned.casefold()]
        if clear_assets:
            for a in project.assets:
                if (a.group or "").strip().casefold() == cleaned.casefold():
                    a.group = ""
                    a.updated_at = _now_iso()
        project.updated_at = _now_iso()
        self._save_project_meta(project)
        return self.get_project(project_id)

    def add_generated_audio(
        self,
        project_id: str,
        *,
        name: str,
        data: bytes,
        filename: str = "speech.wav",
        post_id: str | None = None,
    ) -> Asset:
        """Attach a generated audio blob (e.g. TTS) as a project or post asset."""
        asset = self.add_asset(
            project_id,
            filename=filename,
            data=data,
            apply_logo=False,
            post_id=post_id,
        )
        project = self.get_project(project_id)
        for a in project.assets:
            if a.id == asset.id:
                a.name = name[:120] or a.name
                a.updated_at = _now_iso()
                break
        project.updated_at = _now_iso()
        self._save_project_meta(project)
        return self.get_asset(project_id, asset.id)

    def begin_generated_video(
        self,
        project_id: str,
        *,
        name: str,
        post_id: str | None = None,
        filename: str = "generated.mp4",
    ) -> Asset:
        """Create a video asset in PROCESSING state (filled in by ComfyUI job)."""
        return self.begin_generated_asset(
            project_id,
            name=name,
            post_id=post_id,
            filename=filename,
            asset_type=AssetType.VIDEO,
        )

    def begin_generated_asset(
        self,
        project_id: str,
        *,
        name: str,
        filename: str,
        asset_type: AssetType | str,
        post_id: str | None = None,
        group: str = "",
    ) -> Asset:
        """Create an image/video asset in PROCESSING state for a background job."""
        asset = self.add_asset(
            project_id,
            filename=filename,
            data=b"",
            apply_logo=False,
            post_id=post_id,
            group=group,
            asset_type=asset_type,
        )
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            stored = self._find_asset(project, asset.id)
            stored.name = (name or stored.name)[:120]
            stored.status = AssetStatus.PROCESSING
            stored.error = None
            stored.job_message = "Queued…"
            stored.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return self._find_asset(project, asset.id).model_copy(deep=True)

    def finalize_generated_video(
        self,
        project_id: str,
        asset_id: str,
        data: bytes,
        *,
        filename: str | None = None,
    ) -> Asset:
        """Write generated video bytes and mark the asset READY."""
        return self.finalize_generated_asset(
            project_id, asset_id, data, filename=filename, expect="video"
        )

    def finalize_generated_asset(
        self,
        project_id: str,
        asset_id: str,
        data: bytes,
        *,
        filename: str | None = None,
        expect: str | None = None,
    ) -> Asset:
        """Write generated media bytes and mark the asset READY."""
        if not data:
            raise ValueError("Generated media is empty")
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            if expect == "video" and not is_video_asset(asset.type):
                raise ValueError("Asset is not a video")
            if expect == "image" and not is_image_asset(asset.type):
                raise ValueError("Asset is not an image")
            asset_dir = self._asset_dir(project_id, asset_id)
            preferred = Path(filename or asset.original_filename or "generated.bin")
            ext = preferred.suffix.lower()
            if is_video_asset(asset.type):
                if ext not in VIDEO_EXT:
                    ext = ".mp4"
            elif is_image_asset(asset.type):
                if ext not in IMAGE_EXT:
                    ext = ".png"
            original_name = f"original{ext}"
            out = asset_dir / original_name
            out.write_bytes(data)
            for old in asset_dir.glob("original.*"):
                if old.resolve() != out.resolve():
                    old.unlink(missing_ok=True)
            asset.original_filename = filename or f"generated{ext}"
            asset.original_path = str(Path("assets") / asset_id / original_name)
            asset.status = AssetStatus.READY
            asset.error = None
            asset.job_message = None
            _apply_media_probe(asset, out)
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            asset_id_out = asset.id
            is_vid = is_video_asset(asset.type)
        if is_vid:
            try:
                return self.generate_video_thumb(project_id, asset_id_out)
            except Exception:  # noqa: BLE001 — thumb is best-effort for generated clips
                return self.get_asset(project_id, asset_id_out)
        return self.get_asset(project_id, asset_id_out)

    def replace_video_bytes(
        self,
        project_id: str,
        asset_id: str,
        data: bytes,
        *,
        name: str | None = None,
        post_id: str | None = None,
        set_post_id: bool = False,
        group: str | None = None,
    ) -> Asset:
        """Overwrite a video asset's on-disk file and refresh probe metadata.

        Used when re-saving edits onto an existing Edited videos asset so the
        project does not accumulate duplicates. Clears the cached thumb so it
        can be regenerated. There is no undo.
        """
        if not data or len(data) < 32:
            raise ValueError("Replacement video is empty")
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            if not is_video_asset(asset.type):
                raise ValueError("Asset is not a video")
            asset_dir = self._asset_dir(project_id, asset_id)
            asset_dir.mkdir(parents=True, exist_ok=True)

            locked_flag = bool(asset.locked)
            if locked_flag:
                original_name = "original.csasset"
                original_disk = asset_dir / original_name
                key = asset_crypto.load_or_create_key(self.cfg.cache_dir)
                asset_crypto.write_encrypted(original_disk, data, key)
                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                    tmp_path = Path(tmp.name)
                    tmp.write(data)
                try:
                    _apply_media_probe(asset, tmp_path)
                finally:
                    tmp_path.unlink(missing_ok=True)
            else:
                original_name = "original.mp4"
                original_disk = asset_dir / original_name
                original_disk.write_bytes(data)
                _apply_media_probe(asset, original_disk)

            for old in asset_dir.glob("original.*"):
                if old.resolve() != original_disk.resolve():
                    old.unlink(missing_ok=True)

            processed = asset_dir / "processed"
            if processed.is_dir():
                for old in processed.glob("thumb.*"):
                    old.unlink(missing_ok=True)
            formats = dict(asset.processed_formats or {})
            formats.pop("thumb", None)
            asset.processed_formats = formats

            asset.original_filename = (
                Path(asset.original_filename or "edited.mp4").stem + ".mp4"
            )
            asset.original_path = str(Path("assets") / asset_id / original_name)
            asset.status = AssetStatus.READY
            asset.error = None
            if group is not None:
                cleaned_group = str(group).strip()[:80]
                asset.group = cleaned_group
                if cleaned_group:
                    self._ensure_group_name(project, cleaned_group)
            if name is not None:
                cleaned = str(name).strip()[:120]
                if cleaned:
                    asset.name = cleaned
            if set_post_id:
                owner = (post_id or "").strip() or None
                if owner and not self._post_file(project_id, owner).exists():
                    raise ValueError(f"Post not found: {owner}")
                asset.post_id = owner
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset.model_copy(deep=True)

    def replace_image_bytes(
        self,
        project_id: str,
        asset_id: str,
        data: bytes,
        *,
        name: str | None = None,
        post_id: str | None = None,
        set_post_id: bool = False,
        group: str | None = None,
        apply_logo: bool | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> Asset:
        """Overwrite an image asset's on-disk file and clear processed derivatives.

        Used when re-saving edits onto an existing Edited images asset so the
        project does not accumulate duplicates. Sets status to PENDING so
        callers can re-queue processing. There is no undo.
        """
        if not data or len(data) < 32:
            raise ValueError("Replacement image is empty")
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            if not is_image_asset(asset.type):
                raise ValueError("Asset is not an image")
            asset_dir = self._asset_dir(project_id, asset_id)
            asset_dir.mkdir(parents=True, exist_ok=True)

            locked_flag = bool(asset.locked)
            if locked_flag:
                original_name = "original.csasset"
                original_disk = asset_dir / original_name
                key = asset_crypto.load_or_create_key(self.cfg.cache_dir)
                asset_crypto.write_encrypted(original_disk, data, key)
            else:
                original_name = "original.jpg"
                original_disk = asset_dir / original_name
                original_disk.write_bytes(data)

            for old in asset_dir.glob("original.*"):
                if old.resolve() != original_disk.resolve():
                    old.unlink(missing_ok=True)

            processed = asset_dir / "processed"
            if processed.is_dir():
                for old in processed.iterdir():
                    if old.is_file():
                        old.unlink(missing_ok=True)
            asset.processed_formats = {}

            asset.original_filename = (
                Path(asset.original_filename or "edited.jpg").stem + ".jpg"
            )
            asset.original_path = str(Path("assets") / asset_id / original_name)
            asset.status = AssetStatus.PENDING
            asset.error = None
            asset.file_size_bytes = len(data)
            if width is not None and width > 0:
                asset.width = int(width)
            if height is not None and height > 0:
                asset.height = int(height)
            if apply_logo is not None:
                asset.apply_logo = bool(apply_logo)
            if group is not None:
                cleaned_group = str(group).strip()[:80]
                asset.group = cleaned_group
                if cleaned_group:
                    self._ensure_group_name(project, cleaned_group)
            if name is not None:
                cleaned = str(name).strip()[:120]
                if cleaned:
                    asset.name = cleaned
            if set_post_id:
                owner = (post_id or "").strip() or None
                if owner and not self._post_file(project_id, owner).exists():
                    raise ValueError(f"Post not found: {owner}")
                asset.post_id = owner
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset.model_copy(deep=True)

    def generate_video_thumb(
        self,
        project_id: str,
        asset_id: str,
        *,
        time_s: float | None = None,
    ) -> Asset:
        """Extract a still from a video and store it as ``processed_formats.thumb``."""
        from .video_edit import extract_video_frame, ffmpeg_available

        if not ffmpeg_available():
            raise ValueError("ffmpeg is required to generate video thumbnails")

        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            if not is_video_asset(asset.type):
                raise ValueError("Only video assets can generate a video thumbnail")
            duration_s = asset.duration_s
            locked = bool(asset.locked)
            snapshot = asset.model_copy(deep=True)

        path = self.materialize_asset(project_id, snapshot)
        if not path.is_file():
            raise FileNotFoundError(f"Video file missing for asset {asset_id}")

        seek = float(time_s) if time_s is not None else _default_video_thumb_time_s(duration_s)
        seek = max(0.0, seek)
        if duration_s and duration_s > 0:
            seek = min(seek, max(0.0, float(duration_s) - 0.05))

        frame = extract_video_frame(path, time_s=seek)
        if frame is None:
            raise ValueError("Could not extract a frame from this video")

        asset_dir = self._asset_dir(project_id, asset_id)
        thumb_rel = _save_video_thumb_image(
            asset_dir,
            asset_id,
            frame,
            locked=locked,
            crypto_key=self._crypto_key() if locked else None,
        )

        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            formats = dict(asset.processed_formats or {})
            formats["thumb"] = thumb_rel
            asset.processed_formats = formats
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset.model_copy(deep=True)

    def fail_asset(self, project_id: str, asset_id: str, error: str) -> Asset:
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            asset.status = AssetStatus.FAILED
            asset.error = (error or "Generation failed")[:500]
            asset.job_message = None
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset.model_copy(deep=True)

    def set_asset_job_message(
        self,
        project_id: str,
        asset_id: str,
        message: str | None,
        *,
        status: AssetStatus | None = None,
    ) -> Asset:
        """Update progress text for a long-running asset job (best-effort)."""
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            if status is not None:
                asset.status = status
            asset.job_message = (message or "").strip()[:240] or None
            if status == AssetStatus.PROCESSING:
                asset.error = None
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset.model_copy(deep=True)

    def update_asset(
        self,
        project_id: str,
        asset_id: str,
        *,
        apply_logo: bool | None = None,
        group: str | None = None,
        name: str | None = None,
        description: str | None = None,
        post_id: str | None = None,
        set_post_id: bool = False,
    ) -> Asset:
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            self._recover_orphan_assets(project)
            asset = self._find_asset(project, asset_id)
            if apply_logo is not None and is_processable_image(asset.type):
                asset.apply_logo = apply_logo
                asset.status = AssetStatus.PENDING
            if group is not None:
                asset.group = str(group).strip()[:80]
                if asset.group:
                    self._ensure_group_name(project, asset.group)
            if name is not None:
                cleaned = str(name).strip()[:120]
                if cleaned:
                    asset.name = cleaned
            if description is not None:
                asset.description = " ".join(str(description).split()).strip()[:500]
            if set_post_id:
                owner = (post_id or "").strip() or None
                if owner:
                    if not self._post_file(project_id, owner).exists():
                        raise ValueError(f"Post not found: {owner}")
                asset.post_id = owner
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset

    def set_asset_description(self, project_id: str, asset_id: str, description: str) -> Asset:
        """Persist an AI (or manual) catalog description without other side effects."""
        cleaned = " ".join(str(description or "").split()).strip()[:500]
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            asset.description = cleaned
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset.model_copy(deep=True)

    def delete_asset(self, project_id: str, asset_id: str) -> Project:
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            self._find_asset(project, asset_id)
            project.assets = [a for a in project.assets if a.id != asset_id]
            for kind in LOGO_KINDS:
                if getattr(project, _logo_asset_id_attr(kind), None) == asset_id:
                    setattr(project, _logo_asset_id_attr(kind), None)
                    setattr(project, _logo_path_attr(kind), None)
            self._unlink_asset_from_posts(project_id, asset_id)
            asset_dir = self._asset_dir(project_id, asset_id)
            if asset_dir.exists():
                shutil.rmtree(asset_dir)
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return self._load_project_file(self._project_file(project_id))

    def _unlink_asset_from_posts(self, project_id: str, asset_id: str) -> None:
        """Clear layer/background/music references to a deleted asset."""
        for post in self._load_posts(project_id):
            changed = False
            if post.background_asset_id == asset_id:
                post.background_asset_id = None
                changed = True
            if post.music_asset_id == asset_id:
                post.music_asset_id = None
                changed = True
            for scene in post.scenes:
                if scene.background_asset_id == asset_id:
                    scene.background_asset_id = None
                    changed = True
                for layer in scene.layers:
                    if layer.asset_id == asset_id:
                        layer.asset_id = None
                        changed = True
            if changed:
                post.updated_at = _now_iso()
                self._save_post(project_id, post)

    def get_asset(self, project_id: str, asset_id: str) -> Asset:
        project = self.get_project(project_id)
        return self._find_asset(project, asset_id)

    def resolve_asset_path(self, project_id: str, rel_path: str) -> Path:
        """Resolve a project-relative asset path. Absolute / escaping paths are rejected."""
        raw = str(rel_path or "").strip().replace("\\", "/")
        if not raw or raw.startswith("/") or Path(raw).is_absolute():
            raise ValueError("Asset path must be relative to the project directory.")
        if ".." in Path(raw).parts:
            raise ValueError("Path escapes project directory.")
        pdir = self._project_dir(project_id)
        candidate = (pdir / raw).resolve()
        try:
            candidate.relative_to(pdir.resolve())
        except ValueError as exc:
            raise ValueError("Path escapes project directory.") from exc
        return candidate

    def _crypto_key(self) -> bytes:
        return asset_crypto.load_or_create_key(self.cfg.cache_dir)

    def read_media_bytes(self, project_id: str, rel_path: str) -> bytes:
        """Read asset bytes, decrypting locked ``.csasset`` files when needed."""
        path = self.resolve_asset_path(project_id, rel_path)
        if not path.is_file():
            raise FileNotFoundError(f"Asset file not found: {rel_path}")
        return asset_crypto.read_maybe_encrypted(path, self._crypto_key())

    def media_suffix_for_asset(self, asset: Asset, rel_path: str | None = None) -> str:
        """Best-effort plaintext extension for materializing encrypted media."""
        rel = (rel_path or asset.original_path or "").replace("\\", "/")
        name = Path(rel).name
        if name.endswith(".csasset") or Path(name).suffix.lower() == ".csasset":
            if "processed/" in rel.replace("\\", "/"):
                return ".jpg"
            ext = Path(asset.original_filename or "").suffix.lower()
            if ext and ext != ".csasset":
                return ext
            if is_video_asset(asset.type):
                return ".mp4"
            if is_audio_asset(asset.type):
                return ".mp3"
            return ".jpg"
        ext = Path(name).suffix.lower()
        return ext if ext else ".bin"

    def materialize_media_path(
        self,
        project_id: str,
        rel_path: str,
        *,
        suffix: str | None = None,
    ) -> Path:
        """Return a filesystem path to plaintext media (cached decrypt for locked files)."""
        path = self.resolve_asset_path(project_id, rel_path)
        if not path.is_file():
            raise FileNotFoundError(f"Asset file not found: {rel_path}")
        raw = path.read_bytes()
        if not asset_crypto.is_encrypted_blob(raw):
            return path
        plain = asset_crypto.decrypt_bytes(raw, self._crypto_key())
        ext = suffix or Path(rel_path).suffix.lower()
        if not ext or ext == ".csasset":
            ext = ".bin"
        digest = hashlib.sha256(
            f"{path.resolve()}:{path.stat().st_mtime_ns}:{len(plain)}".encode()
        ).hexdigest()[:24]
        out_dir = Path(self.cfg.cache_dir).resolve() / "decrypted"
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"{digest}{ext}"
        if not out.is_file() or out.stat().st_size != len(plain):
            out.write_bytes(plain)
            try:
                out.chmod(0o600)
            except OSError:
                pass
        return out

    def materialize_asset(
        self,
        project_id: str,
        asset: Asset,
        *,
        rel_path: str | None = None,
    ) -> Path:
        """Materialize an asset (or one of its format paths) to a plaintext file path."""
        rel = rel_path or asset.original_path
        suffix = self.media_suffix_for_asset(asset, rel)
        return self.materialize_media_path(project_id, rel, suffix=suffix)

    def resolve_logos_for_project(self, project_id: str):
        """Watermark logos: project dark/light × short/full when set, else app defaults."""
        from .pipeline import logos_from_variant_paths, resolve_logos

        project = self.get_project(project_id)
        pdir = self._project_dir(project_id)

        def _abs(rel: str | None) -> Path | None:
            if not rel:
                return None
            path = pdir / rel
            return path if path.exists() else None

        project_logos = logos_from_variant_paths(
            dark_short=_abs(project.logo_dark_short_path),
            dark_full=_abs(project.logo_dark_full_path),
            light_short=_abs(project.logo_light_short_path),
            light_full=_abs(project.logo_light_full_path),
        )
        if project_logos is not None:
            return project_logos
        return resolve_logos(self.cfg)

    def set_project_logo(
        self,
        project_id: str,
        kind: str,
        filename: str,
        data: bytes,
    ) -> Project:
        """Upload a logo as a project asset and record its path in config."""
        kind = str(kind or "").strip().lower().replace("-", "_")
        if kind not in LOGO_KINDS:
            raise ValueError(
                "kind must be one of: dark_short, dark_full, light_short, light_full"
            )
        if not data:
            raise ValueError("Empty file.")
        ext = Path(filename).suffix.lower() or ".png"
        if ext not in IMAGE_EXT:
            raise ValueError(f"Unsupported logo type: {filename}")

        label = LOGO_KIND_LABELS[kind]
        safe_name = f"logo_{kind}{ext}"
        asset = self.add_asset(
            project_id,
            safe_name,
            data,
            apply_logo=False,
            group=BRANDING_GROUP,
        )

        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            self._recover_orphan_assets(project)
            stored = self._find_asset(project, asset.id)
            stored.name = label
            stored.group = BRANDING_GROUP
            stored.apply_logo = False
            stored.status = AssetStatus.READY
            stored.error = None
            # Library thumb so logos appear and can be reused as layers/backgrounds.
            original = self._project_dir(project_id) / stored.original_path
            thumb = _write_thumb_from_original(
                self._asset_dir(project_id, stored.id), stored.id, original
            )
            if thumb:
                stored.processed_formats = {**(stored.processed_formats or {}), "thumb": thumb}
            stored.updated_at = _now_iso()
            setattr(project, _logo_asset_id_attr(kind), stored.id)
            setattr(project, _logo_path_attr(kind), stored.original_path)
            self._ensure_group_name(project, BRANDING_GROUP)
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return project

    def clear_project_logos(
        self,
        project_id: str,
        *,
        clear_dark_short: bool = False,
        clear_dark_full: bool = False,
        clear_light_short: bool = False,
        clear_light_full: bool = False,
    ) -> Project:
        """Clear logo config references. Assets remain in the library."""
        flags = {
            "dark_short": clear_dark_short,
            "dark_full": clear_dark_full,
            "light_short": clear_light_short,
            "light_full": clear_light_full,
        }
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            for kind, should_clear in flags.items():
                if should_clear:
                    setattr(project, _logo_asset_id_attr(kind), None)
                    setattr(project, _logo_path_attr(kind), None)
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return project

    def process_asset(self, project_id: str, asset_id: str) -> Asset:
        """Process an image asset into Instagram formats + thumbnail (sync)."""
        from .cache import DecisionCache
        from .pipeline import process_one
        from .router import PlacementRouter

        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            self._recover_orphan_assets(project)
            asset = self._find_asset(project, asset_id)
            if not is_processable_image(asset.type):
                return asset
            asset.status = AssetStatus.PROCESSING
            asset.error = None
            asset.updated_at = _now_iso()
            apply_logo = asset.apply_logo
            original_filename = asset.original_filename
            locked = bool(asset.locked)
            original_rel = asset.original_path
            asset_snapshot = asset.model_copy(deep=True)
            self._save_project_meta(project)

        asset_dir = self._asset_dir(project_id, asset_id)
        src = asset_dir / Path(original_rel).name
        # Prefer the on-disk original.* if path drifted
        if not src.exists():
            found = list(asset_dir.glob("original.*"))
            if found:
                src = found[0]
        if locked or asset_crypto.is_encrypted_file(src):
            src = self.materialize_asset(project_id, asset_snapshot)
        processed_dir = asset_dir / "processed"
        if processed_dir.exists():
            shutil.rmtree(processed_dir)
        processed_dir.mkdir(parents=True)

        logos = self.resolve_logos_for_project(project_id) if apply_logo else None
        cache = DecisionCache(self.cfg.cache_dir / "decisions.jsonl")
        router = PlacementRouter(self.cfg, cache=cache)

        formats: dict[str, str] = {}
        error: str | None = None
        status = AssetStatus.READY
        try:
            process_one(
                src,
                self.cfg,
                processed_dir,
                logos=logos if apply_logo else None,
                router=router,
                source_rel=original_filename,
                quiet=True,
                apply_logo=apply_logo,
            )
            formats = {
                fmt: str(Path("assets") / asset_id / "processed" / f"{fmt}.jpg")
                for fmt in self.cfg.formats
                if (processed_dir / f"{fmt}.jpg").exists()
            }
            thumb_rel = _write_thumb(processed_dir, asset_id)
            if thumb_rel:
                formats["thumb"] = thumb_rel
            if locked:
                key = self._crypto_key()
                encrypted_formats: dict[str, str] = {}
                for fmt, rel in formats.items():
                    plain_path = self.resolve_asset_path(project_id, rel)
                    if not plain_path.is_file():
                        continue
                    plain = plain_path.read_bytes()
                    enc_name = f"{Path(rel).stem}.csasset"
                    enc_path = plain_path.with_name(enc_name)
                    asset_crypto.write_encrypted(enc_path, plain, key)
                    plain_path.unlink(missing_ok=True)
                    encrypted_formats[fmt] = str(
                        Path("assets") / asset_id / "processed" / enc_name
                    )
                formats = encrypted_formats
            if not any(k != "thumb" for k in formats):
                status = AssetStatus.FAILED
                error = "Processing produced no output formats"
            else:
                status = AssetStatus.READY
                error = None
        except Exception as exc:  # noqa: BLE001 — surface to UI
            status = AssetStatus.FAILED
            error = str(exc)
            formats = {}

        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            asset = self._find_asset(project, asset_id)
            asset.processed_formats = formats
            asset.status = status
            asset.error = error
            asset.updated_at = _now_iso()
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return asset

    def process_pending_assets(self, project_id: str) -> list[Asset]:
        project = self.get_project(project_id)
        results: list[Asset] = []
        for asset in project.assets:
            if is_processable_image(asset.type) and asset.status in {
                AssetStatus.PENDING,
                AssetStatus.FAILED,
                AssetStatus.PROCESSING,  # recover stuck mid-process statuses
            }:
                results.append(self.process_asset(project_id, asset.id))
        return results

    def _find_asset(self, project: Project, asset_id: str) -> Asset:
        for asset in project.assets:
            if asset.id == asset_id:
                return asset
        raise FileNotFoundError(f"Asset not found: {asset_id}")

    def _load_posts(self, project_id: str) -> list[Post]:
        posts_dir = self._posts_dir(project_id)
        if not posts_dir.exists():
            return []
        posts: list[Post] = []
        for pdir in sorted(posts_dir.iterdir()):
            if not pdir.is_dir():
                continue
            pfile = pdir / "post.json"
            if not pfile.exists():
                continue
            try:
                posts.append(Post.model_validate(json.loads(pfile.read_text(encoding="utf-8"))))
            except (json.JSONDecodeError, OSError, ValueError):
                continue
        from .render import sync_ref_scene_metadata

        for post in posts:
            sync_ref_scene_metadata(self, project_id, post)
        return sorted(posts, key=lambda p: p.updated_at, reverse=True)

    def _migrate_legacy_project(self, path: Path, data: dict) -> Project:
        """Convert singular post + type into posts/<id>/post.json layout."""
        project_id = str(data.get("id") or path.parent.name)
        name = str(data.get("name") or project_id)
        assets_raw = data.get("assets") or []
        assets = [Asset.model_validate(a) for a in assets_raw]

        legacy_type = data.get("type") or "image"
        try:
            ptype = ProjectType(legacy_type)
        except ValueError:
            ptype = ProjectType.IMAGE

        post_body = data.get("post") or {}
        post = Post(
            id=new_id(),
            name=name,
            type=ptype,
            created_at=str(data.get("created_at") or _now_iso()),
            updated_at=str(data.get("updated_at") or _now_iso()),
            target_format=str(post_body.get("target_format") or "portrait"),
            background_asset_id=post_body.get("background_asset_id"),
            background_format=str(post_body.get("background_format") or "portrait"),
            layers=[*[]],
            scenes=[],
            music_asset_id=post_body.get("music_asset_id"),
            music_volume=float(post_body.get("music_volume") or 0.8),
        )
        # Re-validate layers/scenes via Post model merge
        merged = {**post_body, "id": post.id, "name": post.name, "type": ptype.value,
                  "created_at": post.created_at, "updated_at": post.updated_at}
        post = Post.model_validate(merged)

        project = Project(
            id=project_id,
            name=name,
            created_at=str(data.get("created_at") or _now_iso()),
            updated_at=str(data.get("updated_at") or _now_iso()),
            assets=assets,
            posts=[post],
        )
        (path.parent / "posts").mkdir(exist_ok=True)
        (path.parent / "assets").mkdir(exist_ok=True)
        self._save_post(project_id, post)
        self._save_project_meta(project)
        return self._load_project_file(path)

    def _load_project_file(self, path: Path) -> Project:
        data = json.loads(path.read_text(encoding="utf-8"))
        # Legacy: singular post + type on project
        if "post" in data and "type" in data and "posts" not in data:
            return self._migrate_legacy_project(path, data)

        project_id = str(data.get("id") or path.parent.name)
        assets = [Asset.model_validate(a) for a in (data.get("assets") or [])]
        groups = [str(g).strip() for g in (data.get("asset_groups") or []) if str(g).strip()]
        # Recover groups from assets for older project.json files.
        for a in assets:
            g = (a.group or "").strip()
            if g and g.casefold() not in {x.casefold() for x in groups}:
                groups.append(g)
        groups = sorted(groups, key=lambda g: g.casefold())
        folders = self._monitored_folders_from_data(data)
        project = Project(
            id=project_id,
            name=str(data.get("name") or project_id),
            created_at=str(data.get("created_at") or _now_iso()),
            updated_at=str(data.get("updated_at") or _now_iso()),
            assets=assets,
            posts=[],
            asset_groups=groups,
            monitored_folders=folders,
            **self._logo_fields_from_data(data),
        )
        project.posts = self._load_posts(project_id)
        return project

    @staticmethod
    def _monitored_folders_from_data(data: dict) -> list[ProjectMediaFolder]:
        raw = data.get("monitored_folders") or []
        folders: list[ProjectMediaFolder] = []
        if not isinstance(raw, list):
            return folders
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                folders.append(ProjectMediaFolder.model_validate(item))
            except (ValueError, TypeError):
                continue
        return folders

    def list_monitored_folders(self, project_id: str) -> list[ProjectMediaFolder]:
        project = self.get_project(project_id)
        return list(project.monitored_folders or [])

    def set_monitored_folders(
        self, project_id: str, folders: list[ProjectMediaFolder]
    ) -> list[ProjectMediaFolder]:
        with _locked_project(project_id):
            project = self._load_project_file(self._project_file(project_id))
            project.monitored_folders = list(folders)
            project.updated_at = _now_iso()
            self._save_project_meta(project)
            return list(project.monitored_folders)

    def get_monitored_folder(self, project_id: str, folder_id: str) -> ProjectMediaFolder:
        for folder in self.list_monitored_folders(project_id):
            if folder.id == folder_id:
                return folder
        raise FileNotFoundError(f"Monitored folder not found: {folder_id}")

    @staticmethod
    def _logo_fields_from_data(data: dict) -> dict:
        """Load four logo slots; migrate legacy short/full → dark_short/dark_full."""
        fields: dict[str, str | None] = {}
        for kind in LOGO_KINDS:
            aid_key = _logo_asset_id_attr(kind)
            path_key = _logo_path_attr(kind)
            aid = data.get(aid_key)
            path = data.get(path_key)
            fields[aid_key] = (str(aid).strip() or None) if aid else None
            fields[path_key] = (str(path).strip() or None) if path else None

        # Legacy: logo_short / logo_full → dark_short / dark_full when new fields empty.
        if not fields["logo_dark_short_path"] and data.get("logo_short_path"):
            fields["logo_dark_short_path"] = str(data["logo_short_path"]).strip() or None
            legacy_aid = data.get("logo_short_asset_id")
            fields["logo_dark_short_asset_id"] = (
                (str(legacy_aid).strip() or None) if legacy_aid else None
            )
        if not fields["logo_dark_full_path"] and data.get("logo_full_path"):
            fields["logo_dark_full_path"] = str(data["logo_full_path"]).strip() or None
            legacy_aid = data.get("logo_full_asset_id")
            fields["logo_dark_full_asset_id"] = (
                (str(legacy_aid).strip() or None) if legacy_aid else None
            )
        return fields

    def _save_project_meta(self, project: Project) -> None:
        """Persist project.json without embedding full post bodies."""
        pfile = self._project_file(project.id)
        payload = {
            "id": project.id,
            "name": project.name,
            "created_at": project.created_at,
            "updated_at": project.updated_at,
            "assets": [a.model_dump(mode="json") for a in project.assets],
            "asset_groups": list(project.asset_groups or []),
            "monitored_folders": [f.model_dump(mode="json") for f in (project.monitored_folders or [])],
        }
        for kind in LOGO_KINDS:
            payload[_logo_asset_id_attr(kind)] = getattr(project, _logo_asset_id_attr(kind))
            payload[_logo_path_attr(kind)] = getattr(project, _logo_path_attr(kind))
        pfile.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _save_post(self, project_id: str, post: Post) -> None:
        pdir = self._post_dir(project_id, post.id)
        pdir.mkdir(parents=True, exist_ok=True)
        (pdir / "exports").mkdir(exist_ok=True)
        self._post_file(project_id, post.id).write_text(
            post.model_dump_json(indent=2), encoding="utf-8"
        )
