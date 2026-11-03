"""
I-20 regression: document display names are looked up only within the asking family.

Before the fix `_citations_for` and `build_datasets` called `get_document_names()` with no family, which on
SQLite returned every family's id -> filename map, and on PostgreSQL returned nothing at all (RLS with no
tenant context), so citations there showed "Document 1a2b3c4d" placeholders instead of names.
"""
import inspect

import pytest

from app.config import settings
from app.db import sqlite
from app.services import datasets, pinecone_service, rag_engine
from app.services.rag_engine import _citations_for


@pytest.fixture
def two_families(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "names.db"))
    monkeypatch.setattr(settings, "DATABASE_URL", None)
    sqlite.init_db()
    for fam, doc_id, name in (("fam_a", "doc_a", "Alpha Trust Deed.pdf"), ("fam_b", "doc_b", "Beta Secret Memo.pdf")):
        sqlite.create_family_entity({"id": fam, "name": fam})
        sqlite.insert_document({
            "id": doc_id, "filename": f"{doc_id}.pdf", "original_name": name, "mime_type": "application/pdf",
            "file_size": 1, "file_hash": f"h_{doc_id}", "total_pages": 1, "family_entity_id": fam, "status": "indexed",
        })


def test_names_require_a_family(two_families):
    assert sqlite.get_document_names("fam_a") == {"doc_a": "Alpha Trust Deed.pdf"}
    assert sqlite.get_document_names("") == {}
    assert sqlite.get_document_names(None) == {}  # fails closed instead of returning every family's names


def test_citations_use_only_the_asking_familys_names(two_families):
    passages = [{"document_id": "doc_a", "text": "a"}, {"document_id": "doc_b", "text": "b"}]
    citations = _citations_for(passages, "fam_a")
    assert citations[0]["document_name"] == "Alpha Trust Deed.pdf"
    # Even if another family's id reached this point, its filename is not disclosed
    assert citations[1]["document_name"] == "Document doc_b"
    assert all("Beta" not in c["document_name"] for c in citations)


def test_query_pipeline_passes_the_family_to_citations():
    source = inspect.getsource(rag_engine.stream_rag_events)
    assert "asyncio.to_thread(_citations_for, passages, family_entity_id)" in source


def test_datasets_look_up_names_per_family(monkeypatch):
    calls = []

    def names(family_entity_id, force=False):
        calls.append(family_entity_id)
        return {"fam_a": {"doc_a": "Alpha Prices.xlsx"}, "fam_b": {"doc_b": "Beta Prices.xlsx"}}[family_entity_id]

    monkeypatch.setattr(datasets.pinecone_service, "get_document_names", names)
    table = "| Date | Close |\n|---|---|\n" + "\n".join(f"| 2024-01-{d:02d} | {100 + d} |" for d in range(1, 13))
    chunks = [
        {"document_id": doc, "family_entity_id": fam, "allowed_roles": ["family_admin"], "text": table}
        for fam, doc in (("fam_a", "doc_a"), ("fam_b", "doc_b"))
    ]

    built = datasets.build_datasets(chunks)

    assert sorted(calls) == ["fam_a", "fam_b"]
    assert {(d.family_entity_id, d.document_name) for d in built} == {
        ("fam_a", "Alpha Prices.xlsx"), ("fam_b", "Beta Prices.xlsx"),
    }


def test_service_has_no_cross_tenant_default():
    param = inspect.signature(pinecone_service.get_document_names).parameters["family_entity_id"]
    assert param.default is inspect.Parameter.empty
