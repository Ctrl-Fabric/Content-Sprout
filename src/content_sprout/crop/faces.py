"""Face detection via MediaPipe — feeds the smart cropper a 'must-include' subject."""

from __future__ import annotations

import numpy as np
from PIL import Image

# Lazy singleton: MediaPipe init is ~100ms, and the detector is reusable.
_detector = None


def _get_detector():
    global _detector
    if _detector is None:
        import mediapipe as mp

        # model_selection=1 is the full-range model, better for non-close-up shots
        # (landscapes with people in them, group photos, etc.).
        _detector = mp.solutions.face_detection.FaceDetection(
            model_selection=1,
            min_detection_confidence=0.5,
        )
    return _detector


def detect(img: Image.Image) -> list[tuple[int, int, int, int]]:
    """Return pixel-space face bounding boxes as (x1, y1, x2, y2).

    Empty list if no faces detected or if detection fails for any reason —
    callers should treat this as 'no subject hint available' and fall back to
    saliency-based cropping.
    """
    try:
        arr = np.asarray(img)  # RGB uint8
        result = _get_detector().process(arr)
    except Exception:
        return []

    if not result.detections:
        return []

    h, w = arr.shape[:2]
    boxes: list[tuple[int, int, int, int]] = []
    for d in result.detections:
        rb = d.location_data.relative_bounding_box
        x1 = max(0, int(rb.xmin * w))
        y1 = max(0, int(rb.ymin * h))
        x2 = min(w, int((rb.xmin + rb.width) * w))
        y2 = min(h, int((rb.ymin + rb.height) * h))
        if x2 > x1 and y2 > y1:
            boxes.append((x1, y1, x2, y2))
    return boxes
