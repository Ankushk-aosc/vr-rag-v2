"""
Regression tests for the P0 fixes recorded in AGENT_MEMORY.md:
  I-01  joining an existing family requires a signed, single-use, admin-issued invite
  I-03  rate limiting is keyed per verified user (not a shared JWT-header prefix) and per IP on auth routes
  I-14  the demo administrator is never seeded outside development/test
"""
from datetime import timedelta

import jwt
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import auth


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "test_p0.db"))
    sqlite.init_db()
    limiter.reset()


@pytest.fixture
def client():
    return TestClient(app)


def _register(client, email, **extra):
    payload = {"email": email, "password": "StrongPassword123!", "full_name": "Test User", **extra}
    return client.post("/api/auth/register", json=payload)


def _admin(client, email="admin@alpha.com"):
    res = _register(client, email, family_entity_name="Alpha Trust")
    assert res.status_code == 201
    body = res.json()
    return body["access_token"], body["user"]["memberships"][0]["family_entity_id"]


def _invite(client, token, entity_id, role="family_member"):
    return client.post(
        "/api/auth/invites",
        json={"family_entity_id": entity_id, "role": role},
        headers={"Authorization": f"Bearer {token}"},
    )


# --------------------------------------------------------------------------- I-01

def test_bare_entity_id_cannot_join_existing_family(client):
    _, entity_a = _admin(client)
    for target in (entity_a, "default_family"):
        res = _register(client, f"intruder_{target}@evil.com", invite_entity_id=target)
        assert res.status_code == 403
        # Rejected invite must not leave an orphan account behind
        assert sqlite.get_user_by_email(f"intruder_{target}@evil.com") is None


def test_admin_invite_grants_membership_once(client):
    token_a, entity_a = _admin(client)
    invite = _invite(client, token_a, entity_a, role="read_only_adviser")
    assert invite.status_code == 201
    invite_token = invite.json()["invite_token"]

    res = _register(client, "adviser@alpha.com", invite_token=invite_token)
    assert res.status_code == 201
    memberships = res.json()["user"]["memberships"]
    assert memberships == [{"family_entity_id": entity_a, "role": "read_only_adviser"}]

    # Single use
    reuse = _register(client, "second@alpha.com", invite_token=invite_token)
    assert reuse.status_code == 403
    assert sqlite.get_user_by_email("second@alpha.com") is None


def test_only_family_admin_can_issue_invites(client):
    token_a, entity_a = _admin(client)
    token_b, entity_b = _admin(client, "admin@beta.com")

    # Cross-tenant admin cannot invite into another family
    assert _invite(client, token_b, entity_a).status_code == 403

    # Members cannot issue invites
    member_token = _register(
        client, "member@alpha.com", invite_token=_invite(client, token_a, entity_a).json()["invite_token"]
    ).json()["access_token"]
    assert _invite(client, member_token, entity_a).status_code == 403

    # Admin role cannot be granted by invite
    res = _invite(client, token_a, entity_a, role="family_admin")
    assert res.status_code == 422
    assert entity_b != entity_a


def test_invite_rejects_tampering_expiry_and_mismatch(client):
    token_a, entity_a = _admin(client)
    _, entity_b = _admin(client, "admin@beta.com")
    invite_token = _invite(client, token_a, entity_a).json()["invite_token"]

    # Mismatched explicit entity
    assert _register(client, "x1@evil.com", invite_token=invite_token, invite_entity_id=entity_b).status_code == 403

    # Forged with the wrong key
    forged = jwt.encode(
        {"typ": auth.INVITE_TOKEN_TYPE, "fam": entity_a, "role": "family_member", "inv": "x", "jti": "j1"},
        "not-the-server-secret-but-long-enough-0000",
        algorithm=auth.ALGORITHM,
    )
    assert _register(client, "x2@evil.com", invite_token=forged).status_code == 403

    # Expired
    admin_id = sqlite.get_user_by_email("admin@alpha.com")["id"]
    expired = auth.create_invite_token(entity_a, "family_member", admin_id, 1)["token"]
    payload = jwt.decode(expired, settings.APP_SECRET_KEY, algorithms=[auth.ALGORITHM])
    payload["exp"] = payload["exp"] - int(timedelta(hours=2).total_seconds())
    expired = jwt.encode(payload, settings.APP_SECRET_KEY, algorithm=auth.ALGORITHM)
    assert _register(client, "x3@evil.com", invite_token=expired).status_code == 403

    # An access token is not an invite
    assert _register(client, "x4@evil.com", invite_token=token_a).status_code == 403


def test_invite_token_cannot_authenticate_api_calls(client):
    token_a, entity_a = _admin(client)
    invite_token = _invite(client, token_a, entity_a).json()["invite_token"]
    res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {invite_token}"})
    assert res.status_code == 401


# --------------------------------------------------------------------------- I-03

def test_authenticated_users_have_independent_rate_limit_buckets(client):
    token_a, _ = _admin(client)
    token_b, _ = _admin(client, "admin@beta.com")
    # Same JWT header prefix used to collide into one bucket
    assert token_a[:25] == token_b[:25]

    limiter.reset()
    for _ in range(20):
        assert client.post("/api/auth/invites", json={"family_entity_id": "nope"},
                           headers={"Authorization": f"Bearer {token_a}"}).status_code == 403
    assert client.post("/api/auth/invites", json={"family_entity_id": "nope"},
                       headers={"Authorization": f"Bearer {token_a}"}).status_code == 429
    # User B is unaffected by user A exhausting their bucket
    assert client.post("/api/auth/invites", json={"family_entity_id": "nope"},
                       headers={"Authorization": f"Bearer {token_b}"}).status_code == 403


def test_fake_bearer_headers_cannot_bypass_login_limit(client):
    for i in range(20):
        res = client.post(
            "/api/auth/login",
            json={"email": "victim@example.com", "password": "WrongPassword1!"},
            headers={"Authorization": f"Bearer rotating-fake-{i}"},
        )
        assert res.status_code == 401
    blocked = client.post(
        "/api/auth/login",
        json={"email": "victim@example.com", "password": "WrongPassword1!"},
        headers={"Authorization": "Bearer yet-another-fake"},
    )
    assert blocked.status_code == 429


# --------------------------------------------------------------------------- I-14

@pytest.mark.parametrize("environment", ["production", "staging"])
def test_demo_admin_not_seeded_outside_dev(tmp_path, monkeypatch, environment):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / f"seed_{environment}.db"))
    monkeypatch.setattr(settings, "ENVIRONMENT", environment)
    sqlite.init_db()
    assert sqlite.get_user_by_email(settings.DEMO_ADMIN_EMAIL) is None


def test_demo_admin_seed_can_be_disabled_in_dev(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "seed_off.db"))
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(settings, "SEED_DEMO_ADMIN", False)
    sqlite.init_db()
    assert sqlite.get_user_by_email(settings.DEMO_ADMIN_EMAIL) is None


def test_leftover_demo_admin_is_flagged_outside_dev(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "seed_leftover.db"))
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    sqlite.init_db()  # seeds, as an older build would have
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    with caplog.at_level("CRITICAL"):
        sqlite.seed_default_demo_admin()
    assert any("Demo administrator account" in r.getMessage() for r in caplog.records)
