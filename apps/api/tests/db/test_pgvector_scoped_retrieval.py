"""
pgvector retrieval (migration 008 + SqlAlchemyLocalIndexRepository).

Without PostgreSQL: the generated SQL keeps the tenant, the authorized document ids and the query
vector as bound parameters (no string-built SQL), and the local index uses the pgvector path when it
is available. With TEST_DATABASE_URL pointing at a migrated PostgreSQL that has pgvector, the live test
writes two tenants and proves a scoped similarity search never returns the other tenant's chunks.
"""
import os
import uuid

import numpy as np
import pytest

from app.config import settings
from app.db.repositories import sqlalchemy_local_index
from app.db.repositories.sqlalchemy_local_index import SqlAlchemyLocalIndexRepository
from app.services import local_vector_index


class _Row:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _CapturingSession:
    def __init__(self, sink, rows):
        self.sink, self.rows = sink, rows

    def execute(self, stmt, params=None):
        self.sink.append((str(stmt), dict(params or {})))
        rows = self.rows
        return type("R", (), {"all": lambda _self: rows})()


def _capture(monkeypatch, rows=()):
    sink = []

    class _Ctx:
        def __init__(self, *a, **k):
            self.kw = k

        def __enter__(self):
            sink.append(("context", self.kw))
            return _CapturingSession(sink, list(rows))

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(sqlalchemy_local_index, "get_db_session", _Ctx)
    return sink


def test_pgvector_query_binds_tenant_documents_and_vector(monkeypatch):
    sink = _capture(monkeypatch, rows=[_Row(chunk_id="c1", document_id="d1", allowed_roles='["family_admin"]', score=0.9)])
    repo = SqlAlchemyLocalIndexRepository()
    hostile = "fam_a' OR '1'='1"
    out = repo.search_chunk_vectors_pgvector([0.1, 0.2], hostile, ["d1", "d2'; DROP TABLE x;--"], 5)
    assert out == [{"chunk_id": "c1", "document_id": "d1", "allowed_roles": ["family_admin"], "score": 0.9}]
    (_, ctx), (sql, params) = sink
    assert ctx == {"family_ids": [hostile]}  # RLS tenant context set for the query
    assert "family_entity_id = :fam" in sql and "document_id = ANY(:docs)" in sql
    assert "embedding_vec <=> CAST(:q AS vector)" in sql and "LIMIT :k" in sql
    assert hostile not in sql and "DROP TABLE" not in sql  # values only ever travel as parameters
    assert params["fam"] == hostile and params["docs"] == ["d1", "d2'; DROP TABLE x;--"] and params["k"] == 5


def test_pgvector_query_with_empty_scope_does_not_touch_the_database(monkeypatch):
    sink = _capture(monkeypatch)
    assert SqlAlchemyLocalIndexRepository().search_chunk_vectors_pgvector([0.1], "fam", [], 5) == []
    assert sink == []


def test_local_index_uses_pgvector_when_available(monkeypatch):
    calls = []

    class FakeRepo:
        def pgvector_enabled(self):
            return True

        def search_chunk_vectors_pgvector(self, vec, fam, docs, k):
            calls.append((fam, docs, k))
            return [{"chunk_id": "c1", "document_id": "d1", "allowed_roles": ["family_member"], "score": 0.8}]

    monkeypatch.setattr(local_vector_index.sqlite, "get_local_index_repository", lambda: FakeRepo())
    monkeypatch.setattr(local_vector_index.sqlite, "get_chunks_by_ids", lambda ids: [
        {"id": "c1", "document_id": "d1", "family_entity_id": "fam", "page_number": 1, "content": "text"}])
    hits = local_vector_index.query_similar_chunks([0.3] * 4, 3, "fam", ["family_member"], allowed_document_ids={"d1"})
    assert calls == [("fam", ["d1"], 6)]
    assert [h["chunk_id"] for h in hits] == ["c1"]


# ----------------------------------------------------------------- live PostgreSQL + pgvector

def _pg_url():
    url = os.environ.get("TEST_DATABASE_URL") or ""
    return url if url.startswith("postgresql") else None


@pytest.mark.skipif(not _pg_url(), reason="TEST_DATABASE_URL (PostgreSQL with pgvector) not configured")
def test_live_pgvector_scoped_search_isolates_tenants(monkeypatch):
    from sqlalchemy import text

    from app.db import session as db_session
    from app.db import sqlite

    monkeypatch.setattr(settings, "DATABASE_URL", _pg_url())
    monkeypatch.setattr(db_session, "_engine", None)
    monkeypatch.setattr(db_session, "_sessionmaker", None)
    monkeypatch.setattr(SqlAlchemyLocalIndexRepository, "_pgvector", None)
    sqlite.init_db()
    repo = sqlite.get_local_index_repository()
    if not repo.pgvector_enabled():
        pytest.skip("pgvector extension/column not available in this database")

    dim = settings.EMBEDDING_DIMENSION
    fams = {k: f"pgv_{k}_{uuid.uuid4().hex[:8]}" for k in ("a", "b")}
    docs = {k: str(uuid.uuid4()) for k in ("a", "b")}
    rng = np.random.default_rng(7)
    shared = rng.normal(size=dim).astype(np.float32)  # both tenants hold the same vector: only the filter separates them
    for k in ("a", "b"):
        with db_session.get_db_session(system=True) as s:
            s.execute(text("INSERT INTO family_entities (id, name, entity_type) VALUES (:i, :n, 'Family Trust') ON CONFLICT DO NOTHING"),
                      {"i": fams[k], "n": f"PGV {k}"})
        sqlite.insert_document({"id": docs[k], "filename": f"{k}.txt", "original_name": f"{k}.txt", "mime_type": "text/plain",
                                "file_size": 1, "file_hash": uuid.uuid4().hex, "family_entity_id": fams[k],
                                "status": "indexed", "classification": "confidential"})
        sqlite.insert_chunks([{"id": f"{docs[k]}_p1_c0", "document_id": docs[k], "chunk_index": 0, "page_number": 1,
                               "content": f"tenant {k} content"}])
        local_vector_index.upsert_vectors([{"id": f"{docs[k]}_p1_c0", "document_id": docs[k]}], [shared.tolist()],
                                          family_entity_id=fams[k], allowed_roles=["family_admin", "family_member"])
    try:
        hits = repo.search_chunk_vectors_pgvector(list(shared / np.linalg.norm(shared)), fams["a"], [docs["a"]], 10)
        assert [h["document_id"] for h in hits] == [docs["a"]]
        assert hits[0]["score"] > 0.99
        assert repo.search_chunk_vectors_pgvector(list(shared), fams["a"], [docs["b"]], 10) == []  # other tenant's id
        unscoped = repo.search_chunk_vectors_pgvector(list(shared), fams["a"], None, 10)
        assert {h["document_id"] for h in unscoped} == {docs["a"]}
    finally:
        for k in ("a", "b"):
            with db_session.get_db_session(system=True) as s:
                s.execute(text("DELETE FROM family_entities WHERE id = :i"), {"i": fams[k]})
