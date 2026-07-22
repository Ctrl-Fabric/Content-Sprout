"""Tests for local TTS helpers."""

from unittest.mock import patch

from content_sprout.tts import (
    TtsVoice,
    _mood_audio_filters,
    _parse_voice_id,
    apply_mood_markup,
    available_engines,
    default_voice_id,
    list_voices,
    normalize_mood,
    plain_speech_text,
    prepare_speech_text,
    resolve_mood,
    rich_text_to_speech_markup,
)


def test_parse_voice_id():
    assert _parse_voice_id("macos:Samantha") == ("macos", "Samantha")
    assert _parse_voice_id("Samantha") == ("macos", "Samantha")
    assert _parse_voice_id(None) == (None, None)


def test_list_voices_parses_say_output():
    sample = (
        "Samantha            en_US    # Hello! My name is Samantha.\n"
        "Alice               it_IT    # Ciao! Mi chiamo Alice.\n"
    )
    with patch("content_sprout.tts.shutil.which", return_value="/usr/bin/say"):
        with patch("content_sprout.tts.subprocess.check_output", return_value=sample):
            voices = list_voices()
    assert len(voices) == 2
    assert voices[0].name == "Samantha"
    assert voices[0].id == "macos:Samantha"
    assert voices[0].locale == "en_US"


def test_default_voice_prefers_samantha():
    voices = [
        TtsVoice(id="macos:Alice", name="Alice", locale="it_IT", engine="macos"),
        TtsVoice(id="macos:Samantha", name="Samantha", locale="en_US", engine="macos"),
    ]
    with patch("content_sprout.tts.list_voices", return_value=voices):
        assert default_voice_id() == "macos:Samantha"


def test_available_engines_includes_macos_when_say_present():
    with patch("content_sprout.tts.shutil.which", side_effect=lambda c: "/usr/bin/say" if c == "say" else None):
        assert "macos" in available_engines()


def test_rich_text_markdown_and_html_emphasis():
    out = rich_text_to_speech_markup("Say **this** and <strong>that</strong> now.")
    assert "[[emph +]]this[[emph -]]" in out
    assert "[[emph +]]that[[emph -]]" in out
    assert "**" not in out
    assert "<strong>" not in out


def test_rich_text_italic_and_plain():
    out = rich_text_to_speech_markup("A *soft* word and <em>gentle</em> tone.")
    assert "[[emph +]]soft[[emph -]]" in out
    assert "[[emph +]]gentle[[emph -]]" in out
    assert plain_speech_text("Hello **world**") == "Hello world"


def test_mood_prosody_and_normalize():
    assert normalize_mood("Excited") == "excited"
    assert normalize_mood("nope") == "neutral"
    # Mood must not be injected into spoken text (modern voices read [[rate …]] aloud).
    assert apply_mood_markup("Hello", "excited") == "Hello"
    assert apply_mood_markup("Hello", "neutral") == "Hello"
    excited = resolve_mood("excited")
    assert excited.rate == 230
    assert excited.pitch == 4
    assert excited.volume == 1.05
    assert excited.needs_audio_filter
    assert resolve_mood("neutral").rate is None
    assert not resolve_mood("neutral").needs_audio_filter


def test_mood_audio_filters_pitch_and_volume():
    filters = _mood_audio_filters(resolve_mood("sad"))
    assert any(f.startswith("asetrate=") for f in filters)
    assert any(f.startswith("volume=") for f in filters)
    assert _mood_audio_filters(resolve_mood("neutral")) == []


def test_prepare_speech_text_emphasis_without_mood_markup():
    spoken = prepare_speech_text("I am **really** glad!", mood="happy")
    assert "[[emph +]]really[[emph -]]" in spoken
    assert "[[rate" not in spoken
    assert spoken.startswith("I am")
