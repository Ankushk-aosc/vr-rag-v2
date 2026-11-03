"""
I-24 regression: the database's UNIQUE(family_entity_id, file_hash) constraint, not the read-then-insert
check, decides duplicates. Two simultaneous uploads of the same file give one 201 and one 409 (never a
500), and no request leaves an orphaned original on disk. Files with no extractable text are cleaned up,
and a file whose earlier ingestion failed can be uploaded again.
"""
import io
import threading
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import sqlite
from app.db.repositories.base import DuplicateDocumentError
from app.main import app
from app.middleware.rate_limiter import limiter
from app.services import chunker
from app.services.storage import storage_service

CONTENT = b"Quarterly trust distribution statement: franking credits 4210."


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SQLITE_DB_PATH", str(tmp_path / "dupes.db"))
    monkeypatch.setattr(storage_service, "local_dir", tmp_path / "uploads")
    (tmp_path / "uploads").mkdir()
    sqlite.init_db()
    limiter.reset()
    c = TestClient(app, raise_server_exceptions=False)
    body = c.post("/api/auth/register", json={
        "email": f"dup_{uuid.uuid4().hex[:6]}@x.com", "password": "StrongPassword123!", "full_name": "Dup",
        "family_entity_name": "Dup Trust",
    }).json()
    c.headers.update({"Authorization": f"Bearer {body['access_token']}"})
    c.entity_id = body["user"]["memberships"][0]["family_entity_id"]
    c.uploads = tmp_path / "uploads"
    return c


def _upload(client, name="statement.txt", content=CONTENT):
    return client.post("/api/documents/upload", data={"family_entity_id": client.entity_id},
                       files={"file": (name, io.BytesIO(content), "text/plain")})


def _stored_files(client):
    return sorted(p.name for p in client.uploads.rglob("*") if p.is_file())


def test_concurrent_identical_uploads_give_201_and_409(client, monkeypatch):
    # Both requests pass the advisory duplicate check before either inserts: the race in I-24
    real_lookup = sqlite.get_document_by_hash
    barrier = threading.Barrier(2, timeout=30)
    first_check = threading.local()

    def racing_lookup(family_entity_id, file_hash):
        found = real_lookup(family_entity_id, file_hash)
        if not getattr(first_check, "done", False):  # only the up-front check of each request races
            first_check.done = True
            barrier.wait()
        return found

    monkeypatch.setattr(sqlite, "get_document_by_hash", racing_lookup)
    results = []
    threads = [threading.Thread(target=lambda n=n: results.append(_upload(client, f"copy{n}.txt"))) for n in (1, 2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)

    assert sorted(r.status_code for r in results) == [201, 409], [r.text[:200] for r in results]
    loser = next(r for r in results if r.status_code == 409)
    assert "already exists" in loser.json()["detail"]
    winner_id = next(r for r in results if r.status_code == 201).json()["document"]["id"]
    # exactly one document row and one stored original remain, both the winner's
    docs = sqlite.get_documents_by_entity(client.entity_id, "family_admin")
    assert [d["id"] for d in docs] == [winner_id]
    assert all(name.startswith(winner_id) for name in _stored_files(client)), _stored_files(client)


def test_sequential_duplicate_still_409(client):
    assert _upload(client).status_code == 201
    second = _upload(client, "again.txt")
    assert second.status_code == 409
    assert len(_stored_files(client)) == 1


def test_repository_raises_typed_duplicate_error(client):
    doc = {"id": str(uuid.uuid4()), "filename": "a.txt", "original_name": "a.txt", "mime_type": "text/plain",
           "file_size": 1, "file_hash": "same-hash", "total_pages": 1, "family_entity_id": client.entity_id,
           "status": "indexed"}
    sqlite.insert_document(doc)
    with pytest.raises(DuplicateDocumentError):
        sqlite.insert_document({**doc, "id": str(uuid.uuid4())})


def test_no_extractable_text_removes_stored_original(client, monkeypatch):
    monkeypatch.setattr(chunker, "chunk_document", lambda **kwargs: [])
    res = _upload(client, "blank.txt", b"   ")
    assert res.status_code == 400
    assert _stored_files(client) == []


def test_failed_ingestion_can_be_uploaded_again(client):
    first = _upload(client)
    assert first.status_code == 201
    failed_id = first.json()["document"]["id"]
    sqlite.update_document_status(failed_id, "failed")  # e.g. vector upsert failed earlier
    retry = _upload(client, "retry.txt")
    assert retry.status_code == 201, retry.text
    assert sqlite.get_document_by_id(failed_id) is None
    assert [d["id"] for d in sqlite.get_documents_by_entity(client.entity_id, "family_admin")] == [
        retry.json()["document"]["id"]]
