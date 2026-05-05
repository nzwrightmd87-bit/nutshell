#!/usr/bin/env python3
"""Targeted local smoke test for auth recovery and Google OAuth wiring."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


BASE_URL = "http://127.0.0.1:8789"


def _request(method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE_URL + path, method=method, data=data)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = resp.read().decode("utf-8")
            return int(resp.status), (json.loads(payload) if payload else {})
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        try:
            body_json = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            body_json = {"detail": payload}
        return int(exc.code), body_json


def _wait_health(timeout_seconds: float = 10.0) -> None:
    start = time.time()
    while True:
        try:
            status, _ = _request("GET", "/health")
            if status == 200:
                return
        except Exception:
            pass
        if time.time() - start > timeout_seconds:
            raise RuntimeError("Health check timeout.")
        time.sleep(0.2)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    db_path = Path(".tmp/test_auth_recovery.db")
    if db_path.exists():
        db_path.unlink()

    env = os.environ.copy()
    env["CYPHER_CHAT_DB"] = str(db_path)
    env["CYPHER_CHAT_WEB_DIR"] = "web/e2ee_chat"
    env["CYPHER_CHAT_TOKEN_SECRET"] = "smoke-auth-recovery-secret"
    env["APP_BASE_URL"] = "http://localhost:8789"
    # Non-empty values enable forgot-password path; delivery failures are swallowed by API.
    env["RESEND_API_KEY"] = "dummy-local-key"
    env["RESEND_FROM_EMAIL"] = "noreply@example.com"
    env["GOOGLE_CLIENT_ID"] = "local-test-client-id.apps.googleusercontent.com"

    proc = subprocess.Popen(
        [
            "python3",
            "-m",
            "uvicorn",
            "execution.e2ee_chat_server:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8789",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    error: Exception | None = None
    stderr_out = ""
    try:
        _wait_health()

        # 1) Register known user with email.
        status, body = _request(
            "POST",
            "/api/register",
            {
                "username": "authtester",
                "email": "authtester@example.com",
                "password": "auth_test_password_123",
            },
        )
        _assert(status == 200 and body.get("ok") is True, f"register failed: {status} {body}")

        # 2) Public config should expose Google client id.
        status, body = _request("GET", "/api/config/public")
        _assert(status == 200, f"public config failed: {status} {body}")
        _assert(
            str(body.get("google_client_id", "")).strip() == env["GOOGLE_CLIENT_ID"],
            f"google_client_id mismatch: {body}",
        )

        # 3) Forgot-password should accept existing email.
        status, body = _request(
            "POST",
            "/api/auth/forgot-password",
            {"email": "authtester@example.com"},
        )
        _assert(status == 200 and body.get("ok") is True, f"forgot-password failed: {status} {body}")

        # 4) Verify a reset token row exists in DB for that user.
        conn = sqlite3.connect(db_path)
        try:
            user_id_row = conn.execute(
                "SELECT id FROM users WHERE username = ?",
                ("authtester",),
            ).fetchone()
            _assert(user_id_row is not None, "user missing in DB after register")
            user_id = int(user_id_row[0])
            active_tokens = conn.execute(
                "SELECT COUNT(*) FROM password_reset_tokens WHERE user_id = ? AND used = 0",
                (user_id,),
            ).fetchone()
            _assert(active_tokens is not None and int(active_tokens[0]) >= 1, "no reset token rows found")

            # Insert a deterministic token so reset can be tested end-to-end.
            raw_token = "local-reset-token-123"
            token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
            now = int(time.time())
            conn.execute(
                """
                INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used, created_at)
                VALUES (?, ?, ?, 0, ?)
                """,
                (user_id, token_hash, now + 3600, now),
            )
            conn.commit()
        finally:
            conn.close()

        # 5) Reset with deterministic token.
        status, body = _request(
            "POST",
            "/api/auth/reset-password",
            {"token": "local-reset-token-123", "new_password": "auth_test_password_456"},
        )
        _assert(status == 200 and body.get("ok") is True, f"reset-password failed: {status} {body}")

        # 6) Old password should fail.
        status, _ = _request(
            "POST",
            "/api/login",
            {"username": "authtester", "password": "auth_test_password_123"},
        )
        _assert(status == 401, f"old password still works: {status}")

        # 7) New password should work.
        status, body = _request(
            "POST",
            "/api/login",
            {"username": "authtester", "password": "auth_test_password_456"},
        )
        _assert(status == 200 and isinstance(body.get("token"), str), f"new password login failed: {status} {body}")
        admin_token = str(body["token"])

        # 8) Free access code should mark new user as subscription-exempt.
        status, body = _request(
            "POST",
            "/api/admin/access-codes",
            {"access_code": "VIPFREE123", "grants_free_access": True},
            token=admin_token,
        )
        _assert(status == 200 and body.get("ok") is True, f"create free access code failed: {status} {body}")

        status, body = _request(
            "POST",
            "/api/register",
            {
                "username": "freecodeuser",
                "email": "freecodeuser@example.com",
                "password": "freecode_password_123",
                "access_code": "VIPFREE123",
            },
        )
        _assert(status == 200 and body.get("ok") is True, f"register with free code failed: {status} {body}")

        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT subscription_exempt FROM users WHERE username = ?",
                ("freecodeuser",),
            ).fetchone()
            _assert(row is not None and int(row[0]) == 1, "free-code user was not marked subscription_exempt")
        finally:
            conn.close()

        # 9) Google auth endpoint should reject missing token with explicit error.
        status, body = _request("POST", "/api/auth/google", {"id_token": ""})
        _assert(status == 400, f"google missing token expected 400, got {status}: {body}")
        _assert("Missing Google ID token." in str(body.get("detail", "")), f"google detail mismatch: {body}")
    except Exception as exc:
        error = exc
    finally:
        proc.terminate()
        try:
            _stdout, stderr_out = proc.communicate(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()
            _stdout, stderr_out = proc.communicate(timeout=2)

    if error:
        if stderr_out.strip():
            print("Server stderr:")
            print(stderr_out)
        raise error

    print("Auth recovery + Google wiring smoke test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
