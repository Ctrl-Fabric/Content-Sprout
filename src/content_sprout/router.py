"""Hybrid placement router — heuristic first, vision LLM when uncertain."""

from __future__ import annotations

import logging

from PIL import Image

from .cache import DecisionCache
from .config import AppConfig, LogoConfig
from .llm.client import VisionClient
from .llm.factory import create_vision_client, llm_model_name
from .placement import heuristic
from .placement.base import PlacementDecision

logger = logging.getLogger(__name__)

_LLM_PROVIDERS = frozenset({"ollama", "proxy"})


class PlacementRouter:
    """Route logo placement to local heuristic or a configured vision LLM."""

    def __init__(self, cfg: AppConfig, cache: DecisionCache | None = None):
        self._cfg = cfg
        self._cache = cache
        self._llm: VisionClient | None = None

    def _llm_client(self) -> VisionClient:
        if self._cfg.llm.provider not in _LLM_PROVIDERS:
            raise RuntimeError(
                f"LLM provider {self._cfg.llm.provider!r} is not enabled for vision calls."
            )
        if self._llm is None:
            self._llm = create_vision_client(self._cfg)
        return self._llm

    def _heuristic_confident(self, decision: PlacementDecision) -> bool:
        r = self._cfg.router
        return (
            decision.confidence >= r.heuristic_confidence_min
            and decision.second_best_gap >= r.heuristic_gap_min
        )

    def decide(
        self,
        probe: Image.Image,
        logo_cfg: LogoConfig,
        logo_aspect: float,
        *,
        source_sha: str | None = None,
    ) -> tuple[PlacementDecision, str]:
        """Return (decision, decided_by) where decided_by is heuristic|llm|cache."""
        if source_sha and self._cache:
            cached = self._cache.get(source_sha)
            if cached is not None:
                return cached, "cache"

        local = heuristic.decide(probe, logo_cfg, logo_aspect)
        if self._heuristic_confident(local):
            if source_sha and self._cache:
                self._cache.append(
                    sha256=source_sha,
                    decided_by="heuristic",
                    final=local,
                    heuristic=local,
                )
            return local, "heuristic"

        try:
            if self._cfg.llm.provider not in _LLM_PROVIDERS:
                raise RuntimeError("LLM disabled by configuration.")
            llm_decision = self._llm_client().decide_placement(probe)
            decided_by = "llm"
            final = llm_decision
        except Exception as exc:
            logger.warning("LLM placement failed, using heuristic: %s", exc)
            if self._cfg.router.llm_on_failure == "raise":
                raise
            final = local
            decided_by = "heuristic"

        if source_sha and self._cache:
            self._cache.append(
                sha256=source_sha,
                decided_by=decided_by,  # type: ignore[arg-type]
                final=final,
                heuristic=local,
                llm_model=llm_model_name(self._cfg) if decided_by == "llm" else None,
            )
        return final, decided_by
