"""
Tests for automatic demo administrator database seeding.
Verifies that any fresh system pulling from Git can immediately authenticate with demo credentials.
"""

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.db import sqlite


def test_seed_default_demo_admin_exists():
    """Verify default demo admin is seeded upon database initialization."""
    sqlite.init_db()

    user = sqlite.get_user_by_email("admin@sovereignfamily.com.au")
    assert user is not None, "Demo admin user was not seeded."
    assert user["email"] == "admin@sovereignfamily.com.au"
    assert user["full_name"] == "Sovereign Administrator"

    # Verify membership
    memberships = sqlite.get_user_memberships(user["id"])
    assert len(memberships) >= 1
    assert any(m["family_entity_id"] == "default_family" and m["role"] == "family_admin" for m in memberships)


def test_demo_admin_login_success():
    """Verify demo admin credentials successfully log in via API endpoint."""
    sqlite.init_db()

    client = TestClient(app)
    response = client.post(
        "/api/auth/login",
        json={
            "email": "admin@sovereignfamily.com.au",
            "password": "SovereignAdmin2026!",
        },
    )
    assert response.status_code == 200, f"Login failed: {response.text}"
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["user"]["email"] == "admin@sovereignfamily.com.au"
    assert len(data["user"]["memberships"]) >= 1


def test_demo_admin_seeding_is_idempotent():
    """Verify repeated seeding calls do not raise errors or duplicate records."""
    sqlite.init_db()
    sqlite.seed_default_demo_admin()
    sqlite.seed_default_demo_admin()

    user = sqlite.get_user_by_email("admin@sovereignfamily.com.au")
    assert user is not None
    memberships = sqlite.get_user_memberships(user["id"])
    default_mems = [m for m in memberships if m["family_entity_id"] == "default_family"]
    assert len(default_mems) == 1, "Duplicate membership created during repeated seeding."
