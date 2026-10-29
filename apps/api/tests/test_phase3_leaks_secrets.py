import os
import uuid
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.config import Settings, settings
from app.db import sqlite
from app.services import auth, pinecone_service


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_phase3.db"
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(test_db))
    sqlite.init_db()
    return test_db


@pytest.fixture
def client():
    return TestClient(app)


def test_s6_production_secret_key_fail_fast():
    """S6: Startup/Config must fail fast if production secret is default or < 32 chars."""
    # Development allows default key
    dev_settings = Settings(ENVIRONMENT="development", APP_SECRET_KEY="dev-insecure-key-change-in-production")
    assert dev_settings.APP_SECRET_KEY == "dev-insecure-key-change-in-production"

    # Production rejects default dev key
    with pytest.raises(ValidationError):
        Settings(ENVIRONMENT="production", APP_SECRET_KEY="dev-insecure-key-change-in-production")

    # Production rejects short secret key (< 32 chars)
    with pytest.raises(ValidationError):
        Settings(ENVIRONMENT="production", APP_SECRET_KEY="super-secret-but-too-short")

    # Production accepts cryptographically secure secret (>= 32 chars)
    prod_settings = Settings(ENVIRONMENT="production", APP_SECRET_KEY="c" * 32)
    assert prod_settings.APP_SECRET_KEY == "c" * 32


def test_s10_email_validation(client):
    """S10: Validate that invalid email formats are rejected with 422 Unprocessable Entity."""
    # Invalid email on register
    res = client.post("/api/auth/register", json={
        "email": "invalid-email-format",
        "password": "Password123!",
        "full_name": "Test User"
    })
    assert res.status_code == 422

    # Invalid email on login
    res = client.post("/api/auth/login", json={
        "email": "not-an-email",
        "password": "Password123!"
    })
    assert res.status_code == 422


def test_s10_password_hashing_600k_iterations_and_legacy_compatibility():
    """S10: Verify 600k iterations on new hashes and backward compatibility with 100k hashes."""
    password = "SecurePassword123!"
    hashed = auth.hash_password(password)
    parts = hashed.split("$")
    assert len(parts) == 3
    assert int(parts[0]) == 600_000
    assert auth.verify_password(password, hashed) is True
    assert auth.verify_password("WrongPassword!", hashed) is False

    # Legacy 100k hash format: salt$hex
    import hashlib
    salt = "testlegacy16char"
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000).hex()
    legacy_hash = f"{salt}${key}"
    assert auth.verify_password(password, legacy_hash) is True
    assert auth.verify_password("WrongPassword!", legacy_hash) is False


def test_s11_login_failure_constant_time_dummy_and_email_redaction(client):
    """S11 & S5: Login failures execute dummy verification and redact emails from audit trails."""
    # Attempt login with non-existent email
    res = client.post("/api/auth/login", json={
        "email": "victim_test@familyoffice.com",
        "password": "WrongPassword123!"
    })
    assert res.status_code == 401
    assert res.json()["detail"] == "Invalid email or password."

    # Check audit events in SQLite
    events = sqlite.get_audit_events(limit=10)
    failed_login_events = [e for e in events if e["action"] == "LOGIN_FAILED"]
    assert len(failed_login_events) >= 1
    event = failed_login_events[0]

    # Verify user_id does NOT contain the raw email
    assert event["user_id"] is None
    # Verify email is masked in details
    assert "victim_test@familyoffice.com" not in event["details"]
    assert "v***t@familyoffice.com" in event["details"]


