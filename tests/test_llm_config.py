"""Tests for persistent config.yaml storage and LLM settings."""

from pathlib import Path

from content_sprout.config import (
    load,
    load_or_create,
    save_llm_settings,
    save_storage_settings,
    write_config,
    AppConfig,
)


def test_save_llm_settings_persists_proxy(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("llm:\n  provider: ollama\n", encoding="utf-8")

    llm, _ollama, proxy = save_llm_settings(
        config_path,
        {
            "provider": "proxy",
            "llm_proxy.base_url": "https://api.portkey.ai/v1",
            "llm_proxy.api_key": "secret-key",
            "llm_proxy.model": "gpt-4o-mini",
            "llm_proxy.portkey_provider": "openai",
            "llm_proxy.timeout_s": 45,
        },
    )

    assert llm.provider == "proxy"
    assert proxy.base_url == "https://api.portkey.ai/v1"
    assert proxy.api_key == "secret-key"
    assert proxy.model == "gpt-4o-mini"
    assert proxy.portkey_provider == "openai"
    assert proxy.timeout_s == 45

    reloaded = load(config_path)
    assert reloaded.llm.provider == "proxy"
    assert reloaded.llm_proxy.api_key == "secret-key"


def test_save_llm_settings_keeps_api_key_when_blank_update(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    save_llm_settings(
        config_path,
        {"llm_proxy.api_key": "keep-me", "llm_proxy.model": "gpt-4o"},
    )

    _llm, _ollama, proxy = save_llm_settings(
        config_path,
        {"llm_proxy.model": "gpt-4o-mini"},
    )
    assert proxy.api_key == "keep-me"
    assert proxy.model == "gpt-4o-mini"


def test_load_or_create_writes_default_config(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    assert not config_path.exists()
    cfg = load_or_create(config_path)
    assert config_path.exists()
    assert cfg.projects_dir.name == "projects"
    reloaded = load(config_path)
    assert reloaded.llm.provider == "ollama"


def test_save_storage_settings_persists_across_reload(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    write_config(config_path, AppConfig())
    projects = tmp_path / "my-projects"
    cache = tmp_path / "my-cache"

    saved = save_storage_settings(
        config_path,
        {"projects_dir": str(projects), "cache_dir": str(cache)},
    )
    assert saved.projects_dir == projects
    assert saved.cache_dir == cache
    assert projects.is_dir()
    assert cache.is_dir()

    reloaded = load(config_path)
    assert reloaded.projects_dir == projects
    assert reloaded.cache_dir == cache


def test_save_storage_keeps_llm_settings(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    save_llm_settings(config_path, {"provider": "heuristic_only", "ollama.model": "keep-me"})
    save_storage_settings(config_path, {"projects_dir": str(tmp_path / "p")})
    reloaded = load(config_path)
    assert reloaded.llm.provider == "heuristic_only"
    assert reloaded.ollama.model == "keep-me"
