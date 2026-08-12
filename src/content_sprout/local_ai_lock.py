"""Exclusive execution lock for local AI backends (Ollama, ComfyUI)."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

_KIND_LABELS = {
    "ollama": "Ollama",
    "comfyui": "ComfyUI",
}


@dataclass(frozen=True)
class _Holder:
    kind: str
    task: str

    def label(self) -> str:
        kind = _KIND_LABELS.get(self.kind, self.kind)
        return f"{kind} ({self.task})"


_lock = threading.Lock()
_holder: _Holder | None = None


class LocalAiBusyError(RuntimeError):
    """Raised when a second local AI task is requested while one is active."""

    def __init__(self, *, task: str, holder: _Holder | None = None):
        self.task = task
        self.holder = holder
        if holder is not None:
            super().__init__(
                f"{holder.label()} is already running. "
                f"Wait for it to finish before starting {task}."
            )
        else:
            super().__init__(
                "A local AI task is already running. "
                f"Wait for it to finish before starting {task}."
            )


def local_ai_busy() -> bool:
    """True when Ollama or ComfyUI is executing."""
    return _lock.locked()


def current_local_ai_task() -> str | None:
    """Human-readable label for the active task, if any."""
    holder = _holder
    return holder.label() if holder else None


def require_local_ai_available(task: str) -> None:
    """Fail fast when local AI is busy (e.g. before queueing a long job)."""
    if _lock.locked():
        raise LocalAiBusyError(task=task, holder=_holder)


@contextmanager
def local_ai_task(kind: str, task: str) -> Iterator[None]:
    """Hold the exclusive local-AI lock for one Ollama or ComfyUI execution."""
    global _holder
    if not _lock.acquire(blocking=False):
        raise LocalAiBusyError(task=task, holder=_holder)
    _holder = _Holder(kind=kind, task=task)
    try:
        yield
    finally:
        _holder = None
        _lock.release()
