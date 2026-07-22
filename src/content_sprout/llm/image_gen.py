"""OpenAI-compatible image edit / generation client."""

from __future__ import annotations

import base64
import io
from typing import Protocol

import httpx
from PIL import Image

from ..config import ImageGenConfig


class ImageGenClient(Protocol):
    def edit_image(self, img: Image.Image, prompt: str) -> bytes: ...


class OpenAICompatibleImageGenClient:
    """Call OpenAI-compatible /images/edits (falls back to /images/generations)."""

    def __init__(self, cfg: ImageGenConfig):
        self._cfg = cfg

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self._cfg.api_key:
            headers["Authorization"] = f"Bearer {self._cfg.api_key}"
            headers["x-portkey-api-key"] = self._cfg.api_key
        if self._cfg.portkey_provider:
            headers["x-portkey-provider"] = self._cfg.portkey_provider
        if self._cfg.portkey_virtual_key:
            headers["x-portkey-virtual-key"] = self._cfg.portkey_virtual_key
        return headers

    def _base(self) -> str:
        return self._cfg.base_url.rstrip("/")

    def _image_png_bytes(self, img: Image.Image) -> bytes:
        buf = io.BytesIO()
        img.convert("RGBA").save(buf, format="PNG")
        return buf.getvalue()

    def _decode_response(self, data: dict) -> bytes:
        items = data.get("data") or []
        if not items:
            raise RuntimeError("Image API returned no data")
        item = items[0]
        if item.get("b64_json"):
            return base64.b64decode(item["b64_json"])
        url = item.get("url")
        if url:
            with httpx.Client(timeout=float(self._cfg.timeout_s)) as client:
                r = client.get(url)
                r.raise_for_status()
                return r.content
        raise RuntimeError("Image API response missing b64_json and url")

    def edit_image(self, img: Image.Image, prompt: str) -> bytes:
        if self._cfg.provider == "proxy" and not (
            (self._cfg.api_key or "").strip() or (self._cfg.portkey_virtual_key or "").strip()
        ):
            raise RuntimeError("Image generation API key is not configured.")
        png = self._image_png_bytes(img)
        edits_url = f"{self._base()}/images/edits"
        files = {
            "image": ("image.png", png, "image/png"),
        }
        data = {
            "model": self._cfg.model,
            "prompt": prompt[:32000],
            "n": "1",
            "size": "1024x1024",
            "response_format": "b64_json",
        }
        with httpx.Client(timeout=float(self._cfg.timeout_s)) as client:
            response = client.post(
                edits_url,
                headers=self._headers(),
                data=data,
                files=files,
            )
            if response.status_code == 404:
                # Some gateways only expose generations — send a text-only request.
                gen_url = f"{self._base()}/images/generations"
                payload = {
                    "model": self._cfg.model,
                    "prompt": f"Edit this photo (described conceptually): {prompt}",
                    "n": 1,
                    "size": "1024x1024",
                    "response_format": "b64_json",
                }
                response = client.post(
                    gen_url,
                    headers={**self._headers(), "Content-Type": "application/json"},
                    json=payload,
                )
            response.raise_for_status()
            return self._decode_response(response.json())
