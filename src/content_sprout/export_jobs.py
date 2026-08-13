"""In-memory export job progress (local studio; not durable across restarts)."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

from .models import new_id

_TTL_S = 2 * 60 * 60
_lock = threading.Lock()
_jobs: dict[str, "ExportJob"] = {}


@dataclass
class ExportJob:
    id: str
    project_id: str
    post_id: str
    kind: str  # image | video
    status: str = "queued"  # queued | running | done | error
    percent: float = 0.0
    message: str = "Queued…"
    error: str | None = None
    filename: str | None = None
    path: str | None = None
    media_type: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "post_id": self.post_id,
            "kind": self.kind,
            "status": self.status,
            "percent": round(max(0.0, min(100.0, float(self.percent))), 1),
            "message": self.message,
            "error": self.error,
            "filename": self.filename,
            "ready": self.status == "done" and bool(self.path),
        }


def _prune_locked() -> None:
    now = time.time()
    stale = [jid for jid, job in _jobs.items() if now - job.updated_at > _TTL_S]
    for jid in stale:
        _jobs.pop(jid, None)


def create_job(*, project_id: str, post_id: str, kind: str) -> ExportJob:
    with _lock:
        _prune_locked()
        job = ExportJob(
            id=new_id(),
            project_id=str(project_id),
            post_id=str(post_id),
            kind=str(kind),
        )
        _jobs[job.id] = job
        return job


def find_active_job(project_id: str, post_id: str, kind: str) -> ExportJob | None:
    with _lock:
        for job in _jobs.values():
            if (
                job.project_id == str(project_id)
                and job.post_id == str(post_id)
                and job.kind == str(kind)
                and job.status in {"queued", "running"}
            ):
                return job
        return None


def get_job(job_id: str) -> ExportJob | None:
    with _lock:
        return _jobs.get(str(job_id))


def update_job(job_id: str, **fields: object) -> ExportJob | None:
    with _lock:
        job = _jobs.get(str(job_id))
        if job is None:
            return None
        for key, value in fields.items():
            if hasattr(job, key):
                setattr(job, key, value)
        job.updated_at = time.time()
        return job
