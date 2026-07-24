"""App-bound encryption for locked stock assets at rest.

Files are stored as ``CSASSET1`` + Fernet ciphertext so Finder / external apps
cannot open them. The key lives under the app cache directory (created once).
This is deterrence against casual exfiltration, not DRM against a determined
local attacker who can extract the key.
"""

from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

MAGIC = b"CSASSET1"
KEY_FILENAME = "stock_asset.key"


class AssetCryptoError(ValueError):
    """Raised when encryption or decryption fails."""


def key_path(cache_dir: Path) -> Path:
    return Path(cache_dir).resolve() / KEY_FILENAME


def load_or_create_key(cache_dir: Path) -> bytes:
    """Return a 32-byte key, creating ``stock_asset.key`` on first use."""
    path = key_path(cache_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        raw = path.read_bytes()
        if len(raw) >= 32:
            return raw[:32]
        raise AssetCryptoError("stock_asset.key is corrupt or too short")
    raw = secrets.token_bytes(32)
    path.write_bytes(raw)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return raw


def _fernet(key: bytes) -> Fernet:
    # Fernet expects a url-safe base64-encoded 32-byte key.
    return Fernet(base64.urlsafe_b64encode(key[:32]))


def is_encrypted_blob(data: bytes) -> bool:
    return isinstance(data, (bytes, bytearray)) and bytes(data).startswith(MAGIC)


def is_encrypted_file(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            return fh.read(len(MAGIC)) == MAGIC
    except OSError:
        return False


def encrypt_bytes(plaintext: bytes, key: bytes) -> bytes:
    if not isinstance(plaintext, (bytes, bytearray)):
        raise AssetCryptoError("plaintext must be bytes")
    token = _fernet(key).encrypt(bytes(plaintext))
    return MAGIC + token


def decrypt_bytes(blob: bytes, key: bytes) -> bytes:
    if not is_encrypted_blob(blob):
        raise AssetCryptoError("Not an encrypted asset blob")
    token = blob[len(MAGIC) :]
    try:
        return _fernet(key).decrypt(token)
    except InvalidToken as exc:
        raise AssetCryptoError("Failed to decrypt asset (wrong key or corrupt file)") from exc


def read_maybe_encrypted(path: Path, key: bytes) -> bytes:
    """Read a file, decrypting when it has the CSASSET1 header."""
    data = path.read_bytes()
    if is_encrypted_blob(data):
        return decrypt_bytes(data, key)
    return data


def write_encrypted(path: Path, plaintext: bytes, key: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encrypt_bytes(plaintext, key))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
