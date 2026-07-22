"""Local text-to-speech helpers.

Primary engine: macOS ``say`` (built-in, free, no extra install).
Optional: Piper CLI if installed on PATH (open-source neural TTS).

Speech text may include Markdown/HTML emphasis (``**bold**``, ``<strong>``)
which is converted to Apple Speech emphasis commands. Optional mood presets
adjust rate via ``say -r``, and pitch / volume via ffmpeg post-processing
(modern macOS voices often speak embedded ``[[rate …]]`` markup aloud).
"""

from __future__ import annotations

import html
import logging
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

_VOICE_LINE = re.compile(
    r"^(?P<name>.+?)\s+(?P<locale>[a-z]{2}_[A-Z]{2})\s+#\s*(?P<sample>.*)$"
)

# Friendly labels for macOS `say` locale region codes (xx_YY → YY).
_REGION_LABELS: dict[str, str] = {
    "US": "United States",
    "GB": "United Kingdom",
    "AU": "Australia",
    "IE": "Ireland",
    "IN": "India",
    "ZA": "South Africa",
    "CA": "Canada",
    "NZ": "New Zealand",
    "SG": "Singapore",
    "PH": "Philippines",
    "HK": "Hong Kong",
    "CN": "China",
    "TW": "Taiwan",
    "JP": "Japan",
    "KR": "Korea",
    "DE": "Germany",
    "AT": "Austria",
    "CH": "Switzerland",
    "FR": "France",
    "BE": "Belgium",
    "ES": "Spain",
    "MX": "Mexico",
    "AR": "Argentina",
    "CL": "Chile",
    "CO": "Colombia",
    "IT": "Italy",
    "PT": "Portugal",
    "BR": "Brazil",
    "NL": "Netherlands",
    "SE": "Sweden",
    "NO": "Norway",
    "DK": "Denmark",
    "FI": "Finland",
    "PL": "Poland",
    "CZ": "Czechia",
    "HU": "Hungary",
    "RO": "Romania",
    "GR": "Greece",
    "TR": "Turkey",
    "RU": "Russia",
    "UA": "Ukraine",
    "SA": "Saudi Arabia",
    "AE": "United Arab Emirates",
    "EG": "Egypt",
    "IL": "Israel",
    "TH": "Thailand",
    "ID": "Indonesia",
    "MY": "Malaysia",
    "VN": "Vietnam",
    "BG": "Bulgaria",
    "SK": "Slovakia",
    "HR": "Croatia",
    "RS": "Serbia",
    "SI": "Slovenia",
    "LT": "Lithuania",
    "LV": "Latvia",
    "EE": "Estonia",
    "IS": "Iceland",
    "AF": "Afghanistan",
    "NP": "Nepal",
    "BD": "Bangladesh",
    "PK": "Pakistan",
    "LK": "Sri Lanka",
}

# Mood → prosody (rate WPM for ``say -r``, pitch semitones, volume linear gain).
TTS_MOODS: dict[str, dict] = {
    "neutral": {"label": "Neutral", "rate": None, "pitch": None, "volume": None},
    "excited": {"label": "Excited", "rate": 230, "pitch": 4, "volume": 1.05},
    "happy": {"label": "Happy", "rate": 205, "pitch": 3, "volume": 1.0},
    "angry": {"label": "Angry", "rate": 215, "pitch": 2, "volume": 1.15},
    "sad": {"label": "Sad", "rate": 135, "pitch": -5, "volume": 0.7},
    "calm": {"label": "Calm", "rate": 155, "pitch": -1, "volume": 0.85},
    "serious": {"label": "Serious", "rate": 165, "pitch": -2, "volume": 0.95},
    "whisper": {"label": "Whisper", "rate": 145, "pitch": -3, "volume": 0.4},
}

_DEFAULT_MOOD = "neutral"
_WAV_SAMPLE_RATE = 22050


@dataclass(frozen=True)
class MoodProsody:
    """Resolved mood controls applied outside of spoken text."""

    id: str = _DEFAULT_MOOD
    rate: int | None = None
    pitch: int | None = None
    volume: float | None = None

    @property
    def needs_audio_filter(self) -> bool:
        pitch = self.pitch or 0
        vol = self.volume
        return pitch != 0 or (vol is not None and abs(float(vol) - 1.0) > 0.01)

_HTML_EMPH = re.compile(
    r"<(?P<tag>strong|b|em|i)\b[^>]*>(?P<body>.*?)</(?P=tag)>",
    re.IGNORECASE | re.DOTALL,
)
_MD_BOLD = re.compile(r"\*\*(?P<body>.+?)\*\*|__(?P<body2>.+?)__")
_MD_ITALIC = re.compile(
    r"(?<!\*)\*(?!\*)(?P<body>.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(?P<body2>.+?)(?<!_)_(?!_)"
)
_HTML_TAG = re.compile(r"<[^>]+>")
_EMPH_WRAP = "[[emph +]]{0}[[emph -]]"


