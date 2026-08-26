"""Named local / third-party AI services for image, video, and text/vision LLM."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from PIL import Image

from .config import (
    AiServiceProfile,
    AppConfig,
    GeminiConfig,
    ImageGenConfig,
    gemini_api_key,
    gemini_image_ready,
    image_gen_ready,
    mask_secret,
)

LEGACY_IMAGE_GEN_ID = "legacy-image-gen"
LEGACY_LLM_OLLAMA_ID = "legacy-llm-ollama"
LEGACY_LLM_PROXY_ID = "legacy-llm-proxy"
LEGACY_LLM_GEMINI_ID = "legacy-llm-gemini"

ImageProtocol = Literal["openai_images", "gemini"]
VideoProtocol = Literal["openai_video", "comfyui", "higgsfield"]
LlmProtocol = Literal["ollama", "openai_chat", "gemini"]


def service_ready(profile: AiServiceProfile, cfg: AppConfig | None = None) -> bool:
    if not profile.enabled:
        return False
    protocol = profile.protocol
    host = profile.host
    has_url = bool((profile.base_url or "").strip())
    has_model = bool((profile.model or "").strip())
    has_key = bool((profile.api_key or "").strip() or (profile.portkey_virtual_key or "").strip())
    if protocol == "openai_images":
        if not (has_url and has_model):
            return False
        return True if host == "local" else has_key
    if protocol == "gemini":
        key = (profile.api_key or "").strip()
        if not key and cfg is not None:
            key = gemini_api_key(cfg)
        return bool(key)
    if protocol == "openai_video":
        if not (has_url and has_model):
            return False
        return True if host == "local" else has_key
    if protocol == "comfyui":
        return has_url
    if protocol == "higgsfield":
        return bool((profile.api_key or "").strip() and (profile.api_key_secret or "").strip())
    if protocol == "ollama":
        return has_url and has_model
    if protocol == "openai_chat":
        if not (has_url and has_model):
            return False
        return True if host == "local" else has_key
    return False


def can_edit_image(profile: AiServiceProfile, cfg: AppConfig | None = None) -> bool:
    return (
        profile.category == "image"
        and profile.protocol in ("openai_images", "gemini")
        and service_ready(profile, cfg)
    )


def can_use_llm(profile: AiServiceProfile, cfg: AppConfig | None = None) -> bool:
    return (
        profile.category == "llm"
        and profile.protocol in ("ollama", "openai_chat", "gemini")
        and service_ready(profile, cfg)
    )


def public_service(profile: AiServiceProfile, cfg: AppConfig | None = None) -> dict[str, Any]:
    ready = service_ready(profile, cfg)
    return {
        "id": profile.id,
        "name": profile.name,
        "category": profile.category,
        "host": profile.host,
        "protocol": profile.protocol,
        "enabled": profile.enabled,
        "ready": ready,
        "can_edit_image": can_edit_image(profile, cfg),
        "can_use_llm": can_use_llm(profile, cfg),
        "base_url": profile.base_url,
        "model": profile.model,
        "timeout_s": profile.timeout_s,
        "portkey_provider": profile.portkey_provider,
        "api_key_set": bool((profile.api_key or "").strip()),
        "api_key_masked": mask_secret(profile.api_key) if profile.api_key else "",
        "api_key_secret_set": bool((profile.api_key_secret or "").strip()),
        "portkey_virtual_key_set": bool((profile.portkey_virtual_key or "").strip()),
    }


def _legacy_image_gen(cfg: AppConfig) -> AiServiceProfile | None:
    if not image_gen_ready(cfg):
        return None
    ig = cfg.image_gen
    return AiServiceProfile(
        id=LEGACY_IMAGE_GEN_ID,
        name="OpenAI-compatible image (Settings · legacy)",
        category="image",
        host="local" if ig.provider == "local" else "remote",
        protocol="openai_images",
        enabled=True,
        base_url=ig.base_url,
        api_key=ig.api_key,
        model=ig.model,
        timeout_s=ig.timeout_s,
        portkey_provider=ig.portkey_provider,
        portkey_virtual_key=ig.portkey_virtual_key,
    )


def _legacy_llm_profiles(cfg: AppConfig) -> list[AiServiceProfile]:
    """Synthetic LLM profiles from the global single-provider blocks (active provider only)."""
    provider = cfg.llm.provider
    if provider == "heuristic_only":
        return []
    if provider == "ollama":
        return [
            AiServiceProfile(
                id=LEGACY_LLM_OLLAMA_ID,
                name="Ollama (Settings · legacy)",
                category="llm",
                host="local",
                protocol="ollama",
                enabled=True,
                base_url=cfg.ollama.host or "http://localhost:11434",
                model=cfg.ollama.model or "gemma4:31b",
                timeout_s=cfg.ollama.timeout_s,
            )
        ]
    if provider == "proxy":
        return [
            AiServiceProfile(
                id=LEGACY_LLM_PROXY_ID,
                name="OpenAI-compatible LLM (Settings · legacy)",
                category="llm",
                host="remote",
                protocol="openai_chat",
                enabled=True,
                base_url=cfg.llm_proxy.base_url or "https://api.openai.com/v1",
                api_key=cfg.llm_proxy.api_key,
                model=cfg.llm_proxy.model or "gpt-4o",
                timeout_s=cfg.llm_proxy.timeout_s,
                portkey_provider=cfg.llm_proxy.portkey_provider,
                portkey_virtual_key=cfg.llm_proxy.portkey_virtual_key,
            )
        ]
    if provider == "gemini":
        return [
            AiServiceProfile(
                id=LEGACY_LLM_GEMINI_ID,
                name="Gemini (Settings · legacy)",
                category="llm",
                host="remote",
                protocol="gemini",
                enabled=True,
                api_key=gemini_api_key(cfg),
                model=cfg.gemini.model or "gemini-2.5-flash",
                timeout_s=cfg.gemini.timeout_s,
            )
        ]
    return []


def list_services(cfg: AppConfig, *, category: str | None = None) -> list[AiServiceProfile]:
    items = list(cfg.ai_services)
    legacy = _legacy_image_gen(cfg)
    if legacy and all(item.id != LEGACY_IMAGE_GEN_ID for item in items):
        items.append(legacy)
    if gemini_image_ready(cfg) and not any(
        item.protocol == "gemini" and item.category == "image" for item in items
    ):
        items.append(
            AiServiceProfile(
                id="legacy-gemini-image",
                name="Gemini image (shared key)",
                category="image",
                host="remote",
                protocol="gemini",
                enabled=True,
                api_key=gemini_api_key(cfg),
                model=cfg.gemini.image_model,
                timeout_s=cfg.gemini.image_timeout_s,
            )
        )
    has_llm = any(item.category == "llm" for item in cfg.ai_services)
    if not has_llm:
        for legacy_llm in _legacy_llm_profiles(cfg):
            if all(item.id != legacy_llm.id for item in items):
                items.append(legacy_llm)
    if category in ("image", "video", "llm"):
        items = [item for item in items if item.category == category]
    return items


def list_public_services(cfg: AppConfig, *, category: str | None = None) -> list[dict[str, Any]]:
    return [public_service(item, cfg) for item in list_services(cfg, category=category)]


def get_service(cfg: AppConfig, service_id: str) -> AiServiceProfile:
    sid = (service_id or "").strip()
    for item in list_services(cfg):
        if item.id == sid:
            return item
    raise KeyError(f"AI service not found: {sid}")


def pick_image_edit_service(cfg: AppConfig, service_id: str | None) -> AiServiceProfile:
    ready = [item for item in list_services(cfg, category="image") if can_edit_image(item, cfg)]
    if not ready:
        raise ValueError(
            "No image AI service is ready. Add one under Settings → Image generation & editing."
        )
    sid = (service_id or "").strip()
    if sid:
        for item in ready:
            if item.id == sid:
                return item
        raise ValueError("That image AI service is not available.")
    if len(ready) > 1:
        raise ValueError("More than one image AI service is configured. Choose which one to use.")
    return ready[0]


def pick_llm_service(cfg: AppConfig, service_id: str | None) -> AiServiceProfile:
    ready = [item for item in list_services(cfg, category="llm") if can_use_llm(item, cfg)]
    if not ready:
        raise ValueError(
            "No Text & Vision AI service is ready. Add one under Settings → Text & Vision AI config."
        )
    sid = (service_id or "").strip()
    if sid:
        for item in ready:
            if item.id == sid:
                return item
        raise ValueError("That Text & Vision AI service is not available.")
    if len(ready) > 1:
        raise ValueError(
            "More than one Text & Vision AI service is configured. Choose which one to use."
        )
    return ready[0]


def any_llm_ready(cfg: AppConfig) -> bool:
    return any(can_use_llm(item, cfg) for item in list_services(cfg, category="llm"))


def _as_image_gen_config(profile: AiServiceProfile) -> ImageGenConfig:
    return ImageGenConfig(
        provider="local" if profile.host == "local" else "proxy",
        enabled=True,
        base_url=profile.base_url or "http://127.0.0.1:8080/v1",
        api_key=profile.api_key,
        model=profile.model or "gpt-image-1",
        timeout_s=profile.timeout_s,
        portkey_provider=profile.portkey_provider,
        portkey_virtual_key=profile.portkey_virtual_key,
    )


def run_image_edit(
    cfg: AppConfig,
    profile: AiServiceProfile,
    image_path: Path,
    prompt: str,
) -> bytes:
    """Submit a composed image file to the chosen service and return result bytes."""
    if not can_edit_image(profile, cfg):
        raise ValueError(f"Service {profile.name!r} cannot edit images.")
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError("Composed image file is missing.")
    instruction = (prompt or "").strip()
    if not instruction:
        raise ValueError("An edit instruction is required.")
    if profile.protocol == "openai_images":
        from .llm.image_gen import OpenAICompatibleImageGenClient

        client = OpenAICompatibleImageGenClient(_as_image_gen_config(profile))
        with Image.open(path) as src:
            return client.edit_image(src.convert("RGBA"), instruction)
    from .llm.gemini_client import GeminiImageClient

    gem = GeminiConfig(
        api_key=(profile.api_key or "").strip() or gemini_api_key(cfg),
        image_model=profile.model or cfg.gemini.image_model,
        image_timeout_s=profile.timeout_s or cfg.gemini.image_timeout_s,
    )
    client = GeminiImageClient(gem)
    with Image.open(path) as src:
        return client.edit_image(src.convert("RGBA"), instruction)
