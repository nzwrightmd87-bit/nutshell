#!/usr/bin/env python3
"""Run local E2EE chat server for development."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import uvicorn


PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from execution.e2ee_chat_server import app as chat_app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run BlackEnvelope E2EE chat dev server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", default=".tmp/e2ee_chat.db")
    parser.add_argument("--web-dir", default="web/e2ee_chat")
    parser.add_argument("--token-secret", default="", help="Optional static token signing secret")
    parser.add_argument("--reload", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    os.environ["CYPHER_CHAT_DB"] = args.db
    os.environ["CYPHER_CHAT_WEB_DIR"] = args.web_dir
    os.environ.setdefault("APP_BASE_URL", f"http://{args.host}:{args.port}")
    if args.token_secret:
        os.environ["CYPHER_CHAT_TOKEN_SECRET"] = args.token_secret

    uvicorn.run(chat_app, host=args.host, port=args.port, reload=args.reload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
