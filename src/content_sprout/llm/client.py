"""Vision / JSON LLM clients for placement and editor AI features."""

from __future__ import annotations

import base64
import io
import json
import re
from typing import Any, Protocol

import httpx
from PIL import Image

from ..config import LlmProxyConfig, OllamaConfig
from ..placement.base import Corner, LogoVariant, PlacementDecision
from .prompts import PLACEMENT_PROMPT

_CORNER_ALIASES: dict[str, Corner] = {
    "tl": "tl",
    "tr": "tr",
    "bl": "bl",
    "br": "br",
    "top_left": "tl",
    "top-right": "tr",
    "top_right": "tr",
    "bottom_left": "bl",
    "bottom-left": "bl",
    "bottom_right": "br",
    "bottom-right": "br",
}


class VisionClient(Protocol):
    """Multimodal client that returns a placement decision."""

    def decide_placement(self, img: Image.Image) -> PlacementDecision: ...


class JsonLlmClient(Protocol):
    """Client that returns structured JSON from a prompt (+ optional images)."""

    def complete_json(
        self,
        prompt: str,
        *,
        images: list[Image.Image] | None = None,
    ) -> dict[str, Any]: ...


def _image_to_base64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _parse_corner(raw: str) -> Corner:
    key = raw.strip().lower().replace(" ", "_")
    if key in _CORNER_ALIASES:
        return _CORNER_ALIASES[key]
    raise ValueError(f"invalid corner: {raw!r}")


def _parse_variant(raw: str) -> LogoVariant:
    v = raw.strip().lower()
    if v in ("dark", "white"):
        return v  # type: ignore[return-value]
    raise ValueError(f"invalid logo_variant: {raw!r}")


def extract_json(text: str) -> dict[str, Any]:
    """Parse a JSON object from model text (allows surrounding prose/fences)."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    # Greedy object match for nested JSON
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        data = json.loads(text[start : end + 1])
        if isinstance(data, dict):
            return data
    raise ValueError("Model response did not contain a JSON object")


def _decision_from_json(data: dict[str, Any]) -> PlacementDecision:
    corner = _parse_corner(str(data.get("best_corner", data.get("corner", "br"))))
    variant = _parse_variant(str(data.get("logo_variant", data.get("variant", "dark"))))
    confidence = float(data.get("confidence", 0.9))
    confidence = max(0.0, min(1.0, confidence))
    return PlacementDecision(
        corner=corner,
        logo_variant=variant,
        confidence=confidence,
        second_best_gap=1.0,
    )


class OllamaVisionClient:
    """Call a local multimodal Ollama model for JSON tasks."""

    def __init__(self, cfg: OllamaConfig):
        self._cfg = cfg
        import ollama

        self._client = ollama.Client(host=cfg.host)

    def complete_json(
        self,
        prompt: str,
        *,
        images: list[Image.Image] | None = None,
    ) -> dict[str, Any]:
        message: dict[str, Any] = {"role": "user", "content": prompt}
        if images:
            message["images"] = [_image_to_base64(img) for img in images]
        response = self._client.chat(
            model=self._cfg.model,
            messages=[message],
            format="json",
            options={
                "temperature": 0.2,
                "num_ctx": max(self._cfg.num_ctx, 8192),
            },
        )
        if isinstance(response, dict):
            content = response["message"]["content"]
        else:
            content = response.message.content
        return extract_json(content)

    def decide_placement(self, img: Image.Image) -> PlacementDecision:
        data = self.complete_json(PLACEMENT_PROMPT, images=[img])
        return _decision_from_json(data)


class OpenAICompatibleVisionClient:
    """Call an OpenAI-compatible multimodal API (PortKey, LiteLLM, OpenRouter, etc.)."""

    def __init__(self, cfg: LlmProxyConfig):
        self._cfg = cfg

    def _chat_url(self) -> str:
        base = self._cfg.base_url.rstrip("/")
        if base.endswith("/chat/completions"):
            return base
        return f"{base}/chat/completions"

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._cfg.api_key:
            headers["Authorization"] = f"Bearer {self._cfg.api_key}"
            headers["x-portkey-api-key"] = self._cfg.api_key
        if self._cfg.portkey_provider:
            headers["x-portkey-provider"] = self._cfg.portkey_provider
        if self._cfg.portkey_virtual_key:
            headers["x-portkey-virtual-key"] = self._cfg.portkey_virtual_key
        return headers

    def _chat_payload(
        self,
        *,
        prompt: str,
        images: list[Image.Image] | None = None,
        max_tokens: int = 4096,
    ) -> dict[str, Any]:
        if images:
            content: str | list[dict[str, Any]] = [{"type": "text", "text": prompt}]
            for img in images:
                b64 = _image_to_base64(img)
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                    }
                )
        else:
            content = prompt

        return {
            "model": self._cfg.model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0.2,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }

    def _post_chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._cfg.api_key:
            raise RuntimeError("LLM proxy API key is not configured.")
        with httpx.Client(timeout=float(self._cfg.timeout_s)) as client:
            response = client.post(self._chat_url(), headers=self._headers(), json=payload)
            response.raise_for_status()
            return response.json()

    def complete_json(
        self,
        prompt: str,
        *,
        images: list[Image.Image] | None = None,
    ) -> dict[str, Any]:
        data = self._post_chat(self._chat_payload(prompt=prompt, images=images))
        content = data["choices"][0]["message"]["content"]
        return extract_json(content)

    def decide_placement(self, img: Image.Image) -> PlacementDecision:
        return _decision_from_json(self.complete_json(PLACEMENT_PROMPT, images=[img]))

    def test_connection(self) -> str:
        """Send a tiny text-only request to verify auth and routing."""
        payload = self._chat_payload(prompt='Reply with JSON: {"ok":true}', max_tokens=64)
        data = self._post_chat(payload)
        content = data["choices"][0]["message"]["content"]
        return str(content).strip()[:200]
