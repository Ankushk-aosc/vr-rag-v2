"""
I-07 regression:
  * the upload `allowed_role` form field only accepts real ACL values (family_member, family_admin);
  * a read-only adviser retrieves family-wide documents (the same documents the listing and document
    endpoints already show them) but never admin-only chunks;
  * the Postgres keyword search applies the same ACL rule as the BM25 partitions.
"""
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import session as db_session
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.routers.query import resolve_roles
from app.services import rag_engine
from app.services.lexical_index import LexicalIndex


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "test_adviser_access.db"))
    sqlite.init_db()
    limiter.reset()
    return TestClient(app)


def _register(client, email, **extra):
    res = client.post("/api/auth/register", json={
        "email": email, "password": "StrongPassword123!", "full_name": "Test User", **extra,
    })
    assert res.status_code == 201, res.text
    return res.json()


def _family(client):
    admin = _register(client, "admin@acl.com", family_entity_name="ACL Trust")
    entity_id = admin["user"]["memberships"][0]["family_entity_id"]
    headers = {"Authorization": f"Bearer {admin['access_token']}"}
    invite = client.post("/api/auth/invites", json={"family_entity_id": entity_id, "role": "read_only_adviser"},
                         headers=headers)
    adviser = _register(client, "adviser@acl.com", invite_token=invite.json()["invite_token"])
    return entity_id, headers, {"Authorization": f"Bearer {adviser['access_token']}"}


# ----------------------------------------------------------------- upload ACL validation

@pytest.mark.parametrize("bad_role", ["superuser", "read_only_adviser", "FAMILY_ADMIN"])
def test_upload_rejects_unknown_acl_role(client, bad_role):
    entity_id, admin_headers, _ = _family(client)
    res = client.post(
        "/api/documents/upload",
        files={"file": ("notes.txt", b"Franking credits received.", "text/plain")},
        data={"family_entity_id": entity_id, "allowed_role": bad_role},
        headers=admin_headers,
    )
    assert res.status_code == 422
    assert sqlite.get_documents_by_entity(entity_id, "family_admin") == []


def test_batch_upload_rejects_unknown_acl_role(client):
    entity_id, admin_headers, _ = _family(client)
    res = client.post(
        "/api/documents/upload-batch",
        files=[("files", ("notes.txt", b"Franking credits received.", "text/plain"))],
        data={"family_entity_id": entity_id, "allowed_role": "owner"},
        headers=admin_headers,
    )
    assert res.status_code == 422


# ----------------------------------------------------------------- adviser retrieval

def _user(role, entity="fam"):
    return {"id": "u1", "memberships": [{"family_entity_id": entity, "role": role}]}


def test_resolve_roles_maps_adviser_to_member_tag():
    assert resolve_roles("fam", _user("read_only_adviser")) == ["family_member"]
    assert resolve_roles("fam", _user("family_member")) == ["family_member"]
    assert resolve_roles("fam", _user("family_admin")) == ["family_admin"]


def test_adviser_retrieval_excludes_admin_only_chunks():
    idx = LexicalIndex()
    idx.load_chunks([
        {"chunk_id": "shared", "document_id": "d1", "page_number": 1, "family_entity_id": "fam",
         "allowed_roles": ["family_admin", "family_member"], "text": "franking credits 4210"},
        {"chunk_id": "secret", "document_id": "d2", "page_number": 1, "family_entity_id": "fam",
         "allowed_roles": ["family_admin"], "text": "franking credits trust deed"},
    ])
    roles = resolve_roles("fam", _user("read_only_adviser"))
    assert [r["chunk_id"] for r in idx.search("franking credits", "fam", roles)] == ["shared"]


def test_adviser_query_reaches_retrieval_with_member_tag(client, monkeypatch):
    entity_id, _, adviser_headers = _family(client)
    captured = {}

    async def fake_rag(**kwargs):
        captured.update(kwargs)
        return {"answer": "ok"}

    monkeypatch.setattr(rag_engine, "execute_rag_query", fake_rag)
    res = client.post("/api/query", json={"question": "What franking credits?", "family_entity_id": entity_id},
                      headers=adviser_headers)
    assert res.status_code == 200, res.text
    assert captured["user_roles"] == ["family_member"]


def test_adviser_still_cannot_upload(client):
    entity_id, _, adviser_headers = _family(client)
    res = client.post(
        "/api/documents/upload",
        files={"file": ("notes.txt", b"hello", "text/plain")},
        data={"family_entity_id": entity_id, "allowed_role": "family_member"},
        headers=adviser_headers,
    )
    assert res.status_code == 403


# ----------------------------------------------------------------- Postgres lexical ACL

class _FakeSession:
    def __init__(self, sink):
        self.sink = sink

    def get_bind(self):
        return type("E", (), {"dialect": type("D", (), {"name": "postgresql"})()})()

    def execute(self, stmt, params):
        self.sink.append(str(stmt))
        return type("R", (), {"all": lambda self: []})()


@pytest.fixture
def pg_sql(monkeypatch):
    statements = []

    class _Ctx:
        def __init__(self, **_):
            pass

        def __enter__(self):
            return _FakeSession(statements)

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(db_session, "get_db_session", _Ctx)
    return statements


def test_postgres_lexical_excludes_admin_only_for_members(pg_sql):
    LexicalIndex().search_postgres("franking", "fam", ["family_member"])
    assert "<> 'family_admin'" in pg_sql[0]
    assert "document_acl" in pg_sql[0]


def test_postgres_lexical_admin_sees_everything(pg_sql):
    LexicalIndex().search_postgres("franking", "fam", ["family_admin"])
    assert "<> 'family_admin'" not in pg_sql[0]


def test_postgres_lexical_fails_closed_for_unknown_roles(pg_sql):
    assert LexicalIndex().search_postgres("franking", "fam", ["read_only_adviser"]) == []
    assert LexicalIndex().search_postgres("franking", "fam", []) == []
    assert pg_sql == []
