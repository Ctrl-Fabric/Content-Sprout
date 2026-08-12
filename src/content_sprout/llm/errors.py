"""Human-readable errors for Ollama / Gemini / OpenAI-compatible LLM calls."""

from __future__ import annotations

import json
from typing import Any

import httpx


def format_llm_error(exc: BaseException, *, host: str | None = None, model: str | None = None) -> str:
    """Turn a raw LLM/httpx/Ollama exception into a short message for the UI."""
    if isinstance(exc, httpx.HTTPStatusError):
        return _http_status_message(exc, model=model)
    if isinstance(exc, (httpx.ConnectError, ConnectionError, ConnectionRefusedError)):
        where = host or _host_from_exc(exc) or "the LLM host"
        return f"Could not reach the LLM at {where}. Is the service running?"
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        where = host or _host_from_exc(exc)
        suffix = f" at {where}" if where else ""
        return f"The LLM timed out{suffix}. Try again, or raise the timeout in Settings."
    if isinstance(exc, httpx.RequestError):
        where = host or _host_from_exc(exc) or "the LLM host"
        return f"Could not reach the LLM at {where}: {_clean(str(exc) or type(exc).__name__)}"

    ollama_msg = _ollama_response_error(exc, model=model)
    if ollama_msg:
        return ollama_msg

    raw = _clean(str(exc) or type(exc).__name__)
    lowered = raw.lower()
    if "connection refused" in lowered or "errno 61" in lowered or "errno 111" in lowered:
        where = host or "the configured LLM host"
        return f"Could not reach the LLM at {where}. Is the service running?"
    if "timed out" in lowered or "timeout" in lowered:
        return f"The LLM timed out. Try again, or raise the timeout in Settings. ({raw})"
    if "api key" in lowered or "unauthorized" in lowered or "invalid_api_key" in lowered:
        return raw if raw.lower().startswith(("gemini", "llm", "set ")) else f"LLM authentication failed: {raw}"
    if "did not contain a json object" in lowered:
        return "The model replied, but it was not valid JSON. Try again or switch models in Settings."
    if "not found" in lowered and model:
        return f"LLM model {model!r} was not found. Pull or select it in Settings."
    return raw


def _http_status_message(exc: httpx.HTTPStatusError, *, model: str | None = None) -> str:
    status = exc.response.status_code if exc.response is not None else 0
    body = _response_body(exc)
    if status in (401, 403):
        return body or "LLM authentication failed. Check the API key in Settings."
    if status == 404:
        if model:
            return f"LLM model {model!r} was not found. Pull or select it in Settings."
        return body or "LLM endpoint or model was not found. Check Settings."
    if status == 429:
        return body or "The LLM rate-limited the request. Wait a moment and try again."
    if status >= 500:
        return body or f"The LLM returned HTTP {status}. Check the provider status and try again."
    return body or f"LLM request failed (HTTP {status})."


def _response_body(exc: httpx.HTTPStatusError) -> str:
    response = exc.response
    if response is None:
        return ""
    try:
        payload = response.json()
    except Exception:  # noqa: BLE001
        text = (response.text or "").strip()
        return _clean(text[:400]) if text else ""
    detail = _json_detail(payload)
    return _clean(detail) if detail else ""


def _json_detail(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, dict):
        return ""
    for key in ("error", "detail", "message", "msg"):
        value = payload.get(key)
        if isinstance(value, dict):
            nested = value.get("message") or value.get("msg") or value.get("detail")
            if nested:
                return str(nested)
            return json.dumps(value)[:400]
        if isinstance(value, list) and value:
            first = value[0]
            if isinstance(first, dict):
                return str(first.get("msg") or first.get("message") or first)
            return str(first)
        if value:
            return str(value)
    return ""


def _ollama_response_error(exc: BaseException, *, model: str | None = None) -> str | None:
    name = type(exc).__name__
    module = type(exc).__module__ or ""
    if name != "ResponseError" and "ollama" not in module.lower():
        return None
    raw = _clean(str(exc) or name)
    status = getattr(exc, "status_code", None)
    if status in (401, 403):
        return "Ollama rejected the request (unauthorized). Check the host URL in Settings."
    if status == 404 or "not found" in raw.lower():
        target = model or raw
        return f"Ollama model {target!r} was not found. Pull it with `ollama pull`, or pick another model in Settings."
    if raw:
        return f"Ollama error: {raw}"
    return "Ollama returned an error."


def _host_from_exc(exc: BaseException) -> str | None:
    request = getattr(exc, "request", None)
    url = getattr(request, "url", None)
    if url is None:
        return None
    host = str(getattr(url, "host", "") or "").strip()
    if not host:
        return None
    port = getattr(url, "port", None)
    scheme = str(getattr(url, "scheme", "") or "").strip()
    if port:
        return f"{scheme}://{host}:{port}" if scheme else f"{host}:{port}"
    return f"{scheme}://{host}" if scheme else host


def _clean(text: str) -> str:
    text = " ".join(str(text or "").split()).strip()
    if text.startswith("[Errno"):
        # "[Errno 61] Connection refused" → keep the useful tail when possible
        pass
    return text[:500]
