"""Logo placement strategies."""

from .base import Corner, LogoVariant, PlacementDecision, Placer
from .heuristic import decide

__all__ = [
    "Corner",
    "LogoVariant",
    "PlacementDecision",
    "Placer",
    "decide",
]
