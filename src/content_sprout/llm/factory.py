"""Factory for vision / JSON LLM and image-gen clients."""

from __future__ import annotations

from typing import Any

from ..ai_services import can_use_llm, get_service, pick_llm_service, public_service
from ..config import (
    AiServiceProfile,
    AppConfig,
    GeminiConfig,
    LlmProxyConfig,
    OllamaConfig,
    gemini_api_key,
    image_gen_ready,
)
from .client import JsonLlmClient, OllamaVisionClient, OpenAICompatibleVisionClient, VisionClient
from .errors import format_llm_error
from .gemini_client import GeminiVisionClient
from .image_gen import ImageGenClient, OpenAICompatibleImageGenClient


def _profile_to_ollama(profile: AiServiceProfile, cfg: AppConfig) -> OllamaConfig:
    return OllamaConfig(
        host=(profile.base_url or "").strip() or cfg.ollama.host or "http://localhost:11434",
        model=(profile.model or "").strip() or cfg.ollama.model or "gemma4:31b",
        timeout_s=int(profile.timeout_s or cfg.ollama.timeout_s or 300),
        num_ctx=cfg.ollama.num_ctx,
    )


def _profile_to_proxy(profile: AiServiceProfile) -> LlmProxyConfig:
    return LlmProxyConfig(
        base_url=(profile.base_url or "").strip() or "https://api.openai.com/v1",
        api_key=profile.api_key or "",
        model=(profile.model or "").strip() or "gpt-4o",
        timeout_s=int(profile.timeout_s or 180),
        portkey_provider=profile.portkey_provider or "",
        portkey_virtual_key=profile.portkey_virtual_key or "",
    )


def _profile_to_gemini(profile: AiServiceProfile, cfg: AppConfig) -> GeminiConfig:
    return GeminiConfig(
        api_key=(profile.api_key or "").strip() or gemini_api_key(cfg),
        model=(profile.model or "").strip() or cfg.gemini.model or "gemini-2.5-flash",
        vision_model=cfg.gemini.vision_model,
        timeout_s=int(profile.timeout_s or cfg.gemini.timeout_s or 180),
        image_model=cfg.gemini.image_model,
        image_timeout_s=cfg.gemini.image_timeout_s,
    )


def create_json_client_from_profile(profile: AiServiceProfile, cfg: AppConfig) -> JsonLlmClient:
    if not can_use_llm(profile, cfg):
        raise RuntimeError(f"Text & Vision AI service {profile.name!r} is not ready.")
    if profile.protocol == "ollama":
        return OllamaVisionClient(_profile_to_ollama(profile, cfg))
    if profile.protocol == "openai_chat":
        return OpenAICompatibleVisionClient(_profile_to_proxy(profile))
    if profile.protocol == "gemini":
        return GeminiVisionClient(_profile_to_gemini(profile, cfg))
    raise RuntimeError(f"LLM protocol {profile.protocol!r} does not support JSON calls.")


def create_vision_client_from_profile(profile: AiServiceProfile, cfg: AppConfig) -> VisionClient:
    client = create_json_client_from_profile(profile, cfg)
    if not hasattr(client, "decide_placement"):
        raise RuntimeError(f"LLM protocol {profile.protocol!r} does not support vision calls.")
    return client  # type: ignore[return-value]


def create_vision_client(cfg: AppConfig, service_id: str | None = None) -> VisionClient:
    profile = pick_llm_service(cfg, service_id)
    return create_vision_client_from_profile(profile, cfg)


def create_json_client(cfg: AppConfig, service_id: str | None = None) -> JsonLlmClient:
    """Client for structured JSON editor tasks (layout, photo ops, suggestions)."""
    profile = pick_llm_service(cfg, service_id)
    return create_json_client_from_profile(profile, cfg)


def create_image_gen_client(cfg: AppConfig) -> ImageGenClient:
    if not image_gen_ready(cfg):
        raise RuntimeError(
            "Image generation is not configured. Choose Local or Cloud/gateway in Settings "
            "and provide a base URL and model (API key required for cloud/gateway)."
        )
    return OpenAICompatibleImageGenClient(cfg.image_gen)


def llm_model_name(cfg: AppConfig, service_id: str | None = None) -> str | None:
    try:
        profile = pick_llm_service(cfg, service_id)
    except ValueError:
        return None
    return (profile.model or "").strip() or None


def llm_uses_local_ollama(cfg: AppConfig, service_id: str | None = None) -> bool:
    try:
        profile = pick_llm_service(cfg, service_id)
    except ValueError:
        return cfg.llm.provider == "ollama"
    return profile.protocol == "ollama"


def test_llm_service(cfg: AppConfig, service_id: str) -> dict[str, Any]:
    """Run a live connectivity check for one Text & Vision AI service profile."""
    try:
        profile = get_service(cfg, service_id)
    except KeyError as exc:
        return {
            "ok": False,
            "service_id": (service_id or "").strip(),
            "checks": [{"name": "Service", "ok": False, "detail": str(exc)}],
        }

    checks: list[dict[str, Any]] = []

    def add_check(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail})

    pub = public_service(profile, cfg)
    if profile.category != "llm":
        add_check("Category", False, "Only Text & Vision (llm) services can be tested here.")
        return {
            "ok": False,
            "service_id": profile.id,
            "provider": profile.protocol,
            "ready": False,
            "service": pub,
            "checks": checks,
        }
    if not profile.enabled:
        add_check("Enabled", False, "Enable the service before testing.")
        return {
            "ok": False,
            "service_id": profile.id,
            "provider": profile.protocol,
            "ready": False,
            "service": pub,
            "checks": checks,
        }
    if not can_use_llm(profile, cfg):
        add_check(
            "Configuration",
            False,
            "Not ready — check URL / model / API key (required for remote hosts).",
        )
        return {
            "ok": False,
            "service_id": profile.id,
            "provider": profile.protocol,
            "ready": False,
            "service": pub,
            "checks": checks,
        }

    add_check("Configuration", True, f"{profile.name} · {profile.protocol}")
    try:
        client = create_json_client_from_profile(profile, cfg)
        snippet = client.test_connection()
        label = {
            "ollama": "Ollama reachable",
            "openai_chat": "Proxy reachable",
            "gemini": "Gemini reachable",
        }.get(profile.protocol, "Service reachable")
        add_check(label, True, f"Connected · {profile.model or 'model'}")
        add_check("Model response", True, f"Sample: {snippet}")
        return {
            "ok": True,
            "service_id": profile.id,
            "provider": profile.protocol,
            "ready": True,
            "service": pub,
            "checks": checks,
        }
    except Exception as exc:  # noqa: BLE001
        host = (profile.base_url or "").strip() or (
            "generativelanguage.googleapis.com" if profile.protocol == "gemini" else ""
        )
        add_check(
            "Connection",
            False,
            format_llm_error(exc, host=host or None, model=(profile.model or "").strip() or None),
        )
        return {
            "ok": False,
            "service_id": profile.id,
            "provider": profile.protocol,
            "ready": bool(pub.get("ready")),
            "service": pub,
            "checks": checks,
        }
