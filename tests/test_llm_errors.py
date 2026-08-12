from content_sprout.llm.errors import format_llm_error


def test_format_connection_refused():
    msg = format_llm_error(ConnectionRefusedError(61, "Connection refused"), host="http://localhost:11434")
    assert "Could not reach the LLM" in msg
    assert "11434" in msg


def test_format_timeout():
    msg = format_llm_error(TimeoutError("timed out"), host="http://localhost:11434")
    assert "timed out" in msg.lower()


def test_format_json_parse():
    msg = format_llm_error(ValueError("Model response did not contain a JSON object"))
    assert "JSON" in msg


def test_format_model_not_found():
    class ResponseError(Exception):
        status_code = 404

    exc = ResponseError("model 'gemma4:31b' not found")
    exc.__class__.__module__ = "ollama"
    msg = format_llm_error(exc, model="gemma4:31b")
    assert "not found" in msg.lower()
    assert "gemma4:31b" in msg


def test_format_passthrough_runtime():
    msg = format_llm_error(RuntimeError("Gemini API key is not configured."))
    assert "Gemini API key" in msg
