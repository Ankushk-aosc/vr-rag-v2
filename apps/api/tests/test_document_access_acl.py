"""
I-05 regression: single-document reads (GET /api/documents/{id}, /{id}/table) and the Pinecone listing
path must enforce the document ACL from the SQL system of record, and must work without Pinecone.
Previously they read only the Pinecone registry: 404 when Pinecone was off, and admin-only documents
were readable by any member of the family.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import pinecone_service

TABLE_CHUNK = (
    "### CSV Data Table (Rows 1 to 2 of 2)\n"
    "Date | Amount | Category\n"
    "--- | --- | ---\n"
    "2024-07-01 | $1,250.00 | Dividends\n"
    "2024-07-15 | $310.40 | Franking credits"
)


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "test_doc_acl.db"))
    sqlite.init_db()
    limiter.reset()
    # Pinecone unavailable unless a test overrides these
    monkeypatch.setattr(pinecone_service, "get_document_from_pinecone", lambda doc_id: None)
    monkeypatch.setattr(pinecone_service, "list_documents_from_pinecone", lambda family_entity_id="": [])

    def no_index():
        raise ValueError("Pinecone API key is not configured.")

    monkeypatch.setattr(pinecone_service, "get_index", no_index)


@pytest.fixture
def client():
    return TestClient(app)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _register(client, email, **extra):
    return client.post("/api/auth/register", json={
        "email": email, "password": "StrongPassword123!", "full_name": "ACL Tester", **extra,
    }).json()


def _family(client):
    admin = _register(client, "admin@acl.com", family_entity_name="ACL Trust")
    entity_id = admin["user"]["memberships"][0]["family_entity_id"]
    tokens = {"admin": admin["access_token"]}
    for role in ("family_member", "read_only_adviser"):
        invite = client.post(
            "/api/auth/invites", json={"family_entity_id": entity_id, "role": role},
            headers=_auth(admin["access_token"]),
        ).json()["invite_token"]
        tokens[role] = _register(client, f"{role}@acl.com", invite_token=invite)["access_token"]
    return entity_id, tokens


def _insert_doc(entity_id, name, allowed_role="family_member", status="indexed", table=False):
    doc_id = str(uuid.uuid4())
    sqlite.insert_document({
        "id": doc_id, "filename": f"{doc_id}.csv", "original_name": name, "mime_type": "text/csv",
        "file_size": 10, "file_hash": uuid.uuid4().hex, "total_pages": 1,
        "family_entity_id": entity_id, "status": status,
    })
    sqlite.insert_document_acl(doc_id, entity_id, allowed_role)
    if table:
        sqlite.insert_chunks([{
            "id": f"{doc_id}_p1_t0", "document_id": doc_id, "chunk_index": 0, "page_number": 1,
            "section_title": "Page 1 Table", "content": TABLE_CHUNK, "is_table": True,
        }])
    return doc_id


def test_get_document_works_without_pinecone(client):
    entity_id, tokens = _family(client)
    doc_id = _insert_doc(entity_id, "statement.csv")

    res = client.get(f"/api/documents/{doc_id}", headers=_auth(tokens["family_member"]))
    assert res.status_code == 200
    assert res.json()["original_name"] == "statement.csv"
    assert res.json()["family_entity_id"] == entity_id


def test_table_reads_sql_chunks_without_pinecone(client):
    entity_id, tokens = _family(client)
    doc_id = _insert_doc(entity_id, "dividends.csv", table=True)

    res = client.get(f"/api/documents/{doc_id}/table", headers=_auth(tokens["family_member"]))
    assert res.status_code == 200
    body = res.json()
    assert body["columns"] == ["Date", "Amount", "Category"]
    assert body["rows"][0] == ["2024-07-01", "$1,250.00", "Dividends"]
    assert body["total_rows"] == 2


@pytest.mark.parametrize("path", ["", "/table"])
def test_admin_only_document_hidden_from_member_and_adviser(client, path):
    entity_id, tokens = _family(client)
    doc_id = _insert_doc(entity_id, "trust_deed.csv", allowed_role="family_admin", table=True)

    assert client.get(f"/api/documents/{doc_id}{path}", headers=_auth(tokens["admin"])).status_code == 200
    for role in ("family_member", "read_only_adviser"):
        res = client.get(f"/api/documents/{doc_id}{path}", headers=_auth(tokens[role]))
        assert res.status_code == 403, role


def test_sql_tenancy_overrides_registry_metadata(client, monkeypatch):
    """A registry record claiming the caller's family must not unlock another family's document."""
    entity_id, tokens = _family(client)
    other = _register(client, "other@acl.com", family_entity_name="Other Trust")
    other_entity = other["user"]["memberships"][0]["family_entity_id"]
    doc_id = _insert_doc(other_entity, "other_family.csv")

    monkeypatch.setattr(
        pinecone_service, "get_document_from_pinecone",
        lambda d: {"id": d, "filename": "x.csv", "original_name": "x.csv", "mime_type": "text/csv",
                   "file_size": 1, "file_hash": "h", "total_pages": 1, "family_entity_id": entity_id,
                   "status": "indexed", "uploaded_at": ""},
    )
    res = client.get(f"/api/documents/{doc_id}", headers=_auth(tokens["admin"]))
    assert res.status_code == 403


@pytest.mark.usefixtures("cloud_mode")
def test_registry_only_document_is_admin_only(client, monkeypatch):
    entity_id, tokens = _family(client)
    legacy = {"id": "legacy_doc", "filename": "legacy.csv", "original_name": "legacy.csv",
              "mime_type": "text/csv", "file_size": 1, "file_hash": "h", "total_pages": 1,
              "family_entity_id": entity_id, "status": "indexed", "uploaded_at": "",
              "columns": ["A", "B"]}
    monkeypatch.setattr(pinecone_service, "get_document_from_pinecone", lambda d: legacy if d == "legacy_doc" else None)

    admin_res = client.get("/api/documents/legacy_doc", headers=_auth(tokens["admin"]))
    assert admin_res.status_code == 200
    assert admin_res.json()["columns"] == ["A", "B"]
    assert client.get("/api/documents/legacy_doc", headers=_auth(tokens["family_member"])).status_code == 403


def test_failed_document_is_not_found(client):
    entity_id, tokens = _family(client)
    doc_id = _insert_doc(entity_id, "broken.csv", status="failed")
    assert client.get(f"/api/documents/{doc_id}", headers=_auth(tokens["admin"])).status_code == 404


@pytest.mark.usefixtures("cloud_mode")
def test_pinecone_listing_is_acl_filtered_for_non_admins(client, monkeypatch):
    entity_id, tokens = _family(client)
    shared = _insert_doc(entity_id, "shared.csv")
    secret = _insert_doc(entity_id, "admin_only.csv", allowed_role="family_admin")

    def registry(family_entity_id=""):
        return [
            {"id": d, "filename": f"{d}.csv", "original_name": n, "mime_type": "text/csv", "file_size": 1,
             "file_hash": "h", "total_pages": 1, "family_entity_id": entity_id, "status": "indexed",
             "uploaded_at": ""}
            for d, n in ((shared, "shared.csv"), (secret, "admin_only.csv"), ("legacy_doc", "legacy.csv"))
        ]

    monkeypatch.setattr(pinecone_service, "list_documents_from_pinecone", registry)

    admin_names = {d["original_name"] for d in client.get("/api/documents", headers=_auth(tokens["admin"])).json()}
    assert admin_names == {"shared.csv", "admin_only.csv", "legacy.csv"}

    for role in ("family_member", "read_only_adviser"):
        names = {d["original_name"] for d in client.get("/api/documents", headers=_auth(tokens[role])).json()}
        assert names == {"shared.csv"}, role