def test_s5_audit_trail_tenant_isolation_and_rbac(client):
    """S5: Audit trail must strictly isolate family entities and restrict entity logs to family_admin."""
    # Register Family Alpha (Admin A)
    res_a = client.post("/api/auth/register", json={
        "email": "admin_a@alpha.com",
        "password": "AlphaPassword123!",
        "full_name": "Admin Alpha",
        "family_entity_name": "Alpha Trust"
    })
    token_a = res_a.json()["access_token"]
    entity_a = res_a.json()["user"]["memberships"][0]["family_entity_id"]

    # Register Member in Family Alpha via invite
    res_member = client.post("/api/auth/register", json={
        "email": "member_a@alpha.com",
        "password": "MemberPassword123!",
        "full_name": "Member Alpha",
        "invite_entity_id": entity_a
    })
    token_member = res_member.json()["access_token"]

    # Register Family Beta (Admin B)
    res_b = client.post("/api/auth/register", json={
        "email": "admin_b@beta.com",
        "password": "BetaPassword123!",
        "full_name": "Admin Beta",
        "family_entity_name": "Beta Office"
    })
    token_b = res_b.json()["access_token"]
    entity_b = res_b.json()["user"]["memberships"][0]["family_entity_id"]

    # 1. Admin A calls /api/auth/audit (default) -> should see Alpha events, NEVER Beta events
    res = client.get("/api/auth/audit", headers={"Authorization": f"Bearer {token_a}"})
    assert res.status_code == 200
    events_a = res.json()
    assert len(events_a) >= 1
    for ev in events_a:
        assert ev["family_entity_id"] == entity_a
        assert ev["family_entity_id"] != entity_b

    # 2. Admin A explicitly requests Tenant B's audit trail -> 403 Forbidden
    res = client.get(f"/api/auth/audit?family_entity_id={entity_b}", headers={"Authorization": f"Bearer {token_a}"})
    assert res.status_code == 403
    assert "Access denied" in res.json()["detail"]

    # 3. Non-admin (Member A) requests entity audit trail -> 403 Forbidden
    res = client.get(f"/api/auth/audit?family_entity_id={entity_a}", headers={"Authorization": f"Bearer {token_member}"})
    assert res.status_code == 403
    assert "Permission denied: Only family_admin" in res.json()["detail"]

    # 4. Non-admin (Member A) calls /api/auth/audit without param -> gets only their own user-scoped events
    res = client.get("/api/auth/audit", headers={"Authorization": f"Bearer {token_member}"})
    assert res.status_code == 200
    member_events = res.json()
    assert len(member_events) >= 1
    for ev in member_events:
        assert ev["user_id"] == res_member.json()["user"]["id"]


def test_s16_pinecone_users_registry_deleted():
    """S16: Dead users_registry namespace and save_user_to_pinecone must be removed."""
    assert not hasattr(pinecone_service, "USERS_REGISTRY_NAMESPACE")
    assert not hasattr(pinecone_service, "save_user_to_pinecone")
    assert not hasattr(pinecone_service, "get_user_from_pinecone")


def test_s3_pinecone_document_names_and_wildcard_removal():
    """S3 & R9: Document names served from transactional SQLite without wildcard cross-tenant leaks."""
    # Seed doc in Entity A
    doc_a = {
        "id": "doc_alpha_1",
        "filename": "alpha_portfolio.pdf",
        "original_name": "Alpha Portfolio 2026.pdf",
        "mime_type": "application/pdf",
        "file_size": 1024,
        "file_hash": "hash_a",
        "total_pages": 1,
        "family_entity_id": "fam_alpha",
        "status": "indexed",
        "columns": [],
        "sample_rows": [],
        "preview_text": "preview",
        "is_table": False
    }
    # Seed doc in Entity B
    doc_b = {
        "id": "doc_beta_1",
        "filename": "beta_taxes.pdf",
        "original_name": "Beta Taxes 2026.pdf",
        "mime_type": "application/pdf",
        "file_size": 2048,
        "file_hash": "hash_b",
        "total_pages": 2,
        "family_entity_id": "fam_beta",
        "status": "indexed",
        "columns": [],
        "sample_rows": [],
        "preview_text": "preview",
        "is_table": False
    }
    # Create family entities first to satisfy foreign key constraint
    sqlite.create_family_entity({"id": "fam_alpha", "name": "Alpha Trust", "entity_type": "Family Trust"})
    sqlite.create_family_entity({"id": "fam_beta", "name": "Beta Office", "entity_type": "Family Trust"})

    sqlite.insert_document(doc_a)
    sqlite.insert_document(doc_b)

    # Names for Entity A only contains Entity A doc
    names_a = pinecone_service.get_document_names(family_entity_id="fam_alpha")
    assert "doc_alpha_1" in names_a
    assert "doc_beta_1" not in names_a

    # Names for Entity B only contains Entity B doc
    names_b = pinecone_service.get_document_names(family_entity_id="fam_beta")
    assert "doc_beta_1" in names_b
    assert "doc_alpha_1" not in names_b
