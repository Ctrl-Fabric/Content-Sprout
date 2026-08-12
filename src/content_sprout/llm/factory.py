"""Factory for vision / JSON LLM and image-gen clients."""

from __future__ import annotations

from ..config import AppConfig, image_gen_ready, vision_llm_ready
from .client import JsonLlmClient, OllamaVisionClient, OpenAICompatibleVisionClient, VisionClient
from .gemini_client import GeminiVisionClient
from .image_gen import ImageGenClient, OpenAICompatibleImageGenClient


def create_vision_client(cfg: AppConfig) -> VisionClient:
    if cfg.llm.provider == "ollama":
        return OllamaVisionClient(cfg.ollama)
    if cfg.llm.provider == "proxy":
        return OpenAICompatibleVisionClient(cfg.llm_proxy)
    if cfg.llm.provider == "gemini":
        return GeminiVisionClient(cfg)
    raise RuntimeError(f"LLM provider {cfg.llm.provider!r} does not support vision calls.")


def create_json_client(cfg: AppConfig) -> JsonLlmClient:
    """Client for structured JSON editor tasks (layout, photo ops, suggestions)."""
    if not vision_llm_ready(cfg):
        raise RuntimeError(
            "Enable Ollama, Gemini, or an LLM proxy in Settings to use editor AI features "
            "(heuristic-only has no JSON model)."
        )
    if cfg.llm.provider == "ollama":
        return OllamaVisionClient(cfg.ollama)
    if cfg.llm.provider == "proxy":
        return OpenAICompatibleVisionClient(cfg.llm_proxy)
    if cfg.llm.provider == "gemini":
        return GeminiVisionClient(cfg)
    raise RuntimeError(f"LLM provider {cfg.llm.provider!r} does not support JSON calls.")


def create_image_gen_client(cfg: AppConfig) -> ImageGenClient:
    if not image_gen_ready(cfg):
        raise RuntimeError(
            "Image generation is not configured. Choose Local or Cloud/gateway in Settings "
            "and provide a base URL and model (API key required for cloud/gateway)."
        )
    return OpenAICompatibleImageGenClient(cfg.image_gen)


def llm_model_name(cfg: AppConfig) -> str | None:
    if cfg.llm.provider == "ollama":
        return cfg.ollama.model
    if cfg.llm.provider == "proxy":
        return cfg.llm_proxy.model
    if cfg.llm.provider == "gemini":
        return cfg.gemini.model
    return None
