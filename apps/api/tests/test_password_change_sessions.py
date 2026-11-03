"""
I-15 regression: changing the password signs out every other session. Tokens issued before the change
are rejected; the device that made the change gets a fresh token; new logins work; older databases
gain the `token_version` column; pre-versioning tokens (no `ver`) keep working until the next change.
"""
import sqlite3
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import auth

OLD_PW, NEW_PW = "OldPassword123!", "NewPassword456!"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "sessions.db"))
    sqlite.init_db()
    limiter.reset()
    return TestClient(app)


def _register(client):
    res = client.post("/api/auth/register", json={
        "email": "owner@sessions.com", "password": OLD_PW, "full_name": "Owner", "family_entity_name": "Session Trust",
    })
    assert res.status_code == 201
    return res.json()["access_token"]


def _login(client, password):
    return client.post("/api/auth/login", json={"email": "owner@sessions.com", "password": password})


def _me(client, token):
    return client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})


def test_password_change_signs_out_other_sessions(client):
    laptop = _register(client)
    phone = _login(client, OLD_PW).json()["access_token"]
    assert _me(client, phone).status_code == 200

    res = client.post("/api/auth/password-reset", headers={"Authorization": f"Bearer {laptop}"},
                      json={"current_password": OLD_PW, "new_password": NEW_PW})
    assert res.status_code == 200
    fresh = res.json()["access_token"]

    for stale in (phone, laptop):
        r = _me(client, stale)
        assert r.status_code == 401
        assert "password was changed" in r.json()["detail"]
    assert _me(client, fresh).status_code == 200
    assert _login(client, OLD_PW).status_code == 401
    assert _me(client, _login(client, NEW_PW).json()["access_token"]).status_code == 200


def test_failed_password_change_keeps_sessions(client):
    token = _register(client)
    res = client.post("/api/auth/password-reset", headers={"Authorization": f"Bearer {token}"},
                      json={"current_password": "wrong", "new_password": NEW_PW})
    assert res.status_code == 400
    assert _me(client, token).status_code == 200


def test_version_is_not_exposed_and_tokens_carry_it(client):
    token = _register(client)
    assert "token_version" not in _me(client, token).json()
    assert auth.decode_access_token(token)["ver"] == 0


def test_pre_versioning_token_valid_until_first_change(client):
    _register(client)
    user = sqlite.get_user_by_email("owner@sessions.com")
    legacy = auth.create_access_token({"sub": user["id"], "email": user["email"]})  # no `ver` claim
    assert _me(client, legacy).status_code == 200
    sqlite.update_user_password(user["id"], auth.hash_password(NEW_PW))
    assert _me(client, legacy).status_code == 401


def test_update_returns_incremented_version(client):
    _register(client)
    user_id = sqlite.get_user_by_email("owner@sessions.com")["id"]
    assert sqlite.update_user_password(user_id, auth.hash_password("A-Pass-1!")) == 1
    assert sqlite.update_user_password(user_id, auth.hash_password("B-Pass-2!")) == 2


def test_existing_database_gains_column(tmp_path, monkeypatch):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.execute("""CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
                        hashed_password TEXT NOT NULL, full_name TEXT NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
        conn.execute("INSERT INTO users (id, email, hashed_password, full_name) VALUES (?, ?, ?, ?)",
                     (str(uuid.uuid4()), "legacy@x.com", "h", "Legacy"))
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(path))
    sqlite.init_db()
    assert sqlite.get_user_by_email("legacy@x.com")["token_version"] == 0
