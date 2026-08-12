"""Tests for Ollama LLM client request options."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from content_sprout.config import OllamaConfig
from content_sprout.llm.client import OLLAMA_KEEP_ALIVE, OllamaVisionClient


def test_ollama_chat_requests_keep_alive_zero():
    cfg = OllamaConfig(model="gemma4:31b")
    mock_client = MagicMock()
    mock_client.chat.return_value = {"message": {"content": '{"ok": true}'}}

    with patch("ollama.Client", return_value=mock_client):
        client = OllamaVisionClient(cfg)
        client.complete_json("Reply with JSON")

    mock_client.chat.assert_called_once()
    assert mock_client.chat.call_args.kwargs["keep_alive"] == OLLAMA_KEEP_ALIVE
    assert OLLAMA_KEEP_ALIVE == 0
