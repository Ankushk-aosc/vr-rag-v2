import uuid
import pytest
from app.db import sqlite
from app.services import auth


def test_password_hashing_and_verification():
    raw_password = "AustralianSecurePassword!2024"
    hashed = auth.hash_password(raw_password)

    assert hashed != raw_password
    assert "$" in hashed
    assert auth.verify_password(raw_password, hashed) is True
    assert auth.verify_password("WrongPassword123", hashed) is False


def test_jwt_token_lifecycle():
    user_payload = {"sub": "user_12345", "email": "trustee@smithfamily.com.au"}
    token = auth.create_access_token(user_payload)
    assert isinstance(token, str)

    decoded = auth.decode_access_token(token)
    assert decoded["sub"] == "user_12345"
    assert decoded["email"] == "trustee@smithfamily.com.au"


def test_family_acl_and_cross_tenant_isolation(tmp_path, monkeypatch):
    test_db = tmp_path / "test_acl.db"
    monkeypatch.setattr("app.config.settings.SQLITE_DB_PATH", str(test_db))
    sqlite.init_db()

    # 1. Setup Family Entities
    smith_entity_id = "smith_trust_01"
    jones_entity_id = "jones_trust_02"
    sqlite.create_family_entity({"id": smith_entity_id, "name": "Smith Family Trust"})
    sqlite.create_family_entity({"id": jones_entity_id, "name": "Jones Family Trust"})

    # 2. Setup Users
    alice_id = "user_alice"  # Smith Family Admin
    bob_id = "user_bob"      # Smith Family Member
    charlie_id = "user_charlie"  # Jones Family Member

    sqlite.create_user({"id": alice_id, "email": "alice@smith.au", "hashed_password": "p1", "full_name": "Alice Smith"})
    sqlite.create_user({"id": bob_id, "email": "bob@smith.au", "hashed_password": "p2", "full_name": "Bob Smith"})
    sqlite.create_user({"id": charlie_id, "email": "charlie@jones.au", "hashed_password": "p3", "full_name": "Charlie Jones"})

    sqlite.create_membership({"id": "m1", "user_id": alice_id, "family_entity_id": smith_entity_id, "role": "family_admin"})
    sqlite.create_membership({"id": "m2", "user_id": bob_id, "family_entity_id": smith_entity_id, "role": "family_member"})
    sqlite.create_membership({"id": "m3", "user_id": charlie_id, "family_entity_id": jones_entity_id, "role": "family_member"})

    # 3. Create Documents in Smith Trust: One Admin-Only, One Family-Wide
    doc_admin_only = {
        "id": "doc_admin_only",
        "filename": "trust_deed_distribution.pdf",
        "original_name": "trust_deed_distribution.pdf",
        "mime_type": "application/pdf",
        "file_size": 2048,
        "file_hash": "hash_deed",
        "total_pages": 4,
        "family_entity_id": smith_entity_id,
        "status": "indexed"
    }
    sqlite.insert_document(doc_admin_only)
    sqlite.insert_document_acl(document_id="doc_admin_only", family_entity_id=smith_entity_id, allowed_role="family_admin")

    doc_general = {
        "id": "doc_general",
        "filename": "family_tax_summary.pdf",
        "original_name": "family_tax_summary.pdf",
        "mime_type": "application/pdf",
        "file_size": 1024,
        "file_hash": "hash_tax",
        "total_pages": 2,
        "family_entity_id": smith_entity_id,
        "status": "indexed"
    }
    sqlite.insert_document(doc_general)
    sqlite.insert_document_acl(document_id="doc_general", family_entity_id=smith_entity_id, allowed_role="family_member")

    # 4. NEGATIVE SECURITY TEST 1: Bob (family_member) should NOT see doc_admin_only
    bob_docs = sqlite.get_documents_by_entity(smith_entity_id, user_role="family_member")
    bob_doc_ids = [d["id"] for d in bob_docs]
    assert "doc_general" in bob_doc_ids
    assert "doc_admin_only" not in bob_doc_ids  # Leakage prevented!

    # 5. POSITIVE TEST: Alice (family_admin) sees BOTH
    alice_docs = sqlite.get_documents_by_entity(smith_entity_id, user_role="family_admin")
    alice_doc_ids = [d["id"] for d in alice_docs]
    assert "doc_general" in alice_doc_ids
    assert "doc_admin_only" in alice_doc_ids

    # 6. NEGATIVE SECURITY TEST 2: Charlie (Jones Trust) sees ZERO Smith Trust documents
    charlie_docs = sqlite.get_documents_by_entity(jones_entity_id, user_role="family_member")
    assert len(charlie_docs) == 0

    # 7. Audit log verification
    sqlite.log_audit_event("TEST_EVENT", user_id=alice_id, resource_id="doc_admin_only", details="Verified")
    audit_events = sqlite.get_audit_events(limit=10)
    assert len(audit_events) >= 1
    assert audit_events[0]["action"] == "TEST_EVENT"
    assert audit_events[0]["user_id"] == alice_id
