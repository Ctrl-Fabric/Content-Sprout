"""Google Gemini API clients for JSON/vision LLM and Nano Banana image generation."""

from __future__ import annotations

import base64
import io
import mimetypes
from pathlib import Path
from typing import Any, Callable

import httpx
from PIL import Image

from ..config import AppConfig, GeminiConfig, gemini_api_key
from ..placement.base import PlacementDecision
from .client import _decision_from_json, extract_json
from .prompts import PLACEMENT_PROMPT

ProgressCallback = Callable[[str], None]

_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"


def _aspect_ratio_for_size(width: int, height: int) -> str:
    """Map pixel size to a Gemini-supported aspect ratio string."""
    if width <= 0 or height <= 0:
        return "1:1"
    ratio = width / height
    candidates = {
        "1:1": 1.0,
        "3:4": 0.75,
        "4:3": 4 / 3,
        "9:16": 9 / 16,
        "16:9": 16 / 9,
        "2:3": 2 / 3,
        "3:2": 1.5,
        "4:5": 0.8,
        "5:4": 1.25,
    }
    best = min(candidates.items(), key=lambda item: abs(item[1] - ratio))
    return best[0]


def _image_part(img: Image.Image) -> dict[str, Any]:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=88)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {"inline_data": {"mime_type": "image/jpeg", "data": b64}}


