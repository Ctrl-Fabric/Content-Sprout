"""Logo placement types and protocol."""

from dataclasses import dataclass
from typing import Literal, Protocol

from PIL import Image

from ..config import LogoConfig

Corner = Literal["tl", "tr", "bl", "br"]
LogoVariant = Literal["dark", "white"]


@dataclass(frozen=True)
class PlacementDecision:
    """Where and which logo variant to use on a rendered image."""

    corner: Corner
    logo_variant: LogoVariant
    confidence: float
    second_best_gap: float


class Placer(Protocol):
    def decide(
        self,
        img: Image.Image,
        logo_cfg: LogoConfig,
        logo_aspect: float,
    ) -> PlacementDecision:
        """Choose corner and dark/white logo variant for `img`."""
        ...
