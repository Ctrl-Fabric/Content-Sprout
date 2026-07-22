"""Decision cache — JSONL manifest keyed by source file SHA-256."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from .placement.base import PlacementDecision

DecidedBy = Literal["heuristic", "llm", "cache"]


@dataclass
class ManifestEntry:
    input_sha256: str
    decided_by: DecidedBy
    final_corner: str
    final_variant: str
    heuristic_confidence: float | None = None
    heuristic_gap: float | None = None
    llm_confidence: float | None = None
    llm_model: str | None = None
    timestamp: str | None = None

    def to_json(self) -> str:
        d = asdict(self)
        if d["timestamp"] is None:
            d["timestamp"] = datetime.now(UTC).isoformat()
        return json.dumps(d, separators=(",", ":"))


class DecisionCache:
    """Append-only JSONL cache; latest entry per SHA wins on lookup."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.touch()

    def get(self, sha256: str) -> PlacementDecision | None:
        if not self.path.exists():
            return None
        latest: dict[str, Any] | None = None
        for line in self.path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("input_sha256") == sha256:
                latest = row
        if latest is None:
            return None
        return PlacementDecision(
            corner=latest["final_corner"],  # type: ignore[arg-type]
            logo_variant=latest["final_variant"],  # type: ignore[arg-type]
            confidence=float(latest.get("llm_confidence") or latest.get("heuristic_confidence") or 1.0),
            second_best_gap=float(latest.get("heuristic_gap") or 1.0),
        )

    def append(
        self,
        *,
        sha256: str,
        decided_by: DecidedBy,
        final: PlacementDecision,
        heuristic: PlacementDecision | None = None,
        llm_model: str | None = None,
    ) -> None:
        entry = ManifestEntry(
            input_sha256=sha256,
            decided_by=decided_by,
            final_corner=final.corner,
            final_variant=final.logo_variant,
            heuristic_confidence=heuristic.confidence if heuristic else None,
            heuristic_gap=heuristic.second_best_gap if heuristic else None,
            llm_confidence=final.confidence if decided_by == "llm" else None,
            llm_model=llm_model if decided_by == "llm" else None,
        )
        with self.path.open("a") as f:
            f.write(entry.to_json() + "\n")