def _extract_text(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {payload!r}")
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    texts: list[str] = []
    for part in parts:
        if isinstance(part, dict) and part.get("text"):
            texts.append(str(part["text"]))
    if not texts:
        raise RuntimeError("Gemini response contained no text parts")
    return "\n".join(texts)


def _extract_image_bytes(payload: dict[str, Any]) -> bytes:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {payload!r}")
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    for part in parts:
        if not isinstance(part, dict):
            continue
        inline = part.get("inlineData") or part.get("inline_data")
        if isinstance(inline, dict) and inline.get("data"):
            raw = base64.b64decode(inline["data"])
            mime = str(inline.get("mimeType") or inline.get("mime_type") or "image/png")
            if "jpeg" in mime or "jpg" in mime:
                img = Image.open(io.BytesIO(raw))
                out = io.BytesIO()
                img.convert("RGB").save(out, format="PNG")
                return out.getvalue()
            return raw
    raise RuntimeError("Gemini response contained no image parts")


class GeminiVisionClient:
    """Gemini generateContent client implementing VisionClient / JsonLlmClient."""

    def __init__(self, cfg: GeminiConfig | AppConfig, *, api_key: str | None = None):
        if isinstance(cfg, AppConfig):
            self._cfg = cfg.gemini
            self._api_key = api_key or gemini_api_key(cfg)
        else:
            self._cfg = cfg
            self._api_key = (api_key or cfg.api_key or "").strip()

    def _model_for_images(self, images: list[Image.Image] | None) -> str:
        if images and (self._cfg.vision_model or "").strip():
            return self._cfg.vision_model.strip()
        return (self._cfg.model or "gemini-2.5-flash").strip()

    def _generate(
        self,
        *,
        model: str,
        parts: list[dict[str, Any]],
        generation_config: dict[str, Any] | None = None,
        timeout_s: float | None = None,
    ) -> dict[str, Any]:
        if not self._api_key:
            raise RuntimeError("Gemini API key is not configured.")
        url = f"{_GEMINI_BASE}/models/{model}:generateContent"
        body: dict[str, Any] = {"contents": [{"role": "user", "parts": parts}]}
        if generation_config:
            body["generationConfig"] = generation_config
        try:
            with httpx.Client(timeout=float(timeout_s or self._cfg.timeout_s)) as client:
                response = client.post(url, params={"key": self._api_key}, json=body)
                if response.status_code >= 400:
                    response.raise_for_status()
                return response.json()
        except Exception as exc:  # noqa: BLE001
            from .errors import format_llm_error

            raise RuntimeError(
                format_llm_error(exc, host="generativelanguage.googleapis.com", model=model)
            ) from exc

    def complete_json(
        self,
        prompt: str,
        *,
        images: list[Image.Image] | None = None,
    ) -> dict[str, Any]:
        parts: list[dict[str, Any]] = [{"text": prompt}]
        if images:
            parts.extend(_image_part(img) for img in images)
        payload = self._generate(
            model=self._model_for_images(images),
            parts=parts,
            generation_config={
                "temperature": 0.2,
                "responseMimeType": "application/json",
            },
        )
        return extract_json(_extract_text(payload))

    def decide_placement(self, img: Image.Image) -> PlacementDecision:
        return _decision_from_json(self.complete_json(PLACEMENT_PROMPT, images=[img]))

    def test_connection(self) -> str:
        payload = self._generate(
            model=(self._cfg.model or "gemini-2.5-flash").strip(),
            parts=[{"text": 'Reply with JSON: {"ok":true}'}],
            generation_config={
                "temperature": 0.0,
                "responseMimeType": "application/json",
                "maxOutputTokens": 64,
            },
            timeout_s=min(30.0, float(self._cfg.timeout_s)),
        )
        return _extract_text(payload).strip()[:200]


class GeminiImageClient:
    """Nano Banana / Gemini image generation + enhance."""

    def __init__(self, cfg: GeminiConfig | AppConfig, *, api_key: str | None = None):
        if isinstance(cfg, AppConfig):
            self._cfg = cfg.gemini
            self._api_key = api_key or gemini_api_key(cfg)
        else:
            self._cfg = cfg
            self._api_key = (api_key or cfg.api_key or "").strip()

    def _generate_image(
        self,
        parts: list[dict[str, Any]],
        *,
        width: int | None = None,
        height: int | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> bytes:
        if not self._api_key:
            raise RuntimeError("Gemini API key is not configured.")
        model = (self._cfg.image_model or "gemini-2.5-flash-image").strip()
        generation_config: dict[str, Any] = {
            "responseModalities": ["TEXT", "IMAGE"],
        }
        if width and height:
            generation_config["imageConfig"] = {
                "aspectRatio": _aspect_ratio_for_size(width, height),
            }
        if on_progress:
            on_progress(f"Gemini image · {model}…")
        url = f"{_GEMINI_BASE}/models/{model}:generateContent"
        body = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": generation_config,
        }
        with httpx.Client(timeout=float(self._cfg.image_timeout_s)) as client:
            response = client.post(url, params={"key": self._api_key}, json=body)
            if response.status_code >= 400:
                detail = response.text[:500]
                raise RuntimeError(f"Gemini image error {response.status_code}: {detail}")
            payload = response.json()
        if on_progress:
            on_progress("Saving Gemini image…")
        return _extract_image_bytes(payload)

    def text_to_image(
        self,
        prompt: str,
        *,
        width: int = 512,
        height: int = 512,
        negative_prompt: str | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        text = (prompt or "").strip()
        if not text:
            raise ValueError("prompt is required")
        neg = (negative_prompt or "").strip()
        if neg:
            text = f"{text}\n\nAvoid: {neg}"
        data = self._generate_image(
            [{"text": text}],
            width=width,
            height=height,
            on_progress=on_progress,
        )
        return {"data": data, "filename": "gemini-image.png"}

    def enhance_image(
        self,
        input_path: Path,
        *,
        scale: float = 2.0,
        width: int | None = None,
        height: int | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        path = Path(input_path)
        if not path.is_file():
            raise FileNotFoundError(f"Image not found: {path}")
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        raw = path.read_bytes()
        b64 = base64.b64encode(raw).decode("ascii")
        prompt = (
            f"Enhance and upscale this image about {scale:g}×. "
            "Preserve subject, composition, and style; increase clarity and detail."
        )
        if width and height:
            prompt += f" Target size approximately {width}×{height} pixels."
        parts = [
            {"text": prompt},
            {"inline_data": {"mime_type": mime, "data": b64}},
        ]
        data = self._generate_image(
            parts,
            width=width,
            height=height,
            on_progress=on_progress,
        )
        return {"data": data, "filename": "gemini-upscale.png"}
