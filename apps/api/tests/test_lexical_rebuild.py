"""
I-28 regression: the keyword (BM25) index rebuilds from the system of record, whichever database that is.

Before the fix, `_load_from_sqlite` always opened the SQLite file. With DATABASE_URL set that file is empty
(it was even created just to be read), so after a restart keyword search only worked through the JSON
caches, and `_load_all_caches` returned inside its loop, so only the first tenant's cache was ever loaded.
"""
import json
import os
import uuid

import pytest

from app.config import settings
from app.db import session as db_session
from app.db import sqlite
from app.services import lexical_index as lexical_module
from app.services.lexical_index import LexicalIndex


def _seed_two_tenants():
    """Two families; family A has a member-visible and an admin-only document."""
    tag = uuid.uuid4().hex[:8]
    fam_a, fam_b = f"lex_a_{tag}", f"lex_b_{tag}"
    docs = [
        (fam_a, f"doca_{tag}", "family_member", "Trust deed distribution schedule"),
        (fam_a, f"docs_{tag}", "family_admin", "Confidential succession memo"),
        (fam_b, f"docb_{tag}", "family_member", "Beta fund capital call notice"),
    ]
    for fam in (fam_a, fam_b):
        sqlite.create_family_entity({"id": fam, "name": fam})
    for fam, doc_id, role, text in docs:
        sqlite.insert_document({
            "id": doc_id, "filename": f"{doc_id}.txt", "original_name": f"{doc_id}.txt",
            "mime_type": "text/plain", "file_size": len(text), "file_hash": f"hash_{doc_id}",
            "total_pages": 1, "family_entity_id": fam, "status": "indexed",
        })
        sqlite.insert_document_acl(doc_id, fam, role)
        sqlite.insert_chunks([{
            "id": f"{doc_id}_p1_c0", "document_id": doc_id, "chunk_index": 0, "page_number": 1,
            "section_title": None, "content": text, "is_table": False,
        }])
    return fam_a, fam_b, docs


def _assert_rebuilt(index: LexicalIndex, fam_a: str, fam_b: str, docs) -> None:
    by_doc = {c["document_id"]: c for c in index.snapshot()}
    for fam, doc_id, role, text in docs:
        chunk = by_doc[doc_id]
        assert chunk["family_entity_id"] == fam and chunk["text"] == text
        expected = ["family_admin"] if role == "family_admin" else ["family_admin", "family_member"]
        assert chunk["allowed_roles"] == expected
    # Partitioned by tenant, and the admin-only document stays hidden from members
    assert index.search("capital call", fam_a, ["family_admin"]) == []
    assert index.search("capital call", fam_b, ["family_member"])
    assert index.search("succession memo", fam_a, ["family_member"]) == []
    assert index.search("succession memo", fam_a, ["family_admin"])


@pytest.fixture
def lexical_dir(tmp_path, monkeypatch):
    path = tmp_path / "lexical"
    monkeypatch.setattr(lexical_module, "LEXICAL_DIR", path)
    return path


def test_rebuild_from_sqlite(tmp_path, monkeypatch, lexical_dir):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "lexical.db"))
    monkeypatch.setattr(settings, "DATABASE_URL", None)
    sqlite.init_db()
    fam_a, fam_b, docs = _seed_two_tenants()

    index = LexicalIndex()
    index._load_from_database()

    assert index.ready
    _assert_rebuilt(index, fam_a, fam_b, docs)
    assert {p.name for p in lexical_dir.glob("lexical_*.json")} >= {f"lexical_{fam_a}.json", f"lexical_{fam_b}.json"}


def test_rebuild_uses_the_repository_not_a_raw_sqlite_file(monkeypatch, lexical_dir):
    """In Postgres mode the rows come from the repository; no SQLite connection is opened."""
    monkeypatch.setattr(sqlite, "get_db_connection", lambda: pytest.fail("opened the SQLite file"))
    rows = [{
        "id": "c1", "document_id": "d1", "page_number": 2, "is_table": False, "content": "Franking credits",
        "family_entity_id": "fam_pg", "original_name": "tax.pdf", "allowed_role": None,
    }]
    monkeypatch.setattr(sqlite, "get_lexical_chunks", lambda: rows)

    index = LexicalIndex()
    index._load_from_database()

    [chunk] = index.snapshot("fam_pg")
    assert chunk["allowed_roles"] == ["family_admin", "family_member"]  # a missing ACL row means family-wide
    assert chunk["page_number"] == 2 and chunk["original_name"] == "tax.pdf"


def test_every_tenant_cache_is_loaded(lexical_dir):
    lexical_dir.mkdir()
    for fam in ("fam_one", "fam_two", "fam_three"):
        chunk = {"chunk_id": f"{fam}_c", "document_id": f"{fam}_d", "family_entity_id": fam,
                 "allowed_roles": ["family_admin", "family_member"], "text": f"{fam} ledger"}
        (lexical_dir / f"lexical_{fam}.json").write_text(
            json.dumps({"family_entity_id": fam, "chunks": [chunk]}), encoding="utf-8")

    index = LexicalIndex()
    assert index._load_all_caches() == 3
    assert {c["family_entity_id"] for c in index.snapshot()} == {"fam_one", "fam_two", "fam_three"}


def test_rebuild_from_postgres_under_forced_rls(monkeypatch, lexical_dir):
    """Live check: the rebuild sees every tenant through the system context while RLS is forced."""
    pg_url = os.environ.get("TEST_DATABASE_URL")
    if not pg_url or not pg_url.startswith("postgresql"):
        pytest.skip("TEST_DATABASE_URL not set; live PostgreSQL lexical rebuild check skipped.")
    monkeypatch.setattr(settings, "DATABASE_URL", pg_url)
    monkeypatch.setattr(db_session, "_engine", None)
    monkeypatch.setattr(db_session, "_sessionmaker", None)
    sqlite.init_db()  # migrations to head + RLS verification
    fam_a, fam_b, docs = _seed_two_tenants()
    try:
        # A tenant-scoped session sees only its own family: RLS is really on for this role
        from sqlalchemy import text
        with db_session.get_db_session(family_ids=[fam_a]) as s:
            seen = set(s.execute(text("SELECT family_entity_id FROM documents")).scalars())
        assert fam_b not in seen

        index = LexicalIndex()
        index._load_from_database()
        _assert_rebuilt(index, fam_a, fam_b, docs)
    finally:
        for _, doc_id, _, _ in docs:
            sqlite.delete_document(doc_id)
        db_session._engine = None
        db_session._sessionmaker = None
