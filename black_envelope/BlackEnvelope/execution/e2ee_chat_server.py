#!/usr/bin/env python3
"""Minimal E2EE chat backend.

Server responsibilities:
- account registration and login
- public key directory
- ciphertext message storage/relay

Server does NOT decrypt messages.
"""

from __future__ import annotations

import base64
import csv
import datetime
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from fastapi import FastAPI, Form, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles


DB_PATH = os.getenv("CYPHER_CHAT_DB", ".tmp/e2ee_chat.db")
TOKEN_SECRET = os.getenv("CYPHER_CHAT_TOKEN_SECRET", "")
TOKEN_TTL_SECONDS = int(os.getenv("CYPHER_CHAT_TOKEN_TTL_SECONDS", "604800"))
WEB_DIR = os.getenv("CYPHER_CHAT_WEB_DIR", "web/e2ee_chat")
DIRECT_PAYLOAD_MAX_BYTES = int(os.getenv("CYPHER_CHAT_DIRECT_PAYLOAD_MAX_BYTES", "40000000"))
GROUP_PAYLOAD_MAX_BYTES = int(os.getenv("CYPHER_CHAT_GROUP_PAYLOAD_MAX_BYTES", "150000000"))
BOOTSTRAP_ADMIN_USERNAME = os.getenv("CYPHER_CHAT_ADMIN_USERNAME", "").strip().lower()
BOOTSTRAP_REGISTRATION_CODE = os.getenv("CYPHER_CHAT_REGISTRATION_CODE", "").strip()
SQUARE_ENV = os.getenv("SQUARE_ENV", "").strip().lower()
SQUARE_ACCESS_TOKEN = os.getenv("SQUARE_ACCESS_TOKEN", "").strip()
SQUARE_LOCATION_ID = os.getenv("SQUARE_LOCATION_ID", "").strip()
SQUARE_PLAN_VARIATION_ID = os.getenv("SQUARE_PLAN_VARIATION_ID", "").strip()
SQUARE_WEBHOOK_SIGNATURE_KEY = os.getenv("SQUARE_WEBHOOK_SIGNATURE_KEY", "").strip()
SQUARE_WEBHOOK_NOTIFICATION_URL = os.getenv("SQUARE_WEBHOOK_NOTIFICATION_URL", "").strip()
SQUARE_CHECKOUT_REDIRECT_URL = os.getenv("SQUARE_CHECKOUT_REDIRECT_URL", "").strip()
SQUARE_API_VERSION = os.getenv("SQUARE_API_VERSION", "2026-01-22").strip() or "2026-01-22"
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", "").strip()
APP_BASE_URL = os.getenv("APP_BASE_URL", "").strip().rstrip("/")
PASSWORD_RESET_TTL_SECONDS = int(os.getenv("PASSWORD_RESET_TTL_SECONDS", "3600"))
NUTSHELL_SSO_SECRET = os.getenv("CYPHER_CHAT_NUTSHELL_SSO_SECRET", "").strip()
NUTSHELL_SSO_TTL_SECONDS = int(os.getenv("CYPHER_CHAT_NUTSHELL_SSO_TTL_SECONDS", "300"))
NUTSHELL_PUBLIC_URL = os.getenv("CYPHER_CHAT_NUTSHELL_PUBLIC_URL", "").strip().rstrip("/")

# VAPID / Web Push
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "").strip()
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "").strip()
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com").strip()

try:
    from pywebpush import webpush, WebPushException
    _WEBPUSH_AVAILABLE = True
except ImportError:
    _WEBPUSH_AVAILABLE = False


def _webpush_enabled() -> bool:
    return bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY and _WEBPUSH_AVAILABLE)

STORAGE_LIMIT_BYTES = int(os.getenv("CYPHER_CHAT_STORAGE_LIMIT_BYTES", str(500 * 1024 * 1024)))
if STORAGE_LIMIT_BYTES <= 0:
    STORAGE_LIMIT_BYTES = 500 * 1024 * 1024
STORAGE_WARN_BYTES = int(
    os.getenv("CYPHER_CHAT_STORAGE_WARN_BYTES", str(int(STORAGE_LIMIT_BYTES * 0.9)))
)
if STORAGE_WARN_BYTES <= 0 or STORAGE_WARN_BYTES > STORAGE_LIMIT_BYTES:
    STORAGE_WARN_BYTES = int(STORAGE_LIMIT_BYTES * 0.9)
AVATAR_MAX_BYTES = 200 * 1024  # 200 KB max for profile pictures

PASSWORD_SALT_BYTES = 16
PASSWORD_HASH_LEN = 32
PASSWORD_N = 2**14
PASSWORD_R = 8
PASSWORD_P = 1
REGISTRATION_ACCESS_CODE_SETTING_KEY = "registration_access_code_hash"
BILLING_GRANDFATHERED_SETTING_KEY = "billing_grandfathered_at"
GLOBAL_FEED_GROUP_SETTING_KEY = "global_feed_group_id"
GLOBAL_FEED_GROUP_NAME = "BlackEnvelope Feed"
GLOBAL_FEED_DEFAULT_TOPIC_TITLE = "General"
SQUARE_STATUS_ACTIVE_VALUES = {"ACTIVE", "PENDING"}
SQUARE_SANDBOX_BASE_URL = "https://connect.squareupsandbox.com"
SQUARE_PRODUCTION_BASE_URL = "https://connect.squareup.com"
EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")
NUTSHELL_PROVIDER = "nutshell"
NUTSHELL_LOCAL_DEV_SSO_SECRET = "nutshell-black-envelope-dev-sso"
BLACKENVELOPE_SESSION_STORAGE_KEY = "blackenvelope:session:v1"


@dataclass
class SessionClaims:
    user_id: int
    exp: int


@dataclass
class NutshellClaims:
    subject: str
    username: str
    email: str
    display_name: str
    admin: bool
    exp: int


app = FastAPI(title="BlackEnvelope API", version="0.6.0")
active_sockets: dict[int, set[WebSocket]] = {}
square_plan_price_cache: dict[str, Any] | None = None


def _is_app_shell_asset_path(path: str) -> bool:
    p = (path or "").lower()
    if p in {"/", "/index.html", "/app.js", "/styles.css", "/sw.js", "/manifest.json"}:
        return True
    return p.endswith(".html") or p.endswith(".js") or p.endswith(".css")


@app.middleware("http")
async def app_shell_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.method == "GET":
        path = request.url.path or "/"
        if not path.startswith("/api/") and _is_app_shell_asset_path(path):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
    return response


class SquareAPIError(RuntimeError):
    """Raised when a Square API call fails."""


def _ensure_secret() -> str:
    global TOKEN_SECRET
    if TOKEN_SECRET:
        return TOKEN_SECRET
    TOKEN_SECRET = secrets.token_urlsafe(48)
    return TOKEN_SECRET


def _looks_like_local_dev_host(url: str) -> bool:
    try:
        host = urllib_parse.urlparse(url).hostname or ""
    except ValueError:
        return False

    return bool(host) and (host in {"127.0.0.1", "localhost"} or host.endswith(".localhost"))


def _default_nutshell_public_url() -> str:
    if _looks_like_local_dev_host(APP_BASE_URL):
        return "http://127.0.0.1:3000"

    try:
        parsed = urllib_parse.urlparse(APP_BASE_URL)
    except ValueError:
        return ""

    host = parsed.hostname or ""
    if host.startswith("app."):
        host = host[4:]

    if not host:
        return ""

    scheme = parsed.scheme or "https"
    port = parsed.port
    if port and port not in {80, 443}:
        return f"{scheme}://{host}:{port}"

    return f"{scheme}://{host}"


def _nutshell_public_url() -> str:
    return NUTSHELL_PUBLIC_URL or _default_nutshell_public_url()


def _nutshell_launch_url() -> str:
    base = _nutshell_public_url()
    if not base:
        return ""
    return f"{base}/black_envelope"


def _nutshell_sso_enabled() -> bool:
    return bool(NUTSHELL_SSO_SECRET) or (bool(APP_BASE_URL) and _looks_like_local_dev_host(APP_BASE_URL))


def _ensure_nutshell_sso_secret() -> str:
    global NUTSHELL_SSO_SECRET
    if NUTSHELL_SSO_SECRET:
        return NUTSHELL_SSO_SECRET
    if _looks_like_local_dev_host(APP_BASE_URL):
        NUTSHELL_SSO_SECRET = NUTSHELL_LOCAL_DEV_SSO_SECRET
        return NUTSHELL_SSO_SECRET
    raise HTTPException(status_code=503, detail="Nutshell SSO is not configured.")


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64d(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _verify_nutshell_token(token: str) -> NutshellClaims:
    value = str(token or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Missing Nutshell token.")

    try:
        encoded_body, encoded_sig = value.split(".", 1)
        body = _b64d(encoded_body).decode("utf-8")
        sig = _b64d(encoded_sig)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid Nutshell token format.") from exc

    expected = hmac.new(_ensure_nutshell_sso_secret().encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401, detail="Invalid Nutshell token signature.")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=401, detail="Invalid Nutshell token payload.") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=401, detail="Invalid Nutshell token payload.")

    now = int(time.time())
    exp = int(payload.get("exp") or 0)
    if exp <= now:
        raise HTTPException(status_code=401, detail="Nutshell token expired.")
    if exp > now + max(NUTSHELL_SSO_TTL_SECONDS, 60):
        raise HTTPException(status_code=401, detail="Nutshell token expiry is invalid.")

    username = _validate_username(str(payload.get("username", "")))
    email = _validate_email(str(payload.get("email", "")))
    display_name = str(payload.get("display_name", "")).strip()[:120]
    subject = str(payload.get("sub", "")).strip()
    provider = str(payload.get("provider", "")).strip().lower()
    if not subject:
        raise HTTPException(status_code=401, detail="Nutshell token is missing a subject.")
    if provider != NUTSHELL_PROVIDER:
        raise HTTPException(status_code=401, detail="Unsupported SSO provider.")

    return NutshellClaims(
        subject=subject,
        username=username,
        email=email,
        display_name=display_name,
        admin=bool(payload.get("admin")),
        exp=exp,
    )


def _send_email(to_email: str, subject: str, html_body: str) -> None:
    """Send an email via Resend HTTP API."""
    if not RESEND_API_KEY or not RESEND_FROM_EMAIL:
        raise RuntimeError("Email is not configured.")

    payload = json.dumps(
        {
            "from": RESEND_FROM_EMAIL,
            "to": [to_email],
            "subject": subject,
            "html": html_body,
        }
    ).encode("utf-8")
    req = urllib_request.Request(
        url="https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "BlackEnvelope/1.0",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib_error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Resend API error {exc.code}: {body}") from exc
    except urllib_error.URLError as exc:
        raise RuntimeError(f"Resend connection failed: {exc.reason}") from exc


def _verify_google_id_token(id_token: str) -> dict[str, Any]:
    """Verify Google ID token using Google's tokeninfo endpoint."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Google OAuth is not configured.")
    if not id_token:
        raise HTTPException(status_code=400, detail="Missing Google ID token.")

    url = f"https://oauth2.googleapis.com/tokeninfo?id_token={urllib_parse.quote(id_token, safe='')}"
    req = urllib_request.Request(url, method="GET")
    try:
        with urllib_request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib_error.URLError as exc:
        raise HTTPException(status_code=401, detail="Failed to verify Google token.") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=401, detail="Invalid Google token response.") from exc

    aud = str(data.get("aud") or "").strip()
    if aud != GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=401, detail="Google token audience mismatch.")

    iss = str(data.get("iss") or "").strip()
    if iss not in {"accounts.google.com", "https://accounts.google.com"}:
        raise HTTPException(status_code=401, detail="Google token issuer mismatch.")

    try:
        exp = int(str(data.get("exp") or "0"))
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Google token missing expiry.") from exc
    if exp < int(time.time()):
        raise HTTPException(status_code=401, detail="Google token expired.")

    return data


def _google_username_seed(email: str) -> str:
    local = email.split("@", 1)[0].strip().lower()
    local = re.sub(r"[^a-z0-9_-]+", "-", local).strip("-_")
    if len(local) < 3:
        local = f"user{secrets.randbelow(9000) + 1000}"
    if len(local) > 24:
        local = local[:24].rstrip("-_")
    if len(local) < 3:
        local = "user"
    return local


def _next_available_username(conn: sqlite3.Connection, seed: str) -> str:
    base = seed
    for idx in range(80):
        suffix = "" if idx == 0 else f"-{secrets.randbelow(9000) + 1000}"
        trimmed = base[: max(3, 32 - len(suffix))]
        candidate = (trimmed + suffix).strip("-_")
        if len(candidate) < 3:
            candidate = f"user{secrets.randbelow(9000) + 1000}"
        try:
            candidate = _validate_username(candidate)
        except HTTPException:
            continue
        exists = conn.execute(
            "SELECT 1 FROM users WHERE username = ? LIMIT 1",
            (candidate,),
        ).fetchone()
        if exists is None:
            return candidate
    raise HTTPException(status_code=409, detail="Unable to allocate a username. Try again.")


def _square_billing_enabled() -> bool:
    def ready(value: str) -> bool:
        cleaned = value.strip()
        return bool(cleaned and not cleaned.lower().startswith("replace_with_"))

    return ready(SQUARE_ACCESS_TOKEN) and ready(SQUARE_LOCATION_ID) and ready(SQUARE_PLAN_VARIATION_ID)


def _square_base_url() -> str:
    if SQUARE_ENV == "sandbox":
        return SQUARE_SANDBOX_BASE_URL
    return SQUARE_PRODUCTION_BASE_URL


def _square_api_request(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if not _square_billing_enabled():
        raise SquareAPIError("Square billing is not configured.")

    data: bytes | None = None
    headers = {
        "Authorization": f"Bearer {SQUARE_ACCESS_TOKEN}",
        "Square-Version": SQUARE_API_VERSION,
        "Accept": "application/json",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib_request.Request(
        url=f"{_square_base_url()}{path}",
        data=data,
        headers=headers,
        method=method.upper(),
    )
    try:
        with urllib_request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8").strip()
    except urllib_error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        detail = f"Square API HTTP {exc.code}"
        try:
            parsed = json.loads(raw)
            errors = parsed.get("errors")
            if isinstance(errors, list) and errors:
                first = errors[0]
                if isinstance(first, dict):
                    detail = str(first.get("detail") or first.get("code") or detail)
        except Exception:
            pass
        raise SquareAPIError(detail) from exc
    except urllib_error.URLError as exc:
        raise SquareAPIError(f"Square API connection failed: {exc.reason}") from exc

    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SquareAPIError("Square API returned invalid JSON.") from exc


def _square_subscription_status(subscription: dict[str, Any] | None) -> str:
    if not isinstance(subscription, dict):
        return "NONE"
    return str(subscription.get("status") or "NONE").strip().upper()


def _square_subscription_plan_variation(subscription: dict[str, Any] | None) -> str:
    if not isinstance(subscription, dict):
        return ""
    return str(subscription.get("plan_variation_id") or "").strip()


def _subscription_is_active(status: str) -> bool:
    return status.upper() in SQUARE_STATUS_ACTIVE_VALUES


def _row_subscription_status(row: sqlite3.Row) -> str:
    return str(row["subscription_status"] or "NONE").strip().upper()


def _today_iso() -> str:
    return datetime.date.today().isoformat()


def _row_subscription_charged_through_date(row: sqlite3.Row) -> str:
    return str(row["subscription_charged_through_date"] or "").strip()


SQUARE_FAILED_STATUSES = {"DEACTIVATED", "PAUSED"}
SQUARE_FAILED_GRACE_SECONDS = 3 * 86400  # 3 days


def _row_subscription_allows_access(row: sqlite3.Row) -> bool:
    if bool(row["is_admin"]):
        return True
    if bool(row["subscription_exempt"]):
        return True

    status = _row_subscription_status(row)

    # ACTIVE or PENDING — full access (with plan variation check)
    if status in SQUARE_STATUS_ACTIVE_VALUES:
        configured_plan = SQUARE_PLAN_VARIATION_ID.strip()
        if configured_plan:
            row_plan = str(row["subscription_plan_variation_id"] or "").strip()
            if row_plan and row_plan != configured_plan:
                return False
        return True

    # CANCELED — access until end of paid period
    if status == "CANCELED":
        charged_through = _row_subscription_charged_through_date(row)
        if charged_through and charged_through >= _today_iso():
            return True
        return False

    # DEACTIVATED/PAUSED (payment failure) — 3-day grace period
    if status in SQUARE_FAILED_STATUSES:
        failed_at = int(row["subscription_failed_at"] or 0)
        if failed_at == 0:
            return True  # first encounter; timestamp set on next write path
        if int(time.time()) <= failed_at + SQUARE_FAILED_GRACE_SECONDS:
            return True
        return False

    # All other statuses — block
    return False


def _square_set_failed_at_if_needed(
    conn: sqlite3.Connection, user_id: int, row: sqlite3.Row,
) -> None:
    """Record timestamp of first payment failure if not already set."""
    status = _row_subscription_status(row)
    if status not in SQUARE_FAILED_STATUSES:
        return
    if int(row["subscription_failed_at"] or 0) != 0:
        return
    conn.execute(
        "UPDATE users SET subscription_failed_at = ? WHERE id = ?",
        (int(time.time()), user_id),
    )


def _square_clear_failed_at(conn: sqlite3.Connection, user_id: int) -> None:
    """Clear the failure timestamp when subscription recovers."""
    conn.execute(
        "UPDATE users SET subscription_failed_at = 0 WHERE id = ?",
        (user_id,),
    )


def _build_billing_notification(row: sqlite3.Row) -> dict[str, Any]:
    """Build a WebSocket notification payload for subscription status changes."""
    status = _row_subscription_status(row)
    charged_through = _row_subscription_charged_through_date(row)
    failed_at = int(row["subscription_failed_at"] or 0)
    has_access = _row_subscription_allows_access(row)

    if status in SQUARE_STATUS_ACTIVE_VALUES:
        message = "Your subscription is active."
        level = "info"
    elif status == "CANCELED":
        if charged_through and charged_through >= _today_iso():
            message = f"Your subscription was canceled. Access continues until {charged_through}."
        else:
            message = "Your subscription has ended."
        level = "warn"
    elif not has_access:
        message = "Your subscription has been deactivated. Please renew to continue."
        level = "error"
    else:
        if failed_at:
            grace_end_ts = failed_at + SQUARE_FAILED_GRACE_SECONDS
            grace_end_date = datetime.datetime.fromtimestamp(grace_end_ts).strftime("%Y-%m-%d")
            message = f"Payment failed. Access continues until {grace_end_date}. Please update your payment method."
        else:
            message = "Payment issue detected. Please check your payment method."
        level = "warn"

    return {
        "type": "subscription_update",
        "subscription_status": status,
        "subscription_active": has_access,
        "charged_through_date": charged_through,
        "message": message,
        "level": level,
    }


async def _close_user_sockets_for_billing(user_id: int) -> None:
    """Close all WebSocket connections for a user due to billing."""
    sockets = list(active_sockets.get(user_id, set()))
    for ws in sockets:
        try:
            await ws.close(code=4402, reason="subscription_inactive")
        except Exception:
            pass
    active_sockets.pop(user_id, None)


def _square_pick_best_subscription(subscriptions: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not subscriptions:
        return None

    configured_plan = SQUARE_PLAN_VARIATION_ID.strip()
    candidates = subscriptions
    if configured_plan:
        matching = [
            sub
            for sub in subscriptions
            if str(sub.get("plan_variation_id") or "").strip() == configured_plan
        ]
        if matching:
            candidates = matching

    def score(sub: dict[str, Any]) -> tuple[int, str, str]:
        status = _square_subscription_status(sub)
        priority = 2 if status == "ACTIVE" else 1 if status == "PENDING" else 0
        created_at = str(sub.get("created_at") or "")
        sub_id = str(sub.get("id") or "")
        return (priority, created_at, sub_id)

    return max(candidates, key=score)


def _square_update_user_subscription(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    customer_id: str,
    subscription: dict[str, Any] | None,
) -> None:
    status = _square_subscription_status(subscription)
    subscription_id = ""
    plan_variation_id = ""
    charged_through_date = ""
    if isinstance(subscription, dict):
        subscription_id = str(subscription.get("id") or "").strip()
        plan_variation_id = _square_subscription_plan_variation(subscription)
        charged_through_date = str(subscription.get("charged_through_date") or "").strip()
        if not charged_through_date:
            charged_through_date = str(subscription.get("paid_until_date") or "").strip()

    conn.execute(
        """
        UPDATE users
        SET
            square_customer_id = ?,
            subscription_status = ?,
            subscription_id = ?,
            subscription_plan_variation_id = ?,
            subscription_charged_through_date = ?,
            subscription_updated_at = ?
        WHERE id = ?
        """,
        (customer_id.strip(), status, subscription_id, plan_variation_id, charged_through_date, int(time.time()), user_id),
    )


def _square_read_plan_price_money() -> dict[str, Any]:
    global square_plan_price_cache

    if square_plan_price_cache:
        return square_plan_price_cache

    encoded_id = urllib_parse.quote(SQUARE_PLAN_VARIATION_ID, safe="")
    response = _square_api_request("GET", f"/v2/catalog/object/{encoded_id}")
    obj = response.get("object")
    if not isinstance(obj, dict):
        raise SquareAPIError("Square catalog response was missing object data.")
    variation_data = obj.get("subscription_plan_variation_data")
    if not isinstance(variation_data, dict):
        raise SquareAPIError("Configured plan variation is invalid.")

    phases = variation_data.get("phases")
    if not isinstance(phases, list) or not phases:
        raise SquareAPIError("Configured plan variation has no pricing phases.")

    for phase in phases:
        if not isinstance(phase, dict):
            continue
        pricing = phase.get("pricing")
        if not isinstance(pricing, dict):
            continue
        if str(pricing.get("type") or "").upper() != "STATIC":
            continue
        money = pricing.get("price_money")
        if not isinstance(money, dict):
            continue
        amount = int(money.get("amount") or 0)
        currency = str(money.get("currency") or "").strip().upper()
        if amount > 0 and currency:
            square_plan_price_cache = {"amount": amount, "currency": currency}
            return square_plan_price_cache

    raise SquareAPIError("Configured plan variation does not have a static price.")


def _square_create_checkout_link_for_user(conn: sqlite3.Connection, user_row: sqlite3.Row) -> str:
    price_money = _square_read_plan_price_money()
    now = int(time.time())
    idempotency_key = f"be-{int(user_row['id'])}-{secrets.token_hex(8)}"

    payload: dict[str, Any] = {
        "idempotency_key": idempotency_key,
        "quick_pay": {
            "name": "BlackEnvelope Subscription",
            "price_money": price_money,
            "location_id": SQUARE_LOCATION_ID,
        },
        "checkout_options": {
            "subscription_plan_id": SQUARE_PLAN_VARIATION_ID,
        },
        "payment_note": f"BlackEnvelope user:{int(user_row['id'])} @{user_row['username']}",
    }
    if SQUARE_CHECKOUT_REDIRECT_URL:
        pp_token = _create_payment_pending_token(int(user_row["id"]), user_row["username"])
        sep = "&" if "?" in SQUARE_CHECKOUT_REDIRECT_URL else "?"
        redirect_with_token = f"{SQUARE_CHECKOUT_REDIRECT_URL}{sep}payment_pending={pp_token}"
        payload["checkout_options"]["redirect_url"] = redirect_with_token

    response = _square_api_request("POST", "/v2/online-checkout/payment-links", payload=payload)
    payment_link = response.get("payment_link")
    if not isinstance(payment_link, dict):
        raise SquareAPIError("Square did not return a payment link.")

    checkout_url = str(payment_link.get("url") or "").strip()
    link_id = str(payment_link.get("id") or "").strip()
    order_id = str(payment_link.get("order_id") or "").strip()
    if not checkout_url:
        raise SquareAPIError("Square checkout URL was missing.")
    if not order_id:
        raise SquareAPIError("Square checkout order ID was missing.")

    conn.execute(
        """
        INSERT INTO square_checkout_links (
            user_id,
            checkout_link_id,
            order_id,
            checkout_url,
            status,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (int(user_row["id"]), link_id, order_id, checkout_url, "created", now, now),
    )
    return checkout_url


