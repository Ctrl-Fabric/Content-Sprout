"""Tests for watch-folder helpers."""

from pathlib import Path

from content_sprout.watcher import TRIAGE_DONE, TRIAGE_FAILED, _is_triage_path, file_is_settled


def test_triage_path_detection():
    assert _is_triage_path(Path("input/.done/photo.jpg"))
    assert _is_triage_path(Path("input/.failed/photo.jpg"))
    assert not _is_triage_path(Path("input/Vacation/photo.jpg"))


def test_file_is_settled(tmp_path: Path):
    f = tmp_path / "a.jpg"
    f.write_bytes(b"x" * 100)
    assert file_is_settled(f, checks=2, interval_s=0.01)
