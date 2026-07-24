"""Per-day stock download quota (local calendar day).

Usage is stored encrypted under the app cache directory so the date/count
cannot be casually edited as plaintext JSON. Uses the same key as locked
stock assets (``stock_asset.key``).
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from . import asset_crypto

# Encrypted blob on disk (CSASSET1 + Fernet). Legacy plaintext .json is migrated.
USAGE_FILENAME = "stock_download_usage.csasset"
LEGACY_USAGE_FILENAME = "stock_download_usage.json"


@dataclass(frozen=True)
class QuotaStatus:
    limit: int  # 0 = unlimited
    used: int
    remaining: int | None  # None when unlimited
    date: str

    @property
    def allowed(self) -> bool:
        if self.limit <= 0:
            return True
        return self.used < self.limit


def usage_path(cache_dir: Path) -> Path:
    return Path(cache_dir).resolve() / USAGE_FILENAME


def legacy_usage_path(cache_dir: Path) -> Path:
    return Path(cache_dir).resolve() / LEGACY_USAGE_FILENAME


def _today() -> str:
    return date.today().isoformat()


def _parse_payload(raw: object) -> tuple[str, int]:
    if not isinstance(raw, dict):
        return _today(), 0
    day = str(raw.get("date") or "")
    try:
        count = int(raw.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    if day != _today():
        return _today(), 0
    return day, max(0, count)


def _read_usage(cache_dir: Path) -> tuple[str, int]:
    """Return (date, count). Tampered/corrupt encrypted files fail closed for today."""
    cache = Path(cache_dir).resolve()
    path = usage_path(cache)
    legacy = legacy_usage_path(cache)
    key = asset_crypto.load_or_create_key(cache)

    if path.is_file():
        try:
            blob = path.read_bytes()
            if asset_crypto.is_encrypted_blob(blob):
                plain = asset_crypto.decrypt_bytes(blob, key)
            else:
                # Unexpected plaintext at encrypted path — treat as tamper.
                return _today(), _fail_closed_count()
            raw = json.loads(plain.decode("utf-8"))
            return _parse_payload(raw)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, asset_crypto.AssetCryptoError):
            # Fail closed: cannot verify usage → assume limit already hit for today.
            return _today(), _fail_closed_count()

    if legacy.is_file():
        day, count = _migrate_legacy(legacy, path, key)
        return day, count

    return _today(), 0


def _fail_closed_count() -> int:
    """Large sentinel so any finite daily limit blocks further downloads."""
    return 10**9


def _migrate_legacy(legacy: Path, dest: Path, key: bytes) -> tuple[str, int]:
    """One-time migrate plaintext JSON → encrypted csasset, then remove legacy."""
    try:
        raw = json.loads(legacy.read_text(encoding="utf-8"))
        day, count = _parse_payload(raw)
    except (OSError, json.JSONDecodeError):
        try:
            legacy.unlink(missing_ok=True)
        except OSError:
            pass
        return _today(), 0
    _write_usage(dest, day, count, key)
    try:
        legacy.unlink(missing_ok=True)
    except OSError:
        pass
    return day, count


def _write_usage(path: Path, day: str, count: int, key: bytes | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if key is None:
        key = asset_crypto.load_or_create_key(path.parent)
    payload = json.dumps({"date": day, "count": int(count)}, separators=(",", ":")).encode(
        "utf-8"
    )
    blob = asset_crypto.encrypt_bytes(payload, key)
    fd, tmp_name = tempfile.mkstemp(
        prefix="stock-quota-",
        suffix=".csasset",
        dir=path.parent,
    )
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
        try:
            os.chmod(tmp_name, 0o600)
        except OSError:
            pass
        Path(tmp_name).replace(path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def get_status(cache_dir: Path, limit: int) -> QuotaStatus:
    day, used = _read_usage(cache_dir)
    lim = max(0, int(limit))
    # Cap displayed used at limit for UI when fail-closed sentinel is active.
    display_used = used if lim <= 0 else min(used, lim) if used < _fail_closed_count() else lim
    if lim <= 0:
        return QuotaStatus(limit=0, used=display_used, remaining=None, date=day)
    remaining = max(0, lim - display_used)
    return QuotaStatus(limit=lim, used=display_used, remaining=remaining, date=day)


def check_allowed(cache_dir: Path, limit: int) -> QuotaStatus:
    """Return current status; does not increment."""
    return get_status(cache_dir, limit)


def consume(cache_dir: Path, limit: int) -> QuotaStatus:
    """Increment usage by 1 if under limit. Raises QuotaExceeded when blocked."""
    cache = Path(cache_dir).resolve()
    path = usage_path(cache)
    lim = max(0, int(limit))
    day, used = _read_usage(cache)
    if lim > 0 and used >= lim:
        display = min(used, lim) if used < _fail_closed_count() else lim
        raise QuotaExceeded(
            f"Daily stock download limit reached ({display}/{lim}). Resets at midnight."
        )
    used += 1
    key = asset_crypto.load_or_create_key(cache)
    _write_usage(path, day, used, key)
    if lim <= 0:
        return QuotaStatus(limit=0, used=used, remaining=None, date=day)
    return QuotaStatus(limit=lim, used=used, remaining=max(0, lim - used), date=day)


class QuotaExceeded(Exception):
    """Raised when the daily stock download limit has been hit."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message
