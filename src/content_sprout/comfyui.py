"""ComfyUI client for text/image/video generation and upscale workflows."""

from __future__ import annotations

import copy
import json
import mimetypes
import random
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Literal

import httpx

from .config import ComfyUIConfig, comfy_workflow_name_for_op
from .local_ai_lock import local_ai_task

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "workflows" / "wan21_t2v_api.json"
PACKAGE_WORKFLOWS_DIR = Path(__file__).resolve().parent / "workflows"

WorkflowOp = Literal[
    "text_to_image",
    "text_to_video",
    "image_to_video",
    "upscale_image",
    "upscale_video",
]


def snap_wan_frames(frames: int) -> int:
    """Wan latent length should satisfy (length - 1) % 4 == 0."""
    n = max(1, int(frames))
    return ((n - 1) // 4) * 4 + 1


def default_workflow_path() -> Path:
    return DEFAULT_WORKFLOW


def _as_json_name(name: str) -> str:
    raw = (name or "").strip()
    if not raw:
        return ""
    if raw.lower().endswith(".json"):
        return raw
    return f"{raw}.json"


def resolve_named_workflow(
    cfg: ComfyUIConfig,
    name: str,
    *,
    config_dir: Path | None = None,
    allow_missing: bool = False,
) -> Path | None:
    """Resolve a short workflow stem to a JSON file in app storage or package defaults."""
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
        f"ComfyUI workflow not found: {raw} "
        f"(looked in ContentSprout workflows storage and built-in workflows/)"
    )


def resolve_workflow_for_op(
    cfg: ComfyUIConfig,
    op: str,
    *,
    config_dir: Path | None = None,
) -> Path:
    """Resolve the workflow JSON for a generation/upscale operation."""
    name = comfy_workflow_name_for_op(cfg, op)
    if name:
        return resolve_named_workflow(cfg, name, config_dir=config_dir)  # type: ignore[return-value]

    labels = {
        "text_to_image": "Text → image",
        "text_to_video": "Text → video",
        "image_to_video": "Image → video",
        "upscale_image": "Upscale image",
        "upscale_video": "Upscale video",
    }
    label = labels.get(op, op)
    raise ValueError(
        f"Configure a workflow for “{label}” in Settings → ComfyUI media generation."
    )


def resolve_workflows_dir(cfg: ComfyUIConfig, *, config_dir: Path | None = None) -> Path:
    """Directory where uploaded ComfyUI API workflows are stored (copied on upload)."""
    if config_dir is not None:
        path = (config_dir / "workflows").expanduser()
    else:
        path = PACKAGE_WORKFLOWS_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_ui_workflow(data: dict[str, Any]) -> bool:
    return isinstance(data, dict) and "nodes" in data and "links" in data


def list_stored_workflows(cfg: ComfyUIConfig, *, config_dir: Path | None = None) -> list[dict[str, str]]:
    """List workflow JSON files available for assignment (user dir + package defaults)."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []

    def add(path: Path, *, source: str) -> None:
        stem = path.stem
        if stem in seen:
            return
        seen.add(stem)
        out.append({"stem": stem, "filename": path.name, "source": source})

    folder = resolve_workflows_dir(cfg, config_dir=config_dir)
    for path in sorted(folder.glob("*.json")):
        if path.is_file():
            add(path, source="user")
    for path in sorted(PACKAGE_WORKFLOWS_DIR.glob("*.json")):
        if path.is_file():
            add(path, source="package")
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
