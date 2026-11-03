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
    test_db = tmp_path / "test_lifecycle.db"
    monkeypatch.setattr("app.config.settings.SQLITE_DB_PATH", str(test_db))
    sqlite.init_db()


def test_logout_revokes_jwt_token():
    user_id = str(uuid.uuid4())
    entity_id = "fam_test_logout"
    token = auth.create_access_token({"sub": user_id, "email": "logout_test@example.com"})

    sqlite.create_user({"id": user_id, "email": "logout_test@example.com", "hashed_password": "pwd", "full_name": "Logout Tester"})
    sqlite.create_family_entity({"id": entity_id, "name": "Logout Family", "entity_type": "Family Trust"})
    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": user_id, "family_entity_id": entity_id, "role": "family_admin"})

    headers = {"Authorization": f"Bearer {token}"}
    
    # Check token works initially
    res_me = client.get("/api/auth/me", headers=headers)
    assert res_me.status_code == 200

    # Logout
    res_logout = client.post("/api/auth/logout", headers=headers)
    assert res_logout.status_code == 200
    assert "Logged out successfully" in res_logout.json()["message"]

    # Subsequent request with revoked token must return 401
    res_after = client.get("/api/auth/me", headers=headers)
    assert res_after.status_code == 401
    assert "revoked" in res_after.json()["detail"].lower()


def test_password_reset_flow():
    user_id = str(uuid.uuid4())
    entity_id = "fam_test_pwd"
    initial_hashed = auth.hash_password("OldPassword123!")

    sqlite.create_user({"id": user_id, "email": "pwd_test@example.com", "hashed_password": initial_hashed, "full_name": "Pwd User"})
    sqlite.create_family_entity({"id": entity_id, "name": "Pwd Family", "entity_type": "Family Trust"})
    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": user_id, "family_entity_id": entity_id, "role": "family_admin"})

    token = auth.create_access_token({"sub": user_id, "email": "pwd_test@example.com"})
    headers = {"Authorization": f"Bearer {token}"}

    # Wrong current password
    res_bad = client.post(
        "/api/auth/password-reset",
        json={"current_password": "WrongPassword!", "new_password": "NewPassword123!"},
        headers=headers
    )
    assert res_bad.status_code == 400
    assert "verification failed" in res_bad.json()["detail"].lower()

    # Correct current password
    res_ok = client.post(
        "/api/auth/password-reset",
        json={"current_password": "OldPassword123!", "new_password": "NewPassword123!"},
        headers=headers
    )
    assert res_ok.status_code == 200

    # Verify user can log in with new password
    res_login = client.post(
        "/api/auth/login",
        json={"email": "pwd_test@example.com", "password": "NewPassword123!"}
    )
    assert res_login.status_code == 200


def test_account_deletion_erases_user():
    user_id = str(uuid.uuid4())
    entity_id = "fam_test_delete_acct"

    sqlite.create_user({"id": user_id, "email": "del_acct@example.com", "hashed_password": "pwd", "full_name": "Delete Tester"})
    sqlite.create_family_entity({"id": entity_id, "name": "Delete Family", "entity_type": "Family Trust"})
    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": user_id, "family_entity_id": entity_id, "role": "family_admin"})

    token = auth.create_access_token({"sub": user_id, "email": "del_acct@example.com"})
    headers = {"Authorization": f"Bearer {token}"}

    res_delete = client.delete("/api/auth/account", headers=headers)
    assert res_delete.status_code == 200
    assert "permanently deleted" in res_delete.json()["message"].lower()

    # User row should be gone
    assert sqlite.get_user_by_id(user_id) is None