def _square_refresh_user_subscription(conn: sqlite3.Connection, user_row: sqlite3.Row) -> sqlite3.Row:
    customer_id = str(user_row["square_customer_id"] or "").strip()
    if not customer_id:
        return user_row

    payload = {
        "query": {
            "filter": {
                "customer_ids": [customer_id],
                "location_ids": [SQUARE_LOCATION_ID],
            }
        }
    }
    response = _square_api_request("POST", "/v2/subscriptions/search", payload=payload)
    subscriptions_raw = response.get("subscriptions")
    subscriptions: list[dict[str, Any]] = []
    if isinstance(subscriptions_raw, list):
        subscriptions = [sub for sub in subscriptions_raw if isinstance(sub, dict)]

    best = _square_pick_best_subscription(subscriptions)
    _square_update_user_subscription(
        conn,
        user_id=int(user_row["id"]),
        customer_id=customer_id,
        subscription=best,
    )
    updated = conn.execute("SELECT * FROM users WHERE id = ?", (int(user_row["id"]),)).fetchone()
    if updated is None:
        raise HTTPException(status_code=401, detail="User not found.")

    user_id = int(updated["id"])
    status = _row_subscription_status(updated)
    if status in SQUARE_STATUS_ACTIVE_VALUES:
        _square_clear_failed_at(conn, user_id)
    else:
        _square_set_failed_at_if_needed(conn, user_id, updated)

    return updated


def _square_resolve_customer_id_from_orders(conn: sqlite3.Connection, user_id: int) -> str:
    """Look up Square customer_id by fetching the user's recent checkout orders from Square API."""
    rows = conn.execute(
        "SELECT order_id FROM square_checkout_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 5",
        (user_id,),
    ).fetchall()
    for row in rows:
        order_id = str(row["order_id"] or "").strip()
        if not order_id:
            continue
        try:
            response = _square_api_request("GET", f"/v2/orders/{order_id}")
            order = response.get("order")
            if not isinstance(order, dict):
                continue
            customer_id = str(order.get("customer_id") or "").strip()
            if customer_id:
                return customer_id
        except SquareAPIError:
            continue
    return ""


def _square_subscription_required_response(checkout_url: str) -> JSONResponse:
    return JSONResponse(
        status_code=402,
        content={
            "detail": "Active subscription required to use BlackEnvelope.",
            "subscription_required": True,
            "checkout_url": checkout_url,
        },
    )


def _square_webhook_url(request: Request) -> str:
    if SQUARE_WEBHOOK_NOTIFICATION_URL:
        return SQUARE_WEBHOOK_NOTIFICATION_URL
    return str(request.url)


