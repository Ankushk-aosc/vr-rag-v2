import io
import uuid
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.db import sqlite
from app.services import auth, grounding
from app.services.lexical_index import lexical_index
from app.middleware.rate_limiter import limiter

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    """Isolate SQLite database and clear rate limiter state for each test run."""
    test_db = tmp_path / "test_phase7_matrix.db"
    monkeypatch.setattr("app.config.settings.SQLITE_DB_PATH", str(test_db))
    sqlite.init_db()
    limiter.reset()


def _register_user(name: str, org: str):
    email = f"{name.lower().replace(' ', '_')}_{uuid.uuid4().hex[:6]}@sterlingfamily.com.au"
    res = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "SecurePassword123!",
            "full_name": name,
            "family_entity_name": org,
        },
    )
    assert res.status_code == 201
    data = res.json()
    family_entity_id = data["user"]["memberships"][0]["family_entity_id"]
    return {
        "access_token": data["access_token"],
        "user": data["user"],
        "family_entity_id": family_entity_id,
    }


# 1. Unauthenticated requests to protected endpoints return HTTP 401
def test_anonymous_access_denied():
    """Verify that unauthenticated requests cannot access any protected endpoints."""
    protected_endpoints = [
        ("GET", "/api/documents"),
        ("POST", "/api/documents/upload"),
        ("GET", "/api/documents/doc_123"),
        ("GET", "/api/documents/doc_123/table"),
        ("DELETE", "/api/documents/doc_123"),
        ("POST", "/api/query"),
        ("POST", "/api/query/stream"),
        ("POST", "/api/dashboards"),
        ("POST", "/api/voice/transcribe"),
        ("POST", "/api/voice/synthesize"),
        ("POST", "/api/voice/ask"),
        ("GET", "/api/auth/me"),
        ("GET", "/api/auth/audit"),
    ]

    for method, path in protected_endpoints:
        if method == "POST":
            res = client.post(path)
        elif method == "DELETE":
            res = client.delete(path)
        else:
            res = client.get(path)

        assert res.status_code == 401, f"Expected 401 for {method} {path}, got {res.status_code}"


# 2. User in Family A querying Family B returns HTTP 403
def test_cross_tenant_query_isolation():
    """Verify that a user in Family Alpha cannot query or access Family Beta's vault."""
    user_a = _register_user("Alice Alpha", "Alpha Family Office")
    user_b = _register_user("Bob Beta", "Beta Family Office")

    token_a = user_a["access_token"]
    family_beta_id = user_b["family_entity_id"]

    headers_a = {"Authorization": f"Bearer {token_a}"}

    query_payload = {
        "question": "What are our total dividend returns for FY2024?",
        "family_entity_id": family_beta_id,
    }

    res = client.post("/api/query", json=query_payload, headers=headers_a)
    assert res.status_code == 403
    assert "Access denied" in res.json()["detail"]


# 3. User in Family A cannot retrieve document metadata, tables, or delete Family B's docs
def test_cross_tenant_document_leak():
    """Verify that cross-tenant document metadata, table inspection, and deletion are rejected with 403."""
    user_a = _register_user("Alice Alpha", "Alpha Family Office")
    user_b = _register_user("Bob Beta", "Beta Family Office")

    token_a = user_a["access_token"]
    family_b_id = user_b["family_entity_id"]
    headers_a = {"Authorization": f"Bearer {token_a}"}

    # Insert a document belonging to Family Beta
    doc_b_id = f"doc_{uuid.uuid4().hex[:8]}"
    sqlite.insert_document({
        "id": doc_b_id,
        "filename": "Beta_Holdings.pdf",
        "original_name": "Beta_Holdings.pdf",
        "mime_type": "application/pdf",
        "file_size": 10240,
        "file_hash": "hash_beta_secret_123",
        "family_entity_id": family_b_id,
        "total_pages": 5,
    })

    mock_doc = {
        "id": doc_b_id,
        "filename": "Beta_Holdings.pdf",
        "original_name": "Beta_Holdings.pdf",
        "mime_type": "application/pdf",
        "file_size": 10240,
        "file_hash": "hash_beta_secret_123",
        "family_entity_id": family_b_id,
        "total_pages": 5,
        "status": "indexed",
        "uploaded_at": "2026-10-29T00:00:00Z",
    }

    with patch("app.routers.documents.pinecone_service.get_document_from_pinecone", return_value=mock_doc):
        # A. Metadata access rejected
        res_meta = client.get(f"/api/documents/{doc_b_id}", headers=headers_a)
        assert res_meta.status_code == 403
        assert "Access denied" in res_meta.json()["detail"]

        # B. Table data access rejected
        res_table = client.get(f"/api/documents/{doc_b_id}/table", headers=headers_a)
        assert res_table.status_code == 403

        # C. Deletion rejected
        res_del = client.delete(f"/api/documents/{doc_b_id}", headers=headers_a)
        assert res_del.status_code == 403


