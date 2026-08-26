"""HTTP routes for Photo Magic layered compositions."""

# FastAPI Query/File defaults — same pattern as web.py.
# ruff: noqa: B008

from __future__ import annotations

import io
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageOps

from . import ai_services
from .io import load as load_image
from .models import is_image_asset
from .photo_magic import (
    PHOTO_MAGIC_DIRNAME,
    AddPhotoMagicLayerRequest,
    CreatePhotoMagicRequest,
    PatchPhotoMagicLayerRequest,
    PhotoMagicCompositionPayload,
    PhotoMagicDocument,
    PhotoMagicScope,
    PhotoMagicStore,
    ReorderPhotoMagicLayersRequest,
    SavePhotoMagicDocument,
    UpdatePhotoMagicRequest,
)


def _scope_params(
    scope: PhotoMagicScope,
    project_id: str | None,
    post_id: str | None,
) -> tuple[str | None, str | None]:
    if scope == "global":
        return None, None
    if scope == "project":
        if not (project_id or "").strip():
            raise HTTPException(status_code=400, detail="project_id is required for project scope.")
        return project_id.strip(), None
    if scope == "post":
        if not (project_id or "").strip() or not (post_id or "").strip():
            raise HTTPException(
                status_code=400,
                detail="project_id and post_id are required for post scope.",
            )
        return project_id.strip(), post_id.strip()
    raise HTTPException(status_code=400, detail="Invalid Photo Magic scope.")


