"""Photo Magic — layered still-image compositions with GIMP-style stack order.

GIMP layer order (the contract this module implements):

* ``layers[0]`` is the **topmost** drawable (drawn last, in front).
* ``layers[-1]`` is the **background** (drawn first).
* The layers dialog lists the array top-to-bottom (index 0 at the top of the list).
* A new layer is inserted **above** the selected layer (same index; the selection
  shifts down). With no selection it is inserted at index 0 (the top).
* Raise moves toward index 0; Lower moves toward the end of the list.
"""

from __future__ import annotations

import json
import re
import shutil
import threading
from pathlib import Path
from typing import Any, Literal

from PIL import Image, ImageChops
from pydantic import BaseModel, Field

from .models import _now_iso, new_id

PhotoMagicScope = Literal["global", "project", "post"]
AssetScope = Literal["global", "project"]

MIN_EDGE = 8
MAX_EDGE = 8192
DEFAULT_WIDTH = 1920
DEFAULT_HEIGHT = 1080
PHOTO_MAGIC_DIRNAME = "photo_magic"

_lock = threading.RLock()
_DOC_ID_RE = re.compile(r"^[a-f0-9]{6,40}$")


def safe_doc_id(doc_id: str) -> str:
    raw = str(doc_id or "").strip().lower()
    if not _DOC_ID_RE.fullmatch(raw):
        raise ValueError("Invalid Photo Magic document id.")
    return raw


