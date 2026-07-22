"""Persist Instagram OAuth tokens locally (cache dir, gitignored)."""

from __future__ import annotations

import json
import secrets
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass
class InstagramSession:
    page_id: str
    page_name: str
    page_access_token: str
    ig_user_id: str
    ig_username: str = ""
    connected_at: str = ""
    token_expires_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> InstagramSession:
        return cls(
            page_id=str(data["page_id"]),
            page_name=str(data.get("page_name", "")),
            page_access_token=str(data["page_access_token"]),
            ig_user_id=str(data["ig_user_id"]),
            ig_username=str(data.get("ig_username", "")),
            connected_at=str(data.get("connected_at", "")),
            token_expires_at=data.get("token_expires_at"),
        )


def session_path(cache_dir: Path) -> Path:
    return cache_dir / "instagram_session.json"


def load_session(cache_dir: Path) -> InstagramSession | None:
    path = session_path(cache_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return InstagramSession.from_dict(data)
    except (json.JSONDecodeError, KeyError, TypeError):
        return None


def save_session(cache_dir: Path, session: InstagramSession) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    if not session.connected_at:
        session.connected_at = datetime.now(UTC).isoformat()
    session_path(cache_dir).write_text(
        json.dumps(session.to_dict(), indent=2) + "\n",
        encoding="utf-8",
    )


def clear_session(cache_dir: Path) -> None:
    path = session_path(cache_dir)
    if path.exists():
        path.unlink()


def oauth_state_path(cache_dir: Path) -> Path:
    return cache_dir / "instagram_oauth_state.json"


def save_oauth_state(cache_dir: Path, state: str) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    oauth_state_path(cache_dir).write_text(
        json.dumps({"state": state, "created_at": datetime.now(UTC).isoformat()}),
        encoding="utf-8",
    )


def pop_oauth_state(cache_dir: Path, state: str) -> bool:
    path = oauth_state_path(cache_dir)
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        path.unlink(missing_ok=True)
        return False
    path.unlink(missing_ok=True)
    return data.get("state") == state


def new_oauth_state() -> str:
    return secrets.token_urlsafe(32)
