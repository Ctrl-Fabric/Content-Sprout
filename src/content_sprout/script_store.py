"""Filesystem-backed store for Script Generator drafts under a post scripts root."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .models import _now_iso, new_id

ScriptSource = Literal["generated", "refined", "edited", "manual"]

SCRIPT_PLATFORM_IDS = (
    "youtube",
    "facebook",
    "instagram",
    "tiktok",
    "linkedin",
    "x",
    "other",
)

SCRIPT_VIDEO_FORMATS = (
    "4k",
    "1440p",
    "1080p",
    "720p",
    "standard",
)

_LEGACY_PLATFORM_MAP = {
    "instagram_reel": "instagram",
    "instagram_carousel": "instagram",
    "youtube_short": "youtube",
    "linkedin_video": "linkedin",
    "generic": "other",
}

_LEGACY_CONTENT_FORMATS = {
    "talking_head",
    "voiceover",
    "demo",
    "story",
    "caption",
    "video",
}


def normalize_script_platforms(raw: Any) -> list[str]:
    """Coerce legacy single platform / mixed lists into canonical platform ids."""
    values: list[str] = []
    if isinstance(raw, str):
        values = [p for p in raw.replace(";", ",").split(",") if p.strip()]
    elif isinstance(raw, (list, tuple, set)):
        for item in raw:
            if isinstance(item, str) and ("," in item or ";" in item):
                values.extend(p for p in item.replace(";", ",").split(",") if p.strip())
            else:
                values.append(str(item))
    out: list[str] = []
    for v in values:
        key = str(v or "").strip().lower().replace(" ", "_")
        if not key:
            continue
        key = _LEGACY_PLATFORM_MAP.get(key, key)
        if key not in SCRIPT_PLATFORM_IDS:
            key = "other"
        if key not in out:
            out.append(key)
    return out or ["youtube"]


def normalize_script_video_format(raw: Any) -> str:
    key = str(raw or "").strip().lower().replace(" ", "")
    if key in _LEGACY_CONTENT_FORMATS or not key:
        return "1080p"
    if key in ("4k", "uhd", "2160p"):
        return "4k"
    if key in ("1440p", "qhd", "2k"):
        return "1440p"
    if key in ("1080p", "fhd", "fullhd", "hd1080"):
        return "1080p"
    if key in ("720p", "hd"):
        return "720p"
    if key in ("standard", "sd", "480p", "generic"):
        return "standard"
    return key if key in SCRIPT_VIDEO_FORMATS else "1080p"


def normalize_script_orientation(raw: Any) -> Literal["landscape", "portrait"]:
    key = str(raw or "").strip().lower()
    if key in ("landscape", "horizontal", "wide"):
        return "landscape"
    return "portrait"


class ScriptBrief(BaseModel):
    topic: str = ""
    platforms: list[str] = Field(default_factory=lambda: ["youtube"])
    # Legacy single-platform field; kept for older clients / stored JSON.
    platform: str = ""
    format: str = "1080p"  # delivery format: 4k / 1440p / 1080p / 720p / standard
    orientation: Literal["landscape", "portrait"] = "portrait"
    tone: str = "conversational"
    length: str = "medium"  # legacy bucket; prefer duration_s when set
    duration_s: float | None = Field(default=60.0, ge=1.0, le=600.0)
    audience: str = ""
    language: str = "English"
    notes: str = ""

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        platforms = data.get("platforms")
        if not platforms:
            platforms = data.get("platform")
        data["platforms"] = normalize_script_platforms(platforms)
        # Keep a comma-joined legacy string for older readers.
        data["platform"] = ", ".join(data["platforms"])
        data["format"] = normalize_script_video_format(data.get("format"))
        data["orientation"] = normalize_script_orientation(data.get("orientation"))
        return data

    @field_validator("platforms")
    @classmethod
    def _platforms_nonempty(cls, v: list[str]) -> list[str]:
        return normalize_script_platforms(v)


class ScriptChatTurn(BaseModel):
    role: str = Field(..., min_length=1, max_length=16)
    content: str = Field(..., min_length=1, max_length=20000)


class ScriptMarker(BaseModel):
    """Named cue on the absolute timeline, owned by a script draft."""

    id: str = Field(default_factory=new_id)
    name: str = Field(..., min_length=1, max_length=200)
    time_s: float = Field(0.0, ge=0.0)


class ScriptDocument(BaseModel):
    id: str = Field(default_factory=new_id)
    title: str = "Untitled script"
    summary: str = ""
    script: str = ""
    chat: list[ScriptChatTurn] = Field(default_factory=list)
    brief: ScriptBrief = Field(default_factory=ScriptBrief)
    markers: list[ScriptMarker] = Field(default_factory=list)
    source: ScriptSource = "edited"
    frozen: bool = False
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class ScriptSummary(BaseModel):
    id: str
    title: str
    summary: str = ""
    source: ScriptSource = "edited"
    frozen: bool = False
    word_count: int = 0
    created_at: str
    updated_at: str
    preview: str = ""
    active: bool = False


class CreateScriptRequest(BaseModel):
    title: str = "Untitled script"
    summary: str = ""
    script: str = Field(default="", max_length=100000)
    chat: list[ScriptChatTurn] = Field(default_factory=list)
    brief: ScriptBrief = Field(default_factory=ScriptBrief)
    markers: list[ScriptMarker] = Field(default_factory=list)
    source: ScriptSource = "edited"
    frozen: bool = False
    activate: bool = False


class UpdateScriptRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    script: str | None = Field(default=None, max_length=100000)
    chat: list[ScriptChatTurn] | None = None
    brief: ScriptBrief | None = None
    markers: list[ScriptMarker] | None = None
    source: ScriptSource | None = None
    frozen: bool | None = None
    activate: bool | None = None


class ActivateScriptRequest(BaseModel):
    active: bool = True


def _word_count(text: str) -> int:
    t = (text or "").strip()
    if not t:
        return 0
    return len([w for w in t.split() if w])


def _preview(text: str, max_len: int = 110) -> str:
    one = " ".join((text or "").split())
    if len(one) <= max_len:
        return one
    return f"{one[: max_len - 1]}…"


class ScriptStore:
    """One folder per script: ``{scripts_dir}/{id}/script.json``."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _script_dir(self, script_id: str) -> Path:
        return self.root / script_id

    def _script_file(self, script_id: str) -> Path:
        return self._script_dir(script_id) / "script.json"

    def _load_file(self, path: Path) -> ScriptDocument:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("invalid script file")
        return ScriptDocument.model_validate(data)

    def list_scripts(self) -> list[ScriptSummary]:
        summaries: list[ScriptSummary] = []
        if not self.root.exists():
            return summaries
        for sdir in self.root.iterdir():
            if not sdir.is_dir():
                continue
            sfile = sdir / "script.json"
            if not sfile.exists():
                continue
            try:
                doc = self._load_file(sfile)
            except (OSError, json.JSONDecodeError, ValueError):
                continue
            summaries.append(
                ScriptSummary(
                    id=doc.id,
                    title=doc.title,
                    summary=doc.summary,
                    source=doc.source,
                    frozen=bool(doc.frozen),
                    word_count=_word_count(doc.script),
                    created_at=doc.created_at,
                    updated_at=doc.updated_at,
                    preview=_preview(doc.script),
                )
            )
        return sorted(summaries, key=lambda s: s.updated_at, reverse=True)

    def get_script(self, script_id: str) -> ScriptDocument:
        path = self._script_file(script_id)
        if not path.exists():
            raise FileNotFoundError(f"Script not found: {script_id}")
        return self._load_file(path)

    def create_script(self, req: CreateScriptRequest) -> ScriptDocument:
        script_text = (req.script or "").strip()
        script_id = new_id()
        while self._script_dir(script_id).exists():
            script_id = new_id()
        now = _now_iso()
        markers = list(req.markers or [])
        markers.sort(key=lambda m: (m.time_s, m.name))
        doc = ScriptDocument(
            id=script_id,
            title=(req.title or "").strip() or "Untitled script",
            summary=(req.summary or "").strip(),
            script=script_text,
            chat=list(req.chat or [])[-40:],
            brief=req.brief or ScriptBrief(),
            markers=markers,
            source=req.source or "edited",
            frozen=bool(req.frozen),
            created_at=now,
            updated_at=now,
        )
        sdir = self._script_dir(script_id)
        sdir.mkdir(parents=True)
        self._save(doc)
        return doc

    def update_script(self, script_id: str, req: UpdateScriptRequest) -> ScriptDocument:
        doc = self.get_script(script_id)
        data = doc.model_dump()
        updates = req.model_dump(exclude_unset=True)
        content_keys = ("title", "summary", "script", "chat", "brief", "markers", "source")
        changing_content = any(k in updates and updates[k] is not None for k in content_keys)
        will_unfreeze = "frozen" in updates and updates["frozen"] is False
        if doc.frozen and changing_content and not will_unfreeze:
            raise ValueError("Script is frozen. Unfreeze or create a new version to edit.")
        if "title" in updates and updates["title"] is not None:
            data["title"] = str(updates["title"]).strip() or "Untitled script"
        if "summary" in updates and updates["summary"] is not None:
            data["summary"] = str(updates["summary"]).strip()
        if "script" in updates and updates["script"] is not None:
            data["script"] = str(updates["script"]).strip()
        if "chat" in updates and updates["chat"] is not None:
            data["chat"] = updates["chat"][-40:]
        if "brief" in updates and updates["brief"] is not None:
            data["brief"] = updates["brief"]
        if "markers" in updates and updates["markers"] is not None:
            markers = [ScriptMarker.model_validate(m) for m in (updates["markers"] or [])]
            markers.sort(key=lambda m: (m.time_s, m.name.lower()))
            data["markers"] = [m.model_dump() for m in markers]
        if "source" in updates and updates["source"] is not None:
            data["source"] = updates["source"]
        if "frozen" in updates and updates["frozen"] is not None:
            data["frozen"] = bool(updates["frozen"])
        data["updated_at"] = _now_iso()
        updated = ScriptDocument.model_validate(data)
        self._save(updated)
        return updated

    def delete_script(self, script_id: str) -> str:
        sdir = self._script_dir(script_id)
        if not sdir.exists():
            raise FileNotFoundError(f"Script not found: {script_id}")
        shutil.rmtree(sdir)
        return script_id

    def clear_all(self) -> int:
        deleted = 0
        if not self.root.exists():
            return 0
        for sdir in list(self.root.iterdir()):
            if sdir.is_dir() and (sdir / "script.json").exists():
                shutil.rmtree(sdir)
                deleted += 1
        return deleted

    def _save(self, doc: ScriptDocument) -> None:
        path = self._script_file(doc.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(doc.model_dump_json(indent=2), encoding="utf-8")


def summary_to_api(summary: ScriptSummary) -> dict[str, Any]:
    return {
        "id": summary.id,
        "title": summary.title,
        "summary": summary.summary,
        "source": summary.source,
        "frozen": bool(summary.frozen),
        "word_count": summary.word_count,
        "createdAt": summary.created_at,
        "updatedAt": summary.updated_at,
        "preview": summary.preview,
        "active": bool(summary.active),
    }


def document_to_api(doc: ScriptDocument, *, active: bool = False) -> dict[str, Any]:
    """Serialize for the Script Generator UI (camelCase timestamps match prior UI)."""
    return {
        "id": doc.id,
        "title": doc.title,
        "summary": doc.summary,
        "script": doc.script,
        "chat": [t.model_dump() for t in doc.chat],
        "brief": doc.brief.model_dump(),
        "markers": [m.model_dump() for m in (doc.markers or [])],
        "source": doc.source,
        "frozen": bool(doc.frozen),
        "createdAt": doc.created_at,
        "updatedAt": doc.updated_at,
        "word_count": _word_count(doc.script),
        "preview": _preview(doc.script),
        "active": bool(active),
    }
