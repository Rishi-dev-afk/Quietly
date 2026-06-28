import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_neurotwin.db")

from main import app


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_register_login_and_entries_flow(client):
    register_response = client.post(
        "/api/auth/register",
        json={"email": "maya@example.com", "password": "secret123", "display_name": "Maya"},
    )
    assert register_response.status_code == 201

    login_response = client.post(
        "/api/auth/login",
        json={"email": "maya@example.com", "password": "secret123"},
    )
    assert login_response.status_code == 200
    token = login_response.json()["access_token"]
    assert token

    auth_headers = {"Authorization": f"Bearer {token}"}

    me_response = client.get("/api/auth/me", headers=auth_headers)
    assert me_response.status_code == 200
    assert me_response.json()["email"] == "maya@example.com"

    create_entry_response = client.post(
        "/api/journal/entries",
        headers=auth_headers,
        json={"content": "A calm evening and a long walk.", "mood": 4, "status": "closed"},
    )
    assert create_entry_response.status_code == 201

    entries_response = client.get("/api/journal/entries", headers=auth_headers)
    assert entries_response.status_code == 200
    data = entries_response.json()
    assert len(data["entries"]) >= 1
    assert data["entries"][0]["content"].startswith("A calm")


def test_reflect_works_anonymously_but_is_rate_limited(client, monkeypatch):
    import main

    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "")
    # No Authorization header at all — this should now succeed in reaching the AI call path
    # (and fail with 503 because no key is configured, not 401/403 for lack of auth).
    response = client.post("/api/ai/reflect", json={"content": "hello"})
    assert response.status_code == 503

    # Hammer the endpoint past the anonymous rate limit; the limiter should kick in
    # well before the 6th attempt regardless of upstream AI availability.
    statuses = []
    for _ in range(7):
        r = client.post("/api/ai/reflect", json={"content": "hello again"})
        statuses.append(r.status_code)
    assert 429 in statuses


def test_reflect_without_configured_key_returns_503(client, monkeypatch):
    register_response = client.post(
        "/api/auth/register",
        json={"email": "reflect@example.com", "password": "secret123", "display_name": "Reflect"},
    )
    assert register_response.status_code == 201

    login_response = client.post(
        "/api/auth/login",
        json={"email": "reflect@example.com", "password": "secret123"},
    )
    token = login_response.json()["access_token"]
    auth_headers = {"Authorization": f"Bearer {token}"}

    import main

    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "")

    response = client.post(
        "/api/ai/reflect",
        headers=auth_headers,
        json={"content": "A real journal entry."},
    )
    assert response.status_code == 503


def test_reflect_requires_nonempty_content(client, monkeypatch):
    register_response = client.post(
        "/api/auth/register",
        json={"email": "reflect2@example.com", "password": "secret123", "display_name": "Reflect2"},
    )
    assert register_response.status_code == 201

    login_response = client.post(
        "/api/auth/login",
        json={"email": "reflect2@example.com", "password": "secret123"},
    )
    token = login_response.json()["access_token"]
    auth_headers = {"Authorization": f"Bearer {token}"}

    import main

    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "sk-or-fake-for-test")

    response = client.post(
        "/api/ai/reflect",
        headers=auth_headers,
        json={"content": "   "},
    )
    assert response.status_code == 400


def test_mental_model_gated_until_enough_entries(client, monkeypatch):
    import main

    register_response = client.post(
        "/api/auth/register",
        json={"email": "gate@example.com", "password": "secret123", "display_name": "Gate"},
    )
    assert register_response.status_code == 201
    login_response = client.post("/api/auth/login", json={"email": "gate@example.com", "password": "secret123"})
    token = login_response.json()["access_token"]
    auth_headers = {"Authorization": f"Bearer {token}"}

    # Status before any entries: locked, no snapshot.
    status_response = client.get("/api/ai/mental-model/status", headers=auth_headers)
    assert status_response.status_code == 200
    status_data = status_response.json()
    assert status_data["unlocked"] is False
    assert status_data["has_snapshot"] is False
    assert status_data["entries_remaining"] == main.ANALYSIS_UNLOCK_ENTRY_COUNT

    # With zero entries, the gate (403, "write more entries") should fire — not the generic
    # "no content at all" error (400) — since the gate is the more useful, actionable message.
    zero_entry_build = client.post("/api/ai/mental-model", headers=auth_headers, json={})
    assert zero_entry_build.status_code == 403

    # Attempting to build before unlocking should be rejected even with content present.
    client.post(
        "/api/journal/entries",
        headers=auth_headers,
        json={"content": "Just one entry so far.", "mood": 3, "status": "closed"},
    )
    build_response = client.post("/api/ai/mental-model", headers=auth_headers, json={})
    assert build_response.status_code == 403

    # Write enough entries to cross the unlock threshold.
    for i in range(main.ANALYSIS_UNLOCK_ENTRY_COUNT - 1):
        client.post(
            "/api/journal/entries",
            headers=auth_headers,
            json={"content": f"Entry number {i}", "mood": 3, "status": "closed"},
        )

    status_response_2 = client.get("/api/ai/mental-model/status", headers=auth_headers)
    assert status_response_2.json()["unlocked"] is True

    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "")
    build_response_2 = client.post("/api/ai/mental-model", headers=auth_headers, json={})
    # Now unlocked, so the gate no longer blocks it — it should fail later in the pipeline
    # (503, missing API key) rather than 403 (gate).
    assert build_response_2.status_code == 503


