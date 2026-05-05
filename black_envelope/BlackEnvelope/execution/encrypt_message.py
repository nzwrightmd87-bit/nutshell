#!/usr/bin/env python3
"""Encrypt plaintext into a transportable cypher string."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from cipher_engine import CipherError, encrypt_to_cypher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Encrypt a message")
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--message", help="Plaintext message")
    source_group.add_argument("--infile", help="Path to a plaintext file")
    parser.add_argument(
        "--passphrase",
        help="Shared secret. If omitted, reads from --passphrase-env.",
    )
    parser.add_argument(
        "--passphrase-env",
        default="CYPHER_PASSPHRASE",
        help="Environment variable holding passphrase (default: CYPHER_PASSPHRASE).",
    )
    parser.add_argument("--outfile", help="Optional output file for cyphertext")
    return parser.parse_args()


def read_plaintext(args: argparse.Namespace) -> str:
    if args.message is not None:
        return args.message
    return Path(args.infile).read_text(encoding="utf-8")


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
        plaintext = read_plaintext(args)
        passphrase = resolve_passphrase(args)
        token = encrypt_to_cypher(plaintext=plaintext, passphrase=passphrase)
    except CipherError as exc:
        print(f"Encryption failed: {exc}")
        return 1

    if args.outfile:
        Path(args.outfile).write_text(token, encoding="utf-8")
        print(f"Wrote cyphertext to {args.outfile}")
    else:
        print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
