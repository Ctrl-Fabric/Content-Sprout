"""ComfyUI client for local text-to-video (Wan 2.1 native workflows)."""

from __future__ import annotations

import copy
import json
import random
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from .config import ComfyUIConfig

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "workflows" / "wan21_t2v_api.json"

# Wan latent length should satisfy (length - 1) % 4 == 0.
def snap_wan_frames(frames: int) -> int:
    n = max(1, int(frames))
    return ((n - 1) // 4) * 4 + 1


def default_workflow_path() -> Path:
    return DEFAULT_WORKFLOW


def resolve_workflow_path(cfg: ComfyUIConfig, *, config_dir: Path | None = None) -> Path:
    raw = (cfg.workflow_path or "").strip()
    if not raw:
        return DEFAULT_WORKFLOW
    path = Path(raw).expanduser()
    if path.is_file():
        return path
    if config_dir is not None:
        cand = (config_dir / raw).expanduser()
        if cand.is_file():
            return cand
    raise FileNotFoundError(f"ComfyUI workflow not found: {raw}")


def load_workflow(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not data:
        raise ValueError("Workflow must be a non-empty JSON object (ComfyUI API format)")
    # Reject obvious UI-format exports.
    if "nodes" in data and "links" in data and not any(
        isinstance(v, dict) and "class_type" in v for v in data.values()
    ):
        raise ValueError(
            "Workflow looks like the ComfyUI UI format. Export via "
            "File → Save (API Format) and point Settings at that JSON."
        )
    return data


def _link_target(value: Any) -> tuple[str, int] | None:
    if isinstance(value, list) and len(value) >= 2:
        return str(value[0]), int(value[1])
    return None


def patch_workflow(
    workflow: dict[str, Any],
    *,
    prompt: str,
    negative_prompt: str,
    width: int,
    height: int,
    frames: int,
    fps: float,
    steps: int,
    cfg: float,
    seed: int | None,
    diffusion_model: str,
    clip_name: str,
    vae_name: str,
) -> dict[str, Any]:
    """Inject generation params into a ComfyUI API-format workflow."""
    graph = copy.deepcopy(workflow)
    seed_value = int(seed) if seed is not None else random.randint(0, 2**53 - 1)
    length = snap_wan_frames(frames)

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
    # Fallback when KSampler links are missing: first encode = positive, second = negative.
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
            if nid in positive_ids:
                inputs["text"] = prompt
            elif nid in negative_ids:
                inputs["text"] = negative_prompt
        elif ctype == "EmptyHunyuanLatentVideo":
            inputs["width"] = int(width)
            inputs["height"] = int(height)
            inputs["length"] = int(length)
            inputs.setdefault("batch_size", 1)
        elif ctype == "UNETLoader":
            if diffusion_model:
                inputs["unet_name"] = diffusion_model
        elif ctype == "CLIPLoader":
            if clip_name:
                inputs["clip_name"] = clip_name
            inputs.setdefault("type", "wan")
        elif ctype == "VAELoader":
            if vae_name:
                inputs["vae_name"] = vae_name
        elif ctype == "KSampler":
            inputs["seed"] = seed_value
            inputs["steps"] = int(steps)
            inputs["cfg"] = float(cfg)
        elif ctype == "CreateVideo":
            inputs["fps"] = float(fps)
        elif ctype == "SaveVideo":
            inputs.setdefault("filename_prefix", "content_sprout/wan")
            inputs.setdefault("format", "auto")
            inputs.setdefault("codec", "auto")
        elif ctype == "VHS_VideoCombine":
            inputs["frame_rate"] = int(round(fps))
            inputs.setdefault("filename_prefix", "content_sprout/wan")

    return graph


class ComfyUIClient:
    """Queue a prompt on ComfyUI and download the resulting video bytes."""

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
        text = (prompt or "").strip()
        if not text:
            raise ValueError("Prompt is required")

        workflow_path = resolve_workflow_path(self._cfg, config_dir=self._config_dir)
        workflow = load_workflow(workflow_path)
        patched = patch_workflow(
            workflow,
            prompt=text,
            negative_prompt=(
                negative_prompt
                if negative_prompt is not None
                else self._cfg.negative_prompt
            ),
            width=width if width is not None else self._cfg.width,
            height=height if height is not None else self._cfg.height,
            frames=frames if frames is not None else self._cfg.frames,
            fps=fps if fps is not None else self._cfg.fps,
            steps=steps if steps is not None else self._cfg.steps,
            cfg=cfg if cfg is not None else self._cfg.cfg,
            seed=seed,
            diffusion_model=self._cfg.diffusion_model,
            clip_name=self._cfg.clip_name,
            vae_name=self._cfg.vae_name,
        )

        client_id = str(uuid.uuid4())
        timeout = httpx.Timeout(float(self._cfg.timeout_s))
        with httpx.Client(timeout=timeout) as client:
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
            history_entry: dict[str, Any] | None = None
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
                time.sleep(max(0.5, float(self._cfg.poll_interval_s)))
            else:
                raise TimeoutError(
                    f"ComfyUI timed out after {self._cfg.timeout_s}s waiting for prompt {prompt_id}"
                )

            file_info = _first_video_file(history_entry.get("outputs") or {})
            if not file_info:
                raise RuntimeError("ComfyUI finished but no video output was found in history")

            params = {
                "filename": file_info["filename"],
                "subfolder": file_info.get("subfolder") or "",
                "type": file_info.get("type") or "output",
            }
            view = client.get(f"{self._base()}/view", params=params, headers=self._headers())
            view.raise_for_status()
            data = view.content
            if not data:
                raise RuntimeError("ComfyUI returned an empty video file")
            return data


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
        # Some custom nodes nest file info under arbitrary keys.
        for value in node_out.values():
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict) and _ok(item, require_video_ext=True):
                        return item
    return None
