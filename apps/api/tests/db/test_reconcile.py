import pytest
"""Tests transactional ingestion error recovery and the storage reconcile job."""

import uuid
from app.db import sqlite
from app.db.reconcile import reconcile_storage

pytestmark = pytest.mark.usefixtures("cloud_mode")  # Pinecone-path tests (Audit I-09: local is the default)


def test_transactional_ingestion_pending_to_failed_reconciliation(monkeypatch):
    doc_id = f"test_pending_{uuid.uuid4().hex[:8]}"
    fam_id = "default_family"

    # Insert document with pending status
    doc_record = {
        "id": doc_id,
        "filename": "pending_doc.pdf",
        "original_name": "Pending Doc.pdf",
        "mime_type": "application/pdf",
        "file_size": 2048,
        "file_hash": f"hash_{doc_id}",
        "total_pages": 1,
        "family_entity_id": fam_id,
        "status": "pending",
    }
    sqlite.insert_document(doc_record)

    # Verify pending in DB
    stored = sqlite.get_document_by_id(doc_id)
    assert stored is not None
    assert stored["status"] == "pending"

    # Dry-run reconcile
    res_dry = reconcile_storage(dry_run=True)
    assert res_dry["pending_resolved_failed"] >= 1
    # Check that status was not mutated during dry-run
    assert sqlite.get_document_by_id(doc_id)["status"] == "pending"

    # Real reconcile execution
    res_real = reconcile_storage(dry_run=False)
    assert res_real["pending_resolved_failed"] >= 1

    # Should now be failed
    assert sqlite.get_document_by_id(doc_id)["status"] == "failed"


def test_reconcile_when_vectors_exist_marks_indexed(monkeypatch):
    doc_id = f"test_resolved_{uuid.uuid4().hex[:8]}"
    fam_id = "default_family"

    doc_record = {
        "id": doc_id,
        "filename": "indexed_doc.pdf",
        "original_name": "Indexed Doc.pdf",
        "mime_type": "application/pdf",
        "file_size": 1024,
        "file_hash": f"hash_{doc_id}",
        "total_pages": 1,
        "family_entity_id": fam_id,
        "status": "pending",
    }
    sqlite.insert_document(doc_record)

    from app.services import pinecone_service

    # Mock pinecone returning document with status='indexed'
    monkeypatch.setattr(
        pinecone_service,
        "get_document_from_pinecone",
        lambda d_id: {"id": d_id, "status": "indexed"} if d_id == doc_id else None,
    )

    res = reconcile_storage(dry_run=False)
    assert res["pending_resolved_indexed"] >= 1

    # Verified document status updated to indexed
    assert sqlite.get_document_by_id(doc_id)["status"] == "indexed"
