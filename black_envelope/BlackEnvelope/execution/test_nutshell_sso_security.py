#!/usr/bin/env python3
"""Security regression tests for Nutshell SSO fallback handling."""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
import time
import unittest
from pathlib import Path

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))
import e2ee_chat_server as server


class NutshellSsoSecurityTest(unittest.TestCase):
    def setUp(self) -> None:
        self._original_app_base_url = server.APP_BASE_URL
        self._original_nutshell_sso_secret = server.NUTSHELL_SSO_SECRET

    def tearDown(self) -> None:
        server.APP_BASE_URL = self._original_app_base_url
        server.NUTSHELL_SSO_SECRET = self._original_nutshell_sso_secret

    def _signed_token(self, secret: str) -> str:
        body = json.dumps(
            {
                "provider": "nutshell",
                "sub": "attacker",
                "username": "attacker",
                "email": "attacker@example.test",
                "admin": True,
                "exp": int(time.time()) + 60,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        signature = hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest()
        return f"{server._b64e(body.encode('utf-8'))}.{server._b64e(signature)}"

    def test_blank_app_base_url_is_not_local_dev(self) -> None:
        self.assertFalse(server._looks_like_local_dev_host(""))
        self.assertFalse(server._looks_like_local_dev_host("not a url"))
        self.assertTrue(server._looks_like_local_dev_host("http://localhost:8787"))
        self.assertTrue(server._looks_like_local_dev_host("http://chat.localhost:8787"))

    def test_blank_app_base_url_does_not_enable_dev_sso_secret(self) -> None:
        server.APP_BASE_URL = ""
        server.NUTSHELL_SSO_SECRET = ""

        with self.assertRaises(HTTPException) as raised:
            server._ensure_nutshell_sso_secret()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(server.NUTSHELL_SSO_SECRET, "")

    def test_local_app_base_url_still_enables_dev_sso_secret(self) -> None:
        server.APP_BASE_URL = "http://localhost:8787"
        server.NUTSHELL_SSO_SECRET = ""

        secret = server._ensure_nutshell_sso_secret()

        self.assertEqual(secret, server.NUTSHELL_LOCAL_DEV_SSO_SECRET)

    def test_hardcoded_dev_secret_is_rejected_without_local_app_base_url(self) -> None:
        server.APP_BASE_URL = ""
        server.NUTSHELL_SSO_SECRET = ""
        token = self._signed_token(server.NUTSHELL_LOCAL_DEV_SSO_SECRET)

        with self.assertRaises(HTTPException) as raised:
            server._verify_nutshell_token(token)

        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
