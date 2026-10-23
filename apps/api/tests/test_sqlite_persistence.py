import pytest
from app.db import sqlite


def test_sqlite_document_lifecycle(tmp_path, monkeypatch):
    test_db = tmp_path / "test_app.db"
    monkeypatch.setattr("app.config.settings.SQLITE_DB_PATH", str(test_db))

    sqlite.init_db()

    # Seed test family entity
    sqlite.create_family_entity({
        "id": "smith_family_trust",
        "name": "Smith Family Trust",
        "entity_type": "Family Trust"
    })

    # 1. Insert test document
    doc_id = "test_doc_ato_01"
    doc_payload = {
        "id": doc_id,
        "filename": "ato_noa_2024.pdf",
        "original_name": "ato_noa_2024.pdf",
        "mime_type": "application/pdf",
        "file_size": 1024,
        "file_hash": "hash_12345",
        "total_pages": 2,
        "family_entity_id": "smith_family_trust",
        "status": "indexed"
    }
    sqlite.insert_document(doc_payload)

    # 2. Insert test chunks
    chunks_payload = [
        {
            "id": f"{doc_id}_p1_c0",
            "document_id": doc_id,
            "chunk_index": 0,
            "page_number": 1,
            "section_title": "Page 1",
            "content": "Taxable income is $125,000 AUD.",
            "is_table": False
        },
        {
            "id": f"{doc_id}_p2_c1",
            "document_id": doc_id,
            "chunk_index": 1,
            "page_number": 2,
            "section_title": "Page 2",
            "content": "Total superannuation guarantee contributions: $13,750 AUD.",
            "is_table": False
        }
    ]
    sqlite.insert_chunks(chunks_payload)

    # 3. Retrieve document by ID
    retrieved_doc = sqlite.get_document_by_id(doc_id)
    assert retrieved_doc is not None
    assert retrieved_doc["original_name"] == "ato_noa_2024.pdf"
    assert retrieved_doc["family_entity_id"] == "smith_family_trust"

    # 4. Retrieve chunks by IDs
    fetched_chunks = sqlite.get_chunks_by_ids([f"{doc_id}_p1_c0", f"{doc_id}_p2_c1"])
    assert len(fetched_chunks) == 2
    assert fetched_chunks[0]["page_number"] == 1
    assert "Taxable income" in fetched_chunks[0]["content"]
    assert fetched_chunks[1]["page_number"] == 2
