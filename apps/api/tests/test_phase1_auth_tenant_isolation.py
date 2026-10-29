import io
import uuid
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from app.main import app
from app.services import auth
from app.db import sqlite

client = TestClient(app)

@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_auth_isolation.db"
    monkeypatch.setattr("app.config.settings.SQLITE_DB_PATH", str(test_db))
    sqlite.init_db()


def test_unauthenticated_endpoints_return_401():
    endpoints = [
        ("POST", "/api/query", {"question": "What is our balance?", "family_entity_id": "fam_123"}),
        ("POST", "/api/query/stream", {"question": "What is our balance?", "family_entity_id": "fam_123"}),
        ("POST", "/api/dashboards", {"question": "Plot revenue", "family_entity_id": "fam_123"}),
        ("POST", "/api/voice/transcribe", None),
        ("POST", "/api/voice/synthesize", {"text": "Hello Australian Wealth"}),
        ("POST", "/api/voice/ask", None),
        ("POST", "/api/documents/upload", None),
        ("GET", "/api/documents", None),
        ("GET", "/api/documents/suggestions", None),
        ("GET", "/api/documents/some_doc_id", None),
        ("GET", "/api/documents/some_doc_id/table", None),
    ]

    for method, path, json_data in endpoints:
        if method == "POST":
            if json_data:
                res = client.post(path, json=json_data)
            else:
                res = client.post(path)
        else:
            res = client.get(path)
        assert res.status_code == 401, f"Expected 401 for {method} {path}, got {res.status_code}"


def test_invalid_token_returns_401():
    res = client.get("/api/documents", headers={"Authorization": "Bearer invalid_garbage_token"})
    assert res.status_code == 401


def test_registration_provisions_isolated_family_entity():
    unique_email = f"test_{uuid.uuid4().hex[:8]}@example.com"
    payload = {
        "email": unique_email,
        "password": "Password123!",
        "full_name": "Alexander Sterling",
        "family_entity_name": "Sterling Family Office"
    }
    res = client.post("/api/auth/register", json=payload)
    assert res.status_code == 201
    data = res.json()
    assert "access_token" in data
    user = data["user"]
    assert user["email"] == unique_email
    assert len(user["memberships"]) == 1
    
    membership = user["memberships"][0]
    assigned_entity = membership["family_entity_id"]
    # Guarantee it is NOT default_family
    assert assigned_entity != "default_family"
    assert assigned_entity.startswith("fam_")
    assert membership["role"] == "family_admin"


def test_cross_tenant_query_denied():
    user_a_token = auth.create_access_token({"sub": "user_a", "email": "a@example.com"})
    mock_user_a = {
        "id": "user_a",
        "email": "a@example.com",
        "memberships": [{"family_entity_id": "fam_tenant_a", "role": "family_admin"}]
    }

    with patch("app.services.auth.get_current_user_optional", return_value=mock_user_a):
        # Querying tenant B when member only of tenant A
        res = client.post(
            "/api/query",
            json={"question": "What is our balance?", "family_entity_id": "fam_tenant_b"},
            headers={"Authorization": f"Bearer {user_a_token}"}
        )
        assert res.status_code == 403
        assert "Access denied" in res.json()["detail"]


def test_cross_tenant_voice_ask_denied():
    user_a_token = auth.create_access_token({"sub": "user_a", "email": "a@example.com"})
    mock_user_a = {
        "id": "user_a",
        "email": "a@example.com",
        "memberships": [{"family_entity_id": "fam_tenant_a", "role": "family_admin"}]
    }

    with patch("app.services.auth.get_current_user_optional", return_value=mock_user_a), \
         patch("app.routers.voice._transcribe", return_value="What is our total spend?"):
        
        file_payload = ("voice.webm", io.BytesIO(b"audio bytes"), "audio/webm")
        res = client.post(
            "/api/voice/ask",
            files={"file": file_payload},
            data={"family_entity_id": "fam_tenant_b"},
            headers={"Authorization": f"Bearer {user_a_token}"}
        )
        assert res.status_code == 403
        assert "Access denied" in res.json()["detail"]


def test_cross_tenant_upload_denied():
    user_a_token = auth.create_access_token({"sub": "user_a", "email": "a@example.com"})
    mock_user_a = {
        "id": "user_a",
        "email": "a@example.com",
        "memberships": [{"family_entity_id": "fam_tenant_a", "role": "family_admin"}]
    }

    with patch("app.services.auth.get_current_user_optional", return_value=mock_user_a):
        res = client.post(
            "/api/documents/upload",
            files={"file": ("doc.txt", io.BytesIO(b"Some text"), "text/plain")},
            data={"family_entity_id": "fam_tenant_b", "allowed_role": "family_member"},
            headers={"Authorization": f"Bearer {user_a_token}"}
        )
        assert res.status_code == 403
        assert "Access denied" in res.json()["detail"]


def test_readonly_adviser_upload_denied():
    user_adviser_token = auth.create_access_token({"sub": "user_adv", "email": "adv@example.com"})
    mock_adviser = {
        "id": "user_adv",
        "email": "adv@example.com",
        "memberships": [{"family_entity_id": "fam_tenant_a", "role": "read_only_adviser"}]
    }

    with patch("app.services.auth.get_current_user_optional", return_value=mock_adviser):
        res = client.post(
            "/api/documents/upload",
            files={"file": ("doc.txt", io.BytesIO(b"Some text"), "text/plain")},
            data={"family_entity_id": "fam_tenant_a", "allowed_role": "family_member"},
            headers={"Authorization": f"Bearer {user_adviser_token}"}
        )
        assert res.status_code == 403
        assert "Read-only advisers are not permitted to upload documents." in res.json()["detail"]


def test_cross_tenant_document_view_denied():
    user_a_token = auth.create_access_token({"sub": "user_a", "email": "a@example.com"})
    mock_user_a = {
        "id": "user_a",
        "email": "a@example.com",
        "memberships": [{"family_entity_id": "fam_tenant_a", "role": "family_admin"}]
    }

    mock_doc_b = {
        "id": "doc_b_id",
        "filename": "confidential_b.pdf",
        "original_name": "confidential_b.pdf",
        "mime_type": "application/pdf",
        "file_size": 1024,
        "file_hash": "hash_b",
        "total_pages": 1,
        "family_entity_id": "fam_tenant_b",
        "status": "indexed",
        "uploaded_at": "2026-10-28T10:00:00"
    }

    with patch("app.services.auth.get_current_user_optional", return_value=mock_user_a), \
         patch("app.services.pinecone_service.get_document_from_pinecone", return_value=mock_doc_b):
        
        res = client.get("/api/documents/doc_b_id", headers={"Authorization": f"Bearer {user_a_token}"})
        assert res.status_code == 403
        assert "Access denied" in res.json()["detail"]
