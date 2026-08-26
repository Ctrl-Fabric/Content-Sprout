"""ComfyUI client for text/image/video generation and upscale workflows."""

from __future__ import annotations

import copy
import io
import json
import mimetypes
import random
import shutil
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable, Literal

import httpx

from .config import ComfyUIConfig, comfy_workflow_name_for_op
from .local_ai_lock import local_ai_task

PACKAGE_WORKFLOWS_DIR = Path(__file__).resolve().parent / "workflows"
PACKAGE_CATALOG_PATH = PACKAGE_WORKFLOWS_DIR / "catalog.json"
PACKAGE_META_FILENAMES = frozenset({"catalog.json"})

# User-uploaded API workflows live under tools storage (self-contained copies).
TOOLS_COMFYUI_REL = Path("tools") / "comfyui"
USER_WORKFLOWS_REL = TOOLS_COMFYUI_REL / "workflows"
LEGACY_USER_WORKFLOWS_REL = Path("workflows")

WORKFLOW_BUNDLE_KIND = "content_sprout_comfyui_workflow_bundle"
WORKFLOW_BUNDLE_VERSION = 1
WORKFLOW_BUNDLE_MANIFEST = "manifest.json"
WORKFLOW_BUNDLE_WORKFLOWS_DIR = "workflows"

# class_type -> list of (input_key, role)
_MODEL_LOADER_KEYS: dict[str, list[tuple[str, str]]] = {
    "CheckpointLoaderSimple": [("ckpt_name", "checkpoint")],
    "CheckpointLoader": [("ckpt_name", "checkpoint")],
    "unCLIPCheckpointLoader": [("ckpt_name", "checkpoint")],
    "ImageOnlyCheckpointLoader": [("ckpt_name", "checkpoint")],
    "UNETLoader": [("unet_name", "unet")],
    "CLIPLoader": [("clip_name", "clip")],
    "DualCLIPLoader": [("clip_name1", "clip"), ("clip_name2", "clip")],
    "TripleCLIPLoader": [
        ("clip_name1", "clip"),
        ("clip_name2", "clip"),
        ("clip_name3", "clip"),
    ],
    "VAELoader": [("vae_name", "vae")],
    "LoraLoader": [("lora_name", "lora")],
    "LoraLoaderModelOnly": [("lora_name", "lora")],
    "UpscaleModelLoader": [("model_name", "upscale")],
    "ControlNetLoader": [("control_net_name", "controlnet")],
    "DiffControlNetLoader": [("control_net_name", "controlnet")],
    "StyleModelLoader": [("style_model_name", "style")],
    "GLIGENLoader": [("gligen_name", "gligen")],
    "HypernetworkLoader": [("hypernetwork_name", "hypernetwork")],
    "PhotoMakerLoader": [("photomaker_model_name", "photomaker")],
    "InstantIDModelLoader": [("instantid_file", "instantid")],
}

_MODEL_FILE_SUFFIXES = (
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".gguf",
    ".sft",
)

WorkflowOp = Literal[
    "text_to_image",
    "text_to_video",
    "image_to_video",
    "upscale_image",
    "upscale_video",
]

OP_LABELS: dict[str, str] = {
    "text_to_image": "Text → image",
    "text_to_video": "Text → video",
    "image_to_video": "Image → video",
    "upscale_image": "Upscale image",
    "upscale_video": "Upscale video",
}


