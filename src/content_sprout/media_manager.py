"""Media Manager helpers: monitored folder listing + assisted stock publish packages."""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from .config import MonitoredFolder, PublishPlatform
from .projects import detect_asset_type

PublishStatus = Literal["draft", "opened", "submitted"]

_HIDDEN_PREFIXES = (".",)


def _is_hidden(path: Path) -> bool:
    return any(part.startswith(_HIDDEN_PREFIXES) for part in path.parts)


def _iso_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def resolve_folder_root(folder: MonitoredFolder, *, base_dir: Path | None = None) -> Path:
    """Resolve a monitored folder path to an absolute directory."""
    raw = (folder.path or "").strip()
    if not raw:
        raise ValueError("Folder path is empty.")
    p = Path(raw).expanduser()
    if not p.is_absolute() and base_dir is not None:
        p = (base_dir / p).resolve()
    else:
        p = p.resolve()
    if not p.exists():
        raise ValueError(f"Folder does not exist: {p}")
    if not p.is_dir():
        raise ValueError(f"Path is not a directory: {p}")
    return p


def browse_roots() -> list[dict[str, str]]:
    """Common starting locations for the folder picker (local app)."""
    home = Path.home().resolve()
    roots: list[tuple[str, Path]] = [
        ("Home", home),
        ("Desktop", home / "Desktop"),
        ("Documents", home / "Documents"),
        ("Downloads", home / "Downloads"),
        ("Pictures", home / "Pictures"),
        ("Movies", home / "Movies"),
    ]
    if Path("/Volumes").is_dir():
        roots.append(("Volumes", Path("/Volumes")))
    if Path("/").is_dir():
        roots.append(("Root", Path("/")))

    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for label, path in roots:
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if not resolved.is_dir():
            continue
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        out.append({"label": label, "path": key})
    return out


def browse_directories(path: str | None = None) -> dict[str, Any]:
    """List immediate child directories under `path` for a folder picker UI.

    When `path` is empty, starts at the user home directory.
    """
    raw = (path or "").strip()
    if not raw:
        current = Path.home().resolve()
    else:
        current = Path(raw).expanduser()
        try:
            current = current.resolve()
        except OSError as exc:
            raise ValueError(f"Cannot resolve path: {raw}") from exc

    if not current.exists():
        raise ValueError(f"Folder does not exist: {current}")
    if not current.is_dir():
        raise ValueError(f"Path is not a directory: {current}")

    parent = current.parent if current.parent != current else None
    children: list[dict[str, Any]] = []
    try:
        entries = sorted(current.iterdir(), key=lambda p: p.name.casefold())
    except PermissionError as exc:
        raise ValueError(f"Permission denied: {current}") from exc
    except OSError as exc:
        raise ValueError(f"Cannot read folder: {current}") from exc

    for entry in entries:
        name = entry.name
        if name.startswith("."):
            continue
        try:
            if not entry.is_dir():
                continue
            # Skip inaccessible dirs without failing the whole listing
            if not os_access_dir(entry):
                continue
            children.append(
                {
                    "name": name,
                    "path": str(entry.resolve()),
                }
            )
        except OSError:
            continue

    return {
        "path": str(current),
        "name": current.name or str(current),
        "parent": str(parent) if parent is not None else None,
        "directories": children,
        "roots": browse_roots(),
    }


def os_access_dir(path: Path) -> bool:
    """True when the process can list the directory (best-effort)."""
    import os

    try:
        return os.access(path, os.R_OK | os.X_OK)
    except OSError:
        return False


def safe_resolve_under(root: Path, rel: str) -> Path:
    """Resolve `rel` under `root`, refusing path traversal."""
    root = root.resolve()
    candidate = (root / (rel or ".")).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("Path escapes monitored folder.") from exc
    return candidate


def list_media_files(
    root: Path,
    *,
    query: str = "",
    media_type: str = "all",
) -> list[dict[str, Any]]:
    """Flat list of media files under `root` (image/video/audio via detect_asset_type)."""
    if not root.exists() or not root.is_dir():
        return []
    q = (query or "").strip().casefold()
    mt = (media_type or "all").strip().lower()
    if mt not in {"all", "image", "video", "audio"}:
        mt = "all"

    entries: list[dict[str, Any]] = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        try:
            rel = p.relative_to(root)
        except ValueError:
            continue
        if _is_hidden(rel):
            continue
        asset_type = detect_asset_type(p.name)
        if asset_type is None:
            continue
        type_name = asset_type.value if hasattr(asset_type, "value") else str(asset_type)
        if mt != "all" and type_name != mt:
            continue
        if q and q not in p.name.casefold() and q not in str(rel).casefold():
            continue
        stat = p.stat()
        entries.append(
            {
                "path": str(rel).replace("\\", "/"),
                "name": p.name,
                "type": type_name,
                "size": stat.st_size,
                "size_human": _human_size(stat.st_size),
                "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "suffix": p.suffix.lower(),
            }
        )
    return entries


