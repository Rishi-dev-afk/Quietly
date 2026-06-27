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
