"""
I-08 regression: the Pinecone document registry must be listed with a tenant filter applied inside
Pinecone. Previously one global top_k=100 query was filtered in Python, so a family silently lost
documents once the index held more than 100 registry records across all tenants. The listing endpoint
must also show SQL documents the registry did not return.
"""
import logging
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import pinecone_service

pytestmark = pytest.mark.usefixtures("cloud_mode")  # Pinecone-path tests (Audit I-09: local is the default)


def _meta(doc_id, family, **extra):
    return {
        "id": doc_id, "filename": f"{doc_id}.csv", "original_name": f"{doc_id}.csv", "mime_type": "text/csv",
        "file_size": 1, "file_hash": "h", "total_pages": 1, "family_entity_id": family, "status": "indexed",
        "uploaded_at": "", "sample_rows": "[]", **extra,
    }


class FakeRegistryIndex:
    """Registry namespace that returns records in insertion order, honouring top_k and an $eq filter."""

    def __init__(self, records, honour_filter=True):
        self.records = records
        self.honour_filter = honour_filter
        self.queries = []

    def query(self, vector, top_k, namespace=None, filter=None, include_metadata=False):
        self.queries.append({"top_k": top_k, "namespace": namespace, "filter": filter})
        recs = self.records
        if filter and self.honour_filter:
            want = filter["family_entity_id"]["$eq"]
            recs = [r for r in recs if r["family_entity_id"] == want]
        return {"matches": [{"id": r["id"], "metadata": r} for r in recs[:top_k]]}

    def fetch(self, ids, namespace=None):
        return {"vectors": {}}


@pytest.fixture
def registry(monkeypatch):
    def install(records, honour_filter=True):
        index = FakeRegistryIndex(records, honour_filter)
        monkeypatch.setattr(pinecone_service, "get_index", lambda: index)
        return index
    return install


def test_family_documents_survive_more_than_100_records_overall(registry):
    others = [_meta(f"other_{i}", "fam_big") for i in range(150)]
    mine = [_meta(f"mine_{i}", "fam_small") for i in range(3)]
    index = registry(others + mine)

    docs = pinecone_service.list_documents_from_pinecone("fam_small")
    assert sorted(d["id"] for d in docs) == ["mine_0", "mine_1", "mine_2"]
    q = index.queries[0]
    assert q["filter"] == {"family_entity_id": {"$eq": "fam_small"}}
    assert q["namespace"] == pinecone_service.DOCUMENTS_REGISTRY_NAMESPACE
    assert q["top_k"] == pinecone_service.REGISTRY_LIST_LIMIT


def test_python_tenant_check_kept_as_defence_in_depth(registry):
    registry([_meta("a", "fam_a"), _meta("b", "fam_b")], honour_filter=False)
    assert [d["id"] for d in pinecone_service.list_documents_from_pinecone("fam_a")] == ["a"]


def test_empty_family_never_queries(registry):
    index = registry([_meta("a", "fam_a")])
    assert pinecone_service.list_documents_from_pinecone("") == []
    assert index.queries == []


def test_cap_is_logged(registry, monkeypatch, caplog):
    monkeypatch.setattr(pinecone_service, "REGISTRY_LIST_LIMIT", 5)
    registry([_meta(f"d{i}", "fam_a") for i in range(8)])
    with caplog.at_level(logging.WARNING):
        assert len(pinecone_service.list_documents_from_pinecone("fam_a")) == 5
    assert any("cap" in r.getMessage() for r in caplog.records)


# ----------------------------------------------------------------- endpoint merge

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "test_registry_listing.db"))
    sqlite.init_db()
    limiter.reset()
    return TestClient(app)


def _insert_doc(entity_id, doc_id, name):
    sqlite.insert_document({
        "id": doc_id, "filename": f"{doc_id}.csv", "original_name": name, "mime_type": "text/csv",
        "file_size": 1, "file_hash": uuid.uuid4().hex, "total_pages": 1,
        "family_entity_id": entity_id, "status": "indexed",
    })
    sqlite.insert_document_acl(doc_id, entity_id, "family_member")


def test_listing_merges_sql_documents_missing_from_registry(client, monkeypatch):
    body = client.post("/api/auth/register", json={
        "email": "admin@merge.com", "password": "StrongPassword123!", "full_name": "Merge Admin",
        "family_entity_name": "Merge Trust",
    }).json()
    entity_id = body["user"]["memberships"][0]["family_entity_id"]
    _insert_doc(entity_id, "doc_indexed", "indexed.csv")
    _insert_doc(entity_id, "doc_unindexed", "unindexed.csv")  # uploaded while Pinecone was off

    monkeypatch.setattr(
        pinecone_service, "list_documents_from_pinecone",
        lambda family_entity_id="": [{**_meta("doc_indexed", entity_id), "original_name": "indexed.csv",
                                      "columns": ["Date", "Amount"], "sample_rows": []}],
    )
    res = client.get("/api/documents", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert res.status_code == 200
    docs = {d["id"]: d for d in res.json()}
    assert set(docs) == {"doc_indexed", "doc_unindexed"}
    assert docs["doc_indexed"]["columns"] == ["Date", "Amount"]
