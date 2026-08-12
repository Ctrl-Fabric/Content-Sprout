"""Higgsfield platform client for async image/video generation."""

from __future__ import annotations

import mimetypes
import time
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import urljoin

import httpx

from ..config import AppConfig, HiggsfieldConfig, higgsfield_endpoint_for_op

ProgressCallback = Callable[[str], None]
ExpectKind = Literal["image", "video"]


def _aspect_ratio_for_size(width: int, height: int) -> str:
    if width <= 0 or height <= 0:
        return "1:1"
    ratio = width / height
    candidates = {
        "1:1": 1.0,
        "4:3": 4 / 3,
        "3:4": 0.75,
        "16:9": 16 / 9,
        "9:16": 9 / 16,
    }
    return min(candidates.items(), key=lambda item: abs(item[1] - ratio))[0]


def _guess_content_type(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0]
    if mime:
        return mime
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".mp4":
        return "video/mp4"
    return "image/png"


class HiggsfieldClient:
    """Submit → poll → download against platform.higgsfield.ai."""

    def __init__(self, cfg: HiggsfieldConfig | AppConfig):
        if isinstance(cfg, AppConfig):
            self._cfg = cfg.higgsfield
        else:
            self._cfg = cfg

    def _headers(self) -> dict[str, str]:
        key_id = (self._cfg.api_key_id or "").strip()
        secret = (self._cfg.api_key_secret or "").strip()
        if not key_id or not secret:
            raise RuntimeError("Higgsfield API key id and secret are required.")
        return {
            "Authorization": f"Key {key_id}:{secret}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _base(self) -> str:
        return (self._cfg.base_url or "https://platform.higgsfield.ai").rstrip("/") + "/"

    def _endpoint_url(self, endpoint: str) -> str:
        path = endpoint.strip().lstrip("/")
        if not path:
            raise ValueError("Higgsfield endpoint is empty")
        return urljoin(self._base(), path)

    def upload_file(self, path: Path, *, on_progress: ProgressCallback | None = None) -> str:
        """Upload local media via presigned URL; return public_url for model input."""
        path = Path(path)
        if not path.is_file():
            raise FileNotFoundError(f"Input file not found: {path}")
        content_type = _guess_content_type(path)
        if on_progress:
            on_progress("Uploading input to Higgsfield…")
        with httpx.Client(timeout=float(self._cfg.timeout_s)) as client:
            create = client.post(
                urljoin(self._base(), "files/generate-upload-url"),
                headers=self._headers(),
                json={"content_type": content_type},
            )
            if create.status_code >= 400:
                raise RuntimeError(
                    f"Higgsfield upload URL error {create.status_code}: {create.text[:400]}"
                )
            meta = create.json()
            upload_url = meta.get("upload_url")
            public_url = meta.get("public_url")
            if not upload_url or not public_url:
                raise RuntimeError(f"Unexpected upload URL response: {meta!r}")
            upload_headers = dict(meta.get("upload_headers") or {})
            # Do not send Higgsfield auth to the storage host.
            put = client.put(
                upload_url,
                headers=upload_headers,
                content=path.read_bytes(),
            )
            if put.status_code >= 400:
                raise RuntimeError(
                    f"Higgsfield file upload failed {put.status_code}: {put.text[:400]}"
                )
        return str(public_url)

    def _submit(self, endpoint: str, body: dict[str, Any]) -> dict[str, Any]:
        with httpx.Client(timeout=float(self._cfg.timeout_s)) as client:
            response = client.post(
                self._endpoint_url(endpoint),
                headers=self._headers(),
                json=body,
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    f"Higgsfield submit error {response.status_code}: {response.text[:500]}"
                )
            return response.json()

    def _poll_until_done(
        self,
        submit_response: dict[str, Any],
        *,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        request_id = submit_response.get("request_id")
        status_url = submit_response.get("status_url")
        if not status_url and request_id:
            status_url = urljoin(self._base(), f"requests/{request_id}/status")
        if not status_url:
            raise RuntimeError(f"Higgsfield submit missing status_url: {submit_response!r}")

        started = time.monotonic()
        interval = max(0.5, float(self._cfg.poll_interval_s or 2.0))
        timeout = float(self._cfg.timeout_s)
        last_status = str(submit_response.get("status") or "queued")

        with httpx.Client(timeout=float(self._cfg.timeout_s)) as client:
            while True:
                elapsed = time.monotonic() - started
                if elapsed > timeout:
                    raise TimeoutError(
                        f"Higgsfield job timed out after {int(elapsed)}s (last status={last_status})"
                    )
                if on_progress:
                    on_progress(f"Higgsfield · {last_status} ({int(elapsed)}s)…")
                response = client.get(status_url, headers=self._headers())
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Higgsfield status error {response.status_code}: {response.text[:400]}"
                    )
                payload = response.json()
                last_status = str(payload.get("status") or last_status)
                if last_status in {"completed", "failed", "nsfw", "canceled", "cancelled"}:
                    if last_status != "completed":
                        detail = payload.get("error") or payload.get("detail") or last_status
                        raise RuntimeError(f"Higgsfield job {last_status}: {detail}")
                    return payload
                time.sleep(interval)

    def _download_result(
        self,
        status_payload: dict[str, Any],
        *,
        expect: ExpectKind,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        url: str | None = None
        filename = "higgsfield.bin"
        if expect == "video":
            video = status_payload.get("video")
            if isinstance(video, dict):
                url = video.get("url")
            elif isinstance(video, str):
                url = video
            if not url:
                videos = status_payload.get("videos")
                if isinstance(videos, list) and videos:
                    first = videos[0]
                    url = first.get("url") if isinstance(first, dict) else first
            filename = "higgsfield-video.mp4"
        else:
            images = status_payload.get("images")
            if isinstance(images, list) and images:
                first = images[0]
                url = first.get("url") if isinstance(first, dict) else first
            if not url:
                image = status_payload.get("image")
                if isinstance(image, dict):
                    url = image.get("url")
                elif isinstance(image, str):
                    url = image
            filename = "higgsfield-image.png"

        if not url:
            raise RuntimeError(f"Higgsfield completed without media URL: {status_payload!r}")
        if on_progress:
            on_progress("Downloading Higgsfield result…")
        with httpx.Client(timeout=float(self._cfg.timeout_s), follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
            data = response.content
        # Prefer extension from URL when obvious.
        lower = url.lower().split("?", 1)[0]
        if lower.endswith(".jpg") or lower.endswith(".jpeg"):
            filename = "higgsfield-image.jpg"
        elif lower.endswith(".webp"):
            filename = "higgsfield-image.webp"
        elif lower.endswith(".png"):
            filename = "higgsfield-image.png"
        elif lower.endswith(".mp4"):
            filename = "higgsfield-video.mp4"
        elif lower.endswith(".webm"):
            filename = "higgsfield-video.webm"
        return {"data": data, "filename": filename, "url": url}

    def run_job(
        self,
        op: str,
        *,
        prompt: str = "",
        negative_prompt: str | None = None,
        width: int | None = None,
        height: int | None = None,
        input_path: Path | None = None,
        scale: float | None = None,
        expect: ExpectKind = "image",
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        endpoint = higgsfield_endpoint_for_op(self._cfg, op)
        if not endpoint:
            raise RuntimeError(f"Higgsfield endpoint for {op!r} is not configured.")

        body: dict[str, Any] = {}
        text = (prompt or "").strip()
        if text:
            body["prompt"] = text
        neg = (negative_prompt or "").strip()
        if neg:
            body["negative_prompt"] = neg
        if width and height:
            body["aspect_ratio"] = _aspect_ratio_for_size(width, height)
        if scale is not None:
            body["scale"] = float(scale)

        if input_path is not None:
            public_url = self.upload_file(Path(input_path), on_progress=on_progress)
            # Common parameter names across Higgsfield image/video endpoints.
            if op in {"image_to_video", "upscale_video"}:
                body["image_url"] = public_url
            elif op == "upscale_image":
                body["image_url"] = public_url
            else:
                body["image_url"] = public_url

        if on_progress:
            on_progress(f"Submitting Higgsfield {op}…")
        submitted = self._submit(endpoint, body)
        completed = self._poll_until_done(submitted, on_progress=on_progress)
        return self._download_result(completed, expect=expect, on_progress=on_progress)
