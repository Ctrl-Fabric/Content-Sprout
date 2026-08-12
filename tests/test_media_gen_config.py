"""Tests for media backend routing and Gemini LLM readiness."""

from pathlib import Path

from content_sprout.config import (
    AppConfig,
    ComfyUIConfig,
    GeminiConfig,
    HiggsfieldConfig,
    LlmProviderConfig,
    MediaGenConfig,
    media_op_ready,
    resolve_media_backend,
    save_higgsfield_settings,
    save_llm_settings,
    save_media_gen_settings,
    vision_llm_ready,
)


def test_resolve_falls_back_to_gemini_when_comfy_off():
    cfg = AppConfig(
        comfyui=ComfyUIConfig(provider="off"),
        gemini=GeminiConfig(api_key="k", image_model="gemini-2.5-flash-image"),
        media_gen=MediaGenConfig(default_backend="comfyui"),
    )
    assert media_op_ready(cfg, "text_to_image")
    assert resolve_media_backend(cfg, "text_to_image") == "gemini"


def test_override_prefers_higgsfield_when_ready():
    cfg = AppConfig(
        comfyui=ComfyUIConfig(provider="off"),
        higgsfield=HiggsfieldConfig(
            api_key_id="id",
            api_key_secret="secret",
            endpoint_text_to_image="higgsfield-ai/soul/standard",
        ),
        gemini=GeminiConfig(api_key="k", image_model="gemini-2.5-flash-image"),
        media_gen=MediaGenConfig(
            default_backend="comfyui",
            text_to_image="higgsfield",
        ),
    )
    assert resolve_media_backend(cfg, "text_to_image") == "higgsfield"


def test_gemini_llm_ready_and_persists(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    llm, _o, _p, gem = save_llm_settings(
        config_path,
        {
            "provider": "gemini",
            "gemini.api_key": "secret-gem",
            "gemini.model": "gemini-2.5-flash",
            "gemini.image_model": "gemini-2.5-flash-image",
        },
    )
    assert llm.provider == "gemini"
    assert gem.api_key == "secret-gem"
    cfg = AppConfig(llm=LlmProviderConfig(provider="gemini"), gemini=gem)
    assert vision_llm_ready(cfg)

    mg = save_media_gen_settings(
        config_path,
        {"default_backend": "gemini", "text_to_image": "inherit"},
    )
    assert mg.default_backend == "gemini"

    hf = save_higgsfield_settings(
        config_path,
        {
            "api_key_id": "hf-id",
            "api_key_secret": "hf-secret",
            "endpoint_image_to_video": "higgsfield-ai/dop/standard",
        },
    )
    assert hf.api_key_id == "hf-id"
    assert hf.api_key_secret == "hf-secret"