@pytest.mark.usefixtures("cloud_mode")
def test_document_deletion_cascades_across_stores():
    user_id = str(uuid.uuid4())
    entity_id = "fam_test_del_doc"

    sqlite.create_user({"id": user_id, "email": "admin_del@example.com", "hashed_password": "pwd", "full_name": "Admin Del"})
    sqlite.create_family_entity({"id": entity_id, "name": "Del Family", "entity_type": "Family Trust"})
    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": user_id, "family_entity_id": entity_id, "role": "family_admin"})

    token = auth.create_access_token({"sub": user_id, "email": "admin_del@example.com"})
    headers = {"Authorization": f"Bearer {token}"}

    doc_id = "doc_to_delete_123"
    sqlite.insert_document({
        "id": doc_id,
        "filename": "del_notice.pdf",
        "original_name": "del_notice.pdf",
        "mime_type": "application/pdf",
        "file_size": 2048,
        "file_hash": "hash_del_123",
        "total_pages": 1,
        "family_entity_id": entity_id,
        "status": "indexed"
    })
    sqlite.insert_document_acl(doc_id, entity_id, "family_admin")
    sqlite.insert_chunks([{
        "id": f"{doc_id}_c0",
        "document_id": doc_id,
        "chunk_index": 0,
        "page_number": 1,
        "section_title": "P1",
        "content": "Secret content",
        "is_table": False
    }])

    with patch("app.services.pinecone_service.delete_document_from_pinecone") as mock_pine_del, \
         patch("app.services.lexical_index.lexical_index.delete_document_chunks") as mock_lex_del:
        
        res = client.delete(f"/api/documents/{doc_id}", headers=headers)
        assert res.status_code == 200
        assert "successfully deleted" in res.json()["message"]

        mock_pine_del.assert_called_once_with(doc_id, entity_id, chunk_ids=[f"{doc_id}_c0"])
        mock_lex_del.assert_called_once_with(doc_id)

    # SQLite rows must be deleted
    assert sqlite.get_document_by_id(doc_id) is None
    with sqlite.get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM document_chunks WHERE document_id = ?", (doc_id,))
        assert cursor.fetchone()[0] == 0


def test_document_deletion_denied_for_non_admin_and_wrong_tenant():
    admin_a_id = str(uuid.uuid4())
    member_a_id = str(uuid.uuid4())
    user_b_id = str(uuid.uuid4())
    entity_a = "fam_tenant_a"
    entity_b = "fam_tenant_b"

    sqlite.create_family_entity({"id": entity_a, "name": "Family A", "entity_type": "Family Trust"})
    sqlite.create_family_entity({"id": entity_b, "name": "Family B", "entity_type": "Family Trust"})

    sqlite.create_user({"id": admin_a_id, "email": "admin_a@example.com", "hashed_password": "pwd", "full_name": "Admin A"})
    sqlite.create_user({"id": member_a_id, "email": "member_a@example.com", "hashed_password": "pwd", "full_name": "Member A"})
    sqlite.create_user({"id": user_b_id, "email": "user_b@example.com", "hashed_password": "pwd", "full_name": "User B"})

    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": admin_a_id, "family_entity_id": entity_a, "role": "family_admin"})
    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": member_a_id, "family_entity_id": entity_a, "role": "family_member"})
    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": user_b_id, "family_entity_id": entity_b, "role": "family_admin"})

    doc_a_id = "doc_family_a"
    sqlite.insert_document({
        "id": doc_a_id,
        "filename": "fam_a.pdf",
        "original_name": "fam_a.pdf",
        "mime_type": "application/pdf",
        "file_size": 1024,
        "file_hash": "hash_a",
        "total_pages": 1,
        "family_entity_id": entity_a,
        "status": "indexed"
    })

    # Member in same family attempts delete -> 403 Forbidden
    member_a_token = auth.create_access_token({"sub": member_a_id, "email": "member_a@example.com"})
    res_member = client.delete(f"/api/documents/{doc_a_id}", headers={"Authorization": f"Bearer {member_a_token}"})
    assert res_member.status_code == 403
    assert "Only family_admin" in res_member.json()["detail"]

    # User in Family B attempts delete -> 403 Forbidden
    user_b_token = auth.create_access_token({"sub": user_b_id, "email": "user_b@example.com"})
    res_b = client.delete(f"/api/documents/{doc_a_id}", headers={"Authorization": f"Bearer {user_b_token}"})
    assert res_b.status_code == 403
    assert "Access denied" in res_b.json()["detail"]