def _image_from_bytes(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as src:
        img = ImageOps.exif_transpose(src)
        return img.convert("RGBA")


def register_photo_magic_routes(
    app: FastAPI,
    *,
    project_store: Callable,
    global_asset_store: Callable,
    get_cfg: Callable | None = None,
) -> None:
    def _store_for(scope: PhotoMagicScope, project_id: str | None, post_id: str | None) -> PhotoMagicStore:
        pid, post = _scope_params(scope, project_id, post_id)
        if scope == "global":
            root = global_asset_store().root / PHOTO_MAGIC_DIRNAME
            return PhotoMagicStore(root, scope="global", project_id=None, post_id=None)
        store = project_store()
        try:
            root = store.photo_magic_dir(pid, post)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return PhotoMagicStore(root, scope=scope, project_id=pid, post_id=post)

    def _open_asset_image(
        *,
        asset_id: str,
        asset_scope: str | None,
        project_id: str | None,
    ) -> tuple[Image.Image, str]:
        aid = (asset_id or "").strip()
        if not aid:
            raise HTTPException(status_code=400, detail="source_asset_id is required.")
        resolved_scope = (asset_scope or ("project" if project_id else "global")).strip().lower()
        if resolved_scope == "global":
            gstore = global_asset_store()
            try:
                asset = gstore.get_asset(aid)
                path = gstore.resolve_path(asset)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if not is_image_asset(asset.type):
                raise HTTPException(status_code=400, detail="Only image assets can be opened in Photo Magic.")
            try:
                img = load_image(path).convert("RGBA")
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=400, detail=f"Could not open image: {exc}") from exc
            return img, asset.name
        if not (project_id or "").strip():
            raise HTTPException(status_code=400, detail="project_id is required to open a project asset.")
        pstore = project_store()
        try:
            asset = pstore.get_asset(project_id, aid)
            path = pstore.materialize_asset(project_id, asset)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not is_image_asset(asset.type):
            raise HTTPException(status_code=400, detail="Only image assets can be opened in Photo Magic.")
        try:
            img = load_image(path).convert("RGBA")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Could not open image: {exc}") from exc
        return img, asset.name

    def _payload(store: PhotoMagicStore, doc: PhotoMagicDocument) -> dict:
        return {
            "document": doc.model_dump(mode="json"),
            "composition": store.get_composition(doc.id),
        }

    def _load_or_404(store: PhotoMagicStore, doc_id: str) -> PhotoMagicDocument:
        try:
            return store.get_document(doc_id)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/photo-magic")
    def list_photo_magic_documents(
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        return {"documents": [s.model_dump(mode="json") for s in store.list_documents()]}

    @app.post("/api/photo-magic")
    def create_photo_magic_document(body: CreatePhotoMagicRequest) -> dict:
        store = _store_for(body.scope, body.project_id, body.post_id)
        source_image = None
        source_name = None
        if body.source_asset_id:
            source_image, source_name = _open_asset_image(
                asset_id=body.source_asset_id,
                asset_scope=body.source_asset_scope,
                project_id=body.project_id,
            )
        doc = store.create_document(
            name=body.name,
            width=body.width,
            height=body.height,
            source_image=source_image,
            source_asset_id=body.source_asset_id,
            source_asset_scope=body.source_asset_scope,
            source_name=source_name,
        )
        return _payload(store, doc)

    @app.get("/api/photo-magic/{doc_id}")
    def get_photo_magic_document(
        doc_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        return _payload(store, _load_or_404(store, doc_id))

    @app.patch("/api/photo-magic/{doc_id}")
    def update_photo_magic_document(
        doc_id: str,
        body: UpdatePhotoMagicRequest,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            doc = store.update_document(doc_id, body)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return _payload(store, doc)

    @app.delete("/api/photo-magic/{doc_id}")
    def delete_photo_magic_document(
        doc_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        try:
            deleted = store.delete_document(doc_id)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"deleted": deleted, "documents": [s.model_dump(mode="json") for s in store.list_documents()]}

    @app.put("/api/photo-magic/{doc_id}/save")
    async def save_photo_magic_document(
        doc_id: str,
        request: Request,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        form = await request.form()
        raw = form.get("document")
        if not isinstance(raw, str) or not raw.strip():
            raise HTTPException(status_code=400, detail="document form field is required.")
        try:
            body = SavePhotoMagicDocument.model_validate_json(raw)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Invalid document payload: {exc}") from exc
        composition = None
        raw_comp = form.get("composition")
        if isinstance(raw_comp, str) and raw_comp.strip():
            try:
                composition = PhotoMagicCompositionPayload.model_validate_json(raw_comp)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=400, detail=f"Invalid composition payload: {exc}") from exc
        rasters: dict[str, Image.Image] = {}
        masks: dict[str, Image.Image] = {}
        sources: dict[str, Image.Image] = {}
        source_masks: dict[str, Image.Image] = {}
        for key, value in form.multi_items():
            raw_key = str(key)
            if raw_key.startswith("source_mask_"):
                prefix, dest = "source_mask_", source_masks
            elif raw_key.startswith("source_"):
                prefix, dest = "source_", sources
            elif raw_key.startswith("raster_"):
                prefix, dest = "raster_", rasters
            elif raw_key.startswith("mask_"):
                prefix, dest = "mask_", masks
            else:
                continue
            layer_id = raw_key[len(prefix) :].strip()
            if not layer_id or not hasattr(value, "read"):
                continue
            data = await value.read()
            if not data:
                continue
            try:
                dest[layer_id] = _image_from_bytes(data)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=400,
                    detail=f"Could not open {prefix}{layer_id}: {exc}",
                ) from exc
        try:
            doc = store.replace_stack(
                doc_id,
                body,
                rasters,
                masks,
                composition=composition,
                sources=sources,
                source_masks=source_masks,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return _payload(store, doc)

    @app.get("/api/photo-magic/{doc_id}/preview")
    def preview_photo_magic_document(
        doc_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> Response:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        image = store.render_preview(doc_id)
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return Response(
            content=buf.getvalue(),
            media_type="image/png",
            headers={"Cache-Control": "private, no-store"},
        )

    @app.post("/api/photo-magic/{doc_id}/layers")
    def add_photo_magic_layer(
        doc_id: str,
        body: AddPhotoMagicLayerRequest,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        image = None
        source_name = None
        if body.source_asset_id:
            image, source_name = _open_asset_image(
                asset_id=body.source_asset_id,
                asset_scope=body.source_asset_scope,
                project_id=project_id,
            )
        try:
            doc = store.add_layer(
                doc_id,
                name=body.name or source_name,
                selected_layer_id=body.selected_layer_id,
                image=image,
                fill=body.fill,
                source_asset_id=body.source_asset_id,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return _payload(store, doc)

    @app.post("/api/photo-magic/{doc_id}/layers/upload")
    async def upload_photo_magic_layer(
        doc_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
        file: UploadFile = File(...),
        name: str = "",
        selected_layer_id: str = "",
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty file.")
        try:
            image = _image_from_bytes(data)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Could not open image: {exc}") from exc
        source_name = Path(file.filename or "").stem or None
        try:
            doc = store.add_layer(
                doc_id,
                name=(name or "").strip() or source_name,
                selected_layer_id=(selected_layer_id or "").strip() or None,
                image=image,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return _payload(store, doc)

    @app.patch("/api/photo-magic/{doc_id}/layers/{layer_id}")
    def patch_photo_magic_layer(
        doc_id: str,
        layer_id: str,
        body: PatchPhotoMagicLayerRequest,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            doc = store.patch_layer(doc_id, layer_id, body)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return _payload(store, doc)

    @app.delete("/api/photo-magic/{doc_id}/layers/{layer_id}")
    def delete_photo_magic_layer(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            doc = store.delete_layer(doc_id, layer_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return _payload(store, doc)

    @app.post("/api/photo-magic/{doc_id}/layers/{layer_id}/duplicate")
    def duplicate_photo_magic_layer(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            doc = store.duplicate_layer(doc_id, layer_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return _payload(store, doc)

    @app.post("/api/photo-magic/{doc_id}/layers/{layer_id}/raise")
    def raise_photo_magic_layer(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            return _payload(store, store.raise_layer(doc_id, layer_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/photo-magic/{doc_id}/layers/{layer_id}/lower")
    def lower_photo_magic_layer(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            return _payload(store, store.lower_layer(doc_id, layer_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/photo-magic/{doc_id}/layers/{layer_id}/raise-to-top")
    def raise_photo_magic_layer_to_top(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            return _payload(store, store.raise_layer_to_top(doc_id, layer_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/photo-magic/{doc_id}/layers/{layer_id}/lower-to-bottom")
    def lower_photo_magic_layer_to_bottom(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            return _payload(store, store.lower_layer_to_bottom(doc_id, layer_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.put("/api/photo-magic/{doc_id}/layers/reorder")
    def reorder_photo_magic_layers(
        doc_id: str,
        body: ReorderPhotoMagicLayersRequest,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> dict:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            return _payload(store, store.reorder_layers(doc_id, body.layer_ids))
        except (KeyError, ValueError) as exc:
            status = 404 if isinstance(exc, KeyError) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.get("/api/photo-magic/{doc_id}/layers/{layer_id}/raster")
    def get_photo_magic_layer_raster(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> Response:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            path = store.raster_path(doc_id, layer_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        data = path.read_bytes()
        return Response(
            content=data,
            media_type="image/png",
            headers={"Cache-Control": "private, max-age=60"},
        )

    @app.get("/api/photo-magic/{doc_id}/layers/{layer_id}/mask")
    def get_photo_magic_layer_mask(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> Response:
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        try:
            path = store.mask_path(doc_id, layer_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        data = path.read_bytes()
        return Response(
            content=data,
            media_type="image/png",
            headers={"Cache-Control": "private, max-age=60"},
        )

    def _source_response(store: PhotoMagicStore, doc_id: str, layer_id: str, *, mask: bool) -> Response:
        _load_or_404(store, doc_id)
        try:
            path = store.source_mask_path(doc_id, layer_id) if mask else store.source_path(doc_id, layer_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return Response(
            content=path.read_bytes(),
            media_type="image/png",
            headers={"Cache-Control": "private, max-age=60"},
        )

    @app.get("/api/photo-magic/{doc_id}/sources/{layer_id}")
    def get_photo_magic_layer_source(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> Response:
        return _source_response(_store_for(scope, project_id, post_id), doc_id, layer_id, mask=False)

    @app.get("/api/photo-magic/{doc_id}/sources/{layer_id}/mask")
    def get_photo_magic_layer_source_mask(
        doc_id: str,
        layer_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
    ) -> Response:
        return _source_response(_store_for(scope, project_id, post_id), doc_id, layer_id, mask=True)

    @app.post("/api/photo-magic/{doc_id}/ai-edit")
    async def photo_magic_ai_edit(
        doc_id: str,
        scope: PhotoMagicScope = Query(...),
        project_id: str | None = Query(None),
        post_id: str | None = Query(None),
        instruction: str = Form(...),
        service_id: str = Form(""),
        file: UploadFile = File(...),
    ) -> Response:
        """Compose-ready image in → AI edit → PNG bytes out (for a new/replaced layer)."""
        store = _store_for(scope, project_id, post_id)
        _load_or_404(store, doc_id)
        if get_cfg is None:
            raise HTTPException(status_code=500, detail="AI edit is not configured on this server.")
        cfg = get_cfg()
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty image upload.")
        prompt = (instruction or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="An edit instruction is required.")
        tmp_path = None
        try:
            profile = ai_services.pick_image_edit_service(cfg, service_id or None)
            tmp_path = ai_services.write_temp_image(data, suffix=".png")
            result = ai_services.run_image_edit(cfg, profile, tmp_path, prompt)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"AI image edit failed: {exc}") from exc
        finally:
            if tmp_path is not None:
                try:
                    Path(tmp_path).unlink(missing_ok=True)
                except OSError:
                    pass
        # Validate the model returned an image.
        try:
            with Image.open(io.BytesIO(result)) as check:
                check.load()
                out = io.BytesIO()
                check.convert("RGBA").save(out, format="PNG")
                payload = out.getvalue()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"AI returned an unreadable image: {exc}") from exc
        return Response(
            content=payload,
            media_type="image/png",
            headers={
                "Cache-Control": "private, no-store",
                "X-AI-Service-Id": profile.id,
                "X-AI-Service-Name": profile.name[:80],
            },
        )

