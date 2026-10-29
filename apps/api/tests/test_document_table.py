import pytest
from fastapi.testclient import TestClient
from unittest.mock import MagicMock, patch
from app.main import app
from app.services import auth

client = TestClient(app)

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

def test_get_document_table_requires_auth():
    response = client.get("/api/documents/mock_doc_id/table")
    assert response.status_code == 401

def test_get_document_table_not_found(auth_headers, mock_current_user):
    with patch("app.services.auth.get_current_user_optional", return_value=mock_current_user):
        response = client.get("/api/documents/non_existent_doc_id/table", headers=auth_headers)
        assert response.status_code == 404

def test_get_document_table_mocked(auth_headers, mock_current_user):
    mock_doc = {
        "id": "mock_doc_id",
        "filename": "transactions.csv",
        "original_name": "transactions.csv",
        "total_pages": 10,
        "columns": ["Date", "Amount", "Merchant"],
        "sample_rows": [["2023-01-01", "$50.00", "Store A"]],
        "family_entity_id": "default_family"
    }
    
    mock_chunk = MagicMock()
    mock_chunk.metadata = {
        "text": "### CSV Data Table (Rows 1 to 50 of 500)\nDate | Amount | Merchant\n--- | --- | ---\n2023-01-01 | $50.00 | Store A\n2023-01-02 | $75.00 | Store B"
    }
    
    mock_index = MagicMock()
    mock_fetch_res = MagicMock()
    mock_fetch_res.vectors = {"mock_doc_id_p1_t0": mock_chunk}
    mock_index.fetch.return_value = mock_fetch_res

    with patch("app.services.auth.get_current_user_optional", return_value=mock_current_user), \
         patch("app.services.pinecone_service.get_document_from_pinecone", return_value=mock_doc), \
         patch("app.services.pinecone_service.get_index", return_value=mock_index):
        
        response = client.get("/api/documents/mock_doc_id/table?page=1&page_size=50", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        assert data["document_id"] == "mock_doc_id"
        assert data["filename"] == "transactions.csv"
        assert data["columns"] == ["Date", "Amount", "Merchant"]
        assert len(data["rows"]) == 2
        assert data["total_rows"] == 500
        assert data["page"] == 1
        assert data["total_pages"] == 10