def _square_verify_webhook_signature(signature_header: str, raw_body: bytes, request: Request) -> bool:
    if not SQUARE_WEBHOOK_SIGNATURE_KEY:
        return False
    source = _square_webhook_url(request).encode("utf-8") + raw_body
    digest = hmac.new(SQUARE_WEBHOOK_SIGNATURE_KEY.encode("utf-8"), source, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("ascii")
    return hmac.compare_digest(expected, signature_header.strip())


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = _db()
    try:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                email TEXT NOT NULL DEFAULT '',
                google_id TEXT NOT NULL DEFAULT '',
                public_key TEXT NOT NULL DEFAULT '',
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_id INTEGER NOT NULL,
                recipient_id INTEGER NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(sender_id) REFERENCES users(id),
                FOREIGN KEY(recipient_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS friend_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                requester_id INTEGER NOT NULL,
                target_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                responded_at INTEGER,
                FOREIGN KEY(requester_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(target_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS friendships (
                user_id INTEGER NOT NULL,
                friend_id INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(user_id, friend_id),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(friend_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chat_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(owner_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                joined_at INTEGER NOT NULL,
                PRIMARY KEY(group_id, user_id),
                FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS group_topics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                created_by INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
                FOREIGN KEY(created_by) REFERENCES users(id),
                UNIQUE(group_id, title)
            );

            CREATE TABLE IF NOT EXISTS group_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                topic_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
                FOREIGN KEY(topic_id) REFERENCES group_topics(id) ON DELETE CASCADE,
                FOREIGN KEY(sender_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS group_invites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                invited_user_id INTEGER NOT NULL,
                invited_by_user_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                responded_at INTEGER,
                FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
                FOREIGN KEY(invited_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS encrypted_key_backups (
                user_id INTEGER PRIMARY KEY,
                backup_ciphertext TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at INTEGER NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS registration_access_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code_hash TEXT UNIQUE NOT NULL,
                grants_free_access INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                created_by_user_id INTEGER,
                FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, id);
            CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, id);
            CREATE INDEX IF NOT EXISTS idx_friend_requests_target_status ON friend_requests(target_id, status, id);
            CREATE INDEX IF NOT EXISTS idx_friend_requests_requester_status ON friend_requests(requester_id, status, id);
            CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id, friend_id);
            CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id, group_id);
            CREATE INDEX IF NOT EXISTS idx_group_topics_group ON group_topics(group_id, id);
            CREATE INDEX IF NOT EXISTS idx_group_messages_topic ON group_messages(topic_id, id);
            CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, id);
            CREATE INDEX IF NOT EXISTS idx_group_invites_user_status ON group_invites(invited_user_id, status, id);
            CREATE INDEX IF NOT EXISTS idx_group_invites_group_status ON group_invites(group_id, status, id);
            CREATE INDEX IF NOT EXISTS idx_registration_access_codes_created
                ON registration_access_codes(created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
                ON password_reset_tokens(user_id, used, expires_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
                ON users(email) WHERE email != '';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id_unique
                ON users(google_id) WHERE google_id != '';
            """
        )
        conn.commit()
    finally:
        conn.close()


def _validate_username(username: str) -> str:
    value = username.strip().lower()
    if len(value) < 3 or len(value) > 32:
        raise HTTPException(status_code=400, detail="Username must be 3-32 characters.")
    if not all(ch.isalnum() or ch in {"_", "-"} for ch in value):
        raise HTTPException(
            status_code=400,
            detail="Username can contain letters, numbers, underscore, and dash only.",
        )
    return value


def _validate_password(password: str) -> None:
    if len(password) < 12:
        raise HTTPException(status_code=400, detail="Password must be at least 12 characters.")


def _validate_email(email: str) -> str:
    value = email.strip().lower()
    if not value or not EMAIL_RE.match(value):
        raise HTTPException(status_code=400, detail="Valid email is required.")
    if len(value) > 255:
        raise HTTPException(status_code=400, detail="Email is too long.")
    return value


def _available_username(
    conn: sqlite3.Connection,
    desired_username: str,
    *,
    existing_user_id: int | None = None,
) -> str:
    base = _validate_username(desired_username)
    candidate = base
    suffix = 2

    while True:
        row = conn.execute("SELECT id FROM users WHERE username = ?", (candidate,)).fetchone()
        if row is None or (existing_user_id is not None and int(row["id"]) == existing_user_id):
            return candidate

        suffix_text = f"-{suffix}"
        candidate = f"{base[:32 - len(suffix_text)]}{suffix_text}"
        suffix += 1

        if suffix > 9999:
            raise HTTPException(status_code=409, detail="Unable to reserve a username for this account.")


def _maybe_adopt_nutshell_user(conn: sqlite3.Connection, claims: NutshellClaims) -> sqlite3.Row | None:
    for column, value in (("email", claims.email), ("username", claims.username)):
        row = conn.execute(
            f"""
            SELECT *
            FROM users
            WHERE {column} = ?
              AND COALESCE(external_provider, '') = ''
              AND COALESCE(external_subject, '') = ''
            ORDER BY id ASC
            LIMIT 2
            """,
            (value,),
        ).fetchall()
        if len(row) == 1:
            return row[0]

    return None


def _upsert_nutshell_user(conn: sqlite3.Connection, claims: NutshellClaims) -> tuple[sqlite3.Row, bool]:
    existing = conn.execute(
        """
        SELECT *
        FROM users
        WHERE external_provider = ? AND external_subject = ?
        LIMIT 1
        """,
        (NUTSHELL_PROVIDER, claims.subject),
    ).fetchone()

    created = False
    if existing is None:
        adopted = _maybe_adopt_nutshell_user(conn, claims)
        if adopted is not None:
            user_id = int(adopted["id"])
            username = _available_username(conn, claims.username, existing_user_id=user_id)
            is_admin = 1 if bool(adopted["is_admin"]) or claims.admin else 0
            conn.execute(
                """
                UPDATE users
                SET username = ?,
                    email = ?,
                    display_name = ?,
                    is_admin = ?,
                    subscription_exempt = 1,
                    external_provider = ?,
                    external_subject = ?
                WHERE id = ?
                """,
                (
                    username,
                    claims.email,
                    claims.display_name,
                    is_admin,
                    NUTSHELL_PROVIDER,
                    claims.subject,
                    user_id,
                ),
            )
            _ensure_user_in_global_feed(conn, user_id)
        else:
            password = secrets.token_urlsafe(32)
            salt = secrets.token_bytes(PASSWORD_SALT_BYTES)
            digest = _hash_password(password=password, salt=salt)
            username = _available_username(conn, claims.username)
            created_at = int(time.time())
            cur = conn.execute(
                """
                INSERT INTO users (
                    username,
                    password_hash,
                    password_salt,
                    email,
                    display_name,
                    is_admin,
                    subscription_exempt,
                    external_provider,
                    external_subject,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    username,
                    _b64e(digest),
                    _b64e(salt),
                    claims.email,
                    claims.display_name,
                    1 if claims.admin else 0,
                    NUTSHELL_PROVIDER,
                    claims.subject,
                    created_at,
                ),
            )
            user_id = int(cur.lastrowid)
            _ensure_user_in_global_feed(conn, user_id)
            created = True
    else:
        user_id = int(existing["id"])
        username = _available_username(conn, claims.username, existing_user_id=user_id)
        is_admin = 1 if bool(existing["is_admin"]) or claims.admin else 0
        conn.execute(
            """
            UPDATE users
            SET username = ?,
                email = ?,
                display_name = ?,
                is_admin = ?,
                subscription_exempt = 1
            WHERE id = ?
            """,
            (
                username,
                claims.email,
                claims.display_name,
                is_admin,
                user_id,
            ),
        )
        _ensure_user_in_global_feed(conn, user_id)

    row = conn.execute("SELECT * FROM users WHERE external_provider = ? AND external_subject = ? LIMIT 1", (NUTSHELL_PROVIDER, claims.subject)).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Failed to provision BlackEnvelope account.")

    return row, created


def _public_key_is_json_object(public_key_raw: str | None) -> bool:
    text = str(public_key_raw or "").strip()
    if not text:
        return False
    try:
        parsed = json.loads(text)
    except Exception:
        return False
    return isinstance(parsed, dict)


def _hash_registration_access_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _get_legacy_registration_access_code_hash(conn: sqlite3.Connection) -> str | None:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ?",
        (REGISTRATION_ACCESS_CODE_SETTING_KEY,),
    ).fetchone()
    if row is None:
        return None
    return str(row["value"]).strip()


def _delete_legacy_registration_access_code_hash(conn: sqlite3.Connection) -> None:
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?",
        (REGISTRATION_ACCESS_CODE_SETTING_KEY,),
    )


def _count_registration_access_codes(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM registration_access_codes",
    ).fetchone()
    return int(row["c"])


def _registration_access_code_valid(conn: sqlite3.Connection, access_code: str) -> bool:
    code_hash = _hash_registration_access_code(access_code)
    row = conn.execute(
        "SELECT 1 FROM registration_access_codes WHERE code_hash = ? LIMIT 1",
        (code_hash,),
    ).fetchone()
    return row is not None


def _registration_access_code_grants_free_access(conn: sqlite3.Connection, access_code: str) -> bool:
    code_hash = _hash_registration_access_code(access_code)
    row = conn.execute(
        "SELECT grants_free_access FROM registration_access_codes WHERE code_hash = ? LIMIT 1",
        (code_hash,),
    ).fetchone()
    if row is None:
        return False
    return bool(row["grants_free_access"])


def _create_registration_access_code(
    conn: sqlite3.Connection,
    access_code: str,
    created_by_user_id: int | None,
    grants_free_access: bool = False,
) -> int:
    code_hash = _hash_registration_access_code(access_code)
    created_at = int(time.time())
    cur = conn.execute(
        """
        INSERT INTO registration_access_codes (code_hash, grants_free_access, created_at, created_by_user_id)
        VALUES (?, ?, ?, ?)
        """,
        (code_hash, 1 if grants_free_access else 0, created_at, created_by_user_id),
    )
    return int(cur.lastrowid)


def _registration_code_hash_preview(code_hash: str) -> str:
    if len(code_hash) <= 16:
        return code_hash
    return f"{code_hash[:8]}...{code_hash[-8:]}"


def _set_app_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    now = int(time.time())
    conn.execute(
        """
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (key, value, now),
    )


def _resolve_global_feed_group_id(conn: sqlite3.Connection) -> int | None:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ?",
        (GLOBAL_FEED_GROUP_SETTING_KEY,),
    ).fetchone()
    if row is not None:
        try:
            group_id = int(str(row["value"]).strip())
        except Exception:
            group_id = 0
        if group_id > 0:
            exists = conn.execute(
                "SELECT 1 FROM chat_groups WHERE id = ? LIMIT 1",
                (group_id,),
            ).fetchone()
            if exists is not None:
                return group_id

    row = conn.execute(
        "SELECT id FROM chat_groups WHERE name = ? ORDER BY id ASC LIMIT 1",
        (GLOBAL_FEED_GROUP_NAME,),
    ).fetchone()
    if row is None:
        return None
    return int(row["id"])


def _global_feed_owner_candidate(
    conn: sqlite3.Connection,
    preferred_owner_id: int | None = None,
) -> int | None:
    if preferred_owner_id is not None:
        row = conn.execute(
            "SELECT id FROM users WHERE id = ?",
            (preferred_owner_id,),
        ).fetchone()
        if row is not None:
            return int(row["id"])

    row = conn.execute(
        "SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1",
    ).fetchone()
    if row is not None:
        return int(row["id"])

    row = conn.execute("SELECT id FROM users ORDER BY id ASC LIMIT 1").fetchone()
    if row is None:
        return None
    return int(row["id"])


def _ensure_global_feed_group(
    conn: sqlite3.Connection,
    preferred_owner_id: int | None = None,
) -> int | None:
    group_id = _resolve_global_feed_group_id(conn)
    now = int(time.time())

    if group_id is None:
        owner_id = _global_feed_owner_candidate(conn, preferred_owner_id=preferred_owner_id)
        if owner_id is None:
            return None

        cur = conn.execute(
            """
            INSERT INTO chat_groups (name, owner_id, created_at)
            VALUES (?, ?, ?)
            """,
            (GLOBAL_FEED_GROUP_NAME, owner_id, now),
        )
        group_id = int(cur.lastrowid)

        conn.execute(
            """
            INSERT INTO group_members (group_id, user_id, role, joined_at)
            VALUES (?, ?, 'owner', ?)
            """,
            (group_id, owner_id, now),
        )
        conn.execute(
            """
            INSERT INTO group_topics (group_id, title, created_by, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (group_id, GLOBAL_FEED_DEFAULT_TOPIC_TITLE, owner_id, now),
        )
        _set_app_setting(conn, GLOBAL_FEED_GROUP_SETTING_KEY, str(group_id))
        return group_id

    group_row = conn.execute(
        "SELECT owner_id FROM chat_groups WHERE id = ?",
        (group_id,),
    ).fetchone()
    if group_row is None:
        return None
    owner_id = int(group_row["owner_id"])

    owner_membership = conn.execute(
        "SELECT role FROM group_members WHERE group_id = ? AND user_id = ?",
        (group_id, owner_id),
    ).fetchone()
    if owner_membership is None:
        conn.execute(
            """
            INSERT INTO group_members (group_id, user_id, role, joined_at)
            VALUES (?, ?, 'owner', ?)
            """,
            (group_id, owner_id, now),
        )
    elif owner_membership["role"] != "owner":
        conn.execute(
            "UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?",
            (group_id, owner_id),
        )

    topic_row = conn.execute(
        "SELECT id FROM group_topics WHERE group_id = ? ORDER BY id ASC LIMIT 1",
        (group_id,),
    ).fetchone()
    if topic_row is None:
        conn.execute(
            """
            INSERT INTO group_topics (group_id, title, created_by, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (group_id, GLOBAL_FEED_DEFAULT_TOPIC_TITLE, owner_id, now),
        )

    _set_app_setting(conn, GLOBAL_FEED_GROUP_SETTING_KEY, str(group_id))
    return group_id


def _ensure_user_in_global_feed(conn: sqlite3.Connection, user_id: int) -> int | None:
    group_id = _ensure_global_feed_group(conn, preferred_owner_id=user_id)
    if group_id is None:
        return None

    exists = conn.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
        (group_id, user_id),
    ).fetchone()
    if exists is None:
        conn.execute(
            """
            INSERT INTO group_members (group_id, user_id, role, joined_at)
            VALUES (?, ?, 'member', ?)
            """,
            (group_id, user_id, int(time.time())),
        )
    return group_id


def _ensure_all_users_in_global_feed(conn: sqlite3.Connection) -> int:
    group_id = _ensure_global_feed_group(conn)
    if group_id is None:
        return 0

    existing_rows = conn.execute(
        "SELECT user_id FROM group_members WHERE group_id = ?",
        (group_id,),
    ).fetchall()
    existing_ids = {int(r["user_id"]) for r in existing_rows}

    user_rows = conn.execute("SELECT id FROM users").fetchall()
    now = int(time.time())
    added = 0
    for row in user_rows:
        uid = int(row["id"])
        if uid in existing_ids:
            continue
        conn.execute(
            """
            INSERT INTO group_members (group_id, user_id, role, joined_at)
            VALUES (?, ?, 'member', ?)
            """,
            (group_id, uid, now),
        )
        added += 1
    return added


def _is_global_feed_group(conn: sqlite3.Connection, group_id: int) -> bool:
    current = _resolve_global_feed_group_id(conn)
    return current is not None and int(current) == int(group_id)


def _validate_group_name(name: str) -> str:
    value = name.strip()
    if len(value) < 3 or len(value) > 64:
        raise HTTPException(status_code=400, detail="Group name must be 3-64 characters.")
    if value.casefold() == GLOBAL_FEED_GROUP_NAME.casefold():
        raise HTTPException(status_code=400, detail=f'"{GLOBAL_FEED_GROUP_NAME}" is reserved.')
    return value


def _validate_topic_title(title: str) -> str:
    value = title.strip()
    if len(value) < 1 or len(value) > 80:
        raise HTTPException(status_code=400, detail="Topic title must be 1-80 characters.")
    return value


def _normalize_invite_username(raw: str) -> str:
    value = raw.strip().lower()
    while value.startswith("@"):
        value = value[1:]
    return _validate_username(value)


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=PASSWORD_N,
        r=PASSWORD_R,
        p=PASSWORD_P,
        maxmem=0,
        dklen=PASSWORD_HASH_LEN,
    )


def _create_token(user_id: int) -> str:
    secret = _ensure_secret().encode("utf-8")
    exp = int(time.time()) + TOKEN_TTL_SECONDS
    nonce = secrets.token_hex(8)
    body = f"{user_id}.{exp}.{nonce}"
    sig = hmac.new(secret, body.encode("utf-8"), hashlib.sha256).digest()
    return _b64e(body.encode("utf-8")) + "." + _b64e(sig)


def _verify_token(token: str) -> SessionClaims:
    try:
        encoded_body, encoded_sig = token.split(".", 1)
        body = _b64d(encoded_body).decode("utf-8")
        sig = _b64d(encoded_sig)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid token format.") from exc

    expected = hmac.new(_ensure_secret().encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401, detail="Invalid token signature.")

    try:
        user_id_str, exp_str, _nonce = body.split(".", 2)
        user_id = int(user_id_str)
        exp = int(exp_str)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid token payload.") from exc

    if int(time.time()) > exp:
        raise HTTPException(status_code=401, detail="Token expired.")

    return SessionClaims(user_id=user_id, exp=exp)


PAYMENT_PENDING_TOKEN_TTL = 900  # 15 minutes


def _create_payment_pending_token(user_id: int, username: str) -> str:
    """Short-lived token encoding user_id + username for post-payment redirect."""
    secret = _ensure_secret().encode("utf-8")
    exp = int(time.time()) + PAYMENT_PENDING_TOKEN_TTL
    nonce = secrets.token_hex(8)
    body = f"pp.{user_id}.{username}.{exp}.{nonce}"
    sig = hmac.new(secret, body.encode("utf-8"), hashlib.sha256).digest()
    return _b64e(body.encode("utf-8")) + "." + _b64e(sig)


def _verify_payment_pending_token(token: str) -> tuple[int, str]:
    """Verify a payment-pending token, returns (user_id, username)."""
    try:
        encoded_body, encoded_sig = token.split(".", 1)
        body = _b64d(encoded_body).decode("utf-8")
        sig = _b64d(encoded_sig)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid payment token format.") from exc

    expected = hmac.new(_ensure_secret().encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=400, detail="Invalid payment token.")

    try:
        prefix, user_id_str, username, exp_str, _nonce = body.split(".", 4)
        if prefix != "pp":
            raise ValueError("wrong prefix")
        user_id = int(user_id_str)
        exp = int(exp_str)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid payment token payload.") from exc

    if int(time.time()) > exp:
        raise HTTPException(status_code=400, detail="Payment token expired.")

    return user_id, username


def _bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header.")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization must be Bearer token.")
    return parts[1].strip()


def _user_by_id(
    conn: sqlite3.Connection,
    user_id: int,
    *,
    require_active_subscription: bool = True,
) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="User not found.")
    if require_active_subscription and _square_billing_enabled() and not _row_subscription_allows_access(row):
        raise HTTPException(status_code=402, detail="Active subscription required to use BlackEnvelope.")
    return row


def _require_site_admin(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row:
    user = _user_by_id(conn, user_id, require_active_subscription=False)
    if not bool(user["is_admin"]):
        raise HTTPException(status_code=403, detail="Admin access required.")
    return user


def _serialize_message_row(row: sqlite3.Row, self_user_id: int) -> dict[str, Any]:
    """Serialize a direct message row.

    Optimization: if the payload uses dual-box format (to_sender/to_recipient),
    return only the box the current viewer needs to decrypt.
    """
    direction = "outgoing" if row["sender_id"] == self_user_id else "incoming"
    payload: Any = json.loads(row["payload"])
    if isinstance(payload, dict):
        to_recipient = payload.get("to_recipient")
        to_sender = payload.get("to_sender")
        if isinstance(to_recipient, dict) and isinstance(to_sender, dict):
            box = to_recipient if direction == "incoming" else to_sender
            # Return a compact payload that still works with decryptDirectPayload().
            compact: dict[str, Any] = {}
            if "v" in payload:
                compact["v"] = payload["v"]
            if "alg" in payload:
                compact["alg"] = payload["alg"]
            compact.update(box)
            payload = compact

    return {
        "id": row["id"],
        "direction": direction,
        "sender_id": row["sender_id"],
        "sender_username": row["sender_username"],
        "recipient_id": row["recipient_id"],
        "recipient_username": row["recipient_username"],
        "payload": payload,
        "created_at": row["created_at"],
    }


def _serialize_group_message_row(
    row: sqlite3.Row,
    self_user_id: int,
    self_username: str,
) -> dict[str, Any]:
    """Serialize a group message row.

    Optimization: group payloads store one encrypted box per member username.
    The client only needs the box for the current user, so strip the rest to
    reduce bandwidth and speed up the UI.
    """
    direction = "outgoing" if row["sender_id"] == self_user_id else "incoming"
    payload: Any = json.loads(row["payload"])
    if isinstance(payload, dict) and isinstance(payload.get("boxes"), dict):
        boxes = payload["boxes"]
        box = boxes.get(self_username)
        payload["boxes"] = {self_username: box} if isinstance(box, dict) else {}

    data: dict[str, Any] = {
        "id": row["id"],
        "direction": direction,
        "group_id": row["group_id"],
        "topic_id": row["topic_id"],
        "sender_id": row["sender_id"],
        "sender_username": row["sender_username"],
        "payload": payload,
        "created_at": row["created_at"],
    }
    if "topic_title" in row.keys():
        data["topic_title"] = row["topic_title"]
    return data


def _get_likes_for_messages(
    conn: sqlite3.Connection,
    message_type: str,
    message_ids: list[int],
) -> dict[int, list[dict[str, Any]]]:
    """Return {message_id: [{user_id, username, avatar_b64}, ...]} for a batch of messages."""
    if not message_ids:
        return {}
    placeholders = ",".join("?" for _ in message_ids)
    rows = conn.execute(
        f"""
        SELECT ml.message_id, ml.user_id, u.username, u.avatar_b64
        FROM message_likes ml
        JOIN users u ON u.id = ml.user_id
        WHERE ml.message_type = ? AND ml.message_id IN ({placeholders})
        ORDER BY ml.created_at ASC
        """,
        [message_type] + message_ids,
    ).fetchall()
    result: dict[int, list[dict[str, Any]]] = {}
    for r in rows:
        mid = r["message_id"]
        if mid not in result:
            result[mid] = []
        result[mid].append({
            "user_id": r["user_id"],
            "username": r["username"],
            "avatar_b64": r["avatar_b64"],
        })
    return result


def _require_group_member(conn: sqlite3.Connection, group_id: int, user_id: int) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT
            gm.group_id,
            gm.user_id,
            gm.role,
            g.name AS group_name,
            g.owner_id,
            g.created_at
        FROM group_members gm
        JOIN chat_groups g ON g.id = gm.group_id
        WHERE gm.group_id = ? AND gm.user_id = ?
        """,
        (group_id, user_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=403, detail="You are not a member of this group.")
    return row


def _group_topic_row(conn: sqlite3.Connection, group_id: int, topic_id: int) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT id, group_id, title, created_by, created_at
        FROM group_topics
        WHERE id = ? AND group_id = ?
        """,
        (topic_id, group_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Topic not found in group.")
    return row


def _is_group_admin(role: str) -> bool:
    return role in {"owner", "admin"}


def _are_friends(conn: sqlite3.Connection, user_a_id: int, user_b_id: int) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM friendships
        WHERE user_id = ? AND friend_id = ?
        """,
        (user_a_id, user_b_id),
    ).fetchone()
    return row is not None


def _require_friendship(conn: sqlite3.Connection, user_a_id: int, user_b_id: int) -> None:
    if not _are_friends(conn, user_a_id, user_b_id):
        raise HTTPException(status_code=403, detail="You can only message users in your friend list.")


async def _notify_user(user_id: int, event: dict[str, Any]) -> None:
    sockets = active_sockets.get(user_id, set())
    stale: list[WebSocket] = []
    for ws in sockets:
        try:
            await ws.send_json(event)
        except Exception:
            stale.append(ws)
    for ws in stale:
        sockets.discard(ws)

    # Always send web push for message events. This keeps phone alerts working
    # even when the same account is connected elsewhere (desktop/websocket).
    if event.get("type") in ("new_message", "new_group_message"):
        msg = event.get("message", {})
        sender = msg.get("sender_username", "Someone")
        body = f"New message from {sender}"
        await _send_web_push(user_id, "BlackEnvelope", body)


async def _send_web_push(user_id: int, title: str, body: str) -> None:
    """Send a web push notification to all subscriptions for a user."""
    if not _webpush_enabled():
        return
    conn = _db()
    try:
        rows = conn.execute(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
            (user_id,),
        ).fetchall()
    finally:
        conn.close()

    stale_endpoints: list[str] = []
    for row in rows:
        subscription_info = {
            "endpoint": row["endpoint"],
            "keys": {"p256dh": row["p256dh"], "auth": row["auth"]},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=json.dumps({"title": title, "body": body}),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=86400,
            )
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                stale_endpoints.append(row["endpoint"])
        except Exception:
            pass

    if stale_endpoints:
        clean = _db()
        try:
            for ep in stale_endpoints:
                clean.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (ep,))
            clean.commit()
        finally:
            clean.close()


async def _create_notification(
    conn: sqlite3.Connection,
    user_id: int,
    notif_type: str,
    source_user_id: int | None = None,
    message_id: int | None = None,
    message_type: str | None = None,
    group_id: int | None = None,
    topic_id: int | None = None,
    friend_username: str | None = None,
) -> None:
    """Insert a notification row and push a real-time WS event."""
    now = int(time.time())
    cur = conn.execute(
        """INSERT INTO notifications
           (user_id, type, source_user_id, message_id, message_type,
            group_id, topic_id, friend_username, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, notif_type, source_user_id, message_id, message_type,
         group_id, topic_id, friend_username, now),
    )
    conn.commit()
    notif_id = cur.lastrowid

    # Look up source username for the WS event
    source_username = None
    if source_user_id is not None:
        row = conn.execute("SELECT username FROM users WHERE id = ?", (source_user_id,)).fetchone()
        if row:
            source_username = row["username"]

    # Look up group name if applicable
    group_name = None
    if group_id is not None:
        grow = conn.execute("SELECT name FROM chat_groups WHERE id = ?", (group_id,)).fetchone()
        if grow:
            group_name = grow["name"]

    await _notify_user(user_id, {
        "type": "notification_new",
        "notification": {
            "id": notif_id,
            "type": notif_type,
            "source_username": source_username,
            "message_id": message_id,
            "message_type": message_type,
            "group_id": group_id,
            "group_name": group_name,
            "topic_id": topic_id,
            "friend_username": friend_username,
            "created_at": now,
        },
    })


def _bootstrap_admin_and_registration_code() -> None:
    conn = _db()
    try:
        if BOOTSTRAP_ADMIN_USERNAME:
            conn.execute(
                """
                UPDATE users
                SET is_admin = 1
                WHERE username = ?
                  AND external_provider = ?
                """,
                (BOOTSTRAP_ADMIN_USERNAME, NUTSHELL_PROVIDER),
            )

        # One-time migration from legacy single-code app_settings storage.
        if _count_registration_access_codes(conn) == 0:
            legacy_hash = _get_legacy_registration_access_code_hash(conn)
            if legacy_hash:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO registration_access_codes (code_hash, grants_free_access, created_at, created_by_user_id)
                    VALUES (?, 0, ?, NULL)
                    """,
                    (legacy_hash, int(time.time())),
                )
                _delete_legacy_registration_access_code_hash(conn)

        # Optional bootstrap promo/access code; applied only when no codes exist.
        if BOOTSTRAP_REGISTRATION_CODE and _count_registration_access_codes(conn) == 0:
            _create_registration_access_code(conn, BOOTSTRAP_REGISTRATION_CODE, created_by_user_id=None)
        conn.commit()
    finally:
        conn.close()


def _bootstrap_grandfathered_users() -> None:
    """Mark all existing users as subscription-exempt when billing is first enabled.

    Uses app_settings sentinel to ensure this runs only once.
    """
    if not _square_billing_enabled():
        return

    conn = _db()
    try:
        already_done = conn.execute(
            "SELECT value FROM app_settings WHERE key = ?",
            (BILLING_GRANDFATHERED_SETTING_KEY,),
        ).fetchone()
        if already_done is not None:
            return

        now = int(time.time())
        conn.execute("UPDATE users SET subscription_exempt = 1")
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
            (BILLING_GRANDFATHERED_SETTING_KEY, str(now), now),
        )
        conn.commit()
    finally:
        conn.close()


def _bootstrap_global_feed() -> None:
    conn = _db()
    try:
        _ensure_all_users_in_global_feed(conn)
        conn.commit()
    finally:
        conn.close()


def _migrate_db() -> None:
    """Run idempotent schema migrations after initial table creation."""
    conn = _db()
    try:
        migrations = [
            "ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN avatar_b64 TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN google_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN external_provider TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN external_subject TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN square_customer_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'NONE'",
            "ALTER TABLE users ADD COLUMN subscription_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN subscription_plan_variation_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN subscription_updated_at INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN subscription_exempt INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN subscription_charged_through_date TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN subscription_failed_at INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN link TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE registration_access_codes ADD COLUMN grants_free_access INTEGER NOT NULL DEFAULT 0",
        ]
        for sql in migrations:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id INTEGER PRIMARY KEY,
                notification_sound_enabled INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS square_checkout_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                checkout_link_id TEXT NOT NULL,
                order_id TEXT NOT NULL UNIQUE,
                checkout_url TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS square_webhook_events (
                event_id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS message_likes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_type TEXT NOT NULL,
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(message_type, message_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_message_likes_lookup
                ON message_likes(message_type, message_id);

            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                source_user_id INTEGER,
                message_id INTEGER,
                message_type TEXT,
                group_id INTEGER,
                topic_id INTEGER,
                friend_username TEXT,
                is_read INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_notifications_user
                ON notifications(user_id, is_read, created_at DESC);

            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
                ON push_subscriptions(user_id);

            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at INTEGER NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
                ON password_reset_tokens(user_id, used, expires_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
                ON users(email) WHERE email != '';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id_unique
                ON users(google_id) WHERE google_id != '';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_identity_unique
                ON users(external_provider, external_subject)
                WHERE external_provider != '' AND external_subject != '';

            CREATE INDEX IF NOT EXISTS idx_messages_sender_created
                ON messages(sender_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_group_messages_sender_created
                ON group_messages(sender_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_users_square_customer_id
                ON users(square_customer_id);
            CREATE INDEX IF NOT EXISTS idx_square_checkout_links_user
                ON square_checkout_links(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_square_checkout_links_order
                ON square_checkout_links(order_id);
            """
        )
        conn.commit()
    finally:
        conn.close()


def _get_user_storage_bytes(conn: sqlite3.Connection, user_id: int) -> int:
    """Compute total storage bytes for messages sent by this user."""
    row = conn.execute(
        """
        SELECT
            COALESCE((SELECT SUM(LENGTH(payload)) FROM messages WHERE sender_id = ?), 0)
            + COALESCE((SELECT SUM(LENGTH(payload)) FROM group_messages WHERE sender_id = ?), 0)
            AS total
        """,
        (user_id, user_id),
    ).fetchone()
    return int(row["total"])


def _enforce_storage_limit(conn: sqlite3.Connection, user_id: int) -> bool:
    """Delete oldest sent messages if user exceeds storage limit.

    Returns True if a storage warning should be shown (approaching limit).
    """
    total = _get_user_storage_bytes(conn, user_id)
    warned = total >= STORAGE_WARN_BYTES

    if total <= STORAGE_LIMIT_BYTES:
        return warned

    excess = total - STORAGE_LIMIT_BYTES

    # Delete oldest DMs sent by user first
    freed = 0
    if freed < excess:
        rows = conn.execute(
            """
            SELECT id, LENGTH(payload) AS sz FROM messages
            WHERE sender_id = ?
            ORDER BY created_at ASC
            """,
            (user_id,),
        ).fetchall()
        ids_to_delete = []
        for r in rows:
            if freed >= excess:
                break
            ids_to_delete.append(r["id"])
            freed += r["sz"]
        if ids_to_delete:
            placeholders = ",".join("?" for _ in ids_to_delete)
            conn.execute(f"DELETE FROM messages WHERE id IN ({placeholders})", ids_to_delete)

    # If still over, delete oldest group messages sent by user
    if freed < excess:
        rows = conn.execute(
            """
            SELECT id, LENGTH(payload) AS sz FROM group_messages
            WHERE sender_id = ?
            ORDER BY created_at ASC
            """,
            (user_id,),
        ).fetchall()
        ids_to_delete = []
        for r in rows:
            if freed >= excess:
                break
            ids_to_delete.append(r["id"])
            freed += r["sz"]
        if ids_to_delete:
            placeholders = ",".join("?" for _ in ids_to_delete)
            conn.execute(f"DELETE FROM group_messages WHERE id IN ({placeholders})", ids_to_delete)

    conn.commit()
    return True  # was over limit, always warn


def _square_record_webhook_event(conn: sqlite3.Connection, event_id: str, event_type: str) -> bool:
    try:
        conn.execute(
            """
            INSERT INTO square_webhook_events (event_id, event_type, created_at)
            VALUES (?, ?, ?)
            """,
            (event_id, event_type, int(time.time())),
        )
        return True
    except sqlite3.IntegrityError:
        return False


def _square_handle_payment_event(
    conn: sqlite3.Connection, payment: dict[str, Any],
) -> tuple[int, dict[str, Any]] | None:
    """Returns (user_id, notify_payload) or None."""
    if not isinstance(payment, dict):
        return None

    order_id = str(payment.get("order_id") or "").strip()
    if not order_id:
        return None

    checkout_row = conn.execute(
        """
        SELECT user_id
        FROM square_checkout_links
        WHERE order_id = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (order_id,),
    ).fetchone()
    if checkout_row is None:
        return None

    user_id = int(checkout_row["user_id"])
    customer_id = str(payment.get("customer_id") or "").strip()
    payment_status = str(payment.get("status") or "").strip().lower() or "unknown"
    now = int(time.time())

    conn.execute(
        "UPDATE square_checkout_links SET status = ?, updated_at = ? WHERE order_id = ?",
        (payment_status, now, order_id),
    )

    if not customer_id:
        return None

    conn.execute(
        "UPDATE users SET square_customer_id = ?, subscription_updated_at = ? WHERE id = ?",
        (customer_id, now, user_id),
    )

    user_row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if user_row is None:
        return None

    try:
        _square_refresh_user_subscription(conn, user_row)
    except SquareAPIError:
        return None

    updated_row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if updated_row is None:
        return None

    status = _row_subscription_status(updated_row)
    if status in SQUARE_STATUS_ACTIVE_VALUES:
        _square_clear_failed_at(conn, user_id)
    else:
        _square_set_failed_at_if_needed(conn, user_id, updated_row)

    return (user_id, _build_billing_notification(updated_row))


def _square_handle_subscription_event(
    conn: sqlite3.Connection, subscription: dict[str, Any],
) -> tuple[int, dict[str, Any]] | None:
    """Returns (user_id, notify_payload) or None."""
    if not isinstance(subscription, dict):
        return None

    customer_id = str(subscription.get("customer_id") or "").strip()
    if not customer_id:
        return None

    user_row = conn.execute(
        "SELECT * FROM users WHERE square_customer_id = ? ORDER BY id ASC LIMIT 1",
        (customer_id,),
    ).fetchone()
    if user_row is None:
        return None

    user_id = int(user_row["id"])
    _square_update_user_subscription(
        conn,
        user_id=user_id,
        customer_id=customer_id,
        subscription=subscription,
    )

    updated_row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if updated_row is None:
        return None

    status = _row_subscription_status(updated_row)
    if status in SQUARE_STATUS_ACTIVE_VALUES:
        _square_clear_failed_at(conn, user_id)
    else:
        _square_set_failed_at_if_needed(conn, user_id, updated_row)

    return (user_id, _build_billing_notification(updated_row))


@app.on_event("startup")
async def startup_event() -> None:
    _init_db()
    _migrate_db()
    _bootstrap_admin_and_registration_code()
    _bootstrap_global_feed()
    _bootstrap_grandfathered_users()
    _ensure_secret()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config/public")
async def public_config() -> JSONResponse:
    return JSONResponse(
        {
            "google_client_id": GOOGLE_CLIENT_ID or None,
            "billing_enabled": _square_billing_enabled(),
            "nutshell_sso_enabled": _nutshell_sso_enabled(),
            "nutshell_public_url": _nutshell_public_url(),
            "nutshell_launch_url": _nutshell_launch_url(),
        }
    )


def _auth_user_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "username": row["username"],
        "has_public_key": bool(row["public_key"]),
        "email": row["email"],
        "display_name": row["display_name"],
        "avatar_b64": row["avatar_b64"],
        "is_admin": bool(row["is_admin"]),
        "subscription_exempt": bool(row["subscription_exempt"]),
        "subscription_status": _row_subscription_status(row),
        "subscription_active": (
            True if not _square_billing_enabled() else _row_subscription_allows_access(row)
        ),
        "subscription_charged_through_date": _row_subscription_charged_through_date(row),
        "subscription_id": str(row["subscription_id"] or "").strip(),
    }


def _auth_success_response(row: sqlite3.Row) -> JSONResponse:
    token = _create_token(user_id=row["id"])
    return JSONResponse({"token": token, "user": _auth_user_payload(row)})


def _nutshell_sso_success_response(session_token: str) -> HTMLResponse:
    session_payload = json.dumps({"token": session_token})
    html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Signing you into BlackEnvelope</title>
  </head>
  <body style="background:#0f141f;color:#f5f7fb;font:16px/1.5 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;margin:0;">
    <main style="max-width:28rem;padding:2rem;text-align:center;">
      <h1 style="margin:0 0 0.75rem;font-size:1.5rem;">Opening BlackEnvelope</h1>
      <p style="margin:0;color:#b6bfd2;">Your Nutshell session is being transferred now.</p>
    </main>
    <script>
      try {{
        localStorage.setItem({json.dumps(BLACKENVELOPE_SESSION_STORAGE_KEY)}, {json.dumps(session_payload)});
      }} catch (_error) {{
      }}
      window.location.replace("/");
    </script>
  </body>
</html>
"""
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.post("/api/integrations/nutshell/provision")
async def nutshell_provision(payload: dict[str, Any]) -> JSONResponse:
    claims = _verify_nutshell_token(str(payload.get("token", "")))

    conn = _db()
    try:
        row, created = _upsert_nutshell_user(conn, claims)
        conn.commit()
        return JSONResponse({"ok": True, "created": created, "user": _auth_user_payload(row)})
    finally:
        conn.close()


@app.post("/api/integrations/nutshell/unread-count")
async def nutshell_unread_count(payload: dict[str, Any]) -> JSONResponse:
    claims = _verify_nutshell_token(str(payload.get("token", "")))

    conn = _db()
    try:
        user_row = conn.execute(
            "SELECT id FROM users WHERE external_provider = ? AND external_subject = ? LIMIT 1",
            (NUTSHELL_PROVIDER, claims.subject),
        ).fetchone()

        if user_row is None:
            return JSONResponse({"unread_count": 0})

        row = conn.execute(
            "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0",
            (int(user_row["id"]),),
        ).fetchone()
        return JSONResponse({"unread_count": row["c"] if row else 0})
    finally:
        conn.close()


@app.get("/integrations/nutshell/sso")
async def nutshell_sso(token: str) -> HTMLResponse:
    claims = _verify_nutshell_token(token)

    conn = _db()
    try:
        row, _created = _upsert_nutshell_user(conn, claims)
        conn.commit()
        session_token = _create_token(int(row["id"]))
        return _nutshell_sso_success_response(session_token)
    finally:
        conn.close()


@app.post("/integrations/nutshell/sso")
async def nutshell_sso_post(token: str = Form(default="")) -> HTMLResponse:
    if not token:
        raise HTTPException(status_code=400, detail="Missing token.")
    return await nutshell_sso(token)


@app.post("/api/register")
async def register(payload: dict[str, Any]) -> JSONResponse:
    username = _validate_username(str(payload.get("username", "")))
    password = str(payload.get("password", ""))
    email = _validate_email(str(payload.get("email", "")))
    promo_code = str(payload.get("promo_code", payload.get("access_code", ""))).strip()
    _validate_password(password)

    salt = secrets.token_bytes(PASSWORD_SALT_BYTES)
    digest = _hash_password(password=password, salt=salt)
    created_at = int(time.time())

    conn = _db()
    try:
        grants_free_access = False
        # Promo codes are optional. Only valid codes marked as free skip billing.
        if promo_code and _registration_access_code_valid(conn, promo_code):
            grants_free_access = _registration_access_code_grants_free_access(conn, promo_code)

        existing_email = conn.execute(
            "SELECT 1 FROM users WHERE email = ? AND email != '' LIMIT 1",
            (email,),
        ).fetchone()
        if existing_email is not None:
            raise HTTPException(status_code=409, detail="Email already registered.")

        # Public self-registration must never bootstrap site-admin privileges.
        # Admin rights are granted through trusted Nutshell SSO or admin APIs.
        is_admin = 0

        cur = conn.execute(
            """
            INSERT INTO users (username, password_hash, password_salt, email, is_admin, subscription_exempt, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                username,
                _b64e(digest),
                _b64e(salt),
                email,
                is_admin,
                1 if grants_free_access else 0,
                created_at,
            ),
        )
        new_user_id = int(cur.lastrowid)
        _ensure_user_in_global_feed(conn, new_user_id)
        conn.commit()

        # If billing is enabled, generate a checkout link so the client can
        # redirect the new user to payment immediately after registration.
        checkout_url = ""
        if _square_billing_enabled() and not is_admin:
            try:
                new_row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
                if new_row and not _row_subscription_allows_access(new_row):
                    checkout_url = _square_create_checkout_link_for_user(conn, new_row)
                    conn.commit()
            except SquareAPIError:
                pass  # billing link creation failed — user can still pay at login

        return JSONResponse({"ok": True, "checkout_url": checkout_url or ""})
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Username already exists.") from exc
    finally:
        conn.close()


@app.post("/api/login")
async def login(payload: dict[str, Any]) -> JSONResponse:
    username = _validate_username(str(payload.get("username", "")))
    password = str(payload.get("password", ""))

    conn = _db()
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Invalid username or password.")
        salt = _b64d(row["password_salt"])
        digest = _hash_password(password=password, salt=salt)
        if not hmac.compare_digest(_b64e(digest), row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password.")

        _ensure_user_in_global_feed(conn, int(row["id"]))
        conn.commit()

        if _square_billing_enabled():
            customer_id = str(row["square_customer_id"] or "").strip()
            if not customer_id:
                # New user who paid but webhook couldn't link them yet — resolve via order lookup
                try:
                    customer_id = _square_resolve_customer_id_from_orders(conn, int(row["id"]))
                    if customer_id:
                        conn.execute(
                            "UPDATE users SET square_customer_id = ?, subscription_updated_at = ? WHERE id = ?",
                            (customer_id, int(time.time()), int(row["id"])),
                        )
                        conn.commit()
                        row = conn.execute("SELECT * FROM users WHERE id = ?", (int(row["id"]),)).fetchone()
                except SquareAPIError:
                    pass
            if customer_id and not _row_subscription_allows_access(row):
                try:
                    row = _square_refresh_user_subscription(conn, row)
                    conn.commit()
                except SquareAPIError as exc:
                    conn.rollback()
                    raise HTTPException(status_code=503, detail=f"Billing check failed: {exc}") from exc
            if not _row_subscription_allows_access(row):
                try:
                    checkout_url = _square_create_checkout_link_for_user(conn, row)
                    conn.commit()
                except SquareAPIError as exc:
                    conn.rollback()
                    raise HTTPException(status_code=503, detail=f"Failed to create checkout link: {exc}") from exc
                return _square_subscription_required_response(checkout_url)

        return _auth_success_response(row)
    finally:
        conn.close()


@app.post("/api/auth/google")
async def google_auth(payload: dict[str, Any]) -> JSONResponse:
    id_token = str(payload.get("id_token", "")).strip()
    google_data = _verify_google_id_token(id_token)

    google_id = str(google_data.get("sub") or "").strip()
    if not google_id:
        raise HTTPException(status_code=400, detail="Google token missing subject.")
    google_email = _validate_email(str(google_data.get("email", "")))

    conn = _db()
    try:
        # Path A: existing account already linked by Google ID.
        row = conn.execute(
            "SELECT * FROM users WHERE google_id = ? AND google_id != '' LIMIT 1",
            (google_id,),
        ).fetchone()

        # Path B: existing password account with same email, link Google ID.
        if row is None:
            row = conn.execute(
                "SELECT * FROM users WHERE email = ? AND email != '' LIMIT 1",
                (google_email,),
            ).fetchone()
            if row is not None:
                conn.execute(
                    "UPDATE users SET google_id = ? WHERE id = ?",
                    (google_id, int(row["id"])),
                )
                conn.commit()
                row = conn.execute("SELECT * FROM users WHERE id = ?", (int(row["id"]),)).fetchone()

        # Path C: brand new Google user.
        if row is None:
            desired_username = str(payload.get("username", "")).strip()
            if not desired_username:
                return JSONResponse(
                    {
                        "needs_username": True,
                        "email": google_email,
                        "username_suggestion": _next_available_username(
                            conn,
                            _google_username_seed(google_email),
                        ),
                    }
                )
            desired_username = _validate_username(desired_username)

            promo_code = str(payload.get("promo_code", payload.get("access_code", ""))).strip()
            grants_free_access = False
            # Promo codes are optional. Only valid codes marked as free skip billing.
            if promo_code and _registration_access_code_valid(conn, promo_code):
                grants_free_access = _registration_access_code_grants_free_access(conn, promo_code)

            # Public self-signup must never bootstrap site-admin privileges.
            # Admin rights are granted through trusted Nutshell SSO or admin APIs.
            is_admin = 0

            # Generate a random internal password hash so schema invariants remain intact.
            salt = secrets.token_bytes(PASSWORD_SALT_BYTES)
            digest = _hash_password(password=secrets.token_urlsafe(32), salt=salt)
            created_at = int(time.time())

            cur = conn.execute(
                """
                INSERT INTO users (username, password_hash, password_salt, email, google_id, is_admin, subscription_exempt, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    desired_username,
                    _b64e(digest),
                    _b64e(salt),
                    google_email,
                    google_id,
                    is_admin,
                    1 if grants_free_access else 0,
                    created_at,
                ),
            )
            new_user_id = int(cur.lastrowid)
            _ensure_user_in_global_feed(conn, new_user_id)
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE google_id = ? LIMIT 1", (google_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=500, detail="Failed to create Google account.")

        # Backfill missing email for legacy linked accounts.
        if not str(row["email"] or "").strip():
            conn.execute("UPDATE users SET email = ? WHERE id = ?", (google_email, int(row["id"])))
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id = ?", (int(row["id"]),)).fetchone()
            if row is None:
                raise HTTPException(status_code=500, detail="Account lookup failed.")

        _ensure_user_in_global_feed(conn, int(row["id"]))
        conn.commit()

        if _square_billing_enabled():
            customer_id = str(row["square_customer_id"] or "").strip()
            if not customer_id:
                try:
                    customer_id = _square_resolve_customer_id_from_orders(conn, int(row["id"]))
                    if customer_id:
                        conn.execute(
                            "UPDATE users SET square_customer_id = ?, subscription_updated_at = ? WHERE id = ?",
                            (customer_id, int(time.time()), int(row["id"])),
                        )
                        conn.commit()
                        row = conn.execute("SELECT * FROM users WHERE id = ?", (int(row["id"]),)).fetchone()
                except SquareAPIError:
                    pass
            if customer_id and not _row_subscription_allows_access(row):
                try:
                    row = _square_refresh_user_subscription(conn, row)
                    conn.commit()
                except SquareAPIError as exc:
                    conn.rollback()
                    raise HTTPException(status_code=503, detail=f"Billing check failed: {exc}") from exc
            if not _row_subscription_allows_access(row):
                try:
                    checkout_url = _square_create_checkout_link_for_user(conn, row)
                    conn.commit()
                except SquareAPIError as exc:
                    conn.rollback()
                    raise HTTPException(status_code=503, detail=f"Failed to create checkout link: {exc}") from exc
                return _square_subscription_required_response(checkout_url)

        return _auth_success_response(row)
    except sqlite3.IntegrityError as exc:
        detail = "Username already exists."
        lower = str(exc).lower()
        if "google_id" in lower:
            detail = "Google account is already linked to another user."
        elif "email" in lower:
            detail = "Email already registered."
        raise HTTPException(status_code=409, detail=detail) from exc
    finally:
        conn.close()


@app.post("/api/auth/forgot-password")
async def forgot_password(payload: dict[str, Any]) -> JSONResponse:
    email = _validate_email(str(payload.get("email", "")))
    success_msg = "If that email is registered, a reset link has been sent."
    if not APP_BASE_URL or not RESEND_API_KEY or not RESEND_FROM_EMAIL:
        raise HTTPException(status_code=503, detail="Password reset email is not configured.")

    conn = _db()
    try:
        user_row = conn.execute(
            "SELECT id, username, email FROM users WHERE email = ? AND email != ''",
            (email,),
        ).fetchone()
        if user_row is None:
            return JSONResponse({"ok": True, "detail": success_msg})

        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        created_at = int(time.time())
        expires_at = created_at + PASSWORD_RESET_TTL_SECONDS

        conn.execute(
            "UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0",
            (int(user_row["id"]),),
        )
        conn.execute(
            """
            INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used, created_at)
            VALUES (?, ?, ?, 0, ?)
            """,
            (int(user_row["id"]), token_hash, expires_at, created_at),
        )
        conn.commit()

        if APP_BASE_URL:
            reset_url = f"{APP_BASE_URL}/#/reset-password?token={raw_token}"
            html_body = (
                "<h2>BlackEnvelope Password Reset</h2>"
                f"<p>Hello {user_row['username']},</p>"
                "<p>Click the link below to reset your password. This link expires in 1 hour.</p>"
                f'<p><a href="{reset_url}">Reset Password</a></p>'
                "<p>If you did not request this, you can safely ignore this email.</p>"
            )
            try:
                _send_email(email, "BlackEnvelope - Password Reset", html_body)
            except Exception:
                pass

        return JSONResponse({"ok": True, "detail": success_msg})
    finally:
        conn.close()


@app.post("/api/auth/reset-password")
async def reset_password(payload: dict[str, Any]) -> JSONResponse:
    raw_token = str(payload.get("token", "")).strip()
    new_password = str(payload.get("new_password", ""))

    if not raw_token:
        raise HTTPException(status_code=400, detail="Missing reset token.")
    _validate_password(new_password)

    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    conn = _db()
    try:
        token_row = conn.execute(
            """
            SELECT id, user_id
            FROM password_reset_tokens
            WHERE token_hash = ? AND used = 0 AND expires_at > ?
            """,
            (token_hash, int(time.time())),
        ).fetchone()
        if token_row is None:
            raise HTTPException(status_code=400, detail="Invalid or expired reset token.")

        salt = secrets.token_bytes(PASSWORD_SALT_BYTES)
        digest = _hash_password(password=new_password, salt=salt)

        conn.execute(
            "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
            (_b64e(digest), _b64e(salt), int(token_row["user_id"])),
        )
        conn.execute(
            "UPDATE password_reset_tokens SET used = 1 WHERE id = ?",
            (int(token_row["id"]),),
        )
        conn.commit()
        return JSONResponse({"ok": True, "detail": "Password reset successfully."})
    finally:
        conn.close()


@app.get("/api/me")
async def me(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        row = _user_by_id(conn, claims.user_id, require_active_subscription=False)
        if _square_billing_enabled():
            customer_id = str(row["square_customer_id"] or "").strip()
            if customer_id and not _row_subscription_allows_access(row):
                try:
                    row = _square_refresh_user_subscription(conn, row)
                    conn.commit()
                except SquareAPIError as exc:
                    conn.rollback()
                    raise HTTPException(status_code=503, detail=f"Billing check failed: {exc}") from exc
            if not _row_subscription_allows_access(row):
                try:
                    checkout_url = _square_create_checkout_link_for_user(conn, row)
                    conn.commit()
                except SquareAPIError as exc:
                    conn.rollback()
                    raise HTTPException(status_code=503, detail=f"Failed to create checkout link: {exc}") from exc
                return _square_subscription_required_response(checkout_url)

        backup_row = conn.execute(
            "SELECT 1 FROM encrypted_key_backups WHERE user_id = ? LIMIT 1",
            (claims.user_id,),
        ).fetchone()

        return JSONResponse(
            {
                "id": row["id"],
                "username": row["username"],
                "email": row["email"],
                "has_public_key": bool(row["public_key"]),
                "display_name": row["display_name"],
                "avatar_b64": row["avatar_b64"],
                "is_admin": bool(row["is_admin"]),
                "bio": row["bio"],
                "location": row["location"],
                "link": row["link"],
                "status": row["status"],
                "created_at": row["created_at"],
                "has_key_backup": backup_row is not None,
                "subscription_exempt": bool(row["subscription_exempt"]),
                "subscription_status": _row_subscription_status(row),
                "subscription_active": (
                    True if not _square_billing_enabled() else _row_subscription_allows_access(row)
                ),
                "subscription_charged_through_date": _row_subscription_charged_through_date(row),
                "subscription_id": str(row["subscription_id"] or "").strip(),
            }
        )
    finally:
        conn.close()


@app.post("/api/billing/square/webhook")
async def square_billing_webhook(
    request: Request,
    x_square_hmacsha256_signature: str | None = Header(
        default=None,
        alias="x-square-hmacsha256-signature",
    ),
) -> JSONResponse:
    if not _square_billing_enabled():
        return JSONResponse({"ok": True, "billing_enabled": False})

    if not SQUARE_WEBHOOK_SIGNATURE_KEY:
        raise HTTPException(status_code=503, detail="Square webhook signing key is not configured.")

    if not x_square_hmacsha256_signature:
        raise HTTPException(status_code=400, detail="Missing Square webhook signature header.")

    raw_body = await request.body()
    if not _square_verify_webhook_signature(x_square_hmacsha256_signature, raw_body, request):
        raise HTTPException(status_code=401, detail="Invalid Square webhook signature.")

    try:
        event = json.loads(raw_body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Webhook payload was not valid JSON.") from exc

    event_id = str(event.get("event_id") or "").strip()
    event_type = str(event.get("type") or "").strip()
    if not event_id or not event_type:
        raise HTTPException(status_code=400, detail="Webhook payload is missing event metadata.")

    data_obj: dict[str, Any] = {}
    data = event.get("data")
    if isinstance(data, dict):
        obj = data.get("object")
        if isinstance(obj, dict):
            data_obj = obj

    conn = _db()
    try:
        is_new = _square_record_webhook_event(conn, event_id, event_type)
        if not is_new:
            conn.commit()
            return JSONResponse({"ok": True, "duplicate": True})

        notify_result: tuple[int, dict[str, Any]] | None = None

        if event_type.startswith("payment."):
            payment = data_obj.get("payment")
            if isinstance(payment, dict):
                notify_result = _square_handle_payment_event(conn, payment)
        elif event_type.startswith("subscription."):
            subscription = data_obj.get("subscription")
            if isinstance(subscription, dict):
                notify_result = _square_handle_subscription_event(conn, subscription)

        conn.commit()

        if notify_result:
            uid, payload = notify_result
            await _notify_user(uid, payload)
            if payload.get("subscription_active") is False:
                await _close_user_sockets_for_billing(uid)

        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.post("/api/billing/checkout-link")
async def create_billing_checkout_link(authorization: str | None = Header(default=None)) -> JSONResponse:
    if not _square_billing_enabled():
        raise HTTPException(status_code=503, detail="Square billing is not configured.")

    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        row = _user_by_id(conn, claims.user_id, require_active_subscription=False)
        if _row_subscription_allows_access(row):
            return JSONResponse(
                {
                    "ok": True,
                    "subscription_required": False,
                    "subscription_status": _row_subscription_status(row),
                    "subscription_active": True,
                }
            )

        try:
            checkout_url = _square_create_checkout_link_for_user(conn, row)
            conn.commit()
        except SquareAPIError as exc:
            conn.rollback()
            raise HTTPException(status_code=503, detail=f"Failed to create checkout link: {exc}") from exc

        return JSONResponse(
            {
                "ok": True,
                "subscription_required": True,
                "checkout_url": checkout_url,
                "subscription_status": _row_subscription_status(row),
                "subscription_active": False,
            }
        )
    finally:
        conn.close()


@app.post("/api/billing/cancel")
async def cancel_subscription(authorization: str | None = Header(default=None)) -> JSONResponse:
    if not _square_billing_enabled():
        raise HTTPException(status_code=503, detail="Square billing is not configured.")

    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        row = _user_by_id(conn, claims.user_id, require_active_subscription=False)

        subscription_id = str(row["subscription_id"] or "").strip()
        if not subscription_id:
            raise HTTPException(status_code=400, detail="No active subscription found on your account.")

        status = _row_subscription_status(row)
        if status not in SQUARE_STATUS_ACTIVE_VALUES:
            raise HTTPException(
                status_code=400,
                detail=f"Subscription is already {status.lower()} and cannot be canceled again.",
            )

        encoded_id = urllib_parse.quote(subscription_id, safe="")
        try:
            result = _square_api_request("POST", f"/v2/subscriptions/{encoded_id}/cancel")
        except SquareAPIError as exc:
            raise HTTPException(status_code=503, detail=f"Cancellation failed: {exc}") from exc

        updated_sub = result.get("subscription")
        if isinstance(updated_sub, dict):
            _square_update_user_subscription(
                conn,
                user_id=claims.user_id,
                customer_id=str(row["square_customer_id"] or ""),
                subscription=updated_sub,
            )
        conn.commit()

        updated_row = conn.execute("SELECT * FROM users WHERE id = ?", (claims.user_id,)).fetchone()
        charged_through = _row_subscription_charged_through_date(updated_row) if updated_row else ""

        return JSONResponse({
            "ok": True,
            "subscription_status": _row_subscription_status(updated_row) if updated_row else "CANCELED",
            "charged_through_date": charged_through,
            "message": f"Subscription canceled. Access continues until {charged_through}." if charged_through else "Subscription canceled.",
        })
    finally:
        conn.close()


@app.get("/api/billing/status")
async def get_billing_status(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        row = _user_by_id(conn, claims.user_id, require_active_subscription=False)

        if not _square_billing_enabled():
            return JSONResponse({
                "billing_enabled": False,
                "subscription_active": True,
                "subscription_status": "NONE",
                "subscription_id": "",
                "charged_through_date": "",
                "grace_end_date": "",
                "subscription_exempt": bool(row["subscription_exempt"]),
                "is_admin": bool(row["is_admin"]),
            })

        has_access = _row_subscription_allows_access(row)
        status = _row_subscription_status(row)
        charged_through = _row_subscription_charged_through_date(row)
        subscription_id = str(row["subscription_id"] or "").strip()
        failed_at = int(row["subscription_failed_at"] or 0)

        grace_end_date = ""
        if failed_at:
            grace_end_ts = failed_at + SQUARE_FAILED_GRACE_SECONDS
            grace_end_date = datetime.datetime.fromtimestamp(grace_end_ts).strftime("%Y-%m-%d")

        return JSONResponse({
            "billing_enabled": True,
            "subscription_active": has_access,
            "subscription_status": status,
            "subscription_id": subscription_id,
            "charged_through_date": charged_through,
            "grace_end_date": grace_end_date,
            "subscription_exempt": bool(row["subscription_exempt"]),
            "is_admin": bool(row["is_admin"]),
        })
    finally:
        conn.close()


@app.get("/api/billing/payment-status")
async def get_payment_status(token: str = "") -> JSONResponse:
    """Public endpoint (no auth required) for post-payment polling.

    The frontend calls this after Square redirects the user back with a
    payment_pending token.  The server resolves the Square customer and
    subscription proactively so the user can log in immediately.
    """
    if not token:
        raise HTTPException(status_code=400, detail="Missing payment token.")

    user_id, _username = _verify_payment_pending_token(token)

    conn = _db()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            return JSONResponse({"status": "not_found"})

        # Already has access — nothing to resolve
        if _row_subscription_allows_access(row):
            return JSONResponse({"status": "active", "username": row["username"]})

        if not _square_billing_enabled():
            return JSONResponse({"status": "active", "username": row["username"]})

        # Try to resolve customer_id from checkout orders
        customer_id = str(row["square_customer_id"] or "").strip()
        if not customer_id:
            try:
                customer_id = _square_resolve_customer_id_from_orders(conn, user_id)
                if customer_id:
                    conn.execute(
                        "UPDATE users SET square_customer_id = ?, subscription_updated_at = ? WHERE id = ?",
                        (customer_id, int(time.time()), user_id),
                    )
                    conn.commit()
                    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            except SquareAPIError:
                pass

        # Try to refresh subscription from Square API
        if customer_id and not _row_subscription_allows_access(row):
            try:
                row = _square_refresh_user_subscription(conn, row)
                conn.commit()
            except SquareAPIError:
                pass

        if _row_subscription_allows_access(row):
            return JSONResponse({"status": "active", "username": row["username"]})

        return JSONResponse({"status": "pending"})
    finally:
        conn.close()


@app.get("/api/admin/settings")
async def admin_get_settings(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _require_site_admin(conn, claims.user_id)
        code_count = _count_registration_access_codes(conn)
        user_count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        admin_count = conn.execute("SELECT COUNT(*) AS c FROM users WHERE is_admin = 1").fetchone()["c"]
        return JSONResponse(
            {
                "registration_access_code_enabled": code_count > 0,
                "registration_access_code_count": int(code_count),
                "user_count": int(user_count),
                "admin_count": int(admin_count),
            }
        )
    finally:
        conn.close()


@app.get("/api/admin/access-codes")
async def admin_list_access_codes(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _require_site_admin(conn, claims.user_id)
        rows = conn.execute(
            """
            SELECT
                rac.id,
                rac.code_hash,
                rac.grants_free_access,
                rac.created_at,
                rac.created_by_user_id,
                u.username AS created_by_username
            FROM registration_access_codes rac
            LEFT JOIN users u ON u.id = rac.created_by_user_id
            ORDER BY rac.created_at DESC, rac.id DESC
            """
        ).fetchall()
        return JSONResponse(
            {
                "count": len(rows),
                "codes": [
                    {
                        "id": int(row["id"]),
                        "hash_preview": _registration_code_hash_preview(str(row["code_hash"])),
                        "grants_free_access": bool(row["grants_free_access"]),
                        "created_at": row["created_at"],
                        "created_by_user_id": row["created_by_user_id"],
                        "created_by_username": row["created_by_username"],
                    }
                    for row in rows
                ],
            }
        )
    finally:
        conn.close()


@app.post("/api/admin/access-codes")
async def admin_create_access_code(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    access_code = str(payload.get("access_code", "")).strip()
    grants_free_access = bool(payload.get("grants_free_access", False))
    if len(access_code) < 6 or len(access_code) > 128:
        raise HTTPException(status_code=400, detail="Access code must be 6-128 characters.")

    conn = _db()
    try:
        _require_site_admin(conn, claims.user_id)
        try:
            new_id = _create_registration_access_code(
                conn,
                access_code,
                claims.user_id,
                grants_free_access=grants_free_access,
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="That access code already exists.") from exc
        conn.commit()
        row = conn.execute(
            """
            SELECT
                rac.id,
                rac.code_hash,
                rac.grants_free_access,
                rac.created_at,
                rac.created_by_user_id,
                u.username AS created_by_username
            FROM registration_access_codes rac
            LEFT JOIN users u ON u.id = rac.created_by_user_id
            WHERE rac.id = ?
            """,
            (new_id,),
        ).fetchone()
        count = _count_registration_access_codes(conn)
        return JSONResponse(
            {
                "ok": True,
                "registration_access_code_enabled": count > 0,
                "registration_access_code_count": int(count),
                "code": {
                    "id": int(row["id"]),
                    "hash_preview": _registration_code_hash_preview(str(row["code_hash"])),
                    "grants_free_access": bool(row["grants_free_access"]),
                    "created_at": row["created_at"],
                    "created_by_user_id": row["created_by_user_id"],
                    "created_by_username": row["created_by_username"],
                },
            }
        )
    finally:
        conn.close()


@app.delete("/api/admin/access-codes/{code_id}")
async def admin_delete_access_code(code_id: int, authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _require_site_admin(conn, claims.user_id)
        row = conn.execute(
            "SELECT id FROM registration_access_codes WHERE id = ?",
            (code_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Access code not found.")
        conn.execute(
            "DELETE FROM registration_access_codes WHERE id = ?",
            (code_id,),
        )
        conn.commit()
        count = _count_registration_access_codes(conn)
        return JSONResponse(
            {
                "ok": True,
                "registration_access_code_enabled": count > 0,
                "registration_access_code_count": int(count),
            }
        )
    finally:
        conn.close()


@app.put("/api/admin/access-code")
async def admin_set_access_code(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Backward-compatible alias for creating an access code."""
    return await admin_create_access_code(payload, authorization)


@app.delete("/api/admin/access-code")
async def admin_disable_access_code(authorization: str | None = Header(default=None)) -> JSONResponse:
    """Backward-compatible endpoint that clears all access codes."""
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _require_site_admin(conn, claims.user_id)
        conn.execute("DELETE FROM registration_access_codes")
        conn.commit()
        return JSONResponse(
            {
                "ok": True,
                "registration_access_code_enabled": False,
                "registration_access_code_count": 0,
            }
        )
    finally:
        conn.close()


@app.get("/api/admin/users")
async def admin_list_users(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _require_site_admin(conn, claims.user_id)
        rows = conn.execute(
            """
            SELECT
                id,
                username,
                is_admin,
                subscription_exempt,
                public_key,
                display_name,
                created_at
            FROM users
            ORDER BY created_at DESC, username ASC
            """
        ).fetchall()
        return JSONResponse(
            {
                "users": [
                    {
                        "id": row["id"],
                        "username": row["username"],
                        "is_admin": bool(row["is_admin"]),
                        "subscription_exempt": bool(row["subscription_exempt"]),
                        "has_public_key": bool(row["public_key"]),
                        "display_name": row["display_name"],
                        "created_at": row["created_at"],
                    }
                    for row in rows
                ]
            }
        )
    finally:
        conn.close()


@app.get("/api/admin/export/users.csv")
async def admin_export_users_csv(authorization: str | None = Header(default=None)) -> Response:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _require_site_admin(conn, claims.user_id)
        users = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.is_admin,
                u.display_name,
                u.created_at,
                LENGTH(u.public_key) AS public_key_chars,
                LENGTH(u.avatar_b64) AS avatar_chars,
                COALESCE(us.notification_sound_enabled, 1) AS notification_sound_enabled,
                ekb.updated_at AS key_backup_updated_at,
                u.square_customer_id,
                u.subscription_status,
                u.subscription_id,
                u.subscription_exempt,
                u.subscription_charged_through_date,
                u.subscription_updated_at
            FROM users u
            LEFT JOIN user_settings us ON us.user_id = u.id
            LEFT JOIN encrypted_key_backups ekb ON ekb.user_id = u.id
            ORDER BY u.id ASC
            """
        ).fetchall()

        friend_agg = conn.execute(
            """
            SELECT
                f.user_id,
                COUNT(*) AS friend_count,
                GROUP_CONCAT(u.username, ';') AS friend_usernames
            FROM friendships f
            JOIN users u ON u.id = f.friend_id
            GROUP BY f.user_id
            """
        ).fetchall()

        incoming_agg = conn.execute(
            """
            SELECT
                fr.target_id AS user_id,
                COUNT(*) AS incoming_request_count
            FROM friend_requests fr
            GROUP BY fr.target_id
            """
        ).fetchall()

        outgoing_agg = conn.execute(
            """
            SELECT
                fr.requester_id AS user_id,
                COUNT(*) AS outgoing_request_count
            FROM friend_requests fr
            GROUP BY fr.requester_id
            """
        ).fetchall()

        groups_owned_agg = conn.execute(
            """
            SELECT
                g.owner_id AS user_id,
                COUNT(*) AS groups_owned_count,
                GROUP_CONCAT(g.name, ';') AS groups_owned_names
            FROM chat_groups g
            GROUP BY g.owner_id
            """
        ).fetchall()

        groups_member_agg = conn.execute(
            """
            SELECT
                gm.user_id,
                COUNT(*) AS groups_member_count,
                GROUP_CONCAT(g.name, ';') AS groups_member_names
            FROM group_members gm
            JOIN chat_groups g ON g.id = gm.group_id
            GROUP BY gm.user_id
            """
        ).fetchall()

        direct_sent_agg = conn.execute(
            """
            SELECT
                m.sender_id AS user_id,
                COUNT(*) AS direct_sent_count,
                COALESCE(SUM(LENGTH(m.payload)), 0) AS direct_sent_payload_bytes
            FROM messages m
            GROUP BY m.sender_id
            """
        ).fetchall()

        direct_received_agg = conn.execute(
            """
            SELECT
                m.recipient_id AS user_id,
                COUNT(*) AS direct_received_count
            FROM messages m
            GROUP BY m.recipient_id
            """
        ).fetchall()

        group_sent_agg = conn.execute(
            """
            SELECT
                gm.sender_id AS user_id,
                COUNT(*) AS group_sent_count,
                COALESCE(SUM(LENGTH(gm.payload)), 0) AS group_sent_payload_bytes
            FROM group_messages gm
            GROUP BY gm.sender_id
            """
        ).fetchall()

        group_visible_agg = conn.execute(
            """
            SELECT
                memb.user_id,
                COUNT(gm.id) AS group_visible_count
            FROM group_members memb
            LEFT JOIN group_messages gm ON gm.group_id = memb.group_id
            GROUP BY memb.user_id
            """
        ).fetchall()
    finally:
        conn.close()

    def _agg_map(rows: list[sqlite3.Row], key_field: str) -> dict[int, sqlite3.Row]:
        out: dict[int, sqlite3.Row] = {}
        for row in rows:
            out[int(row[key_field])] = row
        return out

    friend_map = _agg_map(friend_agg, "user_id")
    incoming_map = _agg_map(incoming_agg, "user_id")
    outgoing_map = _agg_map(outgoing_agg, "user_id")
    groups_owned_map = _agg_map(groups_owned_agg, "user_id")
    groups_member_map = _agg_map(groups_member_agg, "user_id")
    direct_sent_map = _agg_map(direct_sent_agg, "user_id")
    direct_received_map = _agg_map(direct_received_agg, "user_id")
    group_sent_map = _agg_map(group_sent_agg, "user_id")
    group_visible_map = _agg_map(group_visible_agg, "user_id")

    # Fetch Square customer emails for users with a customer ID
    square_email_map: dict[str, str] = {}
    if _square_billing_enabled():
        for user in users:
            cid = str(user["square_customer_id"] or "").strip()
            if not cid or cid in square_email_map:
                continue
            try:
                resp = _square_api_request("GET", f"/v2/customers/{cid}")
                customer = resp.get("customer", {})
                square_email_map[cid] = str(customer.get("email_address") or "").strip()
            except Exception:
                square_email_map[cid] = ""

    def _clip(value: str | None, max_chars: int = 1500) -> str:
        if not value:
            return ""
        if len(value) <= max_chars:
            return value
        return value[:max_chars] + "..."

    def _ts_to_date(ts) -> str:
        if not ts:
            return ""
        try:
            return datetime.datetime.fromtimestamp(int(ts), tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        except (ValueError, OSError, TypeError):
            return str(ts)

    csv_columns = [
        "user_id",
        "username",
        "is_admin",
        "display_name",
        "created_at",
        "has_public_key",
        "public_key_chars",
        "has_avatar",
        "avatar_chars",
        "notification_sound_enabled",
        "has_key_backup",
        "key_backup_updated_at",
        "friend_count",
        "friend_usernames",
        "incoming_request_count",
        "outgoing_request_count",
        "groups_owned_count",
        "groups_owned_names",
        "groups_member_count",
        "groups_member_names",
        "direct_sent_count",
        "direct_received_count",
        "group_sent_count",
        "group_visible_count",
        "direct_sent_payload_bytes",
        "group_sent_payload_bytes",
        "subscription_status",
        "subscription_exempt",
        "square_customer_id",
        "square_email",
        "subscription_charged_through_date",
        "subscription_updated_at",
    ]

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=csv_columns)
    writer.writeheader()

    for user in users:
        uid = int(user["id"])
        friend = friend_map.get(uid)
        incoming = incoming_map.get(uid)
        outgoing = outgoing_map.get(uid)
        owned = groups_owned_map.get(uid)
        member = groups_member_map.get(uid)
        dm_sent = direct_sent_map.get(uid)
        dm_recv = direct_received_map.get(uid)
        grp_sent = group_sent_map.get(uid)
        grp_visible = group_visible_map.get(uid)

        public_key_chars = int(user["public_key_chars"] or 0)
        avatar_chars = int(user["avatar_chars"] or 0)
        writer.writerow(
            {
                "user_id": uid,
                "username": user["username"],
                "is_admin": 1 if bool(user["is_admin"]) else 0,
                "display_name": user["display_name"] or "",
                "created_at": _ts_to_date(user["created_at"]),
                "has_public_key": 1 if public_key_chars > 0 else 0,
                "public_key_chars": public_key_chars,
                "has_avatar": 1 if avatar_chars > 0 else 0,
                "avatar_chars": avatar_chars,
                "notification_sound_enabled": 1 if bool(user["notification_sound_enabled"]) else 0,
                "has_key_backup": 1 if user["key_backup_updated_at"] else 0,
                "key_backup_updated_at": _ts_to_date(user["key_backup_updated_at"]),
                "friend_count": int(friend["friend_count"]) if friend else 0,
                "friend_usernames": _clip(friend["friend_usernames"] if friend else ""),
                "incoming_request_count": int(incoming["incoming_request_count"]) if incoming else 0,
                "outgoing_request_count": int(outgoing["outgoing_request_count"]) if outgoing else 0,
                "groups_owned_count": int(owned["groups_owned_count"]) if owned else 0,
                "groups_owned_names": _clip(owned["groups_owned_names"] if owned else ""),
                "groups_member_count": int(member["groups_member_count"]) if member else 0,
                "groups_member_names": _clip(member["groups_member_names"] if member else ""),
                "direct_sent_count": int(dm_sent["direct_sent_count"]) if dm_sent else 0,
                "direct_received_count": int(dm_recv["direct_received_count"]) if dm_recv else 0,
                "group_sent_count": int(grp_sent["group_sent_count"]) if grp_sent else 0,
                "group_visible_count": int(grp_visible["group_visible_count"]) if grp_visible else 0,
                "direct_sent_payload_bytes": int(dm_sent["direct_sent_payload_bytes"]) if dm_sent else 0,
                "group_sent_payload_bytes": int(grp_sent["group_sent_payload_bytes"]) if grp_sent else 0,
                "subscription_status": str(user["subscription_status"] or "NONE").strip().upper(),
                "subscription_exempt": "Yes" if bool(user["subscription_exempt"]) else "No",
                "square_customer_id": str(user["square_customer_id"] or "").strip(),
                "square_email": square_email_map.get(str(user["square_customer_id"] or "").strip(), ""),
                "subscription_charged_through_date": str(user["subscription_charged_through_date"] or "").strip(),
                "subscription_updated_at": _ts_to_date(user["subscription_updated_at"]),
            }
        )

    filename = f"blackenvelope-users-summary-{int(time.time())}.csv"
    csv_content = "\ufeff" + buffer.getvalue()
    return Response(
        content=csv_content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/me/public-key")
async def upsert_public_key(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    public_key = str(payload.get("public_key", "")).strip()
    if not public_key or len(public_key) > 5000:
        raise HTTPException(status_code=400, detail="Invalid public_key.")

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id, require_active_subscription=False)
        conn.execute("UPDATE users SET public_key = ? WHERE id = ?", (public_key, claims.user_id))
        conn.commit()
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.get("/api/me/public-key")
async def get_my_public_key(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        row = _user_by_id(conn, claims.user_id, require_active_subscription=False)
        return JSONResponse({"public_key": row["public_key"]})
    finally:
        conn.close()


@app.post("/api/me/key-backup")
async def upsert_my_key_backup(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    backup_ciphertext = str(payload.get("backup_ciphertext", "")).strip()
    if not backup_ciphertext:
        raise HTTPException(status_code=400, detail="Missing backup_ciphertext.")
    if len(backup_ciphertext) > 300000:
        raise HTTPException(status_code=400, detail="backup_ciphertext is too large.")

    now = int(time.time())
    conn = _db()
    try:
        _user_by_id(conn, claims.user_id, require_active_subscription=False)
        conn.execute(
            """
            INSERT INTO encrypted_key_backups (user_id, backup_ciphertext, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                backup_ciphertext = excluded.backup_ciphertext,
                updated_at = excluded.updated_at
            """,
            (claims.user_id, backup_ciphertext, now, now),
        )
        conn.commit()
        return JSONResponse({"ok": True, "updated_at": now})
    finally:
        conn.close()


@app.get("/api/me/key-backup")
async def get_my_key_backup(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id, require_active_subscription=False)
        row = conn.execute(
            """
            SELECT backup_ciphertext, created_at, updated_at
            FROM encrypted_key_backups
            WHERE user_id = ?
            """,
            (claims.user_id,),
        ).fetchone()
        if row is None:
            return JSONResponse({"has_backup": False, "backup_ciphertext": "", "created_at": None, "updated_at": None})
        return JSONResponse(
            {
                "has_backup": True,
                "backup_ciphertext": row["backup_ciphertext"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
    finally:
        conn.close()


@app.delete("/api/me/key-backup")
async def delete_my_key_backup(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id, require_active_subscription=False)
        conn.execute("DELETE FROM encrypted_key_backups WHERE user_id = ?", (claims.user_id,))
        conn.commit()
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.put("/api/me/email")
async def update_my_email(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    email = _validate_email(str(payload.get("email", "")))

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id, require_active_subscription=False)
        existing = conn.execute(
            "SELECT id FROM users WHERE email = ? AND id != ? AND email != '' LIMIT 1",
            (email, claims.user_id),
        ).fetchone()
        if existing is not None:
            raise HTTPException(status_code=409, detail="Email already registered.")

        conn.execute("UPDATE users SET email = ? WHERE id = ?", (email, claims.user_id))
        conn.commit()
        return JSONResponse({"ok": True, "email": email})
    finally:
        conn.close()


@app.put("/api/me/profile")
async def update_profile(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        user = _user_by_id(conn, claims.user_id)
        updates: list[str] = []
        params: list[Any] = []

        if "display_name" in payload:
            display_name = str(payload["display_name"]).strip()
            if len(display_name) > 32:
                raise HTTPException(status_code=400, detail="Display name must be 32 characters or fewer.")
            updates.append("display_name = ?")
            params.append(display_name)

        if "avatar_b64" in payload:
            avatar_b64 = str(payload["avatar_b64"]).strip()
            if avatar_b64:
                # Rough size check: base64 string length * 0.75 ≈ decoded bytes
                estimated_bytes = len(avatar_b64) * 3 // 4
                if estimated_bytes > AVATAR_MAX_BYTES:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Avatar image must be under {AVATAR_MAX_BYTES // 1024}KB.",
                    )
            updates.append("avatar_b64 = ?")
            params.append(avatar_b64)

        if "bio" in payload:
            bio = str(payload["bio"]).strip()
            if len(bio) > 500:
                raise HTTPException(status_code=400, detail="Bio must be 500 characters or fewer.")
            updates.append("bio = ?")
            params.append(bio)

        if "location" in payload:
            location = str(payload["location"]).strip()
            if len(location) > 100:
                raise HTTPException(status_code=400, detail="Location must be 100 characters or fewer.")
            updates.append("location = ?")
            params.append(location)

        if "link" in payload:
            link = str(payload["link"]).strip()
            if len(link) > 200:
                raise HTTPException(status_code=400, detail="Link must be 200 characters or fewer.")
            updates.append("link = ?")
            params.append(link)

        if "status" in payload:
            status_text = str(payload["status"]).strip()
            if len(status_text) > 100:
                raise HTTPException(status_code=400, detail="Status must be 100 characters or fewer.")
            updates.append("status = ?")
            params.append(status_text)

        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update.")

        params.append(claims.user_id)
        conn.execute(
            f"UPDATE users SET {', '.join(updates)} WHERE id = ?",
            params,
        )
        conn.commit()

        updated = _user_by_id(conn, claims.user_id)
        return JSONResponse({
            "ok": True,
            "display_name": updated["display_name"],
            "avatar_b64": updated["avatar_b64"],
            "bio": updated["bio"],
            "location": updated["location"],
            "link": updated["link"],
            "status": updated["status"],
        })
    finally:
        conn.close()


@app.put("/api/me/username")
async def change_username(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    new_username = _validate_username(str(payload.get("new_username", "")))
    current_password = str(payload.get("current_password", ""))
    if not current_password:
        raise HTTPException(status_code=400, detail="Current password is required.")

    conn = _db()
    try:
        user = _user_by_id(conn, claims.user_id)

        # Verify current password
        salt = _b64d(user["password_salt"])
        digest = _hash_password(password=current_password, salt=salt)
        if not hmac.compare_digest(_b64e(digest), user["password_hash"]):
            raise HTTPException(status_code=401, detail="Incorrect password.")

        if new_username == user["username"]:
            raise HTTPException(status_code=400, detail="New username is the same as current.")

        # Check uniqueness
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ? AND id != ?",
            (new_username, claims.user_id),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Username already taken.")

        conn.execute(
            "UPDATE users SET username = ? WHERE id = ?",
            (new_username, claims.user_id),
        )
        conn.commit()

        return JSONResponse({"ok": True, "username": new_username})
    finally:
        conn.close()


@app.get("/api/me/storage")
async def get_storage(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        user = _user_by_id(conn, claims.user_id)
        user_id = user["id"]

        # Per-conversation DM storage (both sent and received count toward user's view)
        dm_rows = conn.execute(
            """
            SELECT
                CASE
                    WHEN m.sender_id = ? THEN u2.username
                    ELSE u1.username
                END AS friend_username,
                COUNT(*) AS message_count,
                SUM(LENGTH(m.payload)) AS total_bytes
            FROM messages m
            JOIN users u1 ON u1.id = m.sender_id
            JOIN users u2 ON u2.id = m.recipient_id
            WHERE m.sender_id = ? OR m.recipient_id = ?
            GROUP BY friend_username
            ORDER BY total_bytes DESC
            """,
            (user_id, user_id, user_id),
        ).fetchall()

        # Per-group storage
        group_rows = conn.execute(
            """
            SELECT
                g.id AS group_id,
                g.name AS group_name,
                COUNT(gm.id) AS message_count,
                COALESCE(SUM(LENGTH(gm.payload)), 0) AS total_bytes
            FROM group_members mem
            JOIN chat_groups g ON g.id = mem.group_id
            LEFT JOIN group_messages gm ON gm.group_id = g.id
            WHERE mem.user_id = ?
            GROUP BY g.id
            ORDER BY total_bytes DESC
            """,
            (user_id,),
        ).fetchall()

        # Total sent by user (for enforcement purposes)
        total_sent = _get_user_storage_bytes(conn, user_id)

        return JSONResponse({
            "total_bytes": total_sent,
            "limit_bytes": STORAGE_LIMIT_BYTES,
            "warn_bytes": STORAGE_WARN_BYTES,
            "conversations": [
                {
                    "username": row["friend_username"],
                    "bytes": row["total_bytes"],
                    "message_count": row["message_count"],
                }
                for row in dm_rows
            ],
            "groups": [
                {
                    "group_id": row["group_id"],
                    "name": row["group_name"],
                    "bytes": row["total_bytes"],
                    "message_count": row["message_count"],
                }
                for row in group_rows
            ],
        })
    finally:
        conn.close()


@app.get("/api/me/settings")
async def get_settings(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id)
        row = conn.execute(
            "SELECT * FROM user_settings WHERE user_id = ?",
            (claims.user_id,),
        ).fetchone()
        if row is None:
            return JSONResponse({"notification_sound_enabled": True})
        return JSONResponse({
            "notification_sound_enabled": bool(row["notification_sound_enabled"]),
        })
    finally:
        conn.close()


@app.put("/api/me/settings")
async def update_settings(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id)
        sound_enabled = 1 if payload.get("notification_sound_enabled", True) else 0
        conn.execute(
            """
            INSERT INTO user_settings (user_id, notification_sound_enabled)
            VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                notification_sound_enabled = excluded.notification_sound_enabled
            """,
            (claims.user_id, sound_enabled),
        )
        conn.commit()
        return JSONResponse({"ok": True, "notification_sound_enabled": bool(sound_enabled)})
    finally:
        conn.close()


async def _delete_user_account_and_notify(user_id: int) -> dict[str, Any]:
    friend_rows: list[sqlite3.Row] = []
    owned_group_rows: list[sqlite3.Row] = []
    member_group_rows: list[sqlite3.Row] = []

    conn = _db()
    try:
        user = _user_by_id(conn, user_id, require_active_subscription=False)
        username = str(user["username"])
        global_feed_group_id = _resolve_global_feed_group_id(conn)
        preserve_global_feed = False

        if global_feed_group_id is not None:
            global_feed = conn.execute(
                "SELECT owner_id FROM chat_groups WHERE id = ?",
                (global_feed_group_id,),
            ).fetchone()
            if global_feed is not None and int(global_feed["owner_id"]) == int(user_id):
                replacement = conn.execute(
                    """
                    SELECT gm.user_id
                    FROM group_members gm
                    JOIN users u ON u.id = gm.user_id
                    WHERE gm.group_id = ? AND gm.user_id != ?
                    ORDER BY CASE WHEN u.is_admin = 1 THEN 0 ELSE 1 END, gm.user_id ASC
                    LIMIT 1
                    """,
                    (global_feed_group_id, user_id),
                ).fetchone()
                if replacement is not None:
                    replacement_id = int(replacement["user_id"])
                    conn.execute(
                        "UPDATE chat_groups SET owner_id = ? WHERE id = ?",
                        (replacement_id, global_feed_group_id),
                    )
                    conn.execute(
                        "UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?",
                        (global_feed_group_id, replacement_id),
                    )
                    preserve_global_feed = True

        friend_rows = conn.execute(
            """
            SELECT u.id, u.username
            FROM friendships f
            JOIN users u ON u.id = f.friend_id
            WHERE f.user_id = ?
            """,
            (user_id,),
        ).fetchall()

        if preserve_global_feed and global_feed_group_id is not None:
            owned_group_rows = conn.execute(
                """
                SELECT g.id AS group_id, g.name AS group_name, gm.user_id AS member_user_id
                FROM chat_groups g
                JOIN group_members gm ON gm.group_id = g.id
                WHERE g.owner_id = ? AND g.id != ? AND gm.user_id != ?
                """,
                (user_id, global_feed_group_id, user_id),
            ).fetchall()
        else:
            owned_group_rows = conn.execute(
                """
                SELECT g.id AS group_id, g.name AS group_name, gm.user_id AS member_user_id
                FROM chat_groups g
                JOIN group_members gm ON gm.group_id = g.id
                WHERE g.owner_id = ? AND gm.user_id != ?
                """,
                (user_id, user_id),
            ).fetchall()

        member_group_rows = conn.execute(
            """
            SELECT g.id AS group_id, g.name AS group_name, gm2.user_id AS member_user_id
            FROM group_members gm
            JOIN chat_groups g ON g.id = gm.group_id
            JOIN group_members gm2 ON gm2.group_id = g.id
            WHERE gm.user_id = ?
              AND g.owner_id != ?
              AND gm2.user_id != ?
            """,
            (user_id, user_id, user_id),
        ).fetchall()

        conn.execute("DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?", (user_id, user_id))
        conn.execute("DELETE FROM group_messages WHERE sender_id = ?", (user_id,))
        conn.execute(
            """
            UPDATE group_topics
            SET created_by = (
                SELECT g.owner_id
                FROM chat_groups g
                WHERE g.id = group_topics.group_id
            )
            WHERE created_by = ?
              AND group_id IN (SELECT id FROM chat_groups WHERE owner_id != ?)
            """,
            (user_id, user_id),
        )
        if preserve_global_feed and global_feed_group_id is not None:
            conn.execute(
                "DELETE FROM chat_groups WHERE owner_id = ? AND id != ?",
                (user_id, global_feed_group_id),
            )
        else:
            conn.execute("DELETE FROM chat_groups WHERE owner_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()

    notified_friends: set[int] = set()
    for row in friend_rows:
        friend_id = int(row["id"])
        if friend_id in notified_friends:
            continue
        notified_friends.add(friend_id)
        await _notify_user(
            friend_id,
            {
                "type": "friend_removed",
                "friend": {"username": username},
            },
        )

    owned_groups: dict[int, dict[str, Any]] = {}
    for row in owned_group_rows:
        gid = int(row["group_id"])
        entry = owned_groups.setdefault(gid, {"name": row["group_name"], "members": set()})
        entry["members"].add(int(row["member_user_id"]))
    for gid, group in owned_groups.items():
        for member_id in group["members"]:
            await _notify_user(
                member_id,
                {
                    "type": "group_deleted",
                    "group": {"id": gid, "name": group["name"]},
                },
            )

    member_groups: dict[int, dict[str, Any]] = {}
    for row in member_group_rows:
        gid = int(row["group_id"])
        entry = member_groups.setdefault(gid, {"name": row["group_name"], "members": set()})
        entry["members"].add(int(row["member_user_id"]))
    for gid, group in member_groups.items():
        for member_id in group["members"]:
            await _notify_user(
                member_id,
                {
                    "type": "group_member_removed",
                    "group": {"id": gid, "name": group["name"]},
                    "member": {"username": username},
                },
            )

    sockets = list(active_sockets.get(user_id, set()))
    for ws in sockets:
        try:
            await ws.close(code=1008, reason="account_deleted")
        except Exception:
            pass
    active_sockets.pop(user_id, None)
    return {"id": user_id, "username": username}


@app.post("/api/me/delete-account")
async def delete_my_account(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    current_password = str(payload.get("current_password", ""))
    if not current_password:
        raise HTTPException(status_code=400, detail="Current password is required.")
    confirm_text = str(payload.get("confirm_text", "")).strip().upper()
    if confirm_text != "DELETE":
        raise HTTPException(status_code=400, detail='Type "DELETE" to confirm account deletion.')

    conn = _db()
    try:
        user = _user_by_id(conn, claims.user_id)
        salt = _b64d(user["password_salt"])
        digest = _hash_password(password=current_password, salt=salt)
        if not hmac.compare_digest(_b64e(digest), user["password_hash"]):
            raise HTTPException(status_code=401, detail="Incorrect password.")
    finally:
        conn.close()

    await _delete_user_account_and_notify(claims.user_id)
    return JSONResponse({"ok": True})


@app.delete("/api/admin/users/{username}")
async def admin_delete_user(
    username: str,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    target_username = _normalize_invite_username(username)

    conn = _db()
    try:
        admin_user = _require_site_admin(conn, claims.user_id)
        target = conn.execute(
            "SELECT id, username, is_admin FROM users WHERE username = ?",
            (target_username,),
        ).fetchone()
        if target is None:
            raise HTTPException(status_code=404, detail="User not found.")
        if int(target["id"]) == int(admin_user["id"]):
            raise HTTPException(status_code=400, detail="Use Delete Account for your own account.")
        if bool(target["is_admin"]):
            raise HTTPException(status_code=400, detail="Cannot remove another admin account.")
        target_id = int(target["id"])
    finally:
        conn.close()

    deleted = await _delete_user_account_and_notify(target_id)
    return JSONResponse(
        {
            "ok": True,
            "deleted_user": {"id": deleted["id"], "username": deleted["username"]},
        }
    )


@app.patch("/api/admin/users/{username}/exempt")
async def admin_set_user_exempt(
    username: str,
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    target_username = _normalize_invite_username(username)
    exempt = bool(payload.get("subscription_exempt", False))

    conn = _db()
    try:
        _require_site_admin(conn, claims.user_id)
        target = conn.execute(
            "SELECT id, username FROM users WHERE username = ?",
            (target_username,),
        ).fetchone()
        if target is None:
            raise HTTPException(status_code=404, detail="User not found.")
        conn.execute(
            "UPDATE users SET subscription_exempt = ? WHERE id = ?",
            (1 if exempt else 0, int(target["id"])),
        )
        conn.commit()
        return JSONResponse(
            {
                "ok": True,
                "username": target["username"],
                "subscription_exempt": exempt,
            }
        )
    finally:
        conn.close()


@app.get("/api/friends")
async def list_friends(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        rows = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.public_key,
                u.display_name,
                u.avatar_b64,
                f.created_at AS friendship_created_at,
                COALESCE(
                    (SELECT MAX(m.created_at) FROM messages m
                     WHERE (m.sender_id = ? AND m.recipient_id = u.id)
                        OR (m.sender_id = u.id AND m.recipient_id = ?)),
                    0
                ) AS last_message_at
            FROM friendships f
            JOIN users u ON u.id = f.friend_id
            WHERE f.user_id = ?
            ORDER BY u.username ASC
            """,
            (me_row["id"], me_row["id"], me_row["id"]),
        ).fetchall()
        return JSONResponse(
            {
                "friends": [
                    {
                        "id": row["id"],
                        "username": row["username"],
                        "public_key": row["public_key"],
                        "display_name": row["display_name"],
                        "avatar_b64": row["avatar_b64"],
                        "friendship_created_at": row["friendship_created_at"],
                        "last_message_at": row["last_message_at"] or 0,
                    }
                    for row in rows
                ]
            }
        )
    finally:
        conn.close()


@app.get("/api/users")
async def list_users(authorization: str | None = Header(default=None)) -> JSONResponse:
    """Backward-compatible alias that now returns only friend list."""
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        rows = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.public_key,
                f.created_at AS friendship_created_at
            FROM friendships f
            JOIN users u ON u.id = f.friend_id
            WHERE f.user_id = ?
            ORDER BY u.username ASC
            """,
            (me_row["id"],),
        ).fetchall()
        return JSONResponse(
            {
                "users": [
                    {
                        "id": row["id"],
                        "username": row["username"],
                        "public_key": row["public_key"],
                        "friendship_created_at": row["friendship_created_at"],
                    }
                    for row in rows
                ]
            }
        )
    finally:
        conn.close()


@app.get("/api/friend-requests/pending")
async def list_pending_friend_requests(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        rows = conn.execute(
            """
            SELECT
                fr.id,
                fr.requester_id,
                rq.username AS requester_username,
                fr.target_id,
                fr.status,
                fr.created_at
            FROM friend_requests fr
            JOIN users rq ON rq.id = fr.requester_id
            WHERE fr.target_id = ? AND fr.status = 'pending'
            ORDER BY fr.id DESC
            """,
            (me_row["id"],),
        ).fetchall()
        return JSONResponse(
            {
                "requests": [
                    {
                        "id": row["id"],
                        "requester_id": row["requester_id"],
                        "requester_username": row["requester_username"],
                        "target_id": row["target_id"],
                        "status": row["status"],
                        "created_at": row["created_at"],
                    }
                    for row in rows
                ]
            }
        )
    finally:
        conn.close()


@app.get("/api/friend-requests/outgoing")
async def list_outgoing_friend_requests(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        rows = conn.execute(
            """
            SELECT
                fr.id,
                fr.requester_id,
                fr.target_id,
                tg.username AS target_username,
                fr.status,
                fr.created_at
            FROM friend_requests fr
            JOIN users tg ON tg.id = fr.target_id
            WHERE fr.requester_id = ? AND fr.status = 'pending'
            ORDER BY fr.id DESC
            """,
            (me_row["id"],),
        ).fetchall()
        return JSONResponse(
            {
                "requests": [
                    {
                        "id": row["id"],
                        "requester_id": row["requester_id"],
                        "target_id": row["target_id"],
                        "target_username": row["target_username"],
                        "status": row["status"],
                        "created_at": row["created_at"],
                    }
                    for row in rows
                ]
            }
        )
    finally:
        conn.close()


@app.post("/api/friend-requests")
async def create_friend_request(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    username = _normalize_invite_username(str(payload.get("username", "")))
    created_at = int(time.time())

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        target = conn.execute(
            "SELECT id, username, public_key FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if target is None:
            raise HTTPException(status_code=404, detail="User not found.")
        if target["id"] == me_row["id"]:
            raise HTTPException(status_code=400, detail="You cannot add yourself.")
        if not target["public_key"]:
            raise HTTPException(status_code=400, detail="User has no public key yet.")
        if _are_friends(conn, me_row["id"], target["id"]):
            raise HTTPException(status_code=409, detail="Already friends.")

        reverse_pending = conn.execute(
            """
            SELECT id
            FROM friend_requests
            WHERE requester_id = ? AND target_id = ? AND status = 'pending'
            ORDER BY id DESC
            LIMIT 1
            """,
            (target["id"], me_row["id"]),
        ).fetchone()
        if reverse_pending is not None:
            responded_at = int(time.time())
            conn.execute(
                """
                UPDATE friend_requests
                SET status = 'accepted', responded_at = ?
                WHERE id = ?
                """,
                (responded_at, reverse_pending["id"]),
            )
            conn.execute(
                "INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)",
                (me_row["id"], target["id"], responded_at),
            )
            conn.execute(
                "INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)",
                (target["id"], me_row["id"], responded_at),
            )
            conn.commit()
            await _notify_user(
                target["id"],
                {
                    "type": "friend_request_resolved",
                    "request": {
                        "id": reverse_pending["id"],
                        "status": "accepted",
                        "by_username": me_row["username"],
                        "responded_at": responded_at,
                    },
                },
            )
            return JSONResponse({"ok": True, "auto_accepted": True})

        existing_pending = conn.execute(
            """
            SELECT id
            FROM friend_requests
            WHERE requester_id = ? AND target_id = ? AND status = 'pending'
            ORDER BY id DESC
            LIMIT 1
            """,
            (me_row["id"], target["id"]),
        ).fetchone()
        if existing_pending is not None:
            raise HTTPException(status_code=409, detail="Friend request already pending.")

        cur = conn.execute(
            """
            INSERT INTO friend_requests (requester_id, target_id, status, created_at)
            VALUES (?, ?, 'pending', ?)
            """,
            (me_row["id"], target["id"], created_at),
        )
        conn.commit()
        request_id = int(cur.lastrowid)
        await _notify_user(
            target["id"],
            {
                "type": "friend_request",
                "request": {
                    "id": request_id,
                    "requester_id": me_row["id"],
                    "requester_username": me_row["username"],
                    "created_at": created_at,
                },
            },
        )
        return JSONResponse(
            {
                "ok": True,
                "request": {
                    "id": request_id,
                    "requester_id": me_row["id"],
                    "requester_username": me_row["username"],
                    "target_id": target["id"],
                    "target_username": target["username"],
                    "status": "pending",
                    "created_at": created_at,
                },
            }
        )
    finally:
        conn.close()


@app.post("/api/friend-requests/{request_id}/accept")
async def accept_friend_request(
    request_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    responded_at = int(time.time())

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        row = conn.execute(
            """
            SELECT id, requester_id, target_id, status
            FROM friend_requests
            WHERE id = ?
            """,
            (request_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Friend request not found.")
        if row["target_id"] != me_row["id"]:
            raise HTTPException(status_code=403, detail="This request is not for you.")
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail="Request already handled.")

        conn.execute(
            """
            UPDATE friend_requests
            SET status = 'accepted', responded_at = ?
            WHERE id = ?
            """,
            (responded_at, request_id),
        )
        conn.execute(
            "INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)",
            (row["requester_id"], row["target_id"], responded_at),
        )
        conn.execute(
            "INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)",
            (row["target_id"], row["requester_id"], responded_at),
        )
        conn.commit()

        await _notify_user(
            row["requester_id"],
            {
                "type": "friend_request_resolved",
                "request": {
                    "id": request_id,
                    "status": "accepted",
                    "by_username": me_row["username"],
                    "responded_at": responded_at,
                },
            },
        )
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.post("/api/friend-requests/{request_id}/decline")
async def decline_friend_request(
    request_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    responded_at = int(time.time())

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        row = conn.execute(
            """
            SELECT id, requester_id, target_id, status
            FROM friend_requests
            WHERE id = ?
            """,
            (request_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Friend request not found.")
        if row["target_id"] != me_row["id"]:
            raise HTTPException(status_code=403, detail="This request is not for you.")
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail="Request already handled.")

        conn.execute(
            """
            UPDATE friend_requests
            SET status = 'declined', responded_at = ?
            WHERE id = ?
            """,
            (responded_at, request_id),
        )
        conn.commit()
        await _notify_user(
            row["requester_id"],
            {
                "type": "friend_request_resolved",
                "request": {
                    "id": request_id,
                    "status": "declined",
                    "by_username": me_row["username"],
                    "responded_at": responded_at,
                },
            },
        )
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.delete("/api/friends/{username}")
async def remove_friend(
    username: str,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    friend_username = _normalize_invite_username(username)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        target = conn.execute(
            "SELECT id, username FROM users WHERE username = ?",
            (friend_username,),
        ).fetchone()
        if target is None:
            raise HTTPException(status_code=404, detail="User not found.")
        if not _are_friends(conn, me_row["id"], target["id"]):
            raise HTTPException(status_code=404, detail="Friend relationship not found.")

        conn.execute(
            "DELETE FROM friendships WHERE user_id = ? AND friend_id = ?",
            (me_row["id"], target["id"]),
        )
        conn.execute(
            "DELETE FROM friendships WHERE user_id = ? AND friend_id = ?",
            (target["id"], me_row["id"]),
        )
        conn.commit()
        await _notify_user(
            target["id"],
            {
                "type": "friend_removed",
                "friend": {"username": me_row["username"]},
            },
        )
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.get("/api/users/search")
async def search_users(
    q: str = "",
    limit: int = 10,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    query = q.strip().lower()
    safe_limit = max(1, min(limit, 25))

    if not query:
        return JSONResponse({"users": []})

    # Escape wildcard characters for LIKE matching.
    escaped = (
        query.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )
    prefix_pattern = escaped + "%"
    contains_pattern = "%" + escaped + "%"

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        rows = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                CASE WHEN f.user_id IS NULL THEN 0 ELSE 1 END AS is_friend
            FROM users u
            LEFT JOIN friendships f
              ON f.user_id = ? AND f.friend_id = u.id
            WHERE u.id != ?
              AND u.public_key != ''
              AND u.username LIKE ? ESCAPE '\\'
            ORDER BY
              is_friend DESC,
              CASE
                WHEN u.username = ? THEN 0
                WHEN u.username LIKE ? ESCAPE '\\' THEN 1
                ELSE 2
              END ASC,
              LENGTH(u.username) ASC,
              u.username ASC
            LIMIT ?
            """,
            (
                me_row["id"],
                me_row["id"],
                contains_pattern,
                query,
                prefix_pattern,
                safe_limit,
            ),
        ).fetchall()
        return JSONResponse(
            {
                "users": [
                    {
                        "id": row["id"],
                        "username": row["username"],
                        "is_friend": bool(row["is_friend"]),
                    }
                    for row in rows
                ]
            }
        )
    finally:
        conn.close()


@app.get("/api/users/{username}")
async def get_user(username: str, authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    search_name = _validate_username(username)

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id)
        row = conn.execute(
            "SELECT id, username, public_key FROM users WHERE username = ?",
            (search_name,),
        ).fetchone()
        if row is None or not row["public_key"]:
            raise HTTPException(status_code=404, detail="User with public key not found.")
        return JSONResponse(
            {
                "id": row["id"],
                "username": row["username"],
                "public_key": row["public_key"],
            }
        )
    finally:
        conn.close()


@app.get("/api/users/{username}/profile")
async def get_user_profile(
    username: str,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    search_name = _validate_username(username)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        row = conn.execute(
            "SELECT id, username, display_name, avatar_b64, bio, location, link, status, created_at FROM users WHERE username = ?",
            (search_name,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found.")

        is_friend = conn.execute(
            "SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?",
            (me_row["id"], row["id"]),
        ).fetchone() is not None

        has_pending_request = conn.execute(
            "SELECT 1 FROM friend_requests WHERE requester_id = ? AND target_id = ? AND status = 'pending'",
            (me_row["id"], row["id"]),
        ).fetchone() is not None

        return JSONResponse({
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "avatar_b64": row["avatar_b64"],
            "bio": row["bio"],
            "location": row["location"],
            "link": row["link"],
            "status": row["status"],
            "created_at": row["created_at"],
            "is_friend": is_friend,
            "has_pending_request": has_pending_request,
        })
    finally:
        conn.close()


@app.post("/api/messages/send")
async def send_message(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    recipient_username = _validate_username(str(payload.get("recipient_username", "")))
    encrypted_payload = payload.get("payload")

    if not isinstance(encrypted_payload, dict):
        raise HTTPException(status_code=400, detail="payload must be an object.")

    if "v" not in encrypted_payload or "alg" not in encrypted_payload:
        raise HTTPException(status_code=400, detail="payload missing required fields.")

    has_direct = all(field in encrypted_payload for field in ("salt", "iv", "ct", "epk"))
    to_recipient = encrypted_payload.get("to_recipient")
    to_sender = encrypted_payload.get("to_sender")
    has_dual = isinstance(to_recipient, dict) and isinstance(to_sender, dict)
    if not has_direct and not has_dual:
        raise HTTPException(status_code=400, detail="payload format is invalid.")

    if len(json.dumps(encrypted_payload)) > DIRECT_PAYLOAD_MAX_BYTES:
        raise HTTPException(status_code=400, detail="payload is too large.")

    conn = _db()
    try:
        sender = _user_by_id(conn, claims.user_id)
        if not sender["public_key"]:
            raise HTTPException(status_code=400, detail="Sender public key is not registered.")

        recipient = conn.execute(
            "SELECT id, username, public_key FROM users WHERE username = ?",
            (recipient_username,),
        ).fetchone()
        if recipient is None:
            raise HTTPException(status_code=404, detail="Recipient not found.")
        if not recipient["public_key"]:
            raise HTTPException(status_code=400, detail="Recipient does not have a public key.")
        _require_friendship(conn, sender["id"], recipient["id"])

        created_at = int(time.time())
        payload_str = json.dumps(encrypted_payload, separators=(",", ":"), sort_keys=True)
        cur = conn.execute(
            """
            INSERT INTO messages (sender_id, recipient_id, payload, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (sender["id"], recipient["id"], payload_str, created_at),
        )
        conn.commit()
        message_id = cur.lastrowid

        storage_warning = _enforce_storage_limit(conn, sender["id"])

        await _notify_user(
            recipient["id"],
            {
                "type": "new_message",
                "message": {
                    "id": message_id,
                    "sender_id": sender["id"],
                    "sender_username": sender["username"],
                    "recipient_id": recipient["id"],
                    "recipient_username": recipient["username"],
                    "payload": encrypted_payload,
                    "created_at": created_at,
                },
            },
        )
        headers = {}
        if storage_warning:
            headers["X-Storage-Warning"] = "approaching-limit"
        return JSONResponse(
            {"ok": True, "id": message_id, "created_at": created_at},
            headers=headers,
        )
    finally:
        conn.close()


@app.get("/api/messages/with/{username}")
async def list_messages_with(
    username: str,
    limit: int = 100,
    before_id: int | None = None,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    other_username = _validate_username(username)
    safe_limit = max(1, min(limit, 500))
    safe_before_id: int | None = None
    if before_id is not None:
        safe_before_id = int(before_id)
        if safe_before_id < 1:
            raise HTTPException(status_code=400, detail="before_id must be a positive integer.")

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        other_row = conn.execute(
            "SELECT id, username FROM users WHERE username = ?",
            (other_username,),
        ).fetchone()
        if other_row is None:
            raise HTTPException(status_code=404, detail="User not found.")
        _require_friendship(conn, me_row["id"], other_row["id"])

        if safe_before_id is None:
            rows = conn.execute(
                """
                SELECT
                    m.id,
                    m.sender_id,
                    s.username AS sender_username,
                    m.recipient_id,
                    r.username AS recipient_username,
                    m.payload,
                    m.created_at
                FROM messages m
                JOIN users s ON s.id = m.sender_id
                JOIN users r ON r.id = m.recipient_id
                WHERE (m.sender_id = ? AND m.recipient_id = ?)
                   OR (m.sender_id = ? AND m.recipient_id = ?)
                ORDER BY m.id DESC
                LIMIT ?
                """,
                (me_row["id"], other_row["id"], other_row["id"], me_row["id"], safe_limit + 1),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT
                    m.id,
                    m.sender_id,
                    s.username AS sender_username,
                    m.recipient_id,
                    r.username AS recipient_username,
                    m.payload,
                    m.created_at
                FROM messages m
                JOIN users s ON s.id = m.sender_id
                JOIN users r ON r.id = m.recipient_id
                WHERE (
                    (m.sender_id = ? AND m.recipient_id = ?)
                    OR (m.sender_id = ? AND m.recipient_id = ?)
                )
                  AND m.id < ?
                ORDER BY m.id DESC
                LIMIT ?
                """,
                (
                    me_row["id"],
                    other_row["id"],
                    other_row["id"],
                    me_row["id"],
                    safe_before_id,
                    safe_limit + 1,
                ),
            ).fetchall()

        has_more = len(rows) > safe_limit
        if has_more:
            rows = rows[:safe_limit]
        messages = [_serialize_message_row(row, self_user_id=me_row["id"]) for row in rows]
        messages.reverse()
        msg_ids = [m["id"] for m in messages if m.get("id")]
        likes_map = _get_likes_for_messages(conn, "direct", msg_ids)
        for m in messages:
            m["likes"] = likes_map.get(m["id"], [])
            m["like_count"] = len(m["likes"])
        next_before_id = int(messages[0]["id"]) if has_more and messages else None
        return JSONResponse(
            {
                "messages": messages,
                "pagination": {
                    "has_more": has_more,
                    "next_before_id": next_before_id,
                },
            }
        )
    finally:
        conn.close()


@app.delete("/api/messages/{message_id}")
async def delete_direct_message(
    message_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        msg = conn.execute(
            """
            SELECT
                m.id,
                m.sender_id,
                s.username AS sender_username,
                m.recipient_id,
                r.username AS recipient_username
            FROM messages m
            JOIN users s ON s.id = m.sender_id
            JOIN users r ON r.id = m.recipient_id
            WHERE m.id = ?
            """,
            (message_id,),
        ).fetchone()
        if msg is None:
            raise HTTPException(status_code=404, detail="Message not found.")

        is_sender = int(msg["sender_id"]) == int(me_row["id"])
        is_site_admin = bool(me_row["is_admin"])
        if not (is_sender or is_site_admin):
            raise HTTPException(
                status_code=403,
                detail="Only message sender or site admin can delete.",
            )

        conn.execute(
            "DELETE FROM message_likes WHERE message_type='direct' AND message_id=?",
            (message_id,),
        )
        conn.execute(
            "DELETE FROM messages WHERE id = ?",
            (message_id,),
        )
        conn.commit()

        event = {
            "type": "direct_message_deleted",
            "message_id": int(msg["id"]),
            "sender_username": msg["sender_username"],
            "recipient_username": msg["recipient_username"],
        }
        await _notify_user(int(msg["sender_id"]), event)
        await _notify_user(int(msg["recipient_id"]), event)
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.post("/api/messages/{message_id}/like")
async def toggle_direct_message_like(
    message_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    conn = _db()
    try:
        me = _user_by_id(conn, claims.user_id)
        msg = conn.execute(
            "SELECT id, sender_id, recipient_id FROM messages WHERE id = ?",
            (message_id,),
        ).fetchone()
        if msg is None:
            raise HTTPException(status_code=404, detail="Message not found.")
        if me["id"] not in (msg["sender_id"], msg["recipient_id"]):
            raise HTTPException(status_code=403, detail="Access denied.")

        existing = conn.execute(
            "SELECT id FROM message_likes WHERE message_type='direct' AND message_id=? AND user_id=?",
            (message_id, me["id"]),
        ).fetchone()

        if existing:
            conn.execute("DELETE FROM message_likes WHERE id=?", (existing["id"],))
        else:
            conn.execute(
                "INSERT INTO message_likes (message_type, message_id, user_id, created_at) VALUES ('direct', ?, ?, ?)",
                (message_id, me["id"], int(time.time())),
            )
            # Notify the message author about the like
            author_id = int(msg["sender_id"])
            if author_id != me["id"]:
                other_username = conn.execute(
                    "SELECT username FROM users WHERE id = ?",
                    (msg["recipient_id"] if author_id == msg["sender_id"] else msg["sender_id"],),
                ).fetchone()
                await _create_notification(
                    conn, author_id, "like",
                    source_user_id=me["id"],
                    message_id=message_id,
                    message_type="direct",
                    friend_username=other_username["username"] if other_username else None,
                )
        conn.commit()

        likes = _get_likes_for_messages(conn, "direct", [message_id]).get(message_id, [])
        event = {
            "type": "message_like_updated",
            "message_type": "direct",
            "message_id": message_id,
            "likes": likes,
            "like_count": len(likes),
        }
        await _notify_user(int(msg["sender_id"]), event)
        await _notify_user(int(msg["recipient_id"]), event)
        return JSONResponse({"ok": True, "likes": likes, "like_count": len(likes)})
    finally:
        conn.close()


@app.post("/api/groups")
async def create_group(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    group_name = _validate_group_name(str(payload.get("name", "")))
    created_at = int(time.time())

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        cur = conn.execute(
            """
            INSERT INTO chat_groups (name, owner_id, created_at)
            VALUES (?, ?, ?)
            """,
            (group_name, me_row["id"], created_at),
        )
        group_id = int(cur.lastrowid)
        conn.execute(
            """
            INSERT INTO group_members (group_id, user_id, role, joined_at)
            VALUES (?, ?, 'owner', ?)
            """,
            (group_id, me_row["id"], created_at),
        )
        topic_cur = conn.execute(
            """
            INSERT INTO group_topics (group_id, title, created_by, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (group_id, "General", me_row["id"], created_at),
        )
        conn.commit()
        return JSONResponse(
            {
                "ok": True,
                "group": {
                    "id": group_id,
                    "name": group_name,
                    "owner_id": me_row["id"],
                    "role": "owner",
                    "created_at": created_at,
                },
                "default_topic": {
                    "id": int(topic_cur.lastrowid),
                    "group_id": group_id,
                    "title": "General",
                    "created_by": me_row["id"],
                    "created_at": created_at,
                },
            }
        )
    finally:
        conn.close()


@app.get("/api/groups")
async def list_groups(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        _ensure_user_in_global_feed(conn, int(me_row["id"]))
        conn.commit()
        global_feed_id = _resolve_global_feed_group_id(conn)
        rows = conn.execute(
            """
            SELECT
                g.id,
                g.name,
                g.owner_id,
                g.created_at,
                gm.role,
                (
                    SELECT COUNT(*)
                    FROM group_members x
                    WHERE x.group_id = g.id
                ) AS member_count,
                (
                    SELECT COUNT(*)
                    FROM group_topics t
                    WHERE t.group_id = g.id
                ) AS topic_count,
                COALESCE(
                    (SELECT MAX(gm2.created_at) FROM group_messages gm2
                     WHERE gm2.group_id = g.id),
                    0
                ) AS last_message_at
            FROM group_members gm
            JOIN chat_groups g ON g.id = gm.group_id
            WHERE gm.user_id = ?
            ORDER BY g.id DESC
            """,
            (claims.user_id,),
        ).fetchall()
        return JSONResponse(
            {
                "groups": [
                    {
                        "id": row["id"],
                        "name": row["name"],
                        "owner_id": row["owner_id"],
                        "role": row["role"],
                        "is_global_feed": bool(global_feed_id is not None and int(row["id"]) == int(global_feed_id)),
                        "can_manage_members": (
                            False
                            if (global_feed_id is not None and int(row["id"]) == int(global_feed_id))
                            else _is_group_admin(row["role"])
                        ),
                        "member_count": row["member_count"],
                        "topic_count": row["topic_count"],
                        "created_at": row["created_at"],
                        "last_message_at": row["last_message_at"] or 0,
                    }
                    for row in rows
                ]
            }
        )
    finally:
        conn.close()


@app.get("/api/group-invites/pending")
async def list_pending_group_invites(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id)
        rows = conn.execute(
            """
            SELECT
                gi.id,
                gi.group_id,
                g.name AS group_name,
                gi.invited_user_id,
                gi.invited_by_user_id,
                inviter.username AS invited_by_username,
                gi.status,
                gi.created_at
            FROM group_invites gi
            JOIN chat_groups g ON g.id = gi.group_id
            JOIN users inviter ON inviter.id = gi.invited_by_user_id
            WHERE gi.invited_user_id = ? AND gi.status = 'pending'
            ORDER BY gi.id DESC
            """,
            (claims.user_id,),
        ).fetchall()
        return JSONResponse(
            {
                "invites": [
                    {
                        "id": row["id"],
                        "group_id": row["group_id"],
                        "group_name": row["group_name"],
                        "invited_user_id": row["invited_user_id"],
                        "invited_by_user_id": row["invited_by_user_id"],
                        "invited_by_username": row["invited_by_username"],
                        "status": row["status"],
                        "created_at": row["created_at"],
                    }
                    for row in rows
                ]
            }
        )
    finally:
        conn.close()


@app.post("/api/groups/{group_id}/invites")
async def create_group_invite(
    group_id: int,
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    username = _normalize_invite_username(str(payload.get("username", "")))
    created_at = int(time.time())

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        membership = _require_group_member(conn, group_id, me_row["id"])
        if _is_global_feed_group(conn, group_id):
            raise HTTPException(status_code=403, detail="BlackEnvelope Feed membership is automatic.")
        # Any group member can invite new members

        target = conn.execute(
            "SELECT id, username, public_key FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if target is None:
            raise HTTPException(status_code=404, detail="User not found.")
        if target["id"] == me_row["id"]:
            raise HTTPException(status_code=400, detail="You are already in this group.")
        if not target["public_key"]:
            raise HTTPException(status_code=400, detail="User has no public key yet.")

        existing_member = conn.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
            (group_id, target["id"]),
        ).fetchone()
        if existing_member is not None:
            raise HTTPException(status_code=409, detail="User is already in this group.")

        existing_pending = conn.execute(
            """
            SELECT id
            FROM group_invites
            WHERE group_id = ? AND invited_user_id = ? AND status = 'pending'
            ORDER BY id DESC
            LIMIT 1
            """,
            (group_id, target["id"]),
        ).fetchone()
        if existing_pending is not None:
            raise HTTPException(status_code=409, detail="Pending invite already exists for this user.")

        cur = conn.execute(
            """
            INSERT INTO group_invites (
                group_id,
                invited_user_id,
                invited_by_user_id,
                status,
                created_at
            )
            VALUES (?, ?, ?, 'pending', ?)
            """,
            (group_id, target["id"], me_row["id"], created_at),
        )
        conn.commit()
        invite_id = int(cur.lastrowid)

        await _notify_user(
            target["id"],
            {
                "type": "group_invite",
                "invite": {
                    "id": invite_id,
                    "group_id": group_id,
                    "group_name": membership["group_name"],
                    "invited_by_user_id": me_row["id"],
                    "invited_by_username": me_row["username"],
                    "created_at": created_at,
                },
            },
        )
        return JSONResponse(
            {
                "ok": True,
                "invite": {
                    "id": invite_id,
                    "group_id": group_id,
                    "group_name": membership["group_name"],
                    "invited_user_id": target["id"],
                    "invited_user_username": target["username"],
                    "invited_by_user_id": me_row["id"],
                    "invited_by_username": me_row["username"],
                    "status": "pending",
                    "created_at": created_at,
                },
            }
        )
    finally:
        conn.close()


@app.post("/api/group-invites/{invite_id}/accept")
async def accept_group_invite(
    invite_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    responded_at = int(time.time())

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        invite = conn.execute(
            """
            SELECT
                gi.id,
                gi.group_id,
                gi.invited_user_id,
                gi.invited_by_user_id,
                gi.status,
                g.name AS group_name
            FROM group_invites gi
            JOIN chat_groups g ON g.id = gi.group_id
            WHERE gi.id = ?
            """,
            (invite_id,),
        ).fetchone()
        if invite is None:
            raise HTTPException(status_code=404, detail="Invite not found.")
        if invite["invited_user_id"] != me_row["id"]:
            raise HTTPException(status_code=403, detail="Invite does not belong to you.")
        if invite["status"] != "pending":
            raise HTTPException(status_code=409, detail="Invite has already been handled.")

        existing_member = conn.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
            (invite["group_id"], me_row["id"]),
        ).fetchone()
        if existing_member is None:
            conn.execute(
                """
                INSERT INTO group_members (group_id, user_id, role, joined_at)
                VALUES (?, ?, 'member', ?)
                """,
                (invite["group_id"], me_row["id"], responded_at),
            )
        conn.execute(
            """
            UPDATE group_invites
            SET status = 'accepted', responded_at = ?
            WHERE id = ?
            """,
            (responded_at, invite_id),
        )
        conn.commit()

        await _notify_user(
            invite["invited_by_user_id"],
            {
                "type": "group_invite_resolved",
                "invite": {
                    "id": invite_id,
                    "group_id": invite["group_id"],
                    "group_name": invite["group_name"],
                    "status": "accepted",
                    "by_username": me_row["username"],
                    "responded_at": responded_at,
                },
            },
        )
        return JSONResponse(
            {
                "ok": True,
                "invite": {
                    "id": invite_id,
                    "group_id": invite["group_id"],
                    "group_name": invite["group_name"],
                    "status": "accepted",
                    "responded_at": responded_at,
                },
            }
        )
    finally:
        conn.close()


@app.post("/api/group-invites/{invite_id}/decline")
async def decline_group_invite(
    invite_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    responded_at = int(time.time())

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        invite = conn.execute(
            """
            SELECT
                gi.id,
                gi.group_id,
                gi.invited_user_id,
                gi.invited_by_user_id,
                gi.status,
                g.name AS group_name
            FROM group_invites gi
            JOIN chat_groups g ON g.id = gi.group_id
            WHERE gi.id = ?
            """,
            (invite_id,),
        ).fetchone()
        if invite is None:
            raise HTTPException(status_code=404, detail="Invite not found.")
        if invite["invited_user_id"] != me_row["id"]:
            raise HTTPException(status_code=403, detail="Invite does not belong to you.")
        if invite["status"] != "pending":
            raise HTTPException(status_code=409, detail="Invite has already been handled.")

        conn.execute(
            """
            UPDATE group_invites
            SET status = 'declined', responded_at = ?
            WHERE id = ?
            """,
            (responded_at, invite_id),
        )
        conn.commit()

        await _notify_user(
            invite["invited_by_user_id"],
            {
                "type": "group_invite_resolved",
                "invite": {
                    "id": invite_id,
                    "group_id": invite["group_id"],
                    "group_name": invite["group_name"],
                    "status": "declined",
                    "by_username": me_row["username"],
                    "responded_at": responded_at,
                },
            },
        )
        return JSONResponse(
            {
                "ok": True,
                "invite": {
                    "id": invite_id,
                    "group_id": invite["group_id"],
                    "group_name": invite["group_name"],
                    "status": "declined",
                    "responded_at": responded_at,
                },
            }
        )
    finally:
        conn.close()


@app.get("/api/groups/{group_id}/members")
async def list_group_members(
    group_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        membership = _require_group_member(conn, group_id, me_row["id"])
        is_global_feed = _is_global_feed_group(conn, group_id)
        rows = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.public_key,
                u.display_name,
                u.avatar_b64,
                gm.role,
                gm.joined_at
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ?
            ORDER BY
                CASE gm.role WHEN 'owner' THEN 0 ELSE 1 END,
                u.username ASC
            """,
            (group_id,),
        ).fetchall()
        is_site_admin = bool(me_row["is_admin"])
        return JSONResponse(
            {
                "group_id": group_id,
                "group_name": membership["group_name"],
                "is_global_feed": is_global_feed,
                "can_manage_members": (False if is_global_feed else True),  # any member can invite
                "can_remove_members": (
                    False if is_global_feed else (membership["role"] == "owner" or is_site_admin)
                ),
                "members": [
                    {
                        "id": row["id"],
                        "username": row["username"],
                        "public_key": row["public_key"],
                        "display_name": row["display_name"],
                        "avatar_b64": row["avatar_b64"],
                        "role": row["role"],
                        "joined_at": row["joined_at"],
                    }
                    for row in rows
                ],
            }
        )
    finally:
        conn.close()


@app.post("/api/groups/{group_id}/members")
async def add_group_member(
    group_id: int,
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    username = _normalize_invite_username(str(payload.get("username", "")))

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        membership = _require_group_member(conn, group_id, me_row["id"])
        if _is_global_feed_group(conn, group_id):
            raise HTTPException(status_code=403, detail="BlackEnvelope Feed membership is automatic.")
        # Any group member can add new members

        target = conn.execute(
            "SELECT id, username, public_key FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if target is None:
            raise HTTPException(status_code=404, detail="User not found.")
        if not target["public_key"]:
            raise HTTPException(status_code=400, detail="User has no public key yet.")

        exists = conn.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
            (group_id, target["id"]),
        ).fetchone()
        if exists is not None:
            raise HTTPException(status_code=409, detail="User is already in this group.")

        joined_at = int(time.time())
        conn.execute(
            """
            INSERT INTO group_members (group_id, user_id, role, joined_at)
            VALUES (?, ?, 'member', ?)
            """,
            (group_id, target["id"], joined_at),
        )
        conn.commit()
        await _notify_user(
            target["id"],
            {
                "type": "group_member_added",
                "group": {
                    "id": group_id,
                    "name": membership["group_name"],
                },
            },
        )
        return JSONResponse(
            {
                "ok": True,
                "member": {
                    "id": target["id"],
                    "username": target["username"],
                    "role": "member",
                    "joined_at": joined_at,
                },
            }
        )
    finally:
        conn.close()


@app.delete("/api/groups/{group_id}/members/{username}")
async def remove_group_member(
    group_id: int,
    username: str,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    target_username = _normalize_invite_username(username)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        membership = _require_group_member(conn, group_id, me_row["id"])
        if _is_global_feed_group(conn, group_id):
            raise HTTPException(status_code=403, detail="BlackEnvelope Feed members cannot be removed.")
        is_site_admin = bool(me_row["is_admin"])
        if membership["role"] != "owner" and not is_site_admin:
            raise HTTPException(status_code=403, detail="Only the group owner can remove members.")

        target = conn.execute(
            "SELECT id, username FROM users WHERE username = ?",
            (target_username,),
        ).fetchone()
        if target is None:
            raise HTTPException(status_code=404, detail="User not found.")

        target_membership = conn.execute(
            """
            SELECT role
            FROM group_members
            WHERE group_id = ? AND user_id = ?
            """,
            (group_id, target["id"]),
        ).fetchone()
        if target_membership is None:
            raise HTTPException(status_code=404, detail="User is not in this group.")
        if target_membership["role"] == "owner":
            raise HTTPException(status_code=400, detail="Group owner cannot be removed.")

        conn.execute(
            "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
            (group_id, target["id"]),
        )
        conn.execute(
            """
            UPDATE group_invites
            SET status = 'revoked', responded_at = ?
            WHERE group_id = ? AND invited_user_id = ? AND status = 'pending'
            """,
            (int(time.time()), group_id, target["id"]),
        )
        conn.commit()

        await _notify_user(
            target["id"],
            {
                "type": "group_member_removed",
                "group": {
                    "id": group_id,
                    "name": membership["group_name"],
                },
            },
        )
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.get("/api/groups/{group_id}/topics")
async def list_group_topics(
    group_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        membership = _require_group_member(conn, group_id, me_row["id"])
        rows = conn.execute(
            """
            SELECT
                t.id,
                t.group_id,
                t.title,
                t.created_by,
                u.username AS created_by_username,
                t.created_at,
                (
                    SELECT COUNT(*)
                    FROM group_messages gm
                    WHERE gm.topic_id = t.id
                ) AS message_count
            FROM group_topics t
            JOIN users u ON u.id = t.created_by
            WHERE t.group_id = ?
            ORDER BY t.id ASC
            """,
            (group_id,),
        ).fetchall()
        return JSONResponse(
            {
                "group_id": group_id,
                "group_name": membership["group_name"],
                "topics": [
                    {
                        "id": row["id"],
                        "group_id": row["group_id"],
                        "title": row["title"],
                        "created_by": row["created_by"],
                        "created_by_username": row["created_by_username"],
                        "created_at": row["created_at"],
                        "message_count": row["message_count"],
                    }
                    for row in rows
                ],
            }
        )
    finally:
        conn.close()


@app.post("/api/groups/{group_id}/topics")
async def create_group_topic(
    group_id: int,
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    title = _validate_topic_title(str(payload.get("title", "")))
    created_at = int(time.time())

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        _require_group_member(conn, group_id, me_row["id"])
        if _is_global_feed_group(conn, group_id):
            raise HTTPException(status_code=403, detail="BlackEnvelope Feed uses a fixed topic.")

        cur = conn.execute(
            """
            INSERT INTO group_topics (group_id, title, created_by, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (group_id, title, me_row["id"], created_at),
        )
        conn.commit()
        return JSONResponse(
            {
                "ok": True,
                "topic": {
                    "id": int(cur.lastrowid),
                    "group_id": group_id,
                    "title": title,
                    "created_by": me_row["id"],
                    "created_by_username": me_row["username"],
                    "created_at": created_at,
                },
            }
        )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Topic already exists in this group.") from exc
    finally:
        conn.close()


@app.delete("/api/groups/{group_id}/topics/{topic_id}")
async def delete_group_topic(
    group_id: int,
    topic_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        membership = _require_group_member(conn, group_id, me_row["id"])
        if _is_global_feed_group(conn, group_id):
            raise HTTPException(status_code=403, detail="BlackEnvelope Feed topic cannot be deleted.")
        if not _is_group_admin(membership["role"]):
            raise HTTPException(status_code=403, detail="Only group admin can delete topics.")

        topic = _group_topic_row(conn, group_id, topic_id)
        conn.execute(
            "DELETE FROM group_topics WHERE id = ? AND group_id = ?",
            (topic_id, group_id),
        )
        conn.commit()

        members = conn.execute(
            """
            SELECT user_id
            FROM group_members
            WHERE group_id = ?
            """,
            (group_id,),
        ).fetchall()
        for m in members:
            if m["user_id"] == me_row["id"]:
                continue
            await _notify_user(
                m["user_id"],
                {
                    "type": "group_topic_deleted",
                    "group": {"id": group_id, "name": membership["group_name"]},
                    "topic": {"id": topic_id, "title": topic["title"]},
                },
            )
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.delete("/api/groups/{group_id}/messages/{message_id}")
async def delete_group_message(
    group_id: int,
    message_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        membership = _require_group_member(conn, group_id, me_row["id"])
        msg = conn.execute(
            """
            SELECT id, group_id, topic_id, sender_id
            FROM group_messages
            WHERE id = ? AND group_id = ?
            """,
            (message_id, group_id),
        ).fetchone()
        if msg is None:
            raise HTTPException(status_code=404, detail="Message not found.")

        is_sender = int(msg["sender_id"]) == int(me_row["id"])
        is_group_admin = _is_group_admin(membership["role"])
        is_site_admin = bool(me_row["is_admin"])
        if not (is_sender or is_group_admin or is_site_admin):
            raise HTTPException(
                status_code=403,
                detail="Only message sender, group admin, or site admin can delete.",
            )

        conn.execute(
            "DELETE FROM message_likes WHERE message_type='group' AND message_id=?",
            (message_id,),
        )
        conn.execute(
            "DELETE FROM group_messages WHERE id = ? AND group_id = ?",
            (message_id, group_id),
        )
        conn.commit()

        members = conn.execute(
            """
            SELECT user_id
            FROM group_members
            WHERE group_id = ?
            """,
            (group_id,),
        ).fetchall()
        for m in members:
            await _notify_user(
                m["user_id"],
                {
                    "type": "group_message_deleted",
                    "group_id": group_id,
                    "topic_id": msg["topic_id"],
                    "message_id": message_id,
                },
            )
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.post("/api/groups/{group_id}/messages/{message_id}/like")
async def toggle_group_message_like(
    group_id: int,
    message_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    conn = _db()
    try:
        me = _user_by_id(conn, claims.user_id)
        _require_group_member(conn, group_id, me["id"])

        msg = conn.execute(
            "SELECT id, group_id, sender_id, topic_id FROM group_messages WHERE id = ? AND group_id = ?",
            (message_id, group_id),
        ).fetchone()
        if msg is None:
            raise HTTPException(status_code=404, detail="Message not found.")

        existing = conn.execute(
            "SELECT id FROM message_likes WHERE message_type='group' AND message_id=? AND user_id=?",
            (message_id, me["id"]),
        ).fetchone()

        if existing:
            conn.execute("DELETE FROM message_likes WHERE id=?", (existing["id"],))
        else:
            conn.execute(
                "INSERT INTO message_likes (message_type, message_id, user_id, created_at) VALUES ('group', ?, ?, ?)",
                (message_id, me["id"], int(time.time())),
            )
            # Notify message author about the like
            author_id = int(msg["sender_id"])
            if author_id != me["id"]:
                await _create_notification(
                    conn, author_id, "like",
                    source_user_id=me["id"],
                    message_id=message_id,
                    message_type="group",
                    group_id=group_id,
                    topic_id=msg["topic_id"],
                )
        conn.commit()

        likes = _get_likes_for_messages(conn, "group", [message_id]).get(message_id, [])
        members = conn.execute(
            "SELECT user_id FROM group_members WHERE group_id = ?", (group_id,)
        ).fetchall()
        event = {
            "type": "message_like_updated",
            "message_type": "group",
            "message_id": message_id,
            "group_id": group_id,
            "likes": likes,
            "like_count": len(likes),
        }
        for m in members:
            await _notify_user(m["user_id"], event)
        return JSONResponse({"ok": True, "likes": likes, "like_count": len(likes)})
    finally:
        conn.close()


@app.post("/api/groups/{group_id}/messages/send")
async def send_group_message(
    group_id: int,
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    try:
        topic_id = int(payload.get("topic_id"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="topic_id must be an integer.") from exc

    encrypted_payload = payload.get("payload")
    if not isinstance(encrypted_payload, dict):
        raise HTTPException(status_code=400, detail="payload must be an object.")
    if "v" not in encrypted_payload or "alg" not in encrypted_payload:
        raise HTTPException(status_code=400, detail="payload missing required fields.")

    boxes = encrypted_payload.get("boxes")
    if not isinstance(boxes, dict) or not boxes:
        raise HTTPException(status_code=400, detail="Group payload must include non-empty boxes object.")

    normalized_boxes: dict[str, dict[str, Any]] = {}
    for raw_username, box in boxes.items():
        username = _validate_username(str(raw_username))
        if not isinstance(box, dict):
            raise HTTPException(status_code=400, detail=f"Invalid box object for {username}.")
        if not all(field in box for field in ("salt", "iv", "ct", "epk")):
            raise HTTPException(status_code=400, detail=f"Box for {username} is missing fields.")
        normalized_boxes[username] = box
    encrypted_payload["boxes"] = normalized_boxes

    if len(json.dumps(encrypted_payload)) > GROUP_PAYLOAD_MAX_BYTES:
        raise HTTPException(status_code=400, detail="payload is too large.")

    conn = _db()
    try:
        sender = _user_by_id(conn, claims.user_id)
        _require_group_member(conn, group_id, sender["id"])
        _group_topic_row(conn, group_id, topic_id)

        member_rows = conn.execute(
            """
            SELECT u.id, u.username, u.public_key
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ?
            """,
            (group_id,),
        ).fetchall()
        # Only require boxes for members whose public key is usable by clients.
        # Members without a valid key stay in the group but will see
        # "[unable to decrypt]" until they register a key.
        expected_usernames = {sender["username"]}
        for row in member_rows:
            if int(row["id"]) == int(sender["id"]):
                continue
            if _public_key_is_json_object(row["public_key"]):
                expected_usernames.add(row["username"])
        provided_usernames = set(normalized_boxes.keys())
        missing = sorted(expected_usernames - provided_usernames)
        extra = sorted(provided_usernames - expected_usernames)
        if missing or extra:
            detail = f"boxes usernames mismatch. missing={missing}, extra={extra}"
            raise HTTPException(status_code=400, detail=detail)

        created_at = int(time.time())
        payload_str = json.dumps(encrypted_payload, separators=(",", ":"), sort_keys=True)
        cur = conn.execute(
            """
            INSERT INTO group_messages (group_id, topic_id, sender_id, payload, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (group_id, topic_id, sender["id"], payload_str, created_at),
        )
        conn.commit()
        message_id = int(cur.lastrowid)

        storage_warning = _enforce_storage_limit(conn, sender["id"])

        for member in member_rows:
            if member["id"] == sender["id"]:
                continue
            await _notify_user(
                member["id"],
                {
                    "type": "new_group_message",
                    "message": {
                        "id": message_id,
                        "group_id": group_id,
                        "topic_id": topic_id,
                        "sender_id": sender["id"],
                        "sender_username": sender["username"],
                        "created_at": created_at,
                    },
                },
            )

        headers = {}
        if storage_warning:
            headers["X-Storage-Warning"] = "approaching-limit"
        return JSONResponse(
            {"ok": True, "id": message_id, "created_at": created_at},
            headers=headers,
        )
    finally:
        conn.close()


@app.get("/api/groups/{group_id}/topics/{topic_id}/messages")
async def list_group_topic_messages(
    group_id: int,
    topic_id: int,
    limit: int = 100,
    before_id: int | None = None,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    safe_limit = max(1, min(limit, 500))
    safe_before_id: int | None = None
    if before_id is not None:
        safe_before_id = int(before_id)
        if safe_before_id < 1:
            raise HTTPException(status_code=400, detail="before_id must be a positive integer.")

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        _require_group_member(conn, group_id, me_row["id"])
        _group_topic_row(conn, group_id, topic_id)

        if safe_before_id is None:
            rows = conn.execute(
                """
                SELECT
                    gm.id,
                    gm.group_id,
                    gm.topic_id,
                    gm.sender_id,
                    s.username AS sender_username,
                    gm.payload,
                    gm.created_at
                FROM group_messages gm
                JOIN users s ON s.id = gm.sender_id
                WHERE gm.group_id = ? AND gm.topic_id = ?
                ORDER BY gm.id DESC
                LIMIT ?
                """,
                (group_id, topic_id, safe_limit + 1),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT
                    gm.id,
                    gm.group_id,
                    gm.topic_id,
                    gm.sender_id,
                    s.username AS sender_username,
                    gm.payload,
                    gm.created_at
                FROM group_messages gm
                JOIN users s ON s.id = gm.sender_id
                WHERE gm.group_id = ? AND gm.topic_id = ? AND gm.id < ?
                ORDER BY gm.id DESC
                LIMIT ?
                """,
                (group_id, topic_id, safe_before_id, safe_limit + 1),
            ).fetchall()
        has_more = len(rows) > safe_limit
        if has_more:
            rows = rows[:safe_limit]
        messages = [
            _serialize_group_message_row(
                row,
                self_user_id=me_row["id"],
                self_username=me_row["username"],
            )
            for row in rows
        ]
        messages.reverse()
        msg_ids = [m["id"] for m in messages if m.get("id")]
        likes_map = _get_likes_for_messages(conn, "group", msg_ids)
        for m in messages:
            m["likes"] = likes_map.get(m["id"], [])
            m["like_count"] = len(m["likes"])
        next_before_id = int(messages[0]["id"]) if has_more and messages else None
        return JSONResponse(
            {
                "messages": messages,
                "pagination": {
                    "has_more": has_more,
                    "next_before_id": next_before_id,
                },
            }
        )
    finally:
        conn.close()


@app.get("/api/groups/{group_id}/messages")
async def list_group_all_messages(
    group_id: int,
    limit: int = 200,
    before_id: int | None = None,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    safe_limit = max(1, min(limit, 1000))
    safe_before_id: int | None = None
    if before_id is not None:
        safe_before_id = int(before_id)
        if safe_before_id < 1:
            raise HTTPException(status_code=400, detail="before_id must be a positive integer.")

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        _require_group_member(conn, group_id, me_row["id"])

        if safe_before_id is None:
            rows = conn.execute(
                """
                SELECT
                    gm.id,
                    gm.group_id,
                    gm.topic_id,
                    t.title AS topic_title,
                    gm.sender_id,
                    s.username AS sender_username,
                    gm.payload,
                    gm.created_at
                FROM group_messages gm
                JOIN users s ON s.id = gm.sender_id
                JOIN group_topics t ON t.id = gm.topic_id
                WHERE gm.group_id = ?
                ORDER BY gm.id DESC
                LIMIT ?
                """,
                (group_id, safe_limit + 1),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT
                    gm.id,
                    gm.group_id,
                    gm.topic_id,
                    t.title AS topic_title,
                    gm.sender_id,
                    s.username AS sender_username,
                    gm.payload,
                    gm.created_at
                FROM group_messages gm
                JOIN users s ON s.id = gm.sender_id
                JOIN group_topics t ON t.id = gm.topic_id
                WHERE gm.group_id = ? AND gm.id < ?
                ORDER BY gm.id DESC
                LIMIT ?
                """,
                (group_id, safe_before_id, safe_limit + 1),
            ).fetchall()
        has_more = len(rows) > safe_limit
        if has_more:
            rows = rows[:safe_limit]
        messages = [
            _serialize_group_message_row(
                row,
                self_user_id=me_row["id"],
                self_username=me_row["username"],
            )
            for row in rows
        ]
        messages.reverse()
        msg_ids = [m["id"] for m in messages if m.get("id")]
        likes_map = _get_likes_for_messages(conn, "group", msg_ids)
        for m in messages:
            m["likes"] = likes_map.get(m["id"], [])
            m["like_count"] = len(m["likes"])
        next_before_id = int(messages[0]["id"]) if has_more and messages else None
        return JSONResponse(
            {
                "messages": messages,
                "pagination": {
                    "has_more": has_more,
                    "next_before_id": next_before_id,
                },
            }
        )
    finally:
        conn.close()


@app.delete("/api/groups/{group_id}")
async def delete_group(
    group_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    conn = _db()
    try:
        me_row = _user_by_id(conn, claims.user_id)
        membership = _require_group_member(conn, group_id, me_row["id"])
        if _is_global_feed_group(conn, group_id):
            raise HTTPException(status_code=403, detail="BlackEnvelope Feed cannot be deleted.")
        if membership["role"] != "owner":
            raise HTTPException(status_code=403, detail="Only group owner can delete group.")

        members = conn.execute(
            """
            SELECT user_id
            FROM group_members
            WHERE group_id = ?
            """,
            (group_id,),
        ).fetchall()

        conn.execute("DELETE FROM chat_groups WHERE id = ?", (group_id,))
        conn.commit()

        for m in members:
            if m["user_id"] == me_row["id"]:
                continue
            await _notify_user(
                m["user_id"],
                {
                    "type": "group_deleted",
                    "group": {"id": group_id, "name": membership["group_name"]},
                },
            )
        return JSONResponse({"ok": True})
    finally:
        conn.close()


# ── Notifications ──────────────────────────────────────────────


@app.get("/api/notifications")
async def get_notifications(
    limit: int = 50,
    before_id: int | None = None,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    safe_limit = max(1, min(limit, 100))
    safe_before_id: int | None = None
    if before_id is not None:
        safe_before_id = int(before_id)
        if safe_before_id < 1:
            raise HTTPException(status_code=400, detail="before_id must be a positive integer.")
    conn = _db()
    try:
        if safe_before_id is None:
            rows = conn.execute(
                """
                SELECT n.id, n.type, n.source_user_id, n.message_id,
                       n.message_type, n.group_id, n.topic_id,
                       n.friend_username, n.is_read, n.created_at,
                       u.username AS source_username,
                       g.name AS group_name
                FROM notifications n
                LEFT JOIN users u ON u.id = n.source_user_id
                LEFT JOIN chat_groups g ON g.id = n.group_id
                WHERE n.user_id = ?
                ORDER BY n.id DESC
                LIMIT ?
                """,
                (claims.user_id, safe_limit + 1),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT n.id, n.type, n.source_user_id, n.message_id,
                       n.message_type, n.group_id, n.topic_id,
                       n.friend_username, n.is_read, n.created_at,
                       u.username AS source_username,
                       g.name AS group_name
                FROM notifications n
                LEFT JOIN users u ON u.id = n.source_user_id
                LEFT JOIN chat_groups g ON g.id = n.group_id
                WHERE n.user_id = ? AND n.id < ?
                ORDER BY n.id DESC
                LIMIT ?
                """,
                (claims.user_id, safe_before_id, safe_limit + 1),
            ).fetchall()
        has_more = len(rows) > safe_limit
        if has_more:
            rows = rows[:safe_limit]
        notifications = [dict(r) for r in rows]
        unread_row = conn.execute(
            "SELECT COUNT(*) AS unread_count FROM notifications WHERE user_id = ? AND is_read = 0",
            (claims.user_id,),
        ).fetchone()
        unread_count = int(unread_row["unread_count"] or 0) if unread_row else 0
        next_before_id = int(notifications[-1]["id"]) if has_more and notifications else None
        return JSONResponse(
            {
                "notifications": notifications,
                "unread_count": unread_count,
                "pagination": {
                    "has_more": has_more,
                    "next_before_id": next_before_id,
                },
            }
        )
    finally:
        conn.close()


@app.get("/api/notifications/unread-count")
async def get_notification_unread_count(
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    conn = _db()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0",
            (claims.user_id,),
        ).fetchone()
        return JSONResponse({"unread_count": row["c"] if row else 0})
    finally:
        conn.close()


@app.post("/api/notifications/read")
async def mark_notifications_read(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    conn = _db()
    try:
        if payload.get("all"):
            conn.execute(
                "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
                (claims.user_id,),
            )
        elif payload.get("id"):
            conn.execute(
                "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
                (int(payload["id"]), claims.user_id),
            )
        conn.commit()
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.post("/api/notifications/mention")
async def create_mention_notification(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Client-side hint: sender tells server about @mentions in E2EE messages."""
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    mentioned_username = str(payload.get("mentioned_username", "")).strip().lower()
    message_id = payload.get("message_id")
    message_type = str(payload.get("message_type", "")).strip()
    group_id = payload.get("group_id")
    topic_id = payload.get("topic_id")
    friend_username = payload.get("friend_username")

    if not mentioned_username or not message_id or message_type not in ("direct", "group"):
        raise HTTPException(status_code=400, detail="Invalid mention notification payload.")

    conn = _db()
    try:
        target = conn.execute(
            "SELECT id FROM users WHERE username = ?", (mentioned_username,)
        ).fetchone()
        if not target:
            return JSONResponse({"ok": True})  # user doesn't exist, silently ignore

        target_id = int(target["id"])
        if target_id == claims.user_id:
            return JSONResponse({"ok": True})  # don't notify yourself

        await _create_notification(
            conn, target_id, "mention",
            source_user_id=claims.user_id,
            message_id=int(message_id),
            message_type=message_type,
            group_id=int(group_id) if group_id else None,
            topic_id=int(topic_id) if topic_id else None,
            friend_username=friend_username,
        )
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.post("/api/notifications/mention-everyone")
async def create_mention_everyone_notification(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Notify all group members.

    Permission model:
    - Any member can use @everyone in the global BlackEnvelope Feed.
    - For all other groups, only group owner/admin or site admin can use it.
    """
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    message_id = payload.get("message_id")
    group_id = payload.get("group_id")
    topic_id = payload.get("topic_id")

    if not message_id or not group_id:
        raise HTTPException(status_code=400, detail="message_id and group_id are required.")

    group_id = int(group_id)
    conn = _db()
    try:
        membership = _require_group_member(conn, group_id, claims.user_id)
        role = membership["role"]
        is_global_feed = _is_global_feed_group(conn, group_id)
        # Check permission: all members in global feed, otherwise group owner/admin or site admin.
        user = _user_by_id(conn, claims.user_id, require_active_subscription=False)
        if not is_global_feed and not _is_group_admin(role) and not bool(user["is_admin"]):
            raise HTTPException(status_code=403, detail="Only group admins or site admins can @everyone.")

        # Get all group members except the sender
        members = conn.execute(
            "SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?",
            (group_id, claims.user_id),
        ).fetchall()

        for member in members:
            await _create_notification(
                conn, member["user_id"], "mention",
                source_user_id=claims.user_id,
                message_id=int(message_id),
                message_type="group",
                group_id=group_id,
                topic_id=int(topic_id) if topic_id else None,
            )

        return JSONResponse({"ok": True, "notified": len(members)})
    finally:
        conn.close()


@app.get("/api/messages/{message_id}/context")
async def get_message_context(
    message_id: int,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Return a message and its surrounding context for jump-to-message."""
    token = _bearer_token(authorization)
    claims = _verify_token(token)
    conn = _db()
    try:
        # Try direct message first
        dm = conn.execute(
            "SELECT id, sender_id, recipient_id, payload, created_at FROM messages WHERE id = ?",
            (message_id,),
        ).fetchone()
        if dm:
            if claims.user_id not in (dm["sender_id"], dm["recipient_id"]):
                raise HTTPException(status_code=403, detail="Access denied.")
            # Count how many messages come after this one in the conversation
            friend_id = dm["recipient_id"] if dm["sender_id"] == claims.user_id else dm["sender_id"]
            count_after = conn.execute(
                """SELECT COUNT(*) AS c FROM messages
                   WHERE ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))
                   AND id > ?""",
                (claims.user_id, friend_id, friend_id, claims.user_id, message_id),
            ).fetchone()
            friend_row = conn.execute("SELECT username FROM users WHERE id = ?", (friend_id,)).fetchone()
            return JSONResponse({
                "found": True,
                "message_type": "direct",
                "friend_username": friend_row["username"] if friend_row else None,
                "messages_after": count_after["c"] if count_after else 0,
            })

        # Try group message
        gm = conn.execute(
            "SELECT id, group_id, topic_id, sender_id, created_at FROM group_messages WHERE id = ?",
            (message_id,),
        ).fetchone()
        if gm:
            _require_group_member(conn, gm["group_id"], claims.user_id)
            count_after = conn.execute(
                "SELECT COUNT(*) AS c FROM group_messages WHERE group_id=? AND topic_id=? AND id > ?",
                (gm["group_id"], gm["topic_id"], message_id),
            ).fetchone()
            return JSONResponse({
                "found": True,
                "message_type": "group",
                "group_id": gm["group_id"],
                "topic_id": gm["topic_id"],
                "messages_after": count_after["c"] if count_after else 0,
            })

        return JSONResponse({"found": False})
    finally:
        conn.close()


# ── Push Subscription ──────────────────────────────────────────


@app.get("/api/push/public-key")
async def push_public_key() -> JSONResponse:
    return JSONResponse({"public_key": VAPID_PUBLIC_KEY if _webpush_enabled() else ""})


@app.post("/api/push/subscribe")
async def push_subscribe(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    endpoint = str(payload.get("endpoint", "")).strip()
    p256dh = str(payload.get("p256dh", "")).strip()
    auth_key = str(payload.get("auth", "")).strip()
    if not endpoint or not p256dh or not auth_key:
        raise HTTPException(status_code=400, detail="Missing subscription fields.")

    conn = _db()
    try:
        _user_by_id(conn, claims.user_id)
        conn.execute(
            """
            INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
                user_id = excluded.user_id,
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                created_at = excluded.created_at
            """,
            (claims.user_id, endpoint, p256dh, auth_key, int(time.time())),
        )
        conn.commit()
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    token = _bearer_token(authorization)
    claims = _verify_token(token)

    endpoint = str(payload.get("endpoint", "")).strip()
    conn = _db()
    try:
        conn.execute(
            "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
            (claims.user_id, endpoint),
        )
        conn.commit()
        return JSONResponse({"ok": True})
    finally:
        conn.close()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str) -> None:
    claims = _verify_token(token)

    conn = _db()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (claims.user_id,)).fetchone()
    finally:
        conn.close()
    if row is None:
        await websocket.close(code=4401)
        return
    if _square_billing_enabled() and not _row_subscription_allows_access(row):
        await websocket.close(code=4402)
        return

    await websocket.accept()

    active_sockets.setdefault(claims.user_id, set()).add(websocket)
    try:
        await websocket.send_json({"type": "connected"})
        while True:
            _ = await websocket.receive_text()
            await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        sockets = active_sockets.get(claims.user_id, set())
        sockets.discard(websocket)
        if not sockets and claims.user_id in active_sockets:
            del active_sockets[claims.user_id]


if Path(WEB_DIR).is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "execution.e2ee_chat_server:app",
        host="127.0.0.1",
        port=8787,
        reload=False,
    )
