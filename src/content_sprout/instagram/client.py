"""Thin async client for Meta Graph API."""

from __future__ import annotations

from typing import Any

import httpx

from ..config import InstagramConfig


class InstagramApiError(Exception):
    def __init__(self, message: str, *, status: int | None = None, payload: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.payload = payload


class GraphClient:
    def __init__(self, cfg: InstagramConfig) -> None:
        self._cfg = cfg
        self._base = f"https://graph.facebook.com/{cfg.graph_api_version}"

    async def get(self, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, *, data: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._request("POST", path, data=data)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = path if path.startswith("http") else f"{self._base}/{path.lstrip('/')}"
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.request(method, url, params=params, data=data)
        try:
            payload = resp.json()
        except ValueError:
            payload = {"raw": resp.text}
        if resp.is_error:
            err = payload.get("error", {}) if isinstance(payload, dict) else {}
            msg = err.get("message") if isinstance(err, dict) else str(payload)
            raise InstagramApiError(
                msg or f"Graph API {method} failed ({resp.status_code})",
                status=resp.status_code,
                payload=payload,
            )
        if not isinstance(payload, dict):
            raise InstagramApiError("Unexpected Graph API response shape", payload=payload)
        return payload
