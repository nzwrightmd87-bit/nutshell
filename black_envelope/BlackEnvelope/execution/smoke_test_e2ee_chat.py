#!/usr/bin/env python3
"""Smoke test for E2EE chat backend API."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


BASE_URL = "http://127.0.0.1:8788"


def _request(method: str, path: str, body: dict | None = None, token: str | None = None) -> dict:
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE_URL + path, method=method, data=data)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _wait_health(timeout_seconds: float = 10.0) -> None:
    start = time.time()
    while True:
        try:
            _request("GET", "/health")
            return
        except Exception:
            if time.time() - start > timeout_seconds:
                raise RuntimeError("Health check timeout.")
            time.sleep(0.2)


def main() -> int:
    db_path = Path(".tmp/test_e2ee_chat.db")
    if db_path.exists():
        db_path.unlink()

    env = os.environ.copy()
    env["CYPHER_CHAT_DB"] = str(db_path)
    env["CYPHER_CHAT_WEB_DIR"] = "web/e2ee_chat"
    env["CYPHER_CHAT_TOKEN_SECRET"] = "smoke-test-secret"

    proc = subprocess.Popen(
        [
            "python3",
            "-m",
            "uvicorn",
            "execution.e2ee_chat_server:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8788",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    error: Exception | None = None
    try:
        _wait_health()

        _request(
            "POST",
            "/api/register",
            {"username": "alice", "email": "alice@example.com", "password": "alice_password_123"},
        )
        _request(
            "POST",
            "/api/register",
            {"username": "bob", "email": "bob@example.com", "password": "bob_password_123"},
        )
        _request(
            "POST",
            "/api/register",
            {"username": "charlie", "email": "charlie@example.com", "password": "charlie_password_123"},
        )

        conn = sqlite3.connect(db_path)
        try:
            alice_admin = conn.execute(
                "SELECT is_admin FROM users WHERE username = ?",
                ("alice",),
            ).fetchone()
            assert alice_admin is not None and int(alice_admin[0]) == 0
            # Seed admin rights explicitly for the admin-only checks below.
            conn.execute("UPDATE users SET is_admin = 1 WHERE username = ?", ("alice",))
            conn.commit()
        finally:
            conn.close()

        alice_login = _request("POST", "/api/login", {"username": "alice", "password": "alice_password_123"})
        bob_login = _request("POST", "/api/login", {"username": "bob", "password": "bob_password_123"})
        charlie_login = _request("POST", "/api/login", {"username": "charlie", "password": "charlie_password_123"})
        alice_token = alice_login["token"]
        bob_token = bob_login["token"]
        charlie_token = charlie_login["token"]

        fake_pub_alice = json.dumps({"kty": "EC", "crv": "P-256", "x": "aa", "y": "bb"})
        fake_pub_bob = json.dumps({"kty": "EC", "crv": "P-256", "x": "cc", "y": "dd"})
        _request("POST", "/api/me/public-key", {"public_key": fake_pub_alice}, token=alice_token)
        _request("POST", "/api/me/public-key", {"public_key": fake_pub_bob}, token=bob_token)

        # Global feed should tolerate members without keys (e.g. Charlie) by
        # requiring boxes only for encryptable members.
        alice_groups_initial = _request("GET", "/api/groups", token=alice_token)
        global_feed = next((g for g in (alice_groups_initial.get("groups") or []) if g.get("is_global_feed")), None)
        assert global_feed is not None
        global_feed_id = int(global_feed["id"])
        global_members = _request("GET", f"/api/groups/{global_feed_id}/members", token=alice_token)
        assert any(m["username"] == "charlie" for m in global_members["members"])
        global_topics = _request("GET", f"/api/groups/{global_feed_id}/topics", token=alice_token)
        assert len(global_topics["topics"]) >= 1
        global_topic_id = int(global_topics["topics"][0]["id"])
        global_payload = {
            "v": 1,
            "alg": "ECDH-P256-HKDF-SHA256-AES256GCM",
            "boxes": {
                "alice": {"epk": {"kty": "EC"}, "salt": "gs1", "iv": "gi1", "ct": "gc1"},
                "bob": {"epk": {"kty": "EC"}, "salt": "gs2", "iv": "gi2", "ct": "gc2"},
            },
        }
        global_send = _request(
            "POST",
            f"/api/groups/{global_feed_id}/messages/send",
            {"topic_id": global_topic_id, "payload": global_payload},
            token=alice_token,
        )
        assert global_send["ok"] is True

        search_before = _request("GET", "/api/users/search?q=b", token=alice_token)
        assert any(u["username"] == "bob" and (u.get("is_friend") is False) for u in search_before["users"])
        assert all(u["username"] != "alice" for u in search_before["users"])
        search_contains = _request("GET", "/api/users/search?q=ob", token=alice_token)
        assert any(u["username"] == "bob" for u in search_contains["users"])

        friend_req = _request(
            "POST",
            "/api/friend-requests",
            {"username": "@bob"},
            token=alice_token,
        )
        assert friend_req["ok"] is True
        req_id = friend_req["request"]["id"]

        pending_friends = _request("GET", "/api/friend-requests/pending", token=bob_token)
        assert any(int(r["id"]) == req_id for r in pending_friends["requests"])

        accepted_friend = _request("POST", f"/api/friend-requests/{req_id}/accept", {}, token=bob_token)
        assert accepted_friend["ok"] is True

        friends_a = _request("GET", "/api/friends", token=alice_token)
        friends_b = _request("GET", "/api/friends", token=bob_token)
        assert any(f["username"] == "bob" for f in friends_a["friends"])
        assert any(f["username"] == "alice" for f in friends_b["friends"])

        search_after = _request("GET", "/api/users/search?q=b", token=alice_token)
        assert any(u["username"] == "bob" and (u.get("is_friend") is True) for u in search_after["users"])

        payload = {
            "v": 1,
            "alg": "ECDH-P256-HKDF-SHA256-AES256GCM",
            "to_recipient": {"epk": {"kty": "EC"}, "salt": "x", "iv": "y", "ct": "z"},
            "to_sender": {"epk": {"kty": "EC"}, "salt": "x2", "iv": "y2", "ct": "z2"},
        }
        send = _request(
            "POST",
            "/api/messages/send",
            {"recipient_username": "bob", "payload": payload},
            token=alice_token,
        )
        assert send["ok"] is True
        dm_id = int(send["id"])

        convo_a = _request("GET", "/api/messages/with/bob", token=alice_token)
        convo_b = _request("GET", "/api/messages/with/alice", token=bob_token)
        assert len(convo_a["messages"]) == 1
        assert len(convo_b["messages"]) == 1
        assert convo_a["messages"][0]["direction"] == "outgoing"
        assert convo_b["messages"][0]["direction"] == "incoming"

        deleted_dm = _request("DELETE", f"/api/messages/{dm_id}", token=alice_token)
        assert deleted_dm["ok"] is True
        convo_a2 = _request("GET", "/api/messages/with/bob", token=alice_token)
        convo_b2 = _request("GET", "/api/messages/with/alice", token=bob_token)
        assert len(convo_a2["messages"]) == 0
        assert len(convo_b2["messages"]) == 0

        send2 = _request(
            "POST",
            "/api/messages/send",
            {"recipient_username": "alice", "payload": payload},
            token=bob_token,
        )
        assert send2["ok"] is True
        dm_id2 = int(send2["id"])
        # Alice was explicitly seeded as site admin and can delete Bob's message.
        deleted_dm2 = _request("DELETE", f"/api/messages/{dm_id2}", token=alice_token)
        assert deleted_dm2["ok"] is True
        convo_a3 = _request("GET", "/api/messages/with/bob", token=alice_token)
        convo_b3 = _request("GET", "/api/messages/with/alice", token=bob_token)
        assert len(convo_a3["messages"]) == 0
        assert len(convo_b3["messages"]) == 0

        group = _request("POST", "/api/groups", {"name": "ops-room"}, token=alice_token)
        group_id = group["group"]["id"]
        default_topic_id = group["default_topic"]["id"]
        assert isinstance(group_id, int)
        assert isinstance(default_topic_id, int)

        invite = _request(
            "POST",
            f"/api/groups/{group_id}/invites",
            {"username": "bob"},
            token=alice_token,
        )
        assert invite["ok"] is True
        invite_id = invite["invite"]["id"]

        pending = _request("GET", "/api/group-invites/pending", token=bob_token)
        assert any(int(i["id"]) == invite_id for i in pending["invites"])

        accepted = _request("POST", f"/api/group-invites/{invite_id}/accept", {}, token=bob_token)
        assert accepted["ok"] is True

        topic = _request(
            "POST",
            f"/api/groups/{group_id}/topics",
            {"title": "planning"},
            token=alice_token,
        )
        topic_id = topic["topic"]["id"]
        assert isinstance(topic_id, int)

        bob_groups = _request("GET", "/api/groups", token=bob_token)
        assert any(int(g["id"]) == group_id for g in bob_groups["groups"])

        group_payload = {
            "v": 1,
            "alg": "ECDH-P256-HKDF-SHA256-AES256GCM",
            "boxes": {
                "alice": {"epk": {"kty": "EC"}, "salt": "s1", "iv": "i1", "ct": "c1"},
                "bob": {"epk": {"kty": "EC"}, "salt": "s2", "iv": "i2", "ct": "c2"},
            },
        }
        send_group = _request(
            "POST",
            f"/api/groups/{group_id}/messages/send",
            {"topic_id": topic_id, "payload": group_payload},
            token=alice_token,
        )
        assert send_group["ok"] is True
        group_message_id = int(send_group["id"])

        group_convo_a = _request(
            "GET",
            f"/api/groups/{group_id}/topics/{topic_id}/messages",
            token=alice_token,
        )
        group_convo_b = _request(
            "GET",
            f"/api/groups/{group_id}/topics/{topic_id}/messages",
            token=bob_token,
        )
        assert len(group_convo_a["messages"]) == 1
        assert len(group_convo_b["messages"]) == 1
        assert group_convo_a["messages"][0]["direction"] == "outgoing"
        assert group_convo_b["messages"][0]["direction"] == "incoming"

        group_all = _request(
            "GET",
            f"/api/groups/{group_id}/messages",
            token=alice_token,
        )
        assert len(group_all["messages"]) == 1
        assert group_all["messages"][0]["topic_title"] == "planning"

        try:
            _request("DELETE", f"/api/groups/{group_id}/messages/{group_message_id}", token=bob_token)
            raise AssertionError("Expected Bob group message delete to fail.")
        except urllib.error.HTTPError as exc:
            assert exc.code == 403

        deleted_group_msg = _request(
            "DELETE",
            f"/api/groups/{group_id}/messages/{group_message_id}",
            token=alice_token,
        )
        assert deleted_group_msg["ok"] is True
        group_convo_a2 = _request(
            "GET",
            f"/api/groups/{group_id}/topics/{topic_id}/messages",
            token=alice_token,
        )
        assert len(group_convo_a2["messages"]) == 0

        # Site admin override: Alice can delete messages even as a non-group-admin member.
        bob_group = _request("POST", "/api/groups", {"name": "bob-room"}, token=bob_token)
        bob_group_id = int(bob_group["group"]["id"])
        bob_topic_id = int(bob_group["default_topic"]["id"])
        invite2 = _request(
            "POST",
            f"/api/groups/{bob_group_id}/invites",
            {"username": "alice"},
            token=bob_token,
        )
        assert invite2["ok"] is True
        invite2_id = int(invite2["invite"]["id"])
        accepted2 = _request("POST", f"/api/group-invites/{invite2_id}/accept", {}, token=alice_token)
        assert accepted2["ok"] is True
        group_payload2 = {
            "v": 1,
            "alg": "ECDH-P256-HKDF-SHA256-AES256GCM",
            "boxes": {
                "alice": {"epk": {"kty": "EC"}, "salt": "s3", "iv": "i3", "ct": "c3"},
                "bob": {"epk": {"kty": "EC"}, "salt": "s4", "iv": "i4", "ct": "c4"},
            },
        }
        send_group2 = _request(
            "POST",
            f"/api/groups/{bob_group_id}/messages/send",
            {"topic_id": bob_topic_id, "payload": group_payload2},
            token=bob_token,
        )
        assert send_group2["ok"] is True
        group_message_id2 = int(send_group2["id"])
        deleted_group_msg2 = _request(
            "DELETE",
            f"/api/groups/{bob_group_id}/messages/{group_message_id2}",
            token=alice_token,
        )
        assert deleted_group_msg2["ok"] is True

        removed = _request(
            "DELETE",
            f"/api/groups/{group_id}/members/bob",
            token=alice_token,
        )
        assert removed["ok"] is True

        reinvite = _request(
            "POST",
            f"/api/groups/{group_id}/invites",
            {"username": "@bob"},
            token=alice_token,
        )
        _request("POST", f"/api/group-invites/{reinvite['invite']['id']}/accept", {}, token=bob_token)

        deleted_topic = _request(
            "DELETE",
            f"/api/groups/{group_id}/topics/{topic_id}",
            token=alice_token,
        )
        assert deleted_topic["ok"] is True

        deleted_group = _request(
            "DELETE",
            f"/api/groups/{group_id}",
            token=alice_token,
        )
        assert deleted_group["ok"] is True
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

    print("Smoke test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
