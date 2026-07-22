"""Filesystem-backed store for Script Generator drafts under ``scripts_dir``."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .models import _now_iso, new_id

ScriptSource = Literal["generated", "refined", "edited", "manual"]


class ScriptBrief(BaseModel):
    topic: str = ""
    platform: str = "instagram_reel"
    format: str = "talking_head"
    tone: str = "conversational"
    length: str = "medium"
    audience: str = ""
    language: str = "English"
    notes: str = ""


class ScriptChatTurn(BaseModel):
    role: str = Field(..., min_length=1, max_length=16)
    content: str = Field(..., min_length=1, max_length=20000)


class ScriptDocument(BaseModel):
    id: str = Field(default_factory=new_id)
    title: str = "Untitled script"
    summary: str = ""
    script: str = ""
    chat: list[ScriptChatTurn] = Field(default_factory=list)
    brief: ScriptBrief = Field(default_factory=ScriptBrief)
    source: ScriptSource = "edited"
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class ScriptSummary(BaseModel):
    id: str
    title: str
    summary: str = ""
    source: ScriptSource = "edited"
    word_count: int = 0
    created_at: str
    updated_at: str
    preview: str = ""


class CreateScriptRequest(BaseModel):
    title: str = "Untitled script"
    summary: str = ""
    script: str = Field(..., min_length=1, max_length=100000)
    chat: list[ScriptChatTurn] = Field(default_factory=list)
    brief: ScriptBrief = Field(default_factory=ScriptBrief)
    source: ScriptSource = "edited"


class UpdateScriptRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    script: str | None = Field(default=None, max_length=100000)
    chat: list[ScriptChatTurn] | None = None
    brief: ScriptBrief | None = None
    source: ScriptSource | None = None


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
        script_text = req.script.strip()
        if not script_text:
            raise ValueError("Script is empty")
        script_id = new_id()
        while self._script_dir(script_id).exists():
            script_id = new_id()
        now = _now_iso()
        doc = ScriptDocument(
            id=script_id,
            title=(req.title or "").strip() or "Untitled script",
            summary=(req.summary or "").strip(),
            script=script_text,
            chat=list(req.chat or [])[-40:],
            brief=req.brief or ScriptBrief(),
            source=req.source or "edited",
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
        if "title" in updates and updates["title"] is not None:
            data["title"] = str(updates["title"]).strip() or "Untitled script"
        if "summary" in updates and updates["summary"] is not None:
            data["summary"] = str(updates["summary"]).strip()
        if "script" in updates and updates["script"] is not None:
            script_text = str(updates["script"]).strip()
            if not script_text:
                raise ValueError("Script is empty")
            data["script"] = script_text
        if "chat" in updates and updates["chat"] is not None:
            data["chat"] = updates["chat"][-40:]
        if "brief" in updates and updates["brief"] is not None:
            data["brief"] = updates["brief"]
        if "source" in updates and updates["source"] is not None:
            data["source"] = updates["source"]
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


def document_to_api(doc: ScriptDocument) -> dict[str, Any]:
    """Serialize for the Script Generator UI (camelCase timestamps match prior UI)."""
    return {
        "id": doc.id,
        "title": doc.title,
        "summary": doc.summary,
        "script": doc.script,
        "chat": [t.model_dump() for t in doc.chat],
        "brief": doc.brief.model_dump(),
        "source": doc.source,
        "createdAt": doc.created_at,
        "updatedAt": doc.updated_at,
        "word_count": _word_count(doc.script),
        "preview": _preview(doc.script),
    }


def summary_to_api(summary: ScriptSummary) -> dict[str, Any]:
    return {
        "id": summary.id,
        "title": summary.title,
        "summary": summary.summary,
        "source": summary.source,
        "word_count": summary.word_count,
        "createdAt": summary.created_at,
        "updatedAt": summary.updated_at,
        "preview": summary.preview,
    }