@dataclass(frozen=True)
class TtsVoice:
    id: str
    name: str
    locale: str
    engine: str  # macos | piper
    sample: str = ""

    @property
    def region(self) -> str:
        """Country/region code from locale (e.g. en_US → US)."""
        if "_" in self.locale:
            return self.locale.rsplit("_", 1)[-1]
        return self.locale or "XX"

    @property
    def region_label(self) -> str:
        return _REGION_LABELS.get(self.region, self.region)


def list_moods() -> list[dict[str, str]]:
    return [{"id": key, "label": str(meta["label"])} for key, meta in TTS_MOODS.items()]


def normalize_mood(mood: str | None) -> str:
    key = (mood or _DEFAULT_MOOD).strip().lower()
    return key if key in TTS_MOODS else _DEFAULT_MOOD


def _wrap_emphasis(body: str) -> str:
    inner = (body or "").strip()
    if not inner:
        return ""
    return _EMPH_WRAP.format(inner)


def rich_text_to_speech_markup(text: str) -> str:
    """Convert Markdown/HTML emphasis into Apple Speech ``[[emph]]`` commands."""
    raw = html.unescape(text or "")

    def _html_sub(match: re.Match[str]) -> str:
        return _wrap_emphasis(match.group("body"))

    # Repeat until stable so nested tags flatten reasonably.
    for _ in range(8):
        nxt = _HTML_EMPH.sub(_html_sub, raw)
        if nxt == raw:
            break
        raw = nxt

    def _md_bold_sub(match: re.Match[str]) -> str:
        return _wrap_emphasis(match.group("body") or match.group("body2") or "")

    def _md_italic_sub(match: re.Match[str]) -> str:
        return _wrap_emphasis(match.group("body") or match.group("body2") or "")

    raw = _MD_BOLD.sub(_md_bold_sub, raw)
    raw = _MD_ITALIC.sub(_md_italic_sub, raw)
    raw = _HTML_TAG.sub("", raw)
    # Collapse leftover markup noise; keep speech pauses from newlines.
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    raw = re.sub(r"[ \t]+", " ", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def plain_speech_text(text: str) -> str:
    """Human-readable script without Markdown/HTML/speech commands."""
    marked = rich_text_to_speech_markup(text)
    plain = re.sub(r"\[\[.*?\]\]", "", marked)
    plain = re.sub(r"\s+", " ", plain).strip()
    return plain


def resolve_mood(mood: str | None = None) -> MoodProsody:
    """Map a mood id to rate / pitch / volume controls."""
    key = normalize_mood(mood)
    meta = TTS_MOODS[key]
    rate = meta.get("rate")
    pitch = meta.get("pitch")
    volume = meta.get("volume")
    return MoodProsody(
        id=key,
        rate=int(rate) if rate is not None else None,
        pitch=int(pitch) if pitch is not None else None,
        volume=max(0.05, min(1.2, float(volume))) if volume is not None else None,
    )


def apply_mood_markup(text: str, mood: str | None = None) -> str:
    """Return spoken text unchanged.

    Historically prefixed Apple ``[[rate …]]`` commands. Modern voices speak those
    commands aloud, so mood is applied in ``synthesize_to_file`` instead.
    ``mood`` is accepted for call-site compatibility.
    """
    _ = mood
    return (text or "").strip()


def prepare_speech_text(text: str, *, mood: str | None = None) -> str:
    """Rich text → string ready for ``say`` / Piper (emphasis only; mood is separate)."""
    return apply_mood_markup(rich_text_to_speech_markup(text), mood)


def available_engines() -> list[str]:
    engines: list[str] = []
    if shutil.which("say"):
        engines.append("macos")
    if shutil.which("piper"):
        engines.append("piper")
    return engines


def list_voices() -> list[TtsVoice]:
    voices: list[TtsVoice] = []
    if shutil.which("say"):
        voices.extend(_list_macos_voices())
    # Piper voice discovery is model-path based; skip auto-list unless configured.
    return voices


def list_regions(voices: list[TtsVoice] | None = None) -> list[dict[str, str]]:
    items = voices if voices is not None else list_voices()
    seen: dict[str, str] = {}
    for v in items:
        seen.setdefault(v.region, v.region_label)
    return [
        {"id": code, "code": code, "label": label}
        for code, label in sorted(seen.items(), key=lambda x: x[1])
    ]


def _list_macos_voices() -> list[TtsVoice]:
    try:
        raw = subprocess.check_output(["say", "-v", "?"], text=True, timeout=30)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("Failed to list macOS voices: %s", exc)
        return []

    voices: list[TtsVoice] = []
    for line in raw.splitlines():
        m = _VOICE_LINE.match(line.strip())
        if not m:
            continue
        name = m.group("name").strip()
        voices.append(
            TtsVoice(
                id=f"macos:{name}",
                name=name,
                locale=m.group("locale"),
                engine="macos",
                sample=(m.group("sample") or "").strip(),
            )
        )
    # Prefer English voices at the top for the UI.
    voices.sort(key=lambda v: (0 if v.locale.startswith("en_") else 1, v.name.lower()))
    return voices


def default_voice_id() -> str | None:
    voices = list_voices()
    for preferred in ("Samantha", "Alex", "Daniel", "Karen", "Moira"):
        for v in voices:
            if v.name == preferred:
                return v.id
    return voices[0].id if voices else None


def synthesize_to_file(
    text: str,
    out_path: Path,
    *,
    voice_id: str | None = None,
    mood: str | None = None,
) -> Path:
    """Synthesize ``text`` to an audio file (WAV preferred). Returns ``out_path``."""
    spoken = prepare_speech_text(text, mood=mood)
    if not spoken:
        raise ValueError("Text is required for speech generation.")
    prosody = resolve_mood(mood)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    engine, voice_name = _parse_voice_id(voice_id)
    if engine == "macos" or (engine is None and shutil.which("say")):
        return _synthesize_macos(spoken, out_path, voice_name=voice_name, prosody=prosody)
    if engine == "piper" and shutil.which("piper"):
        raise RuntimeError(
            "Piper is installed but voice models are not configured in this build. "
            "Use a macOS voice, or install Piper voices and wire them later."
        )
    raise RuntimeError(
        "No text-to-speech engine available. On Mac, the built-in Speech feature "
        "(`say`) is used automatically."
    )


def _parse_voice_id(voice_id: str | None) -> tuple[str | None, str | None]:
    if not voice_id:
        return None, None
    if ":" in voice_id:
        engine, name = voice_id.split(":", 1)
        return engine.strip().lower(), name.strip()
    return "macos", voice_id.strip()


def _mood_audio_filters(prosody: MoodProsody, *, sample_rate: int = _WAV_SAMPLE_RATE) -> list[str]:
    """Build ffmpeg `-af` filter fragments for pitch / volume."""
    filters: list[str] = []
    pitch = prosody.pitch or 0
    if pitch:
        factor = 2.0 ** (pitch / 12.0)
        # Pitch-shift without changing duration (atempo compensates asetrate).
        atempo = 1.0 / factor
        # atempo only accepts 0.5–2.0; mood pitches stay within ±5 semitones.
        atempo = max(0.5, min(2.0, atempo))
        filters.append(
            f"asetrate={sample_rate * factor:.6f},aresample={sample_rate},atempo={atempo:.6f}"
        )
    if prosody.volume is not None and abs(float(prosody.volume) - 1.0) > 0.01:
        filters.append(f"volume={float(prosody.volume):.3f}")
    return filters


def _synthesize_macos(
    text: str,
    out_path: Path,
    *,
    voice_name: str | None,
    prosody: MoodProsody | None = None,
) -> Path:
    if not shutil.which("say"):
        raise RuntimeError("macOS `say` command not found.")

    prosody = prosody or MoodProsody()

    # say writes AIFF/CAF reliably; convert to WAV with ffmpeg when available.
    with tempfile.TemporaryDirectory() as tmp:
        aiff = Path(tmp) / "speech.aiff"
        cmd = ["say", "-o", str(aiff)]
        if voice_name:
            cmd.extend(["-v", voice_name])
        if prosody.rate is not None:
            cmd.extend(["-r", str(int(prosody.rate))])
        # Pass speech via a file so brackets in emphasis markup are never shell-mangled.
        script = Path(tmp) / "speech.txt"
        script.write_text(text, encoding="utf-8")
        cmd.extend(["-f", str(script)])
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or b"").decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"Speech synthesis failed: {detail or exc}") from exc

        target = out_path if out_path.suffix.lower() == ".wav" else out_path.with_suffix(".wav")
        af = _mood_audio_filters(prosody) if prosody.needs_audio_filter else []
        if shutil.which("ffmpeg"):
            ff_cmd = ["ffmpeg", "-y", "-i", str(aiff)]
            if af:
                ff_cmd.extend(["-af", ",".join(af)])
            ff_cmd.extend(["-acodec", "pcm_s16le", "-ar", str(_WAV_SAMPLE_RATE), str(target)])
            subprocess.run(
                ff_cmd,
                check=True,
                capture_output=True,
                timeout=60,
            )
        else:
            if af:
                logger.warning(
                    "ffmpeg not found; mood pitch/volume for %s will be skipped "
                    "(rate via say -r still applied).",
                    prosody.id,
                )
            # Fallback: keep AIFF if ffmpeg missing
            target = out_path.with_suffix(".aiff")
            shutil.copy2(aiff, target)
        return target


def probe_duration_s(path: Path) -> float | None:
    """Return audio duration in seconds via ffprobe, or None."""
    if not shutil.which("ffprobe"):
        return None
    try:
        raw = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            text=True,
            timeout=30,
        ).strip()
        return max(0.1, float(raw))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, OSError):
        return None
