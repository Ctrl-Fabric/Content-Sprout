"""Tests for multi Text & Vision AI (LLM) service profiles."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from content_sprout import ai_services
from content_sprout.config import (
    AiServiceProfile,
    AppConfig,
    LlmProviderConfig,
    OllamaConfig,
    write_config,
)
from content_sprout.llm import factory as llm_factory
from content_sprout.models import CreatePostRequest, CreateProjectRequest, ProjectType
from content_sprout.projects import ProjectStore
from content_sprout.web import create_app


def _store(tmp_path: Path) -> ProjectStore:
    from content_sprout.config import RouterConfig

    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        router=RouterConfig(heuristic_confidence_min=0.0, heuristic_gap_min=0.0),
        llm=LlmProviderConfig(provider="ollama"),
        ollama=OllamaConfig(host="http://localhost:11434", model="test-model"),
    )
    return ProjectStore(cfg.projects_dir, cfg)


def test_legacy_llm_profile_from_ollama(tmp_path: Path):
    cfg = AppConfig(
        projects_dir=tmp_path / "projects",
        cache_dir=tmp_path / "cache",
        llm=LlmProviderConfig(provider="ollama"),
        ollama=OllamaConfig(host="http://127.0.0.1:11434", model="gemma"),
    )
    items = ai_services.list_services(cfg, category="llm")
    assert len(items) == 1
    assert items[0].id == ai_services.LEGACY_LLM_OLLAMA_ID
    assert ai_services.can_use_llm(items[0], cfg)
    assert ai_services.any_llm_ready(cfg)
    picked = ai_services.pick_llm_service(cfg, None)
    assert picked.protocol == "ollama"


def test_pick_llm_service_requires_choice_when_multiple():
    cfg = AppConfig(
        llm=LlmProviderConfig(provider="heuristic_only"),
        ai_services=[
            AiServiceProfile(
                id="ollama1",
                name="Ollama",
                category="llm",
                host="local",
                protocol="ollama",
                enabled=True,
                base_url="http://localhost:11434",
                model="m1",
            ),
            AiServiceProfile(
                id="proxy1",
                name="OpenAI",
                category="llm",
                host="remote",
                protocol="openai_chat",
                enabled=True,
                base_url="https://api.openai.com/v1",
                model="gpt-4o",
                api_key="sk-test",
            ),
        ],
    )
    assert ai_services.any_llm_ready(cfg)
    try:
        ai_services.pick_llm_service(cfg, None)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "more than one" in str(exc).lower()
    assert ai_services.pick_llm_service(cfg, "proxy1").name == "OpenAI"


def test_factory_from_profile_openai_chat():
    cfg = AppConfig(llm=LlmProviderConfig(provider="heuristic_only"))
    profile = AiServiceProfile(
        id="oai",
        name="OpenAI",
        category="llm",
        host="remote",
        protocol="openai_chat",
        enabled=True,
        base_url="https://api.openai.com/v1",
        model="gpt-4o-mini",
        api_key="sk-x",
    )
    client = llm_factory.create_json_client_from_profile(profile, cfg)
    assert type(client).__name__ == "OpenAICompatibleVisionClient"


def test_post_preferred_llm_service_id_roundtrip(tmp_path: Path):
    store = _store(tmp_path)
    project = store.create_project(CreateProjectRequest(name="LLM Pref"))
    post = store.create_post(project.id, CreatePostRequest(name="P", type=ProjectType.VIDEO))
    assert post.preferred_llm_service_id is None
    post.preferred_llm_service_id = "svc-abc"
    saved = store.update_post(project.id, post.id, post)
    assert saved.preferred_llm_service_id == "svc-abc"
    loaded = store.get_post(project.id, post.id)
    assert loaded.preferred_llm_service_id == "svc-abc"


def test_capabilities_lists_llm_services(tmp_path: Path):
    store = _store(tmp_path)
    config_path = tmp_path / "config.yaml"
    write_config(config_path, store.cfg)
    client = TestClient(create_app(cfg=store.cfg, config_path=config_path))
    caps = client.get("/api/ai/capabilities")
    assert caps.status_code == 200
    body = caps.json()
    assert "llm_services" in body
    assert any(item["protocol"] == "ollama" for item in body["llm_services"])
    assert body["script_generate"] is True


def test_script_generate_passes_service_id(tmp_path: Path):
    store = _store(tmp_path)
    store.cfg.ai_services = [
        AiServiceProfile(
            id="svc-a",
            name="A",
            category="llm",
            host="local",
            protocol="ollama",
            enabled=True,
            base_url="http://localhost:11434",
            model="a",
        ),
        AiServiceProfile(
            id="svc-b",
            name="B",
            category="llm",
            host="remote",
            protocol="openai_chat",
            enabled=True,
            base_url="https://api.openai.com/v1",
            model="gpt-4o",
            api_key="sk-b",
        ),
    ]
    store.cfg.llm = LlmProviderConfig(provider="heuristic_only")
    config_path = tmp_path / "config.yaml"
    write_config(config_path, store.cfg)
    client = TestClient(create_app(cfg=store.cfg, config_path=config_path))

    mock_client = MagicMock()
    mock_client.complete_json.return_value = {
        "title": "T",
        "summary": "S",
        "script": "Hello world.",
    }
    with patch.object(llm_factory, "create_json_client", return_value=mock_client) as create:
        resp = client.post(
            "/api/ai/script/generate",
            json={"topic": "Widgets", "service_id": "svc-b"},
        )
    assert resp.status_code == 200, resp.text
    create.assert_called_once()
    assert create.call_args.args[1] == "svc-b" or create.call_args.kwargs.get("service_id") == "svc-b"
    assert resp.json()["script"] == "Hello world."


def test_save_llm_ai_services(tmp_path: Path):
    store = _store(tmp_path)
    config_path = tmp_path / "config.yaml"
    write_config(config_path, store.cfg)
    client = TestClient(create_app(cfg=store.cfg, config_path=config_path))
    saved = client.put(
        "/api/ai/services",
        json={
            "services": [
                {
                    "id": "llm01",
                    "name": "Claude via OpenRouter",
                    "category": "llm",
                    "host": "remote",
                    "protocol": "openai_chat",
                    "enabled": True,
                    "base_url": "https://openrouter.ai/api/v1",
                    "model": "anthropic/claude-sonnet-4",
                    "api_key": "sk-or-test",
                    "timeout_s": 180,
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    services = saved.json()["services"]
    assert any(item["id"] == "llm01" and item["category"] == "llm" for item in services)
    listed = client.get("/api/ai/services", params={"category": "llm"})
    assert listed.status_code == 200
    assert any(item["id"] == "llm01" for item in listed.json()["services"])


def test_ai_service_test_endpoint_config_gate(tmp_path: Path):
    store = _store(tmp_path)
    config_path = tmp_path / "config.yaml"
    write_config(config_path, store.cfg)
    client = TestClient(create_app(cfg=store.cfg, config_path=config_path))
    saved = client.put(
        "/api/ai/services",
        json={
            "services": [
                {
                    "id": "llm-remote",
                    "name": "OpenAI",
                    "category": "llm",
                    "host": "remote",
                    "protocol": "openai_chat",
                    "enabled": True,
                    "base_url": "https://api.openai.com/v1",
                    "model": "gpt-4o",
                    "timeout_s": 60,
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    # Missing API key → not ready; test should fail on configuration.
    resp = client.post("/api/ai/services/llm-remote/test")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["ready"] is False
    assert any(c["name"] == "Configuration" and c["ok"] is False for c in body["checks"])


def test_ai_service_test_endpoint_live_ok(tmp_path: Path):
    store = _store(tmp_path)
    config_path = tmp_path / "config.yaml"
    write_config(config_path, store.cfg)
    client = TestClient(create_app(cfg=store.cfg, config_path=config_path))
    saved = client.put(
        "/api/ai/services",
        json={
            "services": [
                {
                    "id": "llm-live",
                    "name": "OpenAI",
                    "category": "llm",
                    "host": "remote",
                    "protocol": "openai_chat",
                    "enabled": True,
                    "base_url": "https://api.openai.com/v1",
                    "model": "gpt-4o",
                    "api_key": "sk-test",
                    "timeout_s": 60,
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    mock_client = MagicMock()
    mock_client.test_connection.return_value = '{"ok":true}'
    with patch.object(llm_factory, "create_json_client_from_profile", return_value=mock_client):
        resp = client.post("/api/ai/services/llm-live/test")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["service_id"] == "llm-live"
    assert body["service"]["ready"] is True
    assert body["service"]["id"] == "llm-live"
