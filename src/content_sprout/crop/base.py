"""Cropper protocol — concrete strategies live in sibling modules."""

from typing import Protocol

from PIL import Image


class Cropper(Protocol):
    def crop_to(self, img: Image.Image, target_w: int, target_h: int) -> Image.Image:
        """Return a copy of `img` cropped+resized to exactly (target_w, target_h)."""
        ...
