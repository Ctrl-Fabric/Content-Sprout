"""Tests for OpenAI-compatible LLM proxy client."""

from unittest.mock import MagicMock, patch

from PIL import Image

from content_sprout.config import LlmProxyConfig
from content_sprout.llm.client import OpenAICompatibleVisionClient, _decision_from_json


def test_decision_from_json_parses_fields():
    decision = _decision_from_json(
        {"best_corner": "tl", "logo_variant": "white", "confidence": 0.88}
    )
    assert decision.corner == "tl"
    assert decision.logo_variant == "white"
    assert decision.confidence == 0.88


def test_proxy_client_decide_placement_parses_response():
    cfg = LlmProxyConfig(
        base_url="https://api.portkey.ai/v1",
        api_key="test-key",
        model="gpt-4o",
    )
    client = OpenAICompatibleVisionClient(cfg)
    img = Image.new("RGB", (200, 200), (100, 100, 100))

    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None
    mock_response.json.return_value = {
        "choices": [
            {
                "message": {
                    "content": '{"best_corner":"br","logo_variant":"dark","confidence":0.91}'
                }
            }
        ]
    }

    with patch("content_sprout.llm.client.httpx.Client") as mock_client_cls:
        mock_http = MagicMock()
        mock_client_cls.return_value.__enter__.return_value = mock_http
        mock_http.post.return_value = mock_response

        decision = client.decide_placement(img)

    assert decision.corner == "br"
    assert decision.logo_variant == "dark"
    assert decision.confidence == 0.91

    call_kwargs = mock_http.post.call_args.kwargs
    headers = call_kwargs["headers"]
    assert headers["Authorization"] == "Bearer test-key"
    assert headers["x-portkey-api-key"] == "test-key"
    assert call_kwargs["json"]["model"] == "gpt-4o"


def test_proxy_client_requires_api_key():
    cfg = LlmProxyConfig(api_key="")
    client = OpenAICompatibleVisionClient(cfg)
    img = Image.new("RGB", (100, 100), (0, 0, 0))

    try:
        client.decide_placement(img)
        raised = False
    except RuntimeError as exc:
        raised = True
        assert "API key" in str(exc)

    assert raised
