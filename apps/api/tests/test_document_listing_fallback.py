"""
I-04 regression: GET /api/documents and /api/documents/suggestions must fall back to the SQL system of
record (ACL-filtered by the caller's role) when the Pinecone registry is empty or unavailable.
Previously both called a non-existent `sqlite.get_documents` and failed with a 500.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import pinecone_service


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "test_doc_listing.db"))
    sqlite.init_db()
    limiter.reset()
    monkeypatch.setattr(pinecone_service, "list_documents_from_pinecone", lambda family_entity_id="": [])


@pytest.fixture
def client():
    return TestClient(app)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _family(client):
    admin = client.post("/api/auth/register", json={
        "email": "admin@listing.com", "password": "StrongPassword123!",
        "full_name": "Listing Admin", "family_entity_name": "Listing Trust",
    }).json()
    entity_id = admin["user"]["memberships"][0]["family_entity_id"]
    invite = client.post(
        "/api/auth/invites", json={"family_entity_id": entity_id}, headers=_auth(admin["access_token"])
    ).json()["invite_token"]
    member = client.post("/api/auth/register", json={
        "email": "member@listing.com", "password": "StrongPassword123!",
        "full_name": "Listing Member", "invite_token": invite,
    }).json()
    return entity_id, admin["access_token"], member["access_token"]


def _insert_doc(entity_id, name, allowed_role="family_member", status="indexed"):
    doc_id = str(uuid.uuid4())
    sqlite.insert_document({
        "id": doc_id, "filename": f"{doc_id}.csv", "original_name": name, "mime_type": "text/csv",
        "file_size": 10, "file_hash": uuid.uuid4().hex, "total_pages": 1,
        "family_entity_id": entity_id, "status": status,
    })
    sqlite.insert_document_acl(doc_id, entity_id, allowed_role)
    return doc_id


def test_listing_falls_back_to_sql_with_acl_filtering(client):
    entity_id, admin_token, member_token = _family(client)
    _insert_doc(entity_id, "shared_statement.csv")
    _insert_doc(entity_id, "admin_only_trust_deed.csv", allowed_role="family_admin")
    _insert_doc(entity_id, "broken_upload.csv", status="failed")

    admin_res = client.get("/api/documents", headers=_auth(admin_token))
    assert admin_res.status_code == 200
    assert {d["original_name"] for d in admin_res.json()} == {"shared_statement.csv", "admin_only_trust_deed.csv"}

    member_res = client.get("/api/documents", headers=_auth(member_token))
    assert member_res.status_code == 200
    assert {d["original_name"] for d in member_res.json()} == {"shared_statement.csv"}


def test_listing_falls_back_when_pinecone_errors(client, monkeypatch):
    def unavailable(family_entity_id=""):
        raise RuntimeError("pinecone down")

    monkeypatch.setattr(pinecone_service, "list_documents_from_pinecone", unavailable)
    entity_id, admin_token, _ = _family(client)
    _insert_doc(entity_id, "shared_statement.csv")

    res = client.get(f"/api/documents?family_entity_id={entity_id}", headers=_auth(admin_token))
    assert res.status_code == 200
    assert [d["original_name"] for d in res.json()] == ["shared_statement.csv"]


def test_suggestions_use_sql_fallback(client):
    entity_id, _, member_token = _family(client)
    _insert_doc(entity_id, "share_portfolio_holdings.csv")

    res = client.get("/api/documents/suggestions", headers=_auth(member_token))
    assert res.status_code == 200
    assert any("share portfolio holdings" in s for s in res.json())


def test_empty_vault_returns_empty_list_and_default_suggestions(client):
    _, admin_token, _ = _family(client)
    assert client.get("/api/documents", headers=_auth(admin_token)).json() == []
    suggestions = client.get("/api/documents/suggestions", headers=_auth(admin_token))
    assert suggestions.status_code == 200
    assert len(suggestions.json()) == 2


def test_listing_other_family_is_forbidden(client):
    entity_id, _, _ = _family(client)
    _insert_doc(entity_id, "shared_statement.csv")
    outsider = client.post("/api/auth/register", json={
        "email": "outsider@other.com", "password": "StrongPassword123!", "full_name": "Outsider",
    }).json()["access_token"]

    for path in ("/api/documents", "/api/documents/suggestions"):
        res = client.get(f"{path}?family_entity_id={entity_id}", headers=_auth(outsider))
        assert res.status_code == 403