@pytest.mark.usefixtures("cloud_mode")
@patch("app.routers.documents.extractor.extract_document")
@patch("app.routers.documents.chunker.chunk_document")
@patch("app.routers.documents.embeddings.embed_texts")
@patch("app.routers.documents.pinecone_service.upsert_vectors")
@patch("app.routers.documents.pinecone_service.save_document_to_pinecone")
@patch("app.routers.documents.lexical_index.add_chunks")
def test_f1_fix_duplicate_hash_across_different_families_does_not_overwrite(
    mock_add_chunks,
    mock_save_doc,
    mock_upsert_vectors,
    mock_embed_texts,
    mock_chunk_doc,
    mock_extract_doc
):
    """
    Finding F1 Verification:
    Uploading identical bytes into Family B must NOT overwrite, delete, or reassign Family A's document row.
    """
    mock_extract_doc.return_value = [MagicMock(page_number=1, text="Identical content", tables=[])]
    mock_chunk_doc.return_value = [{"id": "c1", "content": "Identical content", "chunk_index": 0, "page_number": 1}]
    mock_embed_texts.return_value = [[0.1] * 384]
    mock_upsert_vectors.return_value = 1

    entity_a = "fam_corp_a"
    entity_b = "fam_corp_b"
    user_a = "user_corp_a"
    user_b = "user_corp_b"

    sqlite.create_family_entity({"id": entity_a, "name": "Corp A", "entity_type": "Company"})
    sqlite.create_family_entity({"id": entity_b, "name": "Corp B", "entity_type": "Company"})
    sqlite.create_user({"id": user_a, "email": "a@corp.com", "hashed_password": "pwd", "full_name": "User A"})
    sqlite.create_user({"id": user_b, "email": "b@corp.com", "hashed_password": "pwd", "full_name": "User B"})
    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": user_a, "family_entity_id": entity_a, "role": "family_admin"})
    sqlite.create_membership({"id": str(uuid.uuid4()), "user_id": user_b, "family_entity_id": entity_b, "role": "family_admin"})

    token_a = auth.create_access_token({"sub": user_a, "email": "a@corp.com"})
    token_b = auth.create_access_token({"sub": user_b, "email": "b@corp.com"})

    identical_content = b"Exact identical statement bytes across companies"

    # 1. Family A uploads the document
    res_a = client.post(
        "/api/documents/upload",
        files={"file": ("statement.txt", io.BytesIO(identical_content), "text/plain")},
        data={"family_entity_id": entity_a, "allowed_role": "family_member"},
        headers={"Authorization": f"Bearer {token_a}"}
    )
    assert res_a.status_code == 201
    doc_a_id = res_a.json()["document"]["id"]

    # 2. Family A attempts re-uploading the exact same document -> 409 Conflict
    res_a_dup = client.post(
        "/api/documents/upload",
        files={"file": ("statement.txt", io.BytesIO(identical_content), "text/plain")},
        data={"family_entity_id": entity_a, "allowed_role": "family_member"},
        headers={"Authorization": f"Bearer {token_a}"}
    )
    assert res_a_dup.status_code == 409
    assert "already exists in this family vault" in res_a_dup.json()["detail"]

    # 3. Family B uploads the exact same document bytes
    res_b = client.post(
        "/api/documents/upload",
        files={"file": ("statement.txt", io.BytesIO(identical_content), "text/plain")},
        data={"family_entity_id": entity_b, "allowed_role": "family_member"},
        headers={"Authorization": f"Bearer {token_b}"}
    )
    assert res_b.status_code == 201
    doc_b_id = res_b.json()["document"]["id"]

    # Both documents must coexist in SQLite with different IDs and their respective family entities
    doc_a_db = sqlite.get_document_by_id(doc_a_id)
    doc_b_db = sqlite.get_document_by_id(doc_b_id)

    assert doc_a_db is not None
    assert doc_b_db is not None
    assert doc_a_db["family_entity_id"] == entity_a
    assert doc_b_db["family_entity_id"] == entity_b
    assert doc_a_db["file_hash"] == doc_b_db["file_hash"]
    assert doc_a_id != doc_b_id

