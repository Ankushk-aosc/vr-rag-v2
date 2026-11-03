"""
I-06 regression: DELETE /api/documents/{id} must erase every storage tier, including the stored
original file, authorize from the SQL system of record, and never report success (or drop the SQL
record) while Pinecone vectors or the original file may still exist.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import pinecone_service
from app.services.lexical_index import lexical_index
from app.services.storage import storage_service


@pytest.fixture(autouse=True)
def setup_env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "test_erasure.db"))
    monkeypatch.setattr(settings, "PINECONE_API_KEY", None)  # offline unless a test injects an index
    monkeypatch.setattr(pinecone_service, "_pinecone_client", None)
    monkeypatch.setattr(pinecone_service, "_index", None)
    monkeypatch.setattr(storage_service, "local_dir", tmp_path / "uploads")
    monkeypatch.setattr(storage_service, "bucket_name", None)
    sqlite.init_db()
    limiter.reset()


@pytest.fixture
def client():
    return TestClient(app)


def _admin(client, email="admin@erase.com"):
    body = client.post("/api/auth/register", json={
        "email": email, "password": "StrongPassword123!", "full_name": "Erase Admin",
        "family_entity_name": "Erase Trust",
    }).json()
    return {"Authorization": f"Bearer {body['access_token']}"}, body["user"]["memberships"][0]["family_entity_id"]


def _stored_doc(entity_id, tmp_path):
    """A document present in SQL, the lexical index and local original-file storage."""
    doc_id = str(uuid.uuid4())
    stored = f"{doc_id}.pdf"
    sqlite.insert_document({
        "id": doc_id, "filename": stored, "original_name": "tax_return.pdf", "mime_type": "application/pdf",
        "file_size": 4, "file_hash": uuid.uuid4().hex, "total_pages": 1, "family_entity_id": entity_id,
        "status": "indexed",
    })
    sqlite.insert_document_acl(doc_id, entity_id, "family_member")
    sqlite.insert_chunks([{
        "id": f"{doc_id}_p1_c0", "document_id": doc_id, "chunk_index": 0, "page_number": 1,
        "section_title": "P1", "content": "Franking credits of $4,210.55 were received.", "is_table": False,
    }])
    lexical_index.add_chunks([{
        "chunk_id": f"{doc_id}_p1_c0", "document_id": doc_id, "family_entity_id": entity_id,
        "allowed_roles": ["family_admin", "family_member"], "text": "Franking credits of $4,210.55 were received.",
    }])
    src = tmp_path / "upload.pdf"
    src.write_bytes(b"%PDF")
    storage_service.persist_original(src, doc_id, stored)
    return doc_id, storage_service.local_dir / doc_id / stored


def _lexical_hit(doc_id, entity_id):
    return any(m["document_id"] == doc_id for m in lexical_index.search("franking", entity_id, ["family_admin"], top_k=10))


def test_delete_erases_original_file_and_all_tiers(client, tmp_path):
    headers, entity_id = _admin(client)
    doc_id, original = _stored_doc(entity_id, tmp_path)
    assert original.exists()

    res = client.delete(f"/api/documents/{doc_id}", headers=headers)
    assert res.status_code == 200
    assert not original.exists()
    assert not original.parent.exists()
    assert sqlite.get_document_by_id(doc_id) is None
    assert not _lexical_hit(doc_id, entity_id)


@pytest.mark.usefixtures("cloud_mode")
@pytest.mark.parametrize("failing_tier", ["vectors", "file"])
def test_incomplete_erasure_keeps_record_and_can_be_retried(client, tmp_path, monkeypatch, failing_tier):
    headers, entity_id = _admin(client)
    doc_id, _ = _stored_doc(entity_id, tmp_path)

    with monkeypatch.context() as transient:
        if failing_tier == "vectors":
            transient.setattr(pinecone_service, "delete_document_from_pinecone", lambda *a, **k: False)
        else:
            transient.setattr(storage_service, "delete_stored", lambda *a, **k: False)
        res = client.delete(f"/api/documents/{doc_id}", headers=headers)

    assert res.status_code == 502
    assert sqlite.get_document_by_id(doc_id) is not None
    assert _lexical_hit(doc_id, entity_id)
    events = sqlite.get_audit_events_for_entities([entity_id], limit=20)
    assert any(e["action"] == "DOCUMENT_DELETE_INCOMPLETE" and e["resource_id"] == doc_id for e in events)
    assert not any(e["action"] == "DOCUMENT_DELETED" and e["resource_id"] == doc_id for e in events)

    # Transient failure has cleared; the idempotent retry must complete
    retry = client.delete(f"/api/documents/{doc_id}", headers=headers)
    assert retry.status_code == 200
    assert sqlite.get_document_by_id(doc_id) is None


def test_delete_authorizes_from_sql_not_registry(client, tmp_path, monkeypatch):
    headers_a, entity_a = _admin(client)
    _, entity_b = _admin(client, "admin_b@erase.com")
    doc_id, original = _stored_doc(entity_b, tmp_path)

    # Registry record falsely claims the attacker's family
    monkeypatch.setattr(pinecone_service, "get_document_from_pinecone",
                        lambda d: {"id": d, "filename": "x.pdf", "family_entity_id": entity_a})
    called = []
    monkeypatch.setattr(pinecone_service, "delete_document_from_pinecone", lambda *a, **k: called.append(a) or True)

    res = client.delete(f"/api/documents/{doc_id}", headers=headers_a)
    assert res.status_code == 403
    assert called == []
    assert original.exists()
    assert sqlite.get_document_by_id(doc_id) is not None


# ----------------------------------------------------------------- pinecone_service unit

class FakeIndex:
    def __init__(self, listed=(), fail_ids=False, fail_filter=False, fail_registry=False):
        self.listed = list(listed)
        self.fail_ids, self.fail_filter, self.fail_registry = fail_ids, fail_filter, fail_registry
        self.deleted_ids = []

    def list(self, prefix=""):
        yield [i for i in self.listed if i.startswith(prefix)]

    def delete(self, ids=None, filter=None, namespace=None):
        if namespace == pinecone_service.DOCUMENTS_REGISTRY_NAMESPACE:
            if self.fail_registry:
                raise RuntimeError("registry down")
            return
        if filter is not None:
            if self.fail_filter:
                raise RuntimeError("delete by metadata not supported on serverless")
            return
        if self.fail_ids:
            raise RuntimeError("ids delete failed")
        self.deleted_ids.extend(ids)


def _with_index(monkeypatch, index):
    monkeypatch.setattr(pinecone_service, "get_pinecone_client", lambda: object())
    monkeypatch.setattr(pinecone_service, "get_index", lambda: index)


def test_vectors_deleted_by_id_when_filter_unsupported(monkeypatch):
    index = FakeIndex(listed=["doc1_p1_c0", "doc1_p2_t0", "doc10_p1_c0"], fail_filter=True)
    _with_index(monkeypatch, index)

    assert pinecone_service.delete_document_from_pinecone("doc1", "fam", chunk_ids=["doc1_p1_c0", "doc1_p3_c9"]) is True
    assert sorted(index.deleted_ids) == ["doc1_p1_c0", "doc1_p2_t0", "doc1_p3_c9"]  # never doc10_*


@pytest.mark.parametrize("index_kwargs", [
    {"fail_ids": True, "fail_filter": True},
    {"fail_registry": True},
])
def test_unconfirmed_pinecone_deletion_reports_failure(monkeypatch, index_kwargs):
    _with_index(monkeypatch, FakeIndex(listed=["doc1_p1_c0"], **index_kwargs))
    assert pinecone_service.delete_document_from_pinecone("doc1", "fam") is False


def test_unconfigured_pinecone_counts_as_erased():
    assert pinecone_service.delete_document_from_pinecone("doc1", "fam") is True
