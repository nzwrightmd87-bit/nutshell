#!/usr/bin/env python3
"""Core encryption/decryption logic for the local cypher app.

Security model:
- message encryption happens locally before sharing
- only ciphertext leaves the computer
- each message uses fresh random salt + nonce
- passphrase is stretched with scrypt before encryption
- authenticated encryption protects confidentiality and integrity
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import hmac
import json
import zlib
from functools import lru_cache
from secrets import token_bytes
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

TOKEN_PREFIX = "CY1."
TRANSPORT_PREFIX = "CZ1."
FILE_TOKEN_PREFIX = "CYF1."
AAD = b"cypher-desktop-message-v1"
FILE_AAD = b"cypher-desktop-file-v1"
SALT_BYTES = 16
NONCE_BYTES = 12
KEY_BYTES = 32
TRANSPORT_TOKEN_LEN = 10
TRANSPORT_VARIANTS = 8
TRANSPORT_ALPHABET = "abcdefghijklmnopqrstuvwxyz"

SCRYPT_N = 2**16
SCRYPT_R = 8
SCRYPT_P = 1


class CipherError(ValueError):
    """Raised when ciphertext cannot be parsed or decrypted."""


@dataclass(frozen=True)
class DecryptedFile:
    """Represents a decrypted file payload."""

    filename: str
    media_type: str
    data: bytes


def _validate_passphrase(passphrase: str) -> None:
    if len(passphrase) < 12:
        raise CipherError("Passphrase must be at least 12 characters.")


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64d(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    _validate_passphrase(passphrase)
    kdf = Scrypt(
        salt=salt,
        length=KEY_BYTES,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def _serialize_envelope(envelope: dict[str, Any]) -> str:
    raw = json.dumps(envelope, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return TOKEN_PREFIX + _b64e(raw)


def _deserialize_envelope(token: str) -> dict[str, Any]:
    if not token.startswith(TOKEN_PREFIX):
        raise CipherError("Invalid token prefix.")
    encoded = token[len(TOKEN_PREFIX) :].strip()
    if not encoded:
        raise CipherError("Ciphertext is empty.")
    try:
        raw = _b64d(encoded)
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise CipherError("Ciphertext format is invalid.") from exc
    if payload.get("v") != 1:
        raise CipherError("Unsupported cipher version.")
    return payload


def _normalize_filename(filename: str) -> str:
    raw = filename.strip().replace("\\", "/")
    base = raw.rsplit("/", maxsplit=1)[-1]
    if not base or base in {".", ".."}:
        raise CipherError("Filename is invalid.")
    return base


def _deserialize_file_envelope(token: str) -> dict[str, Any]:
    if not token.startswith(FILE_TOKEN_PREFIX):
        raise CipherError("Invalid file token prefix.")
    encoded = token[len(FILE_TOKEN_PREFIX) :].strip()
    if not encoded:
        raise CipherError("Encrypted file token is empty.")
    try:
        raw = _b64d(encoded)
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise CipherError("Encrypted file token format is invalid.") from exc
    if payload.get("v") != 1 or payload.get("kind") != "file":
        raise CipherError("Unsupported encrypted file format.")
    return payload


def encrypt_message(plaintext: str, passphrase: str) -> str:
    """Encrypt a plaintext string into a portable ciphertext token."""
    if not plaintext:
        raise CipherError("Message is empty.")

    salt = token_bytes(SALT_BYTES)
    nonce = token_bytes(NONCE_BYTES)
    key = _derive_key(passphrase=passphrase, salt=salt)

    plain_bytes = plaintext.encode("utf-8")
    compressed = zlib.compress(plain_bytes, level=9)

    cipher = ChaCha20Poly1305(key)
    ciphertext = cipher.encrypt(nonce=nonce, data=compressed, associated_data=AAD)

    envelope = {
        "v": 1,
        "alg": "CHACHA20-POLY1305",
        "kdf": {
            "name": "SCRYPT",
            "n": SCRYPT_N,
            "r": SCRYPT_R,
            "p": SCRYPT_P,
            "salt": _b64e(salt),
        },
        "nonce": _b64e(nonce),
        "ct": _b64e(ciphertext),
    }
    return _serialize_envelope(envelope)


def decrypt_message(token: str, passphrase: str) -> str:
    """Decrypt a ciphertext token back to plaintext."""
    envelope = _deserialize_envelope(token)

    try:
        kdf = envelope["kdf"]
        salt = _b64d(kdf["salt"])
        nonce = _b64d(envelope["nonce"])
        ciphertext = _b64d(envelope["ct"])
    except Exception as exc:
        raise CipherError("Ciphertext structure is invalid.") from exc

    if len(salt) != SALT_BYTES or len(nonce) != NONCE_BYTES:
        raise CipherError("Ciphertext parameters are invalid.")

    key = _derive_key(passphrase=passphrase, salt=salt)
    cipher = ChaCha20Poly1305(key)
    try:
        compressed = cipher.decrypt(nonce=nonce, data=ciphertext, associated_data=AAD)
    except InvalidTag as exc:
        raise CipherError("Wrong passphrase or tampered ciphertext.") from exc

    try:
        plain_bytes = zlib.decompress(compressed)
        return plain_bytes.decode("utf-8")
    except Exception as exc:
        raise CipherError("Ciphertext could not be decoded.") from exc


def encrypt_file_to_cypher(
    *, file_bytes: bytes, filename: str, passphrase: str, media_type: str = "application/octet-stream"
) -> str:
    """Encrypt binary file bytes and return a portable file ciphertext token."""
    if not file_bytes:
        raise CipherError("File is empty.")
    safe_name = _normalize_filename(filename)
    safe_media_type = media_type.strip() or "application/octet-stream"

    salt = token_bytes(SALT_BYTES)
    nonce = token_bytes(NONCE_BYTES)
    key = _derive_key(passphrase=passphrase, salt=salt)

    cipher = ChaCha20Poly1305(key)
    ciphertext = cipher.encrypt(nonce=nonce, data=file_bytes, associated_data=FILE_AAD)

    envelope = {
        "v": 1,
        "kind": "file",
        "alg": "CHACHA20-POLY1305",
        "kdf": {
            "name": "SCRYPT",
            "n": SCRYPT_N,
            "r": SCRYPT_R,
            "p": SCRYPT_P,
            "salt": _b64e(salt),
        },
        "nonce": _b64e(nonce),
        "ct": _b64e(ciphertext),
        "name": safe_name,
        "media_type": safe_media_type,
        "size": len(file_bytes),
    }
    raw = json.dumps(envelope, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return FILE_TOKEN_PREFIX + _b64e(raw)


def decrypt_file_from_cypher(*, cyphertext: str, passphrase: str) -> DecryptedFile:
    """Decrypt a file ciphertext token back into binary payload + metadata."""
    envelope = _deserialize_file_envelope(cyphertext)

    try:
        kdf = envelope["kdf"]
        salt = _b64d(kdf["salt"])
        nonce = _b64d(envelope["nonce"])
        ciphertext = _b64d(envelope["ct"])
        filename = _normalize_filename(str(envelope["name"]))
        media_type = str(envelope.get("media_type") or "application/octet-stream")
        expected_size = int(envelope.get("size", -1))
    except Exception as exc:
        raise CipherError("Encrypted file structure is invalid.") from exc

    if len(salt) != SALT_BYTES or len(nonce) != NONCE_BYTES:
        raise CipherError("Encrypted file parameters are invalid.")

    key = _derive_key(passphrase=passphrase, salt=salt)
    cipher = ChaCha20Poly1305(key)
    try:
        file_bytes = cipher.decrypt(nonce=nonce, data=ciphertext, associated_data=FILE_AAD)
    except InvalidTag as exc:
        raise CipherError("Wrong passphrase or tampered encrypted file.") from exc

    if expected_size < 0 or len(file_bytes) != expected_size:
        raise CipherError("Encrypted file size check failed.")

    return DecryptedFile(filename=filename, media_type=media_type, data=file_bytes)


def _digest_to_alpha(digest: bytes, length: int) -> str:
    base = len(TRANSPORT_ALPHABET)
    value = int.from_bytes(digest, byteorder="big", signed=False)
    out: list[str] = []
    for _ in range(length):
        value, idx = divmod(value, base)
        out.append(TRANSPORT_ALPHABET[idx])
    return "".join(out)


@lru_cache(maxsize=32)
def _build_transport_maps(passphrase: str) -> tuple[tuple[tuple[str, ...], ...], dict[str, int]]:
    """Build deterministic homophonic token maps from the passphrase."""
    _validate_passphrase(passphrase)
    master = hashlib.sha256(f"cypher-transport-v1::{passphrase}".encode("utf-8")).digest()

    forward: list[list[str]] = [[] for _ in range(256)]
    reverse: dict[str, int] = {}
    used: set[str] = set()

    for byte in range(256):
        for variant in range(TRANSPORT_VARIANTS):
            counter = 0
            while True:
                seed = bytes([byte, variant]) + counter.to_bytes(4, byteorder="big")
                digest = hmac.new(master, seed, hashlib.sha256).digest()
                token = _digest_to_alpha(digest=digest, length=TRANSPORT_TOKEN_LEN)
                if token not in used:
                    used.add(token)
                    forward[byte].append(token)
                    reverse[token] = byte
                    break
                counter += 1

    frozen_forward: tuple[tuple[str, ...], ...] = tuple(tuple(v) for v in forward)
    return frozen_forward, reverse


def encode_transport_token(token: str, passphrase: str) -> str:
    """Obfuscate an encrypted CY1 token into random-looking letter chunks."""
    if not token.startswith(TOKEN_PREFIX):
        raise CipherError("Encrypted token is invalid.")

    forward, _ = _build_transport_maps(passphrase=passphrase)
    source = token.encode("utf-8")
    encoded_chunks: list[str] = []

    for byte in source:
        variants = forward[byte]
        choice = int.from_bytes(token_bytes(2), byteorder="big") % len(variants)
        encoded_chunks.append(variants[choice])

    return TRANSPORT_PREFIX + "".join(encoded_chunks)


def decode_transport_token(cyphertext: str, passphrase: str) -> str:
    """Convert random-looking letter chunks back into a CY1 token."""
    if cyphertext.startswith(TOKEN_PREFIX):
        return cyphertext

    if not cyphertext.startswith(TRANSPORT_PREFIX):
        raise CipherError("Cypher prefix is invalid.")

    payload = "".join(cyphertext[len(TRANSPORT_PREFIX) :].split()).lower()
    if not payload:
        raise CipherError("Cyphertext is empty.")
    if len(payload) % TRANSPORT_TOKEN_LEN != 0:
        raise CipherError("Cyphertext length is invalid.")

    _, reverse = _build_transport_maps(passphrase=passphrase)
    decoded = bytearray()

    for idx in range(0, len(payload), TRANSPORT_TOKEN_LEN):
        chunk = payload[idx : idx + TRANSPORT_TOKEN_LEN]
        byte = reverse.get(chunk)
        if byte is None:
            raise CipherError("Cyphertext contains unknown token chunks.")
        decoded.append(byte)

    try:
        token = decoded.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CipherError("Decoded cyphertext is invalid.") from exc
    if not token.startswith(TOKEN_PREFIX):
        raise CipherError("Decoded cyphertext does not contain a valid message envelope.")
    return token


def encrypt_to_cypher(plaintext: str, passphrase: str) -> str:
    """Encrypt plaintext and then obfuscate it as random letter chunks."""
    token = encrypt_message(plaintext=plaintext, passphrase=passphrase)
    return encode_transport_token(token=token, passphrase=passphrase)


def decrypt_from_cypher(cyphertext: str, passphrase: str) -> str:
    """Decode random letter chunks and decrypt to original plaintext."""
    token = decode_transport_token(cyphertext=cyphertext, passphrase=passphrase)
    return decrypt_message(token=token, passphrase=passphrase)
