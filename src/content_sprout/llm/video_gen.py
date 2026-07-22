"""OpenAI-compatible text-to-video client for cloud / gateway endpoints."""

from __future__ import annotations

import base64
import time
from typing import Any

import httpx

from ..config import ComfyUIConfig


class OpenAICompatibleVideoGenClient:
    """Best-effort OpenAI-compatible video generations API.

    Posts to ``{base}/videos/generations`` (or ``/v1/videos/generations`` if base
    has no ``/v1``). Supports immediate ``b64_json`` / ``url`` responses and a
    simple status-poll loop when the API returns an id.
    """

    def __init__(self, cfg: ComfyUIConfig):
        self._cfg = cfg

    def _base(self) -> str:
        return (self._cfg.gateway_base_url or "").rstrip("/")

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        key = (self._cfg.gateway_api_key or "").strip()
        if key:
            headers["Authorization"] = f"Bearer {key}"
            headers["x-portkey-api-key"] = key
        if self._cfg.portkey_provider:
            headers["x-portkey-provider"] = self._cfg.portkey_provider
        if self._cfg.portkey_virtual_key:
            headers["x-portkey-virtual-key"] = self._cfg.portkey_virtual_key
        return headers

    def _generations_url(self) -> str:
        base = self._base()
        if base.endswith("/v1"):
            return f"{base}/videos/generations"
        return f"{base}/v1/videos/generations"

    def generate_video(
        self,
        prompt: str,
        *,
        width: int | None = None,
        height: int | None = None,
        seconds: float | None = None,
    ) -> bytes:
        w = int(width or self._cfg.width)
        h = int(height or self._cfg.height)
        dur = seconds
        if dur is None:
            dur = float(self._cfg.frames) / max(1.0, float(self._cfg.fps))
        payload: dict[str, Any] = {
            "model": self._cfg.gateway_model,
            "prompt": (prompt or "")[:8000],
            "size": f"{w}x{h}",
            "seconds": max(1, int(round(dur))),
        }
        timeout = httpx.Timeout(float(self._cfg.gateway_timeout_s or self._cfg.timeout_s))
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            response = client.post(
                self._generations_url(),
                headers=self._headers(),
                json=payload,
            )
            if response.status_code == 404:
                # Some gateways nest under /videos without /generations.
                alt = f"{self._base()}/videos" if self._base().endswith("/v1") else f"{self._base()}/v1/videos"
                response = client.post(alt, headers=self._headers(), json=payload)
            response.raise_for_status()
            data = response.json()
            return self._extract_bytes(client, data)

    def _extract_bytes(self, client: httpx.Client, data: dict[str, Any]) -> bytes:
        # Immediate OpenAI-images-style payload.
        items = data.get("data") if isinstance(data, dict) else None
        if isinstance(items, list) and items:
            item = items[0] if isinstance(items[0], dict) else {}
            if item.get("b64_json"):
                return base64.b64decode(item["b64_json"])
            url = item.get("url")
            if url:
                r = client.get(url)
                r.raise_for_status()
                return r.content

        if isinstance(data, dict):
            if data.get("b64_json"):
                return base64.b64decode(data["b64_json"])
            direct_url = data.get("url") or data.get("video_url")
            if direct_url and str(direct_url).startswith("http"):
                r = client.get(direct_url)
                r.raise_for_status()
                return r.content

        # Async job: poll status URL or /videos/{id}
        job_id = data.get("id") if isinstance(data, dict) else None
        status_url = None
        if isinstance(data, dict):
            status_url = data.get("status_url") or data.get("href")
        if job_id and not status_url:
            base = self._base()
            status_url = (
                f"{base}/videos/{job_id}"
                if base.endswith("/v1")
                else f"{base}/v1/videos/{job_id}"
            )
        if status_url:
            deadline = time.monotonic() + float(self._cfg.gateway_timeout_s or self._cfg.timeout_s)
            while time.monotonic() < deadline:
                r = client.get(status_url, headers=self._headers())
                r.raise_for_status()
                body = r.json()
                status = str(body.get("status") or body.get("state") or "").lower()
                if status in {"failed", "error", "cancelled"}:
                    raise RuntimeError(f"Video generation failed: {body}")
                nested = body.get("data") if isinstance(body, dict) else None
                if isinstance(nested, list) and nested:
                    item = nested[0] if isinstance(nested[0], dict) else {}
                    if item.get("b64_json"):
                        return base64.b64decode(item["b64_json"])
                    url = item.get("url")
                    if url:
                        vr = client.get(url)
                        vr.raise_for_status()
                        return vr.content
                if status in {"completed", "succeeded", "ready", "done"}:
                    raise RuntimeError(f"Video job completed but no file URL was returned: {body}")
                time.sleep(2.0)
            raise TimeoutError("Timed out waiting for cloud video generation")

        raise RuntimeError(
            "Video gateway response missing video data. "
            "Expected data[].url / b64_json or a pollable job id."
        )