def snap_wan_frames(frames: int) -> int:
    """Wan latent length should satisfy (length - 1) % 4 == 0."""
    n = max(1, int(frames))
    return ((n - 1) // 4) * 4 + 1


def load_package_catalog() -> dict[str, Any]:
    """Load packaged workflow catalog (defaults + metadata)."""
    if not PACKAGE_CATALOG_PATH.is_file():
        return {"version": 1, "defaults": {}, "workflows": {}}
    try:
        data = json.loads(PACKAGE_CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {"version": 1, "defaults": {}, "workflows": {}}
    if not isinstance(data, dict):
        return {"version": 1, "defaults": {}, "workflows": {}}
    defaults = data.get("defaults") if isinstance(data.get("defaults"), dict) else {}
    workflows = data.get("workflows") if isinstance(data.get("workflows"), dict) else {}
    return {
        "version": int(data.get("version") or 1),
        "defaults": {str(k): str(v).strip() for k, v in defaults.items() if str(v).strip()},
        "workflows": workflows,
    }


def package_default_stem_for_op(op: str) -> str:
    catalog = load_package_catalog()
    return str((catalog.get("defaults") or {}).get(op) or "").strip()


def package_workflow_meta(stem: str) -> dict[str, Any]:
    catalog = load_package_catalog()
    entry = (catalog.get("workflows") or {}).get(stem)
    if not isinstance(entry, dict):
        return {}
    return entry


def _as_json_name(name: str) -> str:
    raw = (name or "").strip()
    if not raw:
        return ""
    if raw.lower().endswith(".json"):
        return raw
    return f"{raw}.json"


def _is_package_meta_file(path: Path) -> bool:
    return path.name.lower() in PACKAGE_META_FILENAMES


def _looks_like_model_filename(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    name = value.strip()
    if not name or "/" in name.replace("\\", "/").split("/")[-1] and name.startswith("http"):
        return False
    lower = name.lower()
    return any(lower.endswith(suf) for suf in _MODEL_FILE_SUFFIXES)


def extract_model_requirements(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Scan an API-format workflow for model/checkpoint loader filenames."""
    found: dict[str, dict[str, Any]] = {}

    def add(
        *,
        filename: str,
        role: str,
        class_type: str,
        node_id: str,
        input_key: str,
        required: bool = True,
        notes: str = "",
    ) -> None:
        key = filename.strip()
        if not key:
            return
        existing = found.get(key)
        if existing:
            if role and role not in (existing.get("roles") or []):
                existing.setdefault("roles", []).append(role)
            existing.setdefault("nodes", []).append(
                {"node_id": node_id, "class_type": class_type, "input_key": input_key}
            )
            return
        found[key] = {
            "filename": key,
            "role": role or "model",
            "roles": [role or "model"],
            "required": bool(required),
            "notes": notes or "",
            "class_type": class_type,
            "nodes": [{"node_id": node_id, "class_type": class_type, "input_key": input_key}],
        }

    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        mapped = _MODEL_LOADER_KEYS.get(class_type)
        if mapped:
            for input_key, role in mapped:
                value = inputs.get(input_key)
                if isinstance(value, str) and value.strip():
                    add(
                        filename=value.strip(),
                        role=role,
                        class_type=class_type,
                        node_id=str(nid),
                        input_key=input_key,
                    )
            continue
        # Generic fallback: *_name / *_file string inputs that look like model files.
        for input_key, value in inputs.items():
            if _link_target(value) is not None:
                continue
            key_l = str(input_key).lower()
            if not (
                key_l.endswith("_name")
                or key_l.endswith("_file")
                or key_l.endswith("_model")
                or key_l in ("ckpt_name", "model_name", "lora_name")
            ):
                continue
            if _looks_like_model_filename(value):
                role = key_l.replace("_name", "").replace("_file", "").replace("_model", "") or "model"
                add(
                    filename=str(value).strip(),
                    role=role,
                    class_type=class_type or "Unknown",
                    node_id=str(nid),
                    input_key=str(input_key),
                )

    return sorted(found.values(), key=lambda m: (m.get("role") or "", m.get("filename") or ""))


def merge_model_requirements(
    scanned: list[dict[str, Any]],
    declared: list[Any] | None,
) -> list[dict[str, Any]]:
    """Merge catalog-declared models with scanned ones (declared wins on filename)."""
    by_name: dict[str, dict[str, Any]] = {}
    for item in scanned:
        name = str(item.get("filename") or "").strip()
        if name:
            by_name[name] = dict(item)
    for raw in declared or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("filename") or "").strip()
        if not name:
            continue
        base = by_name.get(name, {"filename": name, "roles": [], "nodes": []})
        role = str(raw.get("role") or base.get("role") or "model").strip() or "model"
        roles = list(base.get("roles") or [])
        if role not in roles:
            roles.insert(0, role)
        by_name[name] = {
            **base,
            "filename": name,
            "role": role,
            "roles": roles,
            "required": bool(raw.get("required", base.get("required", True))),
            "notes": str(raw.get("notes") or base.get("notes") or ""),
            "class_type": str(raw.get("class_type") or base.get("class_type") or ""),
            "nodes": list(base.get("nodes") or []),
            "declared": True,
        }
    return sorted(by_name.values(), key=lambda m: (m.get("role") or "", m.get("filename") or ""))


def build_workflow_graph(workflow: dict[str, Any]) -> dict[str, Any]:
    """Build a simple layered graph for UI visualization from API-format JSON."""
    nodes_out: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    indegree: dict[str, int] = {}
    adjacency: dict[str, list[str]] = {}

    for nid, node in workflow.items():
        if not isinstance(node, dict) or "class_type" not in node:
            continue
        sid = str(nid)
        indegree.setdefault(sid, 0)
        adjacency.setdefault(sid, [])

    for nid, node in workflow.items():
        if not isinstance(node, dict) or "class_type" not in node:
            continue
        sid = str(nid)
        class_type = str(node.get("class_type") or "")
        title = node_title(node) or default_node_title(class_type) or class_type
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        model_files = [
            str(v).strip()
            for k, v in inputs.items()
            if isinstance(v, str) and _looks_like_model_filename(v)
        ]
        is_loader = class_type in _MODEL_LOADER_KEYS or bool(model_files)
        nodes_out.append(
            {
                "id": sid,
                "class_type": class_type,
                "title": title,
                "is_model_loader": is_loader,
                "models": model_files,
            }
        )
        for input_key, value in inputs.items():
            link = _link_target(value)
            if link is None:
                continue
            src, slot = link
            src_s = str(src)
            if src_s not in indegree:
                continue
            edges.append(
                {
                    "from": src_s,
                    "to": sid,
                    "input_key": str(input_key),
                    "slot": slot,
                }
            )
            adjacency.setdefault(src_s, []).append(sid)
            indegree[sid] = indegree.get(sid, 0) + 1

    # Kahn layering for left-to-right layout.
    layer_of: dict[str, int] = {}
    ready = [n for n, d in indegree.items() if d == 0]
    ready.sort()
    remaining = dict(indegree)
    while ready:
        current_layer = list(ready)
        ready = []
        for nid in current_layer:
            layer_of[nid] = layer_of.get(nid, 0)
            for nxt in adjacency.get(nid, []):
                remaining[nxt] = remaining.get(nxt, 1) - 1
                if remaining[nxt] <= 0 and nxt not in layer_of:
                    layer_of[nxt] = layer_of[nid] + 1
                    ready.append(nxt)
        ready.sort()

    # Orphans / cycles: assign remaining nodes.
    max_layer = max(layer_of.values(), default=0)
    for nid in indegree:
        if nid not in layer_of:
            max_layer += 1
            layer_of[nid] = max_layer

    columns: dict[int, list[str]] = {}
    for nid, layer in layer_of.items():
        columns.setdefault(layer, []).append(nid)
    for layer in columns:
        columns[layer].sort()

    node_w, node_h = 168, 56
    gap_x, gap_y = 56, 28
    positions: dict[str, dict[str, float]] = {}
    for layer, ids in sorted(columns.items()):
        for row, nid in enumerate(ids):
            positions[nid] = {
                "x": layer * (node_w + gap_x),
                "y": row * (node_h + gap_y),
            }

    for node in nodes_out:
        pos = positions.get(node["id"], {"x": 0.0, "y": 0.0})
        node["x"] = pos["x"]
        node["y"] = pos["y"]
        node["layer"] = layer_of.get(node["id"], 0)

    width = max((n["x"] + node_w for n in nodes_out), default=node_w) + 24
    height = max((n["y"] + node_h for n in nodes_out), default=node_h) + 24
    return {
        "nodes": nodes_out,
        "edges": edges,
        "node_width": node_w,
        "node_height": node_h,
        "width": width,
        "height": height,
    }


def resolve_named_workflow(
    cfg: ComfyUIConfig,
    name: str,
    *,
    config_dir: Path | None = None,
    allow_missing: bool = False,
) -> Path | None:
    """Resolve a short workflow stem to a JSON file in app storage."""
    raw = (name or "").strip()
    if not raw:
        return None

    filename = _as_json_name(Path(raw).name)
    search_dirs: list[Path] = []
    if config_dir is not None:
        search_dirs.append(resolve_workflows_dir(cfg, config_dir=config_dir))
    search_dirs.append(PACKAGE_WORKFLOWS_DIR)

    for folder in search_dirs:
        cand = folder / filename
        if cand.is_file():
            return cand

    if allow_missing:
        return None
    raise FileNotFoundError(
        f"ComfyUI workflow not found: {raw} (looked in ContentSprout workflows storage)"
    )


def resolve_workflow_for_op(
    cfg: ComfyUIConfig,
    op: str,
    *,
    config_dir: Path | None = None,
) -> Path:
    """Resolve the workflow JSON for a generation/upscale operation.

    Preference order:
    1. Explicit Settings assignment
    2. Packaged default for the op (when that JSON exists under ``workflows/``)
    """
    name = comfy_workflow_name_for_op(cfg, op)
    if name:
        return resolve_named_workflow(cfg, name, config_dir=config_dir)  # type: ignore[return-value]

    default_stem = package_default_stem_for_op(op)
    if default_stem:
        path = resolve_named_workflow(
            cfg, default_stem, config_dir=config_dir, allow_missing=True
        )
        if path is not None:
            return path

    label = OP_LABELS.get(op, op)
    raise ValueError(
        f"Configure a workflow for “{label}” in Settings → ComfyUI media generation "
        f"(or add the packaged default {default_stem or op}.json)."
    )


def effective_workflow_stem_for_op(cfg: ComfyUIConfig, op: str) -> str:
    """Configured stem, else packaged default stem when that file exists."""
    name = comfy_workflow_name_for_op(cfg, op)
    if name:
        return name
    default_stem = package_default_stem_for_op(op)
    if not default_stem:
        return ""
    if (PACKAGE_WORKFLOWS_DIR / _as_json_name(default_stem)).is_file():
        return default_stem
    return ""


def default_ops_for_stem(stem: str) -> list[str]:
    """Operations that use this stem as their packaged default."""
    catalog = load_package_catalog()
    defaults = catalog.get("defaults") or {}
    return sorted(op for op, value in defaults.items() if str(value).strip() == stem)


def summarize_workflow_entry(
    path: Path,
    *,
    source: str,
) -> dict[str, Any]:
    """Build a list/detail summary for a workflow JSON file."""
    stem = path.stem
    meta = package_workflow_meta(stem) if source == "package" else {}
    title = str(meta.get("title") or stem)
    description = str(meta.get("description") or "")
    ops_meta = meta.get("ops") if isinstance(meta.get("ops"), list) else []
    ops = [str(o) for o in ops_meta if str(o).strip()]
    default_for = default_ops_for_stem(stem) if source == "package" else []
    if not ops and default_for:
        ops = list(default_for)

    models: list[dict[str, Any]] = []
    node_count = 0
    available = path.is_file()
    if available:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and not is_ui_workflow(data):
                node_count = sum(
                    1
                    for v in data.values()
                    if isinstance(v, dict) and "class_type" in v
                )
                scanned = extract_model_requirements(data)
                declared = meta.get("models") if isinstance(meta.get("models"), list) else []
                models = merge_model_requirements(scanned, declared)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            available = False

    if not models and isinstance(meta.get("models"), list):
        models = merge_model_requirements([], meta.get("models"))

    return {
        "stem": stem,
        "filename": path.name,
        "source": source,
        "title": title,
        "description": description,
        "ops": ops,
        "default_for": default_for,
        "models": models,
        "model_count": len(models),
        "node_count": node_count,
        "available": available,
    }


def workflow_details(
    cfg: ComfyUIConfig,
    stem: str,
    *,
    config_dir: Path | None = None,
) -> dict[str, Any]:
    """Full workflow detail payload including graph + model requirements."""
    name = Path(stem).stem
    path = resolve_named_workflow(cfg, name, config_dir=config_dir, allow_missing=True)
    source = "package"
    if path is None:
        # Catalog-only placeholder (file not added yet).
        meta = package_workflow_meta(name)
        if not meta and name not in (load_package_catalog().get("defaults") or {}).values():
            raise FileNotFoundError(f"ComfyUI workflow not found: {name}")
        summary = {
            "stem": name,
            "filename": _as_json_name(name),
            "source": "package",
            "title": str(meta.get("title") or name),
            "description": str(meta.get("description") or ""),
            "ops": [str(o) for o in (meta.get("ops") or []) if str(o).strip()],
            "default_for": default_ops_for_stem(name),
            "models": merge_model_requirements([], meta.get("models") if isinstance(meta.get("models"), list) else []),
            "model_count": 0,
            "node_count": 0,
            "available": False,
        }
        summary["model_count"] = len(summary["models"])
        return {
            **summary,
            "graph": {"nodes": [], "edges": [], "width": 320, "height": 120, "node_width": 168, "node_height": 56},
            "workflow": None,
        }

    user_dir = resolve_workflows_dir(cfg, config_dir=config_dir)
    try:
        source = "user" if path.resolve().parent.resolve() == user_dir.resolve() else "package"
    except OSError:
        source = "package"

    data = load_workflow(path)
    summary = summarize_workflow_entry(path, source=source)
    graph = build_workflow_graph(data)
    return {
        **summary,
        "graph": graph,
        "workflow": data,
    }


def resolve_tools_comfyui_dir(cfg: ComfyUIConfig, *, config_dir: Path | None = None) -> Path:
    """Root tools storage folder for ComfyUI assets (workflows, future caches)."""
    _ = cfg
    if config_dir is not None:
        path = (config_dir / TOOLS_COMFYUI_REL).expanduser()
    else:
        path = PACKAGE_WORKFLOWS_DIR.parent / "tools_comfyui"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _migrate_legacy_workflows_dir(config_dir: Path, dest: Path) -> None:
    """Copy legacy ``{config_dir}/workflows/*.json`` into tools storage once."""
    legacy = (config_dir / LEGACY_USER_WORKFLOWS_REL).expanduser()
    if not legacy.is_dir() or legacy.resolve() == dest.resolve():
        return
    for src in sorted(legacy.glob("*.json")):
        if not src.is_file():
            continue
        target = dest / src.name
        if target.exists():
            continue
        try:
            shutil.copy2(src, target)
        except OSError:
            continue


def resolve_workflows_dir(cfg: ComfyUIConfig, *, config_dir: Path | None = None) -> Path:
    """Directory where uploaded ComfyUI API workflows are stored (copied on upload).

    Path: ``{config_dir}/tools/comfyui/workflows/``. Legacy ``{config_dir}/workflows/``
    files are migrated into tools storage when present.
    """
    if config_dir is not None:
        path = (config_dir / USER_WORKFLOWS_REL).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        _migrate_legacy_workflows_dir(config_dir, path)
        return path
    path = PACKAGE_WORKFLOWS_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_ui_workflow(data: dict[str, Any]) -> bool:
    return isinstance(data, dict) and "nodes" in data and "links" in data


def list_stored_workflows(cfg: ComfyUIConfig, *, config_dir: Path | None = None) -> list[dict[str, Any]]:
    """List workflow JSON files available for assignment (user + packaged).

    Packaged catalog defaults that are not yet present on disk are included with
    ``available: false`` so the UI can show pending built-ins.
    """
    seen: set[str] = set()
    out: list[dict[str, Any]] = []

    def add(path: Path, *, source: str) -> None:
        if _is_package_meta_file(path):
            return
        stem = path.stem
        if stem in seen:
            return
        seen.add(stem)
        out.append(summarize_workflow_entry(path, source=source))

    folder = resolve_workflows_dir(cfg, config_dir=config_dir)
    for path in sorted(folder.glob("*.json")):
        if path.is_file():
            add(path, source="user")
    for path in sorted(PACKAGE_WORKFLOWS_DIR.glob("*.json")):
        if path.is_file():
            add(path, source="package")

    catalog = load_package_catalog()
    for stem in sorted((catalog.get("workflows") or {}).keys()):
        if stem in seen:
            continue
        # Pending packaged default — file not added yet.
        placeholder = PACKAGE_WORKFLOWS_DIR / _as_json_name(stem)
        entry = summarize_workflow_entry(placeholder, source="package")
        entry["available"] = False
        out.append(entry)
        seen.add(stem)

    # Prefer available workflows first, then title.
    out.sort(key=lambda e: (not e.get("available", True), e.get("title") or e.get("stem") or ""))
    return out


def save_workflow_upload(
    cfg: ComfyUIConfig,
    *,
    config_dir: Path | None,
    filename: str,
    raw_bytes: bytes,
) -> dict[str, str]:
    """Validate and store an uploaded API-format workflow JSON."""
    name = Path(filename).name
    if not name.lower().endswith(".json"):
        raise ValueError("Workflow file must be a .json file.")
    if ".." in name or "/" in name or "\\" in name:
        raise ValueError("Invalid workflow filename.")

    try:
        data = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Workflow is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("Workflow JSON must be an object.")

    if is_ui_workflow(data):
        raise ValueError(
            "This file is in ComfyUI editor format (has top-level \"nodes\" and \"links\"). "
            "Open it in ComfyUI and export/save as API format (a flat JSON object keyed by "
            "node id with class_type and inputs), then upload that file."
        )

    load_workflow_from_data(data)
    dest = resolve_workflows_dir(cfg, config_dir=config_dir) / name
    dest.write_bytes(raw_bytes)
    return {"stem": dest.stem, "filename": dest.name, "source": "user", "stored_path": str(dest)}


def _bundle_settings_snapshot(cfg: ComfyUIConfig) -> dict[str, Any]:
    """Non-secret ComfyUI generation defaults included in a portable bundle."""
    return {
        "workflow_text_to_image": (cfg.workflow_text_to_image or "").strip(),
        "workflow_text_to_video": (cfg.workflow_text_to_video or "").strip(),
        "workflow_image_to_video": (cfg.workflow_image_to_video or "").strip(),
        "workflow_upscale_image": (cfg.workflow_upscale_image or "").strip(),
        "workflow_upscale_video": (cfg.workflow_upscale_video or "").strip(),
        "workflow_input_config": copy.deepcopy(cfg.workflow_input_config or {}),
        "workflow_input_defaults": copy.deepcopy(cfg.workflow_input_defaults or {}),
        "width": int(cfg.width),
        "height": int(cfg.height),
        "frames": int(cfg.frames),
        "fps": float(cfg.fps),
        "steps": int(cfg.steps),
        "cfg": float(cfg.cfg),
        "negative_prompt": cfg.negative_prompt or "",
    }


def build_workflow_bundle_manifest(cfg: ComfyUIConfig, *, workflow_files: list[str]) -> dict[str, Any]:
    return {
        "kind": WORKFLOW_BUNDLE_KIND,
        "version": WORKFLOW_BUNDLE_VERSION,
        "workflows": sorted(workflow_files),
        "settings": _bundle_settings_snapshot(cfg),
    }


def export_workflow_bundle(
    cfg: ComfyUIConfig,
    *,
    config_dir: Path | None,
) -> bytes:
    """Zip user workflows + assignments / input defaults for download."""
    folder = resolve_workflows_dir(cfg, config_dir=config_dir)
    files = sorted(p for p in folder.glob("*.json") if p.is_file())
    manifest = build_workflow_bundle_manifest(cfg, workflow_files=[p.name for p in files])

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            WORKFLOW_BUNDLE_MANIFEST,
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        )
        for path in files:
            zf.write(path, arcname=f"{WORKFLOW_BUNDLE_WORKFLOWS_DIR}/{path.name}")
    return buf.getvalue()


def _safe_zip_member_name(name: str) -> str | None:
    """Return a basename-only zip member path, rejecting traversal."""
    raw = (name or "").replace("\\", "/").strip()
    if not raw or raw.endswith("/"):
        return None
    parts = [p for p in raw.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def _read_bundle_manifest(zf: zipfile.ZipFile) -> dict[str, Any]:
    try:
        raw = zf.read(WORKFLOW_BUNDLE_MANIFEST)
    except KeyError as exc:
        raise ValueError(
            f"Not a ContentSprout workflow bundle (missing {WORKFLOW_BUNDLE_MANIFEST})."
        ) from exc
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Bundle manifest is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("Bundle manifest must be a JSON object.")
    if data.get("kind") != WORKFLOW_BUNDLE_KIND:
        raise ValueError("Unrecognized workflow bundle kind.")
    version = data.get("version", 1)
    try:
        version_i = int(version)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid workflow bundle version.") from exc
    if version_i < 1 or version_i > WORKFLOW_BUNDLE_VERSION:
        raise ValueError(f"Unsupported workflow bundle version: {version}")
    return data


def import_workflow_bundle(
    cfg: ComfyUIConfig,
    *,
    config_dir: Path | None,
    raw_bytes: bytes,
    replace_existing: bool = False,
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Import a previously exported workflow zip into tools storage.

    Returns ``(settings_updates, imported_workflow_entries)``. Caller applies
    ``settings_updates`` via ``save_comfyui_settings``.
    """
    if not raw_bytes:
        raise ValueError("Empty workflow bundle.")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except zipfile.BadZipFile as exc:
        raise ValueError("File is not a valid zip archive.") from exc

    with zf:
        manifest = _read_bundle_manifest(zf)
        settings = manifest.get("settings")
        if settings is not None and not isinstance(settings, dict):
            raise ValueError("Bundle settings must be an object.")
        settings = settings if isinstance(settings, dict) else {}

        members: list[tuple[str, str]] = []
        for info in zf.infolist():
            if info.is_dir():
                continue
            safe = _safe_zip_member_name(info.filename)
            if safe is None:
                continue
            if safe == WORKFLOW_BUNDLE_MANIFEST:
                continue
            if not (
                safe.startswith(f"{WORKFLOW_BUNDLE_WORKFLOWS_DIR}/")
                or (safe.endswith(".json") and "/" not in safe)
            ):
                continue
            basename = Path(safe).name
            if not basename.lower().endswith(".json"):
                continue
            if ".." in basename or "/" in basename or "\\" in basename:
                continue
            members.append((info.filename, basename))

        if not members and not settings:
            raise ValueError("Workflow bundle contains no workflows or settings.")

        dest_dir = resolve_workflows_dir(cfg, config_dir=config_dir)
        if replace_existing:
            for existing in dest_dir.glob("*.json"):
                if existing.is_file():
                    existing.unlink(missing_ok=True)

        imported: list[dict[str, str]] = []
        seen: set[str] = set()
        for zip_name, basename in members:
            if basename in seen:
                continue
            seen.add(basename)
            raw = zf.read(zip_name)
            entry = save_workflow_upload(
                cfg,
                config_dir=config_dir,
                filename=basename,
                raw_bytes=raw,
            )
            imported.append(entry)

    updates: dict[str, Any] = {}
    assign_keys = (
        "workflow_text_to_image",
        "workflow_text_to_video",
        "workflow_image_to_video",
        "workflow_upscale_image",
        "workflow_upscale_video",
    )
    for key in assign_keys:
        if key in settings and settings[key] is not None:
            updates[key] = str(settings[key]).strip()

    if "workflow_input_config" in settings and isinstance(settings["workflow_input_config"], dict):
        updates["workflow_input_config"] = settings["workflow_input_config"]
    if "workflow_input_defaults" in settings and isinstance(
        settings["workflow_input_defaults"], dict
    ):
        updates["workflow_input_defaults"] = settings["workflow_input_defaults"]

    for key, caster in (
        ("width", int),
        ("height", int),
        ("frames", int),
        ("steps", int),
        ("fps", float),
        ("cfg", float),
    ):
        if key in settings and settings[key] is not None:
            try:
                updates[key] = caster(settings[key])
            except (TypeError, ValueError):
                continue
    if "negative_prompt" in settings and settings["negative_prompt"] is not None:
        updates["negative_prompt"] = str(settings["negative_prompt"])

    return updates, imported


def load_workflow_from_data(data: dict[str, Any]) -> dict[str, Any]:
    if not data:
        raise ValueError("Workflow must be a non-empty JSON object (ComfyUI API format)")
    if is_ui_workflow(data):
        raise ValueError(
            "Workflow is in ComfyUI editor format. Export API format from ComfyUI and upload that."
        )
    if not any(isinstance(v, dict) and "class_type" in v for v in data.values()):
        raise ValueError(
            "Workflow must be ComfyUI API format: each node needs class_type and inputs."
        )
    return data


def load_workflow(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not data:
        raise ValueError("Workflow must be a non-empty JSON object (ComfyUI API format)")
    return load_workflow_from_data(data)


def _link_target(value: Any) -> tuple[str, int] | None:
    if isinstance(value, list) and len(value) >= 2:
        return str(value[0]), int(value[1])
    return None


def default_node_title(class_type: str) -> str:
    """Humanize a ComfyUI class_type the way the editor often labels untitled nodes."""
    raw = (class_type or "").strip()
    if not raw:
        return ""
    spaced = raw.replace("_", " ")
    # Insert spaces before internal capitals: CLIPTextEncode → CLIP Text Encode
    out: list[str] = []
    for i, ch in enumerate(spaced):
        if i > 0 and ch.isupper() and (spaced[i - 1].islower() or spaced[i - 1].isdigit()):
            out.append(" ")
        elif (
            i > 0
            and ch.isupper()
            and spaced[i - 1].isupper()
            and i + 1 < len(spaced)
            and spaced[i + 1].islower()
        ):
            out.append(" ")
        out.append(ch)
    return "".join(out).strip()


def node_title(node: dict[str, Any]) -> str:
    meta = node.get("_meta")
    if isinstance(meta, dict):
        title = meta.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
    return ""


def _is_primitive_input(value: Any) -> bool:
    if _link_target(value) is not None:
        return False
    return isinstance(value, (str, int, float, bool))


def _input_type_name(value: Any) -> Literal["string", "number", "boolean"]:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    return "string"


def list_workflow_inputs(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """List all primitive (non-link) inputs from an API-format workflow.

    Configurers pick which of these may be edited at generate time.
    """
    out: list[dict[str, Any]] = []
    for nid, node in workflow.items():
        if not isinstance(node, dict) or "class_type" not in node:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        ctype = str(node.get("class_type") or "")
        title = node_title(node) or default_node_title(ctype) or ctype or str(nid)
        primitives = [(key, val) for key, val in inputs.items() if _is_primitive_input(val)]
        for key, val in primitives:
            label = f"{title} · {key}"
            out.append(
                {
                    "id": f"{nid}.{key}",
                    "node_id": str(nid),
                    "input_key": str(key),
                    "label": label,
                    "type": _input_type_name(val),
                    "default": val,
                    "class_type": ctype,
                    "title": title,
                }
            )
    # Stable order: node id then input key
    out.sort(key=lambda f: (str(f.get("node_id") or ""), str(f.get("input_key") or "")))
    return out


def normalize_field_config(entry: Any) -> dict[str, Any]:
    """Normalize a stored field config entry to ``{enabled, default?}``."""
    if isinstance(entry, dict):
        enabled = bool(entry.get("enabled", False))
        out: dict[str, Any] = {"enabled": enabled}
        if "default" in entry:
            out["default"] = entry["default"]
        return out
    # Legacy bare value meant "override default and allow"
    return {"enabled": True, "default": entry}


def op_input_config(cfg: ComfyUIConfig, op: str) -> dict[str, dict[str, Any]]:
    """Return per-field config for an op: ``field_id -> {enabled, default?}``."""
    raw = (cfg.workflow_input_config or {}).get(op) or {}
    if not isinstance(raw, dict):
        # Migrate legacy workflow_input_defaults if present
        legacy = (getattr(cfg, "workflow_input_defaults", None) or {}).get(op) or {}
        if isinstance(legacy, dict) and legacy:
            return {str(k): normalize_field_config(v) for k, v in legacy.items()}
        return {}
    return {str(k): normalize_field_config(v) for k, v in raw.items()}


def defaults_map_from_config(field_cfg: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Map of field_id -> default for enabled fields that have an explicit default."""
    out: dict[str, Any] = {}
    for fid, entry in field_cfg.items():
        if not entry.get("enabled"):
            continue
        if "default" in entry:
            out[fid] = entry["default"]
    return out


def merge_workflow_input_config(
    fields: list[dict[str, Any]],
    field_cfg: dict[str, dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Annotate scanned fields with enabled flag and configured defaults (Settings view)."""
    cfg = field_cfg or {}
    merged: list[dict[str, Any]] = []
    for field in fields:
        item = dict(field)
        fid = str(item.get("id") or "")
        entry = cfg.get(fid) or {"enabled": False}
        item["enabled"] = bool(entry.get("enabled", False))
        if "default" in entry:
            item["default"] = entry["default"]
        merged.append(item)
    return merged


def apply_workflow_inputs(
    workflow: dict[str, Any],
    overrides: dict[str, Any] | None,
) -> dict[str, Any]:
    """Apply ``node_id.input_key`` overrides onto an API-format workflow graph."""
    graph = copy.deepcopy(workflow)
    if not overrides:
        return graph
    for raw_key, value in overrides.items():
        key = str(raw_key or "").strip()
        if not key or "." not in key:
            continue
        node_id, input_key = key.split(".", 1)
        node = graph.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.setdefault("inputs", {})
        if not isinstance(inputs, dict):
            continue
        if input_key not in inputs and not _is_primitive_input(value):
            continue
        # Coerce to match existing type when possible.
        existing = inputs.get(input_key)
        if isinstance(existing, bool):
            if isinstance(value, bool):
                inputs[input_key] = value
            elif isinstance(value, (int, float)):
                inputs[input_key] = bool(value)
            else:
                inputs[input_key] = str(value).strip().lower() in {"1", "true", "yes", "on"}
        elif isinstance(existing, int) and not isinstance(existing, bool):
            try:
                inputs[input_key] = int(value)
            except (TypeError, ValueError):
                continue
        elif isinstance(existing, float):
            try:
                inputs[input_key] = float(value)
            except (TypeError, ValueError):
                continue
        elif isinstance(existing, str) or existing is None or input_key not in inputs:
            inputs[input_key] = "" if value is None else str(value)
        else:
            inputs[input_key] = value
    return graph


def introspect_workflow_path(path: Path) -> list[dict[str, Any]]:
    return list_workflow_inputs(load_workflow(path))


def workflow_inputs_for_settings(
    cfg: ComfyUIConfig,
    op: str,
    *,
    config_dir: Path | None = None,
    stem: str | None = None,
) -> list[dict[str, Any]]:
    """All scanned fields for Settings, with enabled + default from config."""
    name = (stem or "").strip() or comfy_workflow_name_for_op(cfg, op)
    if not name:
        return []
    path = resolve_named_workflow(cfg, name, config_dir=config_dir)
    if path is None:
        return []
    fields = list_workflow_inputs(load_workflow(path))
    return merge_workflow_input_config(fields, op_input_config(cfg, op))


def workflow_inputs_for_op(
    cfg: ComfyUIConfig,
    op: str,
    *,
    config_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Allowed (enabled) inputs for Generate, with configured defaults applied."""
    path = resolve_workflow_for_op(cfg, op, config_dir=config_dir)
    fields = list_workflow_inputs(load_workflow(path))
    annotated = merge_workflow_input_config(fields, op_input_config(cfg, op))
    return [f for f in annotated if f.get("enabled")]


def settings_defaults_for_op(cfg: ComfyUIConfig, op: str) -> dict[str, Any]:
    """Enabled field defaults to apply when running an op."""
    return defaults_map_from_config(op_input_config(cfg, op))


def patch_workflow(
    workflow: dict[str, Any],
    *,
    prompt: str | None = None,
    negative_prompt: str | None = None,
    width: int | None = None,
    height: int | None = None,
    frames: int | None = None,
    fps: float | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    seed: int | None = None,
    input_image_name: str | None = None,
    scale: float | None = None,
) -> dict[str, Any]:
    """Inject generation params into a ComfyUI API-format workflow.

    Model loaders (UNET/CLIP/VAE) are left as configured in the workflow JSON.
    """
    graph = copy.deepcopy(workflow)
    seed_value = int(seed) if seed is not None else random.randint(0, 2**53 - 1)
    length = snap_wan_frames(frames) if frames is not None else None

    positive_ids: set[str] = set()
    negative_ids: set[str] = set()
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "KSampler":
            continue
        inputs = node.get("inputs") or {}
        pos = _link_target(inputs.get("positive"))
        neg = _link_target(inputs.get("negative"))
        if pos:
            positive_ids.add(pos[0])
        if neg:
            negative_ids.add(neg[0])

    text_nodes = [
        (nid, node)
        for nid, node in graph.items()
        if isinstance(node, dict) and node.get("class_type") == "CLIPTextEncode"
    ]
    if not positive_ids and text_nodes:
        positive_ids.add(text_nodes[0][0])
    if not negative_ids and len(text_nodes) > 1:
        negative_ids.add(text_nodes[1][0])

    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        ctype = node.get("class_type")
        inputs = node.setdefault("inputs", {})

        if ctype == "CLIPTextEncode":
            if prompt is not None and nid in positive_ids:
                inputs["text"] = prompt
            elif negative_prompt is not None and nid in negative_ids:
                inputs["text"] = negative_prompt
        elif ctype in {"EmptyHunyuanLatentVideo", "EmptyLatentImage", "EmptySD3LatentImage", "WanImageToVideo"}:
            if width is not None:
                inputs["width"] = int(width)
            if height is not None:
                inputs["height"] = int(height)
            if length is not None:
                key = "length" if "length" in inputs or ctype == "WanImageToVideo" else None
                if key:
                    inputs[key] = int(length)
            inputs.setdefault("batch_size", 1)
        elif ctype == "KSampler":
            inputs["seed"] = seed_value
            if steps is not None:
                inputs["steps"] = int(steps)
            if cfg is not None:
                inputs["cfg"] = float(cfg)
        elif ctype == "CreateVideo":
            if fps is not None:
                inputs["fps"] = float(fps)
        elif ctype == "SaveVideo":
            inputs.setdefault("filename_prefix", "content_sprout/gen")
            inputs.setdefault("format", "auto")
            inputs.setdefault("codec", "auto")
        elif ctype == "VHS_VideoCombine":
            if fps is not None:
                inputs["frame_rate"] = int(round(fps))
            inputs.setdefault("filename_prefix", "content_sprout/gen")
        elif ctype == "LoadImage" and input_image_name:
            inputs["image"] = input_image_name
        elif ctype in {"VHS_LoadVideo", "LoadVideo"} and input_image_name:
            # Some workflows reuse the same upload filename field.
            if "video" in inputs:
                inputs["video"] = input_image_name
            elif "file" in inputs:
                inputs["file"] = input_image_name
            else:
                inputs["video"] = input_image_name
        elif ctype in {"ImageScaleBy", "ImageUpscaleWithModel"} and scale is not None:
            if "scale_by" in inputs:
                inputs["scale_by"] = float(scale)
            elif "scale" in inputs:
                inputs["scale"] = float(scale)
        elif ctype == "ImageScale" and scale is not None and width is not None and height is not None:
            inputs["width"] = int(width)
            inputs["height"] = int(height)
        elif scale is not None and "scale_by" in inputs:
            inputs["scale_by"] = float(scale)

    return graph


class ComfyUIClient:
    """Queue a prompt on ComfyUI and download the resulting media bytes."""

    def __init__(self, cfg: ComfyUIConfig, *, config_dir: Path | None = None):
        self._cfg = cfg
        self._config_dir = config_dir

    def _base(self) -> str:
        return (self._cfg.base_url or "http://127.0.0.1:8188").rstrip("/")

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        key = (getattr(self._cfg, "api_key", None) or "").strip()
        if key:
            headers["Authorization"] = f"Bearer {key}"
        return headers

    def ping(self) -> dict[str, Any]:
        with httpx.Client(timeout=min(30.0, float(self._cfg.timeout_s))) as client:
            r = client.get(f"{self._base()}/system_stats", headers=self._headers())
            r.raise_for_status()
            return r.json()

    def upload_input(self, path: Path, *, client: httpx.Client | None = None) -> str:
        """Upload a local file to ComfyUI input folder; return the server filename."""
        if not path.is_file():
            raise FileNotFoundError(f"Input media not found: {path}")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        owns = client is None
        http = client or httpx.Client(timeout=httpx.Timeout(float(self._cfg.timeout_s)))
        try:
            with path.open("rb") as fh:
                files = {"image": (path.name, fh, mime)}
                data = {"overwrite": "true"}
                r = http.post(
                    f"{self._base()}/upload/image",
                    headers=self._headers(),
                    files=files,
                    data=data,
                )
            if r.status_code >= 400:
                raise RuntimeError(f"ComfyUI upload failed: {r.text}")
            body = r.json()
            name = body.get("name") if isinstance(body, dict) else None
            if not name:
                raise RuntimeError(f"ComfyUI upload did not return a filename: {body}")
            return str(name)
        finally:
            if owns:
                http.close()

    def generate_video(
        self,
        prompt: str,
        *,
        negative_prompt: str | None = None,
        width: int | None = None,
        height: int | None = None,
        frames: int | None = None,
        fps: float | None = None,
        steps: int | None = None,
        cfg: float | None = None,
        seed: int | None = None,
    ) -> bytes:
        result = self.run_job(
            "text_to_video",
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            frames=frames,
            fps=fps,
            steps=steps,
            cfg=cfg,
            seed=seed,
        )
        return result["data"]

    def run_job(
        self,
        op: WorkflowOp | str,
        *,
        prompt: str | None = None,
        negative_prompt: str | None = None,
        width: int | None = None,
        height: int | None = None,
        frames: int | None = None,
        fps: float | None = None,
        steps: int | None = None,
        cfg: float | None = None,
        seed: int | None = None,
        input_path: Path | None = None,
        scale: float | None = None,
        expect: Literal["image", "video", "auto"] = "auto",
        workflow_inputs: dict[str, Any] | None = None,
        on_progress: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        """Run a named workflow op and return ``{data, kind, filename}``."""
        def _progress(msg: str) -> None:
            if on_progress:
                try:
                    on_progress(msg)
                except Exception:  # noqa: BLE001
                    pass

        text = (prompt or "").strip()
        if op in {"text_to_image", "text_to_video", "image_to_video"} and not text:
            raise ValueError("Prompt is required")
        if op in {"image_to_video", "upscale_image", "upscale_video"} and input_path is None:
            raise ValueError("Input media is required for this operation")

        with local_ai_task("comfyui", str(op)):
            return self._run_job_locked(
                op,
                prompt=prompt,
                negative_prompt=negative_prompt,
                width=width,
                height=height,
                frames=frames,
                fps=fps,
                steps=steps,
                cfg=cfg,
                seed=seed,
                input_path=input_path,
                scale=scale,
                expect=expect,
                workflow_inputs=workflow_inputs,
                on_progress=on_progress,
            )

    def _run_job_locked(
        self,
        op: WorkflowOp | str,
        *,
        prompt: str | None = None,
        negative_prompt: str | None = None,
        width: int | None = None,
        height: int | None = None,
        frames: int | None = None,
        fps: float | None = None,
        steps: int | None = None,
        cfg: float | None = None,
        seed: int | None = None,
        input_path: Path | None = None,
        scale: float | None = None,
        expect: Literal["image", "video", "auto"] = "auto",
        workflow_inputs: dict[str, Any] | None = None,
        on_progress: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        def _progress(msg: str) -> None:
            if on_progress:
                try:
                    on_progress(msg)
                except Exception:  # noqa: BLE001
                    pass

        text = (prompt or "").strip()

        _progress("Loading workflow…")
        workflow_path = resolve_workflow_for_op(self._cfg, op, config_dir=self._config_dir)
        workflow = load_workflow(workflow_path)

        media_kind: Literal["image", "video"]
        if expect == "auto":
            media_kind = "image" if op in {"text_to_image", "upscale_image"} else "video"
        else:
            media_kind = expect

        timeout = httpx.Timeout(float(self._cfg.timeout_s))
        with httpx.Client(timeout=timeout) as client:
            uploaded_name: str | None = None
            if input_path is not None:
                _progress("Uploading input to ComfyUI…")
                uploaded_name = self.upload_input(input_path, client=client)

            out_w = width if width is not None else self._cfg.width
            out_h = height if height is not None else self._cfg.height
            if scale is not None and input_path is not None and op.startswith("upscale"):
                pass

            patched = patch_workflow(
                workflow,
                prompt=text or None,
                negative_prompt=(
                    negative_prompt
                    if negative_prompt is not None
                    else self._cfg.negative_prompt
                ),
                width=out_w,
                height=out_h,
                frames=frames if frames is not None else self._cfg.frames,
                fps=fps if fps is not None else self._cfg.fps,
                steps=steps if steps is not None else self._cfg.steps,
                cfg=cfg if cfg is not None else self._cfg.cfg,
                seed=seed,
                input_image_name=uploaded_name,
                scale=scale,
            )
            # Configured defaults for allowed fields, then per-request overrides win.
            settings_defaults = settings_defaults_for_op(self._cfg, str(op))
            merged_inputs: dict[str, Any] = {**settings_defaults, **(workflow_inputs or {})}
            if merged_inputs:
                patched = apply_workflow_inputs(patched, merged_inputs)

            client_id = str(uuid.uuid4())
            _progress("Queuing on ComfyUI…")
            queued = client.post(
                f"{self._base()}/prompt",
                headers=self._headers(),
                json={"prompt": patched, "client_id": client_id},
            )
            if queued.status_code >= 400:
                detail = queued.text
                try:
                    detail = queued.json()
                except Exception:  # noqa: BLE001
                    pass
                raise RuntimeError(f"ComfyUI rejected the workflow: {detail}")
            body = queued.json()
            prompt_id = body.get("prompt_id")
            if not prompt_id:
                raise RuntimeError(f"ComfyUI did not return prompt_id: {body}")

            deadline = time.monotonic() + float(self._cfg.timeout_s)
            started = time.monotonic()
            last_report = 0.0
            history_entry: dict[str, Any] | None = None
            _progress("Running on ComfyUI…")
            while time.monotonic() < deadline:
                hist = client.get(f"{self._base()}/history/{prompt_id}", headers=self._headers())
                hist.raise_for_status()
                data = hist.json()
                entry = data.get(prompt_id) if isinstance(data, dict) else None
                if entry:
                    status = (entry.get("status") or {}) if isinstance(entry, dict) else {}
                    if status.get("status_str") == "error" or status.get("completed") is False:
                        messages = status.get("messages") or entry.get("messages") or status
                        raise RuntimeError(f"ComfyUI generation failed: {messages}")
                    if entry.get("outputs"):
                        history_entry = entry
                        break
                now = time.monotonic()
                if now - last_report >= 3.0:
                    elapsed = int(now - started)
                    _progress(f"Running on ComfyUI… ({elapsed}s)")
                    last_report = now
                time.sleep(max(0.5, float(self._cfg.poll_interval_s)))
            else:
                raise TimeoutError(
                    f"ComfyUI timed out after {self._cfg.timeout_s}s waiting for prompt {prompt_id}"
                )

            _progress("Downloading result…")
            outputs = history_entry.get("outputs") or {}
            file_info = (
                _first_video_file(outputs)
                if media_kind == "video"
                else _first_image_file(outputs)
            )
            if not file_info and media_kind == "video":
                file_info = _first_image_file(outputs)
                if file_info:
                    media_kind = "image"
            if not file_info and media_kind == "image":
                file_info = _first_video_file(outputs)
                if file_info:
                    media_kind = "video"
            if not file_info:
                raise RuntimeError(
                    f"ComfyUI finished but no {media_kind} output was found in history"
                )

            params = {
                "filename": file_info["filename"],
                "subfolder": file_info.get("subfolder") or "",
                "type": file_info.get("type") or "output",
            }
            view = client.get(f"{self._base()}/view", params=params, headers=self._headers())
            view.raise_for_status()
            payload = view.content
            if not payload:
                raise RuntimeError("ComfyUI returned an empty media file")
            _progress("Saving…")
            return {
                "data": payload,
                "kind": media_kind,
                "filename": str(
                    file_info.get("filename")
                    or f"generated.{'png' if media_kind == 'image' else 'mp4'}"
                ),
            }


def _first_video_file(outputs: dict[str, Any]) -> dict[str, Any] | None:
    """Pick the first saved video/gif entry from history outputs."""
    preferred_keys = ("videos", "gifs", "images")
    video_exts = (".mp4", ".webm", ".mov", ".mkv", ".avi", ".webp", ".gif")

    def _ok(item: dict[str, Any], *, require_video_ext: bool) -> bool:
        name = str(item.get("filename") or "")
        if not name:
            return False
        if require_video_ext and not name.lower().endswith(video_exts):
            return False
        return True

    for _node_id, node_out in outputs.items():
        if not isinstance(node_out, dict):
            continue
        for key in preferred_keys:
            items = node_out.get(key)
            if not isinstance(items, list) or not items:
                continue
            require_ext = key == "images"
            for item in items:
                if isinstance(item, dict) and _ok(item, require_video_ext=require_ext):
                    return item
        for value in node_out.values():
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict) and _ok(item, require_video_ext=True):
                        return item
    return None


def _first_image_file(outputs: dict[str, Any]) -> dict[str, Any] | None:
    image_exts = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")
    for _node_id, node_out in outputs.items():
        if not isinstance(node_out, dict):
            continue
        items = node_out.get("images")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("filename") or "").lower()
            if name.endswith(image_exts):
                return item
            # Still accept unlabeled image outputs from SaveImage.
            if name and not name.endswith((".mp4", ".webm", ".mov", ".mkv", ".avi", ".gif")):
                return item
    return None
