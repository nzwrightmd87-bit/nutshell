#!/usr/bin/env python3
"""Decrypt a cypher string back to plaintext."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from cipher_engine import CipherError, decrypt_from_cypher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Decrypt a message")
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--token", help="Cyphertext string")
    source_group.add_argument("--infile", help="Path to file with cyphertext string")
    parser.add_argument(
        "--passphrase",
        help="Shared secret. If omitted, reads from --passphrase-env.",
    )
    parser.add_argument(
        "--passphrase-env",
        default="CYPHER_PASSPHRASE",
        help="Environment variable holding passphrase (default: CYPHER_PASSPHRASE).",
    )
    parser.add_argument("--outfile", help="Optional output file for plaintext")
    return parser.parse_args()


def read_token(args: argparse.Namespace) -> str:
    if args.token is not None:
        return args.token.strip()
    return Path(args.infile).read_text(encoding="utf-8").strip()


def resolve_passphrase(args: argparse.Namespace) -> str:
    if args.passphrase:
        return args.passphrase
    from_env = os.getenv(args.passphrase_env, "")
    if from_env:
        return from_env
    raise CipherError(
        f"Passphrase missing. Use --passphrase or set {args.passphrase_env}."
    )


def main() -> int:
    try:
        args = parse_args()
        token = read_token(args)
        passphrase = resolve_passphrase(args)
        plaintext = decrypt_from_cypher(cyphertext=token, passphrase=passphrase)
    except CipherError as exc:
        print(f"Decryption failed: {exc}")
        return 1

    if args.outfile:
        Path(args.outfile).write_text(plaintext, encoding="utf-8")
        print(f"Wrote plaintext to {args.outfile}")
    else:
        print(plaintext)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