def clamp_edge(value: Any, *, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = default
    return max(MIN_EDGE, min(MAX_EDGE, n))


def next_layer_name(existing: list[str]) -> str:
    taken = {str(n or "").strip() for n in existing}
    if "Layer" not in taken:
        return "Layer"
    n = 2
    while f"Layer {n}" in taken:
        n += 1
    return f"Layer {n}"


def duplicate_layer_name(name: str, existing: list[str]) -> str:
    base = (name or "Layer").strip() or "Layer"
    candidate = f"{base} copy"
    if candidate not in existing:
        return candidate
    n = 2
    while f"{candidate} {n}" in existing:
        n += 1
    return f"{candidate} {n}"


class PhotoMagicLayer(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str = "Layer"
    visible: bool = True
    opacity: float = 1.0
    locked: bool = False
    offset_x: int = 0
    offset_y: int = 0
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    raster: str = ""
    mask: str = ""
    has_mask: bool = False
    mask_enabled: bool = True
    source_asset_id: str | None = None


class PhotoMagicDocument(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str = "Untitled"
    scope: PhotoMagicScope = "global"
    project_id: str | None = None
    post_id: str | None = None
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    source_asset_id: str | None = None
    source_asset_scope: AssetScope | None = None
    selected_layer_id: str | None = None
    layers: list[PhotoMagicLayer] = Field(default_factory=list)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class PhotoMagicSummary(BaseModel):
    id: str
    name: str
    scope: PhotoMagicScope
    project_id: str | None = None
    post_id: str | None = None
    width: int
    height: int
    layer_count: int = 0
    source_asset_id: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class CreatePhotoMagicRequest(BaseModel):
    scope: PhotoMagicScope
    project_id: str | None = None
    post_id: str | None = None
    name: str | None = None
    width: int | None = None
    height: int | None = None
    source_asset_id: str | None = None
    source_asset_scope: AssetScope | None = None


class UpdatePhotoMagicRequest(BaseModel):
    name: str | None = None
    width: int | None = None
    height: int | None = None
    selected_layer_id: str | None = None


class AddPhotoMagicLayerRequest(BaseModel):
    name: str | None = None
    selected_layer_id: str | None = None
    source_asset_id: str | None = None
    source_asset_scope: AssetScope | None = None
    fill: Literal["transparent", "white", "black"] = "transparent"


class PatchPhotoMagicLayerRequest(BaseModel):
    name: str | None = None
    visible: bool | None = None
    opacity: float | None = None
    locked: bool | None = None
    offset_x: int | None = None
    offset_y: int | None = None


class ReorderPhotoMagicLayersRequest(BaseModel):
    layer_ids: list[str]


class SavePhotoMagicLayer(BaseModel):
    id: str
    name: str = "Layer"
    visible: bool = True
    opacity: float = 1.0
    locked: bool = False
    offset_x: int = 0
    offset_y: int = 0
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    has_mask: bool = False
    mask_enabled: bool = True
    source_asset_id: str | None = None


class SavePhotoMagicDocument(BaseModel):
    name: str | None = None
    selected_layer_id: str | None = None
    width: int | None = None
    height: int | None = None
    source_asset_id: str | None = None
    source_asset_scope: AssetScope | None = None
    layers: list[SavePhotoMagicLayer] = Field(default_factory=list)


class PhotoMagicCompositionPayload(BaseModel):
    """Sequential edit log stored as composition.json in scoped storage."""

    baseline: dict[str, Any] | None = None
    instructions: list[Any] = Field(default_factory=list)
    cursor: int = -1


def document_summary(doc: PhotoMagicDocument) -> PhotoMagicSummary:
    return PhotoMagicSummary(
        id=doc.id,
        name=doc.name,
        scope=doc.scope,
        project_id=doc.project_id,
        post_id=doc.post_id,
        width=doc.width,
        height=doc.height,
        layer_count=len(doc.layers),
        source_asset_id=doc.source_asset_id,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


def layer_index(layers: list[PhotoMagicLayer], layer_id: str) -> int:
    for i, layer in enumerate(layers):
        if layer.id == layer_id:
            return i
    raise KeyError(f"Layer not found: {layer_id}")


def insert_layer_above(
    layers: list[PhotoMagicLayer],
    layer: PhotoMagicLayer,
    *,
    selected_layer_id: str | None,
) -> list[PhotoMagicLayer]:
    """Insert ``layer`` above the selection (GIMP). No selection → top (index 0)."""
    out = list(layers)
    if selected_layer_id:
        try:
            idx = layer_index(out, selected_layer_id)
        except KeyError:
            idx = 0
    else:
        idx = 0
    out.insert(idx, layer)
    return out


def raise_layer(layers: list[PhotoMagicLayer], layer_id: str) -> list[PhotoMagicLayer]:
    """Move the layer toward the top of the image (lower index)."""
    out = list(layers)
    idx = layer_index(out, layer_id)
    if idx <= 0:
        return out
    out[idx - 1], out[idx] = out[idx], out[idx - 1]
    return out


def lower_layer(layers: list[PhotoMagicLayer], layer_id: str) -> list[PhotoMagicLayer]:
    """Move the layer toward the background (higher index)."""
    out = list(layers)
    idx = layer_index(out, layer_id)
    if idx >= len(out) - 1:
        return out
    out[idx + 1], out[idx] = out[idx], out[idx + 1]
    return out


def raise_layer_to_top(layers: list[PhotoMagicLayer], layer_id: str) -> list[PhotoMagicLayer]:
    out = list(layers)
    idx = layer_index(out, layer_id)
    if idx <= 0:
        return out
    layer = out.pop(idx)
    out.insert(0, layer)
    return out


def lower_layer_to_bottom(layers: list[PhotoMagicLayer], layer_id: str) -> list[PhotoMagicLayer]:
    out = list(layers)
    idx = layer_index(out, layer_id)
    if idx >= len(out) - 1:
        return out
    layer = out.pop(idx)
    out.append(layer)
    return out


def reorder_layers(layers: list[PhotoMagicLayer], layer_ids: list[str]) -> list[PhotoMagicLayer]:
    """Replace stack order. ``layer_ids[0]`` becomes the topmost layer."""
    by_id = {layer.id: layer for layer in layers}
    if set(layer_ids) != set(by_id) or len(layer_ids) != len(layers):
        raise ValueError("Reorder must include each layer id exactly once.")
    return [by_id[lid] for lid in layer_ids]


def selection_after_delete(layers: list[PhotoMagicLayer], deleted_index: int) -> str | None:
    """GIMP: select the layer that was below the deleted one, else the one above."""
    if not layers:
        return None
    if deleted_index < len(layers):
        return layers[deleted_index].id
    return layers[-1].id


def composite_document(doc: PhotoMagicDocument, root: Path) -> Image.Image:
    """Flatten the stack. Draw background first (last list item), top last."""
    canvas = Image.new("RGBA", (doc.width, doc.height), (0, 0, 0, 0))
    for layer in reversed(doc.layers):
        if not layer.visible:
            continue
        opacity = max(0.0, min(1.0, float(layer.opacity)))
        if opacity <= 0:
            continue
        path = root / layer.raster if layer.raster else None
        if path is None or not path.is_file():
            continue
        with Image.open(path) as src:
            img = src.convert("RGBA")
        if layer.has_mask and layer.mask_enabled and layer.mask:
            mask_path = root / layer.mask
            if mask_path.is_file():
                with Image.open(mask_path) as mask_src:
                    mask_l = mask_src.convert("L")
                if mask_l.size != img.size:
                    mask_l = mask_l.resize(img.size, Image.Resampling.LANCZOS)
                red, green, blue, alpha = img.split()
                img = Image.merge("RGBA", (red, green, blue, ImageChops.multiply(alpha, mask_l)))
        if opacity < 1.0:
            r, g, b, a = img.split()
            a = a.point(lambda p, o=opacity: int(p * o))
            img = Image.merge("RGBA", (r, g, b, a))
        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        overlay.paste(img, (int(layer.offset_x), int(layer.offset_y)), img)
        canvas = Image.alpha_composite(canvas, overlay)
    return canvas


def _blank_rgba(width: int, height: int, fill: str = "transparent") -> Image.Image:
    if fill == "white":
        color = (255, 255, 255, 255)
    elif fill == "black":
        color = (0, 0, 0, 255)
    else:
        color = (0, 0, 0, 0)
    return Image.new("RGBA", (width, height), color)


class PhotoMagicStore:
    """Filesystem store for one scope root (global, project, or post)."""

    def __init__(self, root: Path, *, scope: PhotoMagicScope, project_id: str | None, post_id: str | None):
        self.root = Path(root).resolve()
        self.scope = scope
        self.project_id = project_id
        self.post_id = post_id
        self.root.mkdir(parents=True, exist_ok=True)

    def _doc_dir(self, doc_id: str) -> Path:
        return self.root / safe_doc_id(doc_id)

    def _doc_file(self, doc_id: str) -> Path:
        return self._doc_dir(doc_id) / "document.json"

    def _composition_file(self, doc_id: str) -> Path:
        return self._doc_dir(doc_id) / "composition.json"

    def _layers_dir(self, doc_id: str) -> Path:
        return self._doc_dir(doc_id) / "layers"

    def _sources_dir(self, doc_id: str) -> Path:
        return self._doc_dir(doc_id) / "sources"

    def _exists(self, doc_id: str) -> bool:
        return self._composition_file(doc_id).is_file() or self._doc_file(doc_id).is_file()

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(path)

    def _load(self, doc_id: str) -> PhotoMagicDocument:
        comp_path = self._composition_file(doc_id)
        if comp_path.is_file():
            raw = json.loads(comp_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and isinstance(raw.get("document"), dict):
                return PhotoMagicDocument.model_validate(raw["document"])
        path = self._doc_file(doc_id)
        if not path.is_file():
            raise FileNotFoundError(f"Photo Magic document not found: {doc_id}")
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise FileNotFoundError(f"Photo Magic document not found: {doc_id}")
        return PhotoMagicDocument.model_validate(raw)

    def get_composition(self, doc_id: str) -> dict[str, Any]:
        """Return the sequential composition log (baseline + ordered edits)."""
        path = self._composition_file(doc_id)
        if path.is_file():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                baseline = raw.get("baseline")
                if not isinstance(baseline, dict):
                    baseline = self._load(doc_id).model_dump(mode="json")
                instructions = raw.get("instructions")
                if not isinstance(instructions, list):
                    instructions = []
                try:
                    cursor = int(raw.get("cursor", -1))
                except (TypeError, ValueError):
                    cursor = -1
                cursor = max(-1, min(cursor, len(instructions) - 1))
                return {
                    "baseline": baseline,
                    "instructions": instructions,
                    "cursor": cursor,
                }
        doc = self._load(doc_id)
        return {
            "baseline": doc.model_dump(mode="json"),
            "instructions": [],
            "cursor": -1,
        }

    def write_composition(
        self,
        doc: PhotoMagicDocument,
        *,
        baseline: dict[str, Any] | None = None,
        instructions: list[Any] | None = None,
        cursor: int = -1,
    ) -> dict[str, Any]:
        steps = list(instructions or [])
        bounded = max(-1, min(int(cursor), len(steps) - 1))
        snap = baseline if isinstance(baseline, dict) else doc.model_dump(mode="json")
        payload = {
            "version": 1,
            "id": doc.id,
            "name": doc.name,
            "scope": self.scope,
            "project_id": self.project_id,
            "post_id": self.post_id,
            "width": doc.width,
            "height": doc.height,
            "source_asset_id": doc.source_asset_id,
            "created_at": doc.created_at,
            "updated_at": doc.updated_at,
            "document": doc.model_dump(mode="json"),
            "baseline": snap,
            "instructions": steps,
            "cursor": bounded,
        }
        self._write_json(self._composition_file(doc.id), payload)
        return {"baseline": snap, "instructions": steps, "cursor": bounded}

    def _touch_composition_snapshot(self, doc: PhotoMagicDocument) -> None:
        path = self._composition_file(doc.id)
        if not path.is_file():
            self.write_composition(doc, baseline=doc.model_dump(mode="json"), instructions=[], cursor=-1)
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self.write_composition(doc, baseline=doc.model_dump(mode="json"), instructions=[], cursor=-1)
            return
        if not isinstance(raw, dict):
            self.write_composition(doc, baseline=doc.model_dump(mode="json"), instructions=[], cursor=-1)
            return
        raw["document"] = doc.model_dump(mode="json")
        raw["name"] = doc.name
        raw["width"] = doc.width
        raw["height"] = doc.height
        raw["updated_at"] = doc.updated_at
        raw["scope"] = self.scope
        raw["project_id"] = self.project_id
        raw["post_id"] = self.post_id
        self._write_json(path, raw)

    def _save(self, doc: PhotoMagicDocument) -> PhotoMagicDocument:
        doc.updated_at = _now_iso()
        doc.scope = self.scope
        doc.project_id = self.project_id
        doc.post_id = self.post_id
        self._write_json(self._doc_file(doc.id), doc.model_dump(mode="json"))
        self._touch_composition_snapshot(doc)
        return doc

    def _write_raster(self, doc_id: str, layer_id: str, image: Image.Image) -> str:
        return self._write_layer_png(doc_id, f"{layer_id}.png", image, mode="RGBA")

    def _write_mask(self, doc_id: str, layer_id: str, image: Image.Image) -> str:
        return self._write_layer_png(doc_id, f"{layer_id}_mask.png", image, mode="L")

    def _write_source(self, doc_id: str, layer_id: str, image: Image.Image) -> str:
        sources_dir = self._sources_dir(doc_id)
        sources_dir.mkdir(parents=True, exist_ok=True)
        image.convert("RGBA").save(sources_dir / f"{layer_id}.png", format="PNG")
        return f"sources/{layer_id}.png"

    def _write_source_mask(self, doc_id: str, layer_id: str, image: Image.Image) -> str:
        sources_dir = self._sources_dir(doc_id)
        sources_dir.mkdir(parents=True, exist_ok=True)
        image.convert("L").save(sources_dir / f"{layer_id}_mask.png", format="PNG")
        return f"sources/{layer_id}_mask.png"

    def _write_layer_png(self, doc_id: str, filename: str, image: Image.Image, *, mode: str) -> str:
        layers_dir = self._layers_dir(doc_id)
        layers_dir.mkdir(parents=True, exist_ok=True)
        image.convert(mode).save(layers_dir / filename, format="PNG")
        return f"layers/{filename}"

    def _unlink_rel(self, doc_id: str, rel: str) -> None:
        if not rel:
            return
        path = self._doc_dir(doc_id) / rel
        if path.is_file():
            try:
                path.unlink()
            except OSError:
                pass

    def list_documents(self) -> list[PhotoMagicSummary]:
        with _lock:
            items: list[PhotoMagicSummary] = []
            if not self.root.exists():
                return items
            for child in self.root.iterdir():
                if not child.is_dir():
                    continue
                if not (child / "composition.json").is_file() and not (child / "document.json").is_file():
                    continue
                try:
                    doc = self._load(child.name)
                except (OSError, json.JSONDecodeError, ValueError):
                    continue
                items.append(document_summary(doc))
            items.sort(key=lambda d: str(d.updated_at or ""), reverse=True)
            return items

    def get_document(self, doc_id: str) -> PhotoMagicDocument:
        with _lock:
            return self._load(doc_id)

    def create_document(
        self,
        *,
        name: str | None = None,
        width: int | None = None,
        height: int | None = None,
        source_image: Image.Image | None = None,
        source_asset_id: str | None = None,
        source_asset_scope: AssetScope | None = None,
        source_name: str | None = None,
    ) -> PhotoMagicDocument:
        with _lock:
            if source_image is not None:
                src = source_image.convert("RGBA")
                canvas_w = clamp_edge(src.size[0], default=DEFAULT_WIDTH)
                canvas_h = clamp_edge(src.size[1], default=DEFAULT_HEIGHT)
                if src.size != (canvas_w, canvas_h):
                    src = src.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
            else:
                canvas_w = clamp_edge(width, default=DEFAULT_WIDTH)
                canvas_h = clamp_edge(height, default=DEFAULT_HEIGHT)
                src = None

            doc = PhotoMagicDocument(
                name=(name or source_name or "Untitled").strip()[:120] or "Untitled",
                scope=self.scope,
                project_id=self.project_id,
                post_id=self.post_id,
                width=canvas_w,
                height=canvas_h,
                source_asset_id=source_asset_id,
                source_asset_scope=source_asset_scope,
            )
            layer_name = (source_name or "Background").strip()[:80] or "Background"
            layer = PhotoMagicLayer(
                name=layer_name,
                width=canvas_w,
                height=canvas_h,
                source_asset_id=source_asset_id,
            )
            raster = src if src is not None else _blank_rgba(canvas_w, canvas_h, "transparent")
            layer.raster = self._write_raster(doc.id, layer.id, raster)
            self._write_source(doc.id, layer.id, raster)
            doc.layers = [layer]
            doc.selected_layer_id = layer.id
            return self._save(doc)

    def update_document(self, doc_id: str, body: UpdatePhotoMagicRequest) -> PhotoMagicDocument:
        with _lock:
            doc = self._load(doc_id)
            if body.name is not None:
                name = str(body.name).strip()[:120]
                if name:
                    doc.name = name
            if body.width is not None:
                doc.width = clamp_edge(body.width, default=doc.width)
            if body.height is not None:
                doc.height = clamp_edge(body.height, default=doc.height)
            if body.selected_layer_id is not None:
                if body.selected_layer_id == "":
                    doc.selected_layer_id = None
                else:
                    layer_index(doc.layers, body.selected_layer_id)
                    doc.selected_layer_id = body.selected_layer_id
            return self._save(doc)

    def delete_document(self, doc_id: str) -> str:
        with _lock:
            path = self._doc_dir(doc_id)
            if not self._exists(doc_id):
                raise FileNotFoundError(f"Photo Magic document not found: {doc_id}")
            shutil.rmtree(path)
            return doc_id

    def add_layer(
        self,
        doc_id: str,
        *,
        name: str | None = None,
        selected_layer_id: str | None = None,
        image: Image.Image | None = None,
        fill: str = "transparent",
        source_asset_id: str | None = None,
    ) -> PhotoMagicDocument:
        with _lock:
            doc = self._load(doc_id)
            existing = [layer.name for layer in doc.layers]
            layer_name = (name or "").strip()[:80] or next_layer_name(existing)
            if image is not None:
                raster = image.convert("RGBA")
                lw, lh = raster.size
            else:
                lw, lh = doc.width, doc.height
                raster = _blank_rgba(lw, lh, fill)
            layer = PhotoMagicLayer(
                name=layer_name,
                width=lw,
                height=lh,
                source_asset_id=source_asset_id,
            )
            layer.raster = self._write_raster(doc.id, layer.id, raster)
            above = selected_layer_id if selected_layer_id is not None else doc.selected_layer_id
            doc.layers = insert_layer_above(doc.layers, layer, selected_layer_id=above)
            doc.selected_layer_id = layer.id
            return self._save(doc)

    def patch_layer(self, doc_id: str, layer_id: str, body: PatchPhotoMagicLayerRequest) -> PhotoMagicDocument:
        with _lock:
            doc = self._load(doc_id)
            idx = layer_index(doc.layers, layer_id)
            layer = doc.layers[idx]
            if layer.locked and (
                body.offset_x is not None or body.offset_y is not None or body.opacity is not None
            ):
                raise ValueError("Layer is locked.")
            if body.name is not None:
                name = str(body.name).strip()[:80]
                if name:
                    layer.name = name
            if body.visible is not None:
                layer.visible = bool(body.visible)
            if body.opacity is not None:
                layer.opacity = max(0.0, min(1.0, float(body.opacity)))
            if body.locked is not None:
                layer.locked = bool(body.locked)
            if body.offset_x is not None:
                layer.offset_x = int(body.offset_x)
            if body.offset_y is not None:
                layer.offset_y = int(body.offset_y)
            doc.layers[idx] = layer
            return self._save(doc)

    def delete_layer(self, doc_id: str, layer_id: str) -> PhotoMagicDocument:
        with _lock:
            doc = self._load(doc_id)
            idx = layer_index(doc.layers, layer_id)
            if doc.layers[idx].locked:
                raise ValueError("Layer is locked.")
            removed = doc.layers.pop(idx)
            raster = self._doc_dir(doc_id) / removed.raster if removed.raster else None
            if raster is not None and raster.is_file():
                try:
                    raster.unlink()
                except OSError:
                    pass
            doc.selected_layer_id = selection_after_delete(doc.layers, idx)
            return self._save(doc)

    def duplicate_layer(self, doc_id: str, layer_id: str) -> PhotoMagicDocument:
        with _lock:
            doc = self._load(doc_id)
            idx = layer_index(doc.layers, layer_id)
            src = doc.layers[idx]
            copy = src.model_copy(deep=True)
            copy.id = new_id()
            copy.name = duplicate_layer_name(src.name, [layer.name for layer in doc.layers])
            copy.locked = False
            src_path = self._doc_dir(doc_id) / src.raster if src.raster else None
            if src_path is not None and src_path.is_file():
                with Image.open(src_path) as img:
                    copy.raster = self._write_raster(doc.id, copy.id, img.convert("RGBA"))
            else:
                blank = _blank_rgba(src.width or doc.width, src.height or doc.height)
                copy.raster = self._write_raster(doc.id, copy.id, blank)
            doc.layers.insert(idx, copy)
            doc.selected_layer_id = copy.id
            return self._save(doc)

    def _mutate_order(self, doc_id: str, layer_id: str, fn) -> PhotoMagicDocument:
        with _lock:
            doc = self._load(doc_id)
            doc.layers = fn(doc.layers, layer_id)
            doc.selected_layer_id = layer_id
            return self._save(doc)

    def raise_layer(self, doc_id: str, layer_id: str) -> PhotoMagicDocument:
        return self._mutate_order(doc_id, layer_id, raise_layer)

    def lower_layer(self, doc_id: str, layer_id: str) -> PhotoMagicDocument:
        return self._mutate_order(doc_id, layer_id, lower_layer)

    def raise_layer_to_top(self, doc_id: str, layer_id: str) -> PhotoMagicDocument:
        return self._mutate_order(doc_id, layer_id, raise_layer_to_top)

    def lower_layer_to_bottom(self, doc_id: str, layer_id: str) -> PhotoMagicDocument:
        return self._mutate_order(doc_id, layer_id, lower_layer_to_bottom)

    def reorder_layers(self, doc_id: str, layer_ids: list[str]) -> PhotoMagicDocument:
        with _lock:
            doc = self._load(doc_id)
            doc.layers = reorder_layers(doc.layers, layer_ids)
            if doc.selected_layer_id and doc.selected_layer_id not in layer_ids:
                doc.selected_layer_id = layer_ids[0] if layer_ids else None
            return self._save(doc)

    def _safe_child(self, doc_id: str, rel: str) -> Path:
        path = (self._doc_dir(doc_id) / rel).resolve()
        try:
            path.relative_to(self._doc_dir(doc_id).resolve())
        except ValueError as exc:
            raise ValueError("Path escapes document directory.") from exc
        return path

    def raster_path(self, doc_id: str, layer_id: str) -> Path:
        with _lock:
            doc = self._load(doc_id)
            idx = layer_index(doc.layers, layer_id)
            rel = doc.layers[idx].raster
            path = self._safe_child(doc_id, rel)
            if not path.is_file():
                raise FileNotFoundError(f"Layer raster not found: {layer_id}")
            return path

    def source_path(self, doc_id: str, layer_id: str) -> Path:
        with _lock:
            lid = str(layer_id or "").strip()
            if not lid:
                raise KeyError("Layer not found.")
            path = self._safe_child(doc_id, f"sources/{lid}.png")
            if path.is_file():
                return path
            return self.raster_path(doc_id, lid)

    def source_mask_path(self, doc_id: str, layer_id: str) -> Path:
        with _lock:
            lid = str(layer_id or "").strip()
            if not lid:
                raise KeyError("Layer not found.")
            path = self._safe_child(doc_id, f"sources/{lid}_mask.png")
            if path.is_file():
                return path
            return self.mask_path(doc_id, lid)

    def mask_path(self, doc_id: str, layer_id: str) -> Path:
        with _lock:
            doc = self._load(doc_id)
            idx = layer_index(doc.layers, layer_id)
            rel = doc.layers[idx].mask
            if not rel:
                raise FileNotFoundError(f"Layer mask not found: {layer_id}")
            path = (self._doc_dir(doc_id) / rel).resolve()
            try:
                path.relative_to(self._doc_dir(doc_id).resolve())
            except ValueError as exc:
                raise ValueError("Path escapes document directory.") from exc
            if not path.is_file():
                raise FileNotFoundError(f"Layer mask not found: {layer_id}")
            return path

    def render_preview(self, doc_id: str) -> Image.Image:
        with _lock:
            doc = self._load(doc_id)
            return composite_document(doc, self._doc_dir(doc_id))

    def replace_stack(
        self,
        doc_id: str,
        body: SavePhotoMagicDocument,
        rasters: dict[str, Image.Image],
        masks: dict[str, Image.Image] | None = None,
        *,
        composition: PhotoMagicCompositionPayload | None = None,
        sources: dict[str, Image.Image] | None = None,
        source_masks: dict[str, Image.Image] | None = None,
    ) -> PhotoMagicDocument:
        """Commit the working stack and the sequential composition JSON."""
        with _lock:
            try:
                doc = self._load(doc_id)
            except FileNotFoundError:
                canvas_w = clamp_edge(body.width, default=DEFAULT_WIDTH)
                canvas_h = clamp_edge(body.height, default=DEFAULT_HEIGHT)
                doc = PhotoMagicDocument(
                    id=safe_doc_id(doc_id),
                    name=(body.name or "Untitled").strip()[:120] or "Untitled",
                    width=canvas_w,
                    height=canvas_h,
                    source_asset_id=body.source_asset_id,
                    source_asset_scope=body.source_asset_scope,
                )
            if body.name is not None:
                name = str(body.name).strip()[:120]
                if name:
                    doc.name = name
            if body.width is not None:
                doc.width = clamp_edge(body.width, default=doc.width)
            if body.height is not None:
                doc.height = clamp_edge(body.height, default=doc.height)
            if body.source_asset_id is not None:
                doc.source_asset_id = body.source_asset_id
            if body.source_asset_scope is not None:
                doc.source_asset_scope = body.source_asset_scope
            keep_ids: set[str] = set()
            new_layers: list[PhotoMagicLayer] = []
            existing = {layer.id: layer for layer in doc.layers}
            for spec in body.layers:
                layer_id = str(spec.id or "").strip()
                if not layer_id:
                    continue
                keep_ids.add(layer_id)
                prev = existing.get(layer_id)
                layer = PhotoMagicLayer(
                    id=layer_id,
                    name=(spec.name or prev.name if prev else spec.name or "Layer").strip()[:80] or "Layer",
                    visible=spec.visible,
                    opacity=max(0.0, min(1.0, float(spec.opacity))),
                    locked=bool(spec.locked),
                    offset_x=int(spec.offset_x),
                    offset_y=int(spec.offset_y),
                    width=clamp_edge(spec.width, default=doc.width),
                    height=clamp_edge(spec.height, default=doc.height),
                    raster=prev.raster if prev else "",
                    mask=prev.mask if prev else "",
                    has_mask=bool(spec.has_mask),
                    mask_enabled=bool(spec.mask_enabled),
                    source_asset_id=spec.source_asset_id,
                )
                image = rasters.get(layer_id)
                if image is None and not layer.raster:
                    image = _blank_rgba(layer.width, layer.height)
                if image is not None:
                    layer.width, layer.height = image.convert("RGBA").size
                    layer.raster = self._write_raster(doc.id, layer.id, image)
                mask_image = (masks or {}).get(layer_id)
                if mask_image is not None:
                    layer.mask = self._write_mask(doc.id, layer.id, mask_image)
                    layer.has_mask = True
                elif not spec.has_mask:
                    if prev and prev.mask:
                        self._unlink_rel(doc.id, prev.mask)
                    layer.mask = ""
                    layer.has_mask = False
                new_layers.append(layer)
            for prev in doc.layers:
                if prev.id in keep_ids:
                    continue
                self._unlink_rel(doc.id, prev.raster)
                self._unlink_rel(doc.id, prev.mask)
            doc.layers = new_layers
            if body.selected_layer_id and any(layer.id == body.selected_layer_id for layer in doc.layers):
                doc.selected_layer_id = body.selected_layer_id
            elif doc.layers:
                doc.selected_layer_id = doc.layers[0].id
            else:
                doc.selected_layer_id = None
            for layer_id, image in (sources or {}).items():
                if not layer_id or image is None:
                    continue
                self._write_source(doc.id, layer_id, image)
            for layer_id, image in (source_masks or {}).items():
                if not layer_id or image is None:
                    continue
                self._write_source_mask(doc.id, layer_id, image)
            saved = self._save(doc)
            if composition is not None:
                self.write_composition(
                    saved,
                    baseline=composition.baseline,
                    instructions=composition.instructions,
                    cursor=composition.cursor,
                )
            return saved