# 4. Uploading identical file bytes across different families does not delete or overwrite either file
def test_duplicate_upload_non_destructive():
    """Verify multi-tenant safe hashing: UNIQUE(family_entity_id, file_hash) preserves cross-tenant copies."""
    user_a = _register_user("Alice Alpha", "Alpha Family Office")
    user_b = _register_user("Bob Beta", "Beta Family Office")

    fam_a_id = user_a["family_entity_id"]
    fam_b_id = user_b["family_entity_id"]

    shared_hash = "shared_financial_statement_hash_999"

    # Family A inserts document
    doc_a_id = f"doc_{uuid.uuid4().hex[:8]}"
    sqlite.insert_document({
        "id": doc_a_id,
        "filename": "Tax_Return_2024.pdf",
        "original_name": "Tax_Return_2024.pdf",
        "mime_type": "application/pdf",
        "file_size": 20480,
        "file_hash": shared_hash,
        "family_entity_id": fam_a_id,
        "total_pages": 10,
    })

    # Family B inserts document with identical bytes and file_hash
    doc_b_id = f"doc_{uuid.uuid4().hex[:8]}"
    sqlite.insert_document({
        "id": doc_b_id,
        "filename": "Tax_Return_2024.pdf",
        "original_name": "Tax_Return_2024.pdf",
        "mime_type": "application/pdf",
        "file_size": 20480,
        "file_hash": shared_hash,
        "family_entity_id": fam_b_id,
        "total_pages": 10,
    })

    # Both documents must exist independently in SQLite
    doc_a = sqlite.get_document_by_id(doc_a_id)
    doc_b = sqlite.get_document_by_id(doc_b_id)

    assert doc_a is not None
    assert doc_b is not None
    assert doc_a["id"] != doc_b["id"]
    assert doc_a["family_entity_id"] == fam_a_id
    assert doc_b["family_entity_id"] == fam_b_id
    assert doc_a["file_hash"] == doc_b["file_hash"]


# 5. Deleting a document removes metadata from SQLite, vectors from Pinecone, and entries from BM25
@pytest.mark.usefixtures("cloud_mode")
def test_document_deletion_cascade():
    """Verify sovereign deletion cascades across SQLite, Pinecone, and BM25 index."""
    user_a = _register_user("Alice Admin", "Alpha Family Office")
    token_a = user_a["access_token"]
    fam_a_id = user_a["family_entity_id"]
    headers_a = {"Authorization": f"Bearer {token_a}"}

    doc_id = f"doc_{uuid.uuid4().hex[:8]}"
    sqlite.insert_document({
        "id": doc_id,
        "filename": "Portfolio_Statement.pdf",
        "original_name": "Portfolio_Statement.pdf",
        "mime_type": "application/pdf",
        "file_size": 5000,
        "file_hash": "hash_delete_cascade_123",
        "family_entity_id": fam_a_id,
        "total_pages": 2,
    })

    # Seed BM25 index with chunks
    test_chunks = [
        {
            "chunk_id": f"{doc_id}_c0",
            "document_id": doc_id,
            "text": "Alpha investment distribution of AUD $25,000 to beneficiaries.",
            "family_entity_id": fam_a_id,
            "allowed_roles": ["family_admin"],
        }
    ]
    lexical_index.add_chunks(test_chunks)
    assert len(lexical_index.search("distribution", fam_a_id, user_roles=["family_admin"], top_k=5)) > 0

    mock_pinecone = {
        "id": doc_id,
        "filename": "Portfolio_Statement.pdf",
        "original_name": "Portfolio_Statement.pdf",
        "family_entity_id": fam_a_id,
        "status": "indexed",
    }

    with patch("app.routers.documents.pinecone_service.get_document_from_pinecone", return_value=mock_pinecone), \
         patch("app.routers.documents.pinecone_service.delete_document_from_pinecone") as mock_del_pinecone:

        del_res = client.delete(f"/api/documents/{doc_id}", headers=headers_a)
        assert del_res.status_code == 200
        assert del_res.json()["document_id"] == doc_id

        # 1. Removed from SQLite
        assert sqlite.get_document_by_id(doc_id) is None

        # 2. Cascade called to Pinecone
        mock_del_pinecone.assert_called_once_with(doc_id, fam_a_id, chunk_ids=[])

        # 3. Chunks removed from BM25 index
        bm25_matches = lexical_index.search("distribution", fam_a_id, user_roles=["family_admin"], top_k=5)
        assert not any(m["document_id"] == doc_id for m in bm25_matches)


# 6. Answers with hallucinated numbers are flagged as ungrounded
def test_numeric_grounding_verification():
    """Verify that claims containing hallucinated numbers not present in evidence fail grounding."""
    citations = [
        {
            "ref": 1,
            "text": "The Macquarie Private Bank balance on 30 June was $450,000.00.",
            "document_name": "Bank_Statement.pdf",
        },
        {
            "ref": 2,
            "text": "Total franking credits claimed for FY2024 were $14,250.50.",
            "document_name": "Tax_Summary.pdf",
        },
    ]

    # Valid grounded answer citing ref 1 and 2 with authentic numbers
    grounded_answer = "Macquarie Private Bank held $450,000.00 [1] with franking credits of $14,250.50 [2]."
    res_grounded = grounding.verify_grounding(grounded_answer, citations)
    assert res_grounded["grounded"] is True
    assert len(res_grounded["unverified_numeric_claims"]) == 0

    # Hallucinated answer inventing financial figures
    hallucinated_answer = "The Macquarie Private Bank balance was $999,999,999.00 [1]."
    res_hallucinated = grounding.verify_grounding(hallucinated_answer, citations)
    assert res_hallucinated["grounded"] is False
    assert "$999,999,999.00" in res_hallucinated["unverified_numeric_claims"] or "999,999,999" in str(res_hallucinated["unverified_numeric_claims"])


# 7. Rate limiting: Excess requests receive HTTP 429
def test_rate_limiting():
    """Verify that requests exceeding window limits receive HTTP 429 and Retry-After."""
    # Login endpoint is limited to 20 requests per 60s
    for i in range(20):
        res = client.post("/api/auth/login", json={"email": "ratelimit_test@example.com", "password": "WrongPassword1!"})
        assert res.status_code == 401

    # 21st request must trigger rate limit
    res_exceeded = client.post("/api/auth/login", json={"email": "ratelimit_test@example.com", "password": "WrongPassword1!"})
    assert res_exceeded.status_code == 429
    assert "Rate limit exceeded" in res_exceeded.json()["detail"]
    assert "Retry-After" in res_exceeded.headers
