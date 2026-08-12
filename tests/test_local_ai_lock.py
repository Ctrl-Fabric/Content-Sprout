"""Tests for exclusive local AI execution lock."""

from __future__ import annotations

import threading
import time

import pytest

from content_sprout.local_ai_lock import (
    LocalAiBusyError,
    current_local_ai_task,
    local_ai_busy,
    local_ai_task,
    require_local_ai_available,
)


def test_local_ai_task_exclusive():
    with local_ai_task("ollama", "gemma4:31b"):
        assert local_ai_busy()
        assert current_local_ai_task() == "Ollama (gemma4:31b)"
        with pytest.raises(LocalAiBusyError):
            with local_ai_task("comfyui", "text_to_video"):
                pass
    assert not local_ai_busy()
    assert current_local_ai_task() is None


def test_require_local_ai_available():
    with local_ai_task("comfyui", "image_to_video"):
        with pytest.raises(LocalAiBusyError, match="already running"):
            require_local_ai_available("layout AI")


def test_second_thread_cannot_acquire():
    started = threading.Event()
    release = threading.Event()

    def holder() -> None:
        with local_ai_task("ollama", "model-a"):
            started.set()
            release.wait(timeout=5)

    thread = threading.Thread(target=holder)
    thread.start()
    assert started.wait(timeout=2)

    with pytest.raises(LocalAiBusyError):
        require_local_ai_available("video generation")

    release.set()
    thread.join(timeout=2)
    assert not thread.is_alive()

    with local_ai_task("comfyui", "text_to_image"):
        assert local_ai_busy()

    time.sleep(0)
