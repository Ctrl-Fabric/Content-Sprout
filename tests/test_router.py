"""Tests for hybrid placement router."""

from unittest.mock import MagicMock, patch

from PIL import Image

from content_sprout.config import AppConfig, RouterConfig
from content_sprout.placement.base import PlacementDecision
from content_sprout.placement.heuristic import decide
from content_sprout.router import PlacementRouter


def test_router_uses_heuristic_when_confident():
    cfg = AppConfig(
        router=RouterConfig(heuristic_confidence_min=0.5, heuristic_gap_min=0.01)
    )
    router = PlacementRouter(cfg, cache=None)
    img = Image.new("RGB", (400, 400), (250, 250, 250))

    with patch.object(router, "_heuristic_confident", return_value=True):
        decision, decided_by = router.decide(img, cfg.logo, logo_aspect=2.5)
    assert decided_by == "heuristic"
    assert decision.corner in {"tl", "tr", "bl", "br"}


def test_router_calls_llm_when_uncertain():
    cfg = AppConfig(
        router=RouterConfig(heuristic_confidence_min=0.99, heuristic_gap_min=0.99)
    )
    router = PlacementRouter(cfg, cache=None)
    img = Image.new("RGB", (400, 400), (128, 128, 128))
    llm_decision = PlacementDecision(
        corner="br", logo_variant="white", confidence=0.95, second_best_gap=1.0
    )

    with patch.object(router, "_llm_client") as mock_client_factory:
        mock_client = MagicMock()
        mock_client.decide_placement.return_value = llm_decision
        mock_client_factory.return_value = mock_client

        decision, decided_by = router.decide(img, cfg.logo, logo_aspect=2.5)
        assert decided_by == "llm"
        assert decision.corner == "br"
        mock_client.decide_placement.assert_called_once()


def test_router_falls_back_to_heuristic_on_llm_error():
    cfg = AppConfig(
        router=RouterConfig(
            heuristic_confidence_min=0.99,
            heuristic_gap_min=0.99,
            llm_on_failure="use_heuristic",
        )
    )
    router = PlacementRouter(cfg, cache=None)
    img = Image.new("RGB", (400, 400), (128, 128, 128))
    expected = decide(img, cfg.logo, logo_aspect=2.5)

    with patch.object(router, "_llm_client") as mock_client_factory:
        mock_client = MagicMock()
        mock_client.decide_placement.side_effect = RuntimeError("ollama down")
        mock_client_factory.return_value = mock_client

        decision, decided_by = router.decide(img, cfg.logo, logo_aspect=2.5)
        assert decided_by == "heuristic"
        assert decision.corner == expected.corner