def publish_root(cache_dir: Path) -> Path:
    root = Path(cache_dir).resolve() / "media_publish"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _index_path(cache_dir: Path) -> Path:
    return publish_root(cache_dir) / "index.json"


def load_package_index(cache_dir: Path) -> list[dict[str, Any]]:
    path = _index_path(cache_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def save_package_index(cache_dir: Path, items: list[dict[str, Any]]) -> None:
    path = _index_path(cache_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, indent=2), encoding="utf-8")


def get_package(cache_dir: Path, package_id: str) -> dict[str, Any] | None:
    for item in load_package_index(cache_dir):
        if item.get("id") == package_id:
            return item
    return None


def update_package(
    cache_dir: Path,
    package_id: str,
    *,
    status: PublishStatus | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    items = load_package_index(cache_dir)
    found: dict[str, Any] | None = None
    for item in items:
        if item.get("id") == package_id:
            if status is not None:
                item["status"] = status
            if extra:
                item.update(extra)
            item["updated_at"] = _iso_now()
            found = item
            # Keep metadata.json in sync when present
            pkg_dir = Path(item.get("package_dir") or "")
            meta_path = pkg_dir / "metadata.json" if pkg_dir else None
            if meta_path and meta_path.is_file():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    if isinstance(meta, dict):
                        meta["status"] = item.get("status")
                        meta["updated_at"] = item.get("updated_at")
                        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
                except (OSError, json.JSONDecodeError):
                    pass
            break
    if found is None:
        raise ValueError(f"Publish package not found: {package_id}")
    save_package_index(cache_dir, items)
    return found


def create_publish_package(
    cache_dir: Path,
    sources: list[tuple[Path, str]],
    platforms: list[PublishPlatform],
    *,
    title: str = "",
    description: str = "",
    tags: list[str] | None = None,
    folder_id: str = "",
) -> dict[str, Any]:
    """Copy selected files into cache/media_publish/<id>/ and register in index.

    `sources` is a list of (absolute_file_path, relative_display_path).
    """
    if not sources:
        raise ValueError("Select at least one file to publish.")
    if not platforms:
        raise ValueError("Select at least one publish platform.")

    package_id = uuid4().hex[:12]
    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    pkg_dir = publish_root(cache_dir) / f"{stamp}_{package_id}"
    files_dir = pkg_dir / "files"
    files_dir.mkdir(parents=True, exist_ok=True)

    copied: list[dict[str, Any]] = []
    used_names: set[str] = set()
    for src, rel in sources:
        src = Path(src)
        if not src.is_file():
            raise ValueError(f"File not found: {src}")
        base = src.name
        name = base
        n = 1
        while name.casefold() in used_names:
            stem = Path(base).stem
            suffix = Path(base).suffix
            name = f"{stem}_{n}{suffix}"
            n += 1
        used_names.add(name.casefold())
        dest = files_dir / name
        shutil.copy2(src, dest)
        asset_type = detect_asset_type(name)
        copied.append(
            {
                "name": name,
                "source_path": str(rel).replace("\\", "/"),
                "type": (
                    asset_type.value if asset_type is not None and hasattr(asset_type, "value") else None
                ),
                "size": dest.stat().st_size,
            }
        )

    tag_list = [str(t).strip() for t in (tags or []) if str(t).strip()]
    platform_payload = [
        {
            "id": p.id,
            "label": p.label,
            "contributor_url": p.contributor_url,
        }
        for p in platforms
    ]
    now = _iso_now()
    metadata = {
        "id": package_id,
        "status": "draft",
        "title": (title or "").strip()[:200],
        "description": (description or "").strip()[:2000],
        "tags": tag_list,
        "folder_id": folder_id,
        "platforms": platform_payload,
        "files": copied,
        "created_at": now,
        "updated_at": now,
        "package_dir": str(pkg_dir),
    }
    (pkg_dir / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    readme_lines = [
        "Content-Sprout stock publish package",
        "====================================",
        "",
        f"Title: {metadata['title'] or '(untitled)'}",
        f"Description: {metadata['description'] or '(none)'}",
        f"Tags: {', '.join(tag_list) if tag_list else '(none)'}",
        "",
        "Platforms (open these contributor portals and upload files from ./files/):",
    ]
    for p in platform_payload:
        readme_lines.append(f"  - {p['label']}: {p['contributor_url'] or '(no URL configured)'}")
    readme_lines.extend(["", "Files:", *[f"  - {f['name']} ({f['source_path']})" for f in copied], ""])
    (pkg_dir / "README.txt").write_text("\n".join(readme_lines), encoding="utf-8")

    items = load_package_index(cache_dir)
    summary = {
        "id": package_id,
        "status": "draft",
        "title": metadata["title"],
        "description": metadata["description"],
        "tags": tag_list,
        "folder_id": folder_id,
        "platforms": platform_payload,
        "file_count": len(copied),
        "files": copied,
        "created_at": now,
        "updated_at": now,
        "package_dir": str(pkg_dir),
    }
    items.insert(0, summary)
    # Keep index bounded
    save_package_index(cache_dir, items[:100])
    return summary
