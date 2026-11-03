import io
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from app.main import app
from app.config import settings
from app.routers.documents import MAX_FILE_SIZE
from app.services import auth
from app.db import sqlite

pytestmark = pytest.mark.usefixtures("cloud_mode")  # Pinecone-path tests (Audit I-09: local is the default)


client = TestClient(app)

@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_upload_limit.db"
    monkeypatch.setattr("app.config.settings.SQLITE_DB_PATH", str(test_db))
    sqlite.init_db()

@pytest.fixture
def auth_headers():
    token = auth.create_access_token({"sub": "test_user_id", "email": "test@example.com"})
    return {"Authorization": f"Bearer {token}"}

@pytest.fixture
def mock_current_user():
    return {
        "id": "test_user_id",
        "email": "test@example.com",
        "full_name": "Test User",
        "memberships": [{"family_entity_id": "default_family", "role": "family_admin"}]
    }


def test_max_file_size_configuration():
    assert settings.MAX_FILE_SIZE_MB == 100
    assert MAX_FILE_SIZE == 100 * 1024 * 1024


def test_upload_exceeds_100mb_limit(auth_headers, mock_current_user):
    oversized_size = MAX_FILE_SIZE + 1024

    class OversizedStream(io.RawIOBase):
        def __init__(self, total_bytes):
            self.remaining = total_bytes

        def read(self, size=-1):
            if self.remaining <= 0:
                return b""
            to_read = min(size if size > 0 else self.remaining, self.remaining)
            self.remaining -= to_read
            return b"A" * to_read

    oversized_file = OversizedStream(oversized_size)
    with patch("app.services.auth.get_current_user_optional", return_value=mock_current_user):
        response = client.post(
            "/api/documents/upload",
            files={"file": ("large_document.txt", oversized_file, "text/plain")},
            data={"family_entity_id": "default_family", "allowed_role": "family_member"},
            headers=auth_headers
        )
        assert response.status_code == 413
        assert f"File exceeds maximum allowed upload size of {settings.MAX_FILE_SIZE_MB}MB." in response.json()["detail"]


@patch("app.routers.documents.extractor.extract_document")
@patch("app.routers.documents.chunker.chunk_document")
@patch("app.routers.documents.embeddings.embed_texts")
@patch("app.routers.documents.pinecone_service.upsert_vectors")
@patch("app.routers.documents.pinecone_service.save_document_to_pinecone")
@patch("app.routers.documents.lexical_index.add_chunks")
def test_upload_within_100mb_limit(
    mock_add_chunks,
    mock_save_doc,
    mock_upsert_vectors,
    mock_embed_texts,
    mock_chunk_doc,
    mock_extract_doc,
    auth_headers,
    mock_current_user
):
    mock_extract_doc.return_value = [MagicMock(page_number=1, text="Sample text", tables=[])]
    mock_chunk_doc.return_value = [{"id": "chunk_1", "content": "Sample text", "chunk_index": 0, "page_number": 1}]
    mock_embed_texts.return_value = [[0.1] * 384]
    mock_upsert_vectors.return_value = 1

    content = b"Tax Notice content within size limit"
    with patch("app.services.auth.get_current_user_optional", return_value=mock_current_user):
        response = client.post(
            "/api/documents/upload",
            files={"file": ("tax_notice.txt", io.BytesIO(content), "text/plain")},
            data={"family_entity_id": "default_family", "allowed_role": "family_member"},
            headers=auth_headers
        )
        assert response.status_code == 201
        assert response.json()["total_vectors_indexed"] == 1
        mock_save_doc.assert_called_once()


@patch("app.routers.documents.extractor.extract_document")
@patch("app.routers.documents.chunker.chunk_document")
@patch("app.routers.documents.embeddings.embed_texts")
@patch("app.routers.documents.pinecone_service.upsert_vectors")
@patch("app.routers.documents.pinecone_service.save_document_to_pinecone")
@patch("app.routers.documents.lexical_index.add_chunks")
def test_batch_upload_multiple_files(
    mock_add_chunks,
    mock_save_doc,
    mock_upsert_vectors,
    mock_embed_texts,
    mock_chunk_doc,
    mock_extract_doc,
    auth_headers,
    mock_current_user
):
    mock_extract_doc.return_value = [MagicMock(page_number=1, text="Sample text", tables=[])]
    mock_chunk_doc.return_value = [{"id": "chunk_1", "content": "Sample text", "chunk_index": 0, "page_number": 1}]
    mock_embed_texts.return_value = [[0.1] * 384]
    mock_upsert_vectors.return_value = 1

    files = [
        ("files", ("notice_1.txt", io.BytesIO(b"Notice 1"), "text/plain")),
        ("files", ("notice_2.txt", io.BytesIO(b"Notice 2"), "text/plain")),
    ]
    with patch("app.services.auth.get_current_user_optional", return_value=mock_current_user):
        response = client.post(
            "/api/documents/upload-batch",
            files=files,
            data={"family_entity_id": "default_family", "allowed_role": "family_member"},
            headers=auth_headers
        )
        assert response.status_code == 201
        data = response.json()
        assert data["total_files"] == 2
        assert data["successful_files"] == 2
        assert len(data["documents"]) == 2
        assert mock_save_doc.call_count == 2


@patch("app.routers.documents.pinecone_service.list_documents_from_pinecone")
def test_list_documents_pure_pinecone(mock_list_pinecone, auth_headers, mock_current_user):
    mock_list_pinecone.return_value = [
        {
            "id": "doc-1",
            "filename": "file1.pdf",
            "original_name": "file1.pdf",
            "mime_type": "application/pdf",
            "file_size": 1024,
            "file_hash": "hash1",
            "total_pages": 1,
            "family_entity_id": "default_family",
            "status": "indexed",
            "uploaded_at": "2026-10-28T10:00:00"
        },
        {
            "id": "doc-2",
            "filename": "file2.docx",
            "original_name": "file2.docx",
            "mime_type": "application/docx",
            "file_size": 2048,
            "file_hash": "hash2",
            "total_pages": 2,
            "family_entity_id": "default_family",
            "status": "indexed",
            "uploaded_at": "2026-10-28T10:05:00"
        }
    ]
    with patch("app.services.auth.get_current_user_optional", return_value=mock_current_user):
        response = client.get("/api/documents", headers=auth_headers)
        assert response.status_code == 200
        docs = response.json()
        assert len(docs) == 2
        assert docs[0]["original_name"] == "file1.pdf"
        assert docs[1]["original_name"] == "file2.docx"