def test_delete_journal_entry(client):
    register_response = client.post(
        "/api/auth/register",
        json={"email": "deleter@example.com", "password": "secret123", "display_name": "Deleter"},
    )
    assert register_response.status_code == 201
    login_response = client.post("/api/auth/login", json={"email": "deleter@example.com", "password": "secret123"})
    token = login_response.json()["access_token"]
    auth_headers = {"Authorization": f"Bearer {token}"}

    create_response = client.post(
        "/api/journal/entries",
        headers=auth_headers,
        json={"content": "An entry to be deleted.", "mood": 3, "status": "closed"},
    )
    assert create_response.status_code == 201
    entry_id = create_response.json()["id"]

    entries_before = client.get("/api/journal/entries", headers=auth_headers).json()["entries"]
    assert any(e["id"] == entry_id for e in entries_before)

    delete_response = client.delete(f"/api/journal/entries/{entry_id}", headers=auth_headers)
    assert delete_response.status_code == 204

    entries_after = client.get("/api/journal/entries", headers=auth_headers).json()["entries"]
    assert not any(e["id"] == entry_id for e in entries_after)

    # Deleting again (or an entry that never existed) should 404, not silently succeed.
    second_delete = client.delete(f"/api/journal/entries/{entry_id}", headers=auth_headers)
    assert second_delete.status_code == 404


def test_delete_journal_entry_requires_ownership(client):
    register_a = client.post(
        "/api/auth/register",
        json={"email": "owner-a@example.com", "password": "secret123", "display_name": "Owner A"},
    )
    assert register_a.status_code == 201
    token_a = client.post("/api/auth/login", json={"email": "owner-a@example.com", "password": "secret123"}).json()["access_token"]
    headers_a = {"Authorization": f"Bearer {token_a}"}

    register_b = client.post(
        "/api/auth/register",
        json={"email": "owner-b@example.com", "password": "secret123", "display_name": "Owner B"},
    )
    assert register_b.status_code == 201
    token_b = client.post("/api/auth/login", json={"email": "owner-b@example.com", "password": "secret123"}).json()["access_token"]
    headers_b = {"Authorization": f"Bearer {token_b}"}

    entry = client.post(
        "/api/journal/entries",
        headers=headers_a,
        json={"content": "Owner A's private entry.", "mood": 3, "status": "closed"},
    ).json()

    # User B must not be able to delete user A's entry.
    cross_delete = client.delete(f"/api/journal/entries/{entry['id']}", headers=headers_b)
    assert cross_delete.status_code == 404

    # The entry should still exist for user A afterwards.
    entries_a = client.get("/api/journal/entries", headers=headers_a).json()["entries"]
    assert any(e["id"] == entry["id"] for e in entries_a)


def test_delete_chat_session(client, monkeypatch):
    import main

    register_response = client.post(
        "/api/auth/register",
        json={"email": "chatdeleter@example.com", "password": "secret123", "display_name": "ChatDeleter"},
    )
    assert register_response.status_code == 201
    token = client.post("/api/auth/login", json={"email": "chatdeleter@example.com", "password": "secret123"}).json()["access_token"]
    auth_headers = {"Authorization": f"Bearer {token}"}

    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "sk-or-fake-for-test")

    async def fake_call_openrouter(messages, model, timeout=60):
        return "A thoughtful reply.", model

    monkeypatch.setattr(main, "call_openrouter", fake_call_openrouter)

    chat_response = client.post(
        "/api/ai/chat",
        headers=auth_headers,
        json={"messages": [{"role": "user", "content": "Hello there"}]},
    )
    assert chat_response.status_code == 200
    session_id = chat_response.json()["session_id"]

    sessions_before = client.get("/api/chat/sessions", headers=auth_headers).json()["sessions"]
    assert any(s["session_id"] == session_id for s in sessions_before)

    delete_response = client.delete(f"/api/chat/sessions/{session_id}", headers=auth_headers)
    assert delete_response.status_code == 204

    sessions_after = client.get("/api/chat/sessions", headers=auth_headers).json()["sessions"]
    assert not any(s["session_id"] == session_id for s in sessions_after)

    get_after_delete = client.get(f"/api/chat/sessions/{session_id}", headers=auth_headers)
    assert get_after_delete.status_code == 404

    second_delete = client.delete(f"/api/chat/sessions/{session_id}", headers=auth_headers)
    assert second_delete.status_code == 404


def test_auth_endpoints_are_rate_limited(client):
    import main

    statuses = []
    for i in range(main.AUTH_ATTEMPT_LIMIT + 5):
        r = client.post(
            "/api/auth/login",
            json={"email": "nobody@example.com", "password": "wrong-password"},
        )
        statuses.append(r.status_code)
    assert 429 in statuses
