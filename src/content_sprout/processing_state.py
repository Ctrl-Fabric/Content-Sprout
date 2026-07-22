"""Cross-process tracking of which input files are currently being processed.

The watcher and the UI server run as separate processes, so they coordinate
via a tiny JSON file in `cache/`. The watcher records the file it's working
on at the start of `_process()` and clears it on success/failure. The UI
reads the file on every `/api/input` request to mark rows with a spinner.

Format:
    {
        "items": [
            {"path": "Vacation/beach.jpg", "started_at": "2026-05-30T17:31:00+00:00", "pid": 19741},
            ...
        ]
    }

Atomic writes are done via `os.replace` on a sibling temp file. Stale entries
(older than `STALE_SECONDS`) are filtered out on read so a crashed watcher
never leaves a spinner spinning forever.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATE_FILENAME = "processing.json"
STALE_SECONDS = 600  # 10 minutes — any entry older is assumed crashed

_lock = threading.Lock()


def _state_path(cache_dir: Path) -> Path:
    return cache_dir / STATE_FILENAME


def _read_raw(cache_dir: Path) -> list[dict]:
    p = _state_path(cache_dir)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        items = data.get("items", []) if isinstance(data, dict) else []
        return [i for i in items if isinstance(i, dict) and "path" in i]
    except (OSError, json.JSONDecodeError):
        return []


def _write_atomic(cache_dir: Path, items: list[dict]) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = _state_path(cache_dir)
    fd, tmp = tempfile.mkstemp(
        prefix=".processing-", suffix=".tmp", dir=str(cache_dir)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"items": items}, f)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _prune_stale(items: list[dict]) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=STALE_SECONDS)
    fresh: list[dict] = []
    for item in items:
        started = item.get("started_at")
        if not started:
            continue
        try:
            ts = datetime.fromisoformat(started)
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts >= cutoff:
            fresh.append(item)
    return fresh


def mark_start(cache_dir: Path, rel_path: str) -> None:
    """Record `rel_path` (relative to input_dir) as currently being processed."""
    with _lock:
        items = _prune_stale(_read_raw(cache_dir))
        items = [i for i in items if i.get("path") != rel_path]
        items.append(
            {
                "path": rel_path,
                "started_at": datetime.now(timezone.utc).isoformat(),
                "pid": os.getpid(),
            }
        )
        _write_atomic(cache_dir, items)


def mark_done(cache_dir: Path, rel_path: str) -> None:
    """Remove `rel_path` from the processing set (success or failure)."""
    with _lock:
        items = _prune_stale(_read_raw(cache_dir))
        items = [i for i in items if i.get("path") != rel_path]
        _write_atomic(cache_dir, items)


def clear_all(cache_dir: Path) -> None:
    """Reset the state file — useful when the watcher boots."""
    with _lock:
        _write_atomic(cache_dir, [])


def in_progress(cache_dir: Path) -> set[str]:
    """Set of input-relative paths currently being processed (stale pruned)."""
    items = _prune_stale(_read_raw(cache_dir))
    return {i["path"] for i in items if isinstance(i.get("path"), str)}
