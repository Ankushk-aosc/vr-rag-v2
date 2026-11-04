"""Database compatibility shim.

Exposes the legacy `app.db.sqlite` API for zero breaking changes across routers,
delegating to repository implementations backed by either SQLite or PostgreSQL
based on `settings.DATABASE_URL`.
"""

import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import is_dev_environment, settings
from app.db.repositories import (
    get_audit_repository,
    get_document_repository,
    get_family_repository,
    get_local_index_repository,
    get_token_repository,
    get_user_repository,
    is_postgres,
)

logger = logging.getLogger(__name__)


def get_db_connection() -> sqlite3.Connection:
    """Returns a raw SQLite connection for backward compatibility and tests."""
    db_path = Path(settings.SQLITE_DB_PATH)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    """Initializes tables and seeds default demo administrator."""
    if is_postgres():
        from app.db.postgres_setup import prepare_database
        from app.db.session import get_engine

        # Schema comes from the Alembic migrations (RLS included), never create_all (Audit I-16)
        prepare_database(get_engine())
        seed_default_demo_admin()
        return

    # SQLite schema initialization
    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Users table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                hashed_password TEXT NOT NULL,
                full_name TEXT NOT NULL,
                token_version INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        # Session version (Audit I-15): bumped on password change to invalidate every older token
        cursor.execute("PRAGMA table_info(users);")
        if "token_version" not in [c[1] for c in cursor.fetchall()]:
            cursor.execute("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;")

        # Family Entities (e.g. Smith Family Trust, Personal Portfolio)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS family_entities (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                entity_type TEXT NOT NULL DEFAULT 'Family Trust',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        # Memberships: maps user to family entity with specific role
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS memberships (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                family_entity_id TEXT NOT NULL,
                role TEXT NOT NULL, -- 'family_admin', 'family_member', 'read_only_adviser'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (family_entity_id) REFERENCES family_entities(id) ON DELETE CASCADE,
                UNIQUE(user_id, family_entity_id)
            );
        """)

        # Documents registry
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                original_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_hash TEXT NOT NULL,
                total_pages INTEGER DEFAULT 1,
                family_entity_id TEXT NOT NULL,
                status TEXT DEFAULT 'indexed',
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (family_entity_id) REFERENCES family_entities(id) ON DELETE CASCADE,
                UNIQUE(family_entity_id, file_hash)
            );
        """)

        # Document ACL rules
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS document_acl (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                family_entity_id TEXT NOT NULL,
                allowed_role TEXT NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY (family_entity_id) REFERENCES family_entities(id) ON DELETE CASCADE
            );
        """)

        # Raw document chunks with strict page provenance
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS document_chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                page_number INTEGER NOT NULL,
                section_title TEXT,
                content TEXT NOT NULL,
                is_table BOOLEAN DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );
        """)

        # Redacted Audit Log
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS audit_events (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                family_entity_id TEXT,
                action TEXT NOT NULL,
                resource_id TEXT,
                details TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        cursor.execute("PRAGMA table_info(audit_events);")
        audit_cols = [c[1] for c in cursor.fetchall()]
        if "family_entity_id" not in audit_cols:
            cursor.execute("ALTER TABLE audit_events ADD COLUMN family_entity_id TEXT;")

        # Revoked Tokens (for session logout and token revocation)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS revoked_tokens (
                jti TEXT PRIMARY KEY,
                user_id TEXT,
                revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP
            );
        """)

        # Local vector index and document display metadata (Audit I-09, PRIVACY_MODE=local)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS chunk_vectors (
                chunk_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                family_entity_id TEXT NOT NULL,
                allowed_roles TEXT NOT NULL,
                embedder_model TEXT,
                embedding_dim INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY (family_entity_id) REFERENCES family_entities(id) ON DELETE CASCADE
            );
        """)
                # Conversations and Messages
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT 'Financial Inquiry',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (tenant_id) REFERENCES family_entities(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                citations_json TEXT,
                metadata_json TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS document_meta (
                document_id TEXT PRIMARY KEY,
                family_entity_id TEXT NOT NULL,
                meta_json TEXT NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY (family_entity_id) REFERENCES family_entities(id) ON DELETE CASCADE
            );
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunk_vectors_family ON chunk_vectors(family_entity_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunk_vectors_doc ON chunk_vectors(document_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_document_meta_family ON document_meta(family_entity_id);")

        # Performance and lookup indexes
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON document_chunks(document_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_page ON document_chunks(page_number);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_doc_acl ON document_acl(document_id, family_entity_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_family ON audit_events(family_entity_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id);")

        # Document security metadata for ABAC: owner and classification. Existing rows take their
        # classification from the ACL (admin-only documents are "restricted"), matching migration 008.
        cursor.execute("PRAGMA table_info(documents);")
        doc_cols = [c[1] for c in cursor.fetchall()]
        if "owner_user_id" not in doc_cols:
            cursor.execute("ALTER TABLE documents ADD COLUMN owner_user_id TEXT;")
        if "classification" not in doc_cols:
            cursor.execute("ALTER TABLE documents ADD COLUMN classification TEXT NOT NULL DEFAULT 'confidential';")
            cursor.execute(
                "UPDATE documents SET classification = 'restricted' WHERE id IN "
                "(SELECT document_id FROM document_acl WHERE allowed_role = 'family_admin');"
            )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_documents_family_class ON documents(family_entity_id, classification);")

        # LLM Usage (Token budget & cost tracking)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS llm_usage (
                id TEXT PRIMARY KEY,
                family_entity_id TEXT NOT NULL,
                user_id TEXT,
                route TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_tokens INTEGER DEFAULT 0,
                completion_tokens INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                cost_usd NUMERIC,
                run_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (family_entity_id) REFERENCES family_entities(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_llm_usage_family_created ON llm_usage(family_entity_id, created_at);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_llm_usage_user_created ON llm_usage(user_id, created_at);")

        # Seed default family entity
        cursor.execute("""
            INSERT OR IGNORE INTO family_entities (id, name, entity_type)
            VALUES ('default_family', 'Default Family Trust', 'Family Trust');
        """)

        conn.commit()

    seed_default_demo_admin()


def demo_admin_seeding_allowed() -> bool:
    """Only in development/test (Audit I-14), and only with a DEMO_ADMIN_PASSWORD from the environment:
    the repository carries no default credential."""
    return (
        bool(settings.SEED_DEMO_ADMIN)
        and is_dev_environment(settings.ENVIRONMENT)
        and bool(settings.DEMO_ADMIN_PASSWORD)
    )


def seed_default_demo_admin() -> None:
    if demo_admin_seeding_allowed():
        get_user_repository().seed_default_demo_admin()
        return

    # Fail loudly if a database seeded by an older build still carries the demo account
    if is_dev_environment(settings.ENVIRONMENT):
        return
    try:
        existing = get_user_by_email(settings.DEMO_ADMIN_EMAIL)
    except Exception:
        return
    if existing:
        logger.critical(
            "Demo administrator account '%s' exists in a %s environment. It was seeded with a publicly "
            "known password: delete it or reset its password immediately.",
            settings.DEMO_ADMIN_EMAIL, settings.ENVIRONMENT,
        )


# --- User & Family Operations ---

def create_user(user: Dict[str, Any]) -> None:
    get_user_repository().create_user(user)


def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    return get_user_repository().get_user_by_email(email)


def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    return get_user_repository().get_user_by_id(user_id)


def update_user_password(user_id: str, hashed_password: str) -> int:
    return get_user_repository().update_user_password(user_id, hashed_password)


def delete_user_account(user_id: str) -> bool:
    return get_user_repository().delete_user_account(user_id)


def create_family_entity(entity: Dict[str, Any]) -> None:
    get_family_repository().create_family_entity(entity)


def get_family_entity(entity_id: str) -> Optional[Dict[str, Any]]:
    return get_family_repository().get_family_entity(entity_id)


def create_membership(membership: Dict[str, Any]) -> None:
    get_family_repository().create_membership(membership)


def get_user_memberships(user_id: str) -> List[Dict[str, Any]]:
    return get_family_repository().get_user_memberships(user_id)


# --- Document & ACL Operations ---

def get_document_by_hash(family_entity_id: str, file_hash: str) -> Optional[Dict[str, Any]]:
    return get_document_repository().get_document_by_hash(family_entity_id, file_hash)


def insert_document(doc: Dict[str, Any]) -> None:
    get_document_repository().insert_document(doc)


def update_document_status(document_id: str, status: str) -> None:
    get_document_repository().update_document_status(document_id, status)


def delete_document(document_id: str) -> bool:
    return get_document_repository().delete_document(document_id)


def insert_document_acl(document_id: str, family_entity_id: str, allowed_role: str) -> None:
    repo = get_document_repository()
    repo.insert_document_acl(document_id, family_entity_id, allowed_role)
    # An admin-only ACL and the "restricted" classification are the same rule; keep them in step
    if allowed_role == "family_admin":
        repo.set_document_classification(document_id, "restricted")


def get_document_allowed_roles(document_id: str, family_entity_id: str) -> List[str]:
    return get_document_repository().get_document_allowed_roles(document_id, family_entity_id)


def insert_chunks(chunks: List[Dict[str, Any]]) -> None:
    get_document_repository().insert_chunks(chunks)


def get_chunks_by_ids(chunk_ids: List[str]) -> List[Dict[str, Any]]:
    return get_document_repository().get_chunks_by_ids(chunk_ids)


def get_chunk_ids_for_document(document_id: str, family_entity_id: str) -> List[str]:
    return get_document_repository().get_chunk_ids_for_document(document_id, family_entity_id)


def get_documents_by_entity(entity_id: str, user_role: str) -> List[Dict[str, Any]]:
    return get_document_repository().get_documents_by_entity(entity_id, user_role)


def get_authorized_document_ids(family_entity_id: str, classifications: List[str]) -> List[str]:
    """Ids of one tenant's usable documents whose classification is in the caller's clearance (DB-side filter)."""
    return get_document_repository().get_authorized_document_ids(family_entity_id, classifications)


def get_all_documents() -> List[Dict[str, Any]]:
    return get_document_repository().get_all_documents()


def get_lexical_chunks() -> List[Dict[str, Any]]:
    return get_document_repository().get_lexical_chunks()


def get_document_by_id(doc_id: str) -> Optional[Dict[str, Any]]:
    return get_document_repository().get_document_by_id(doc_id)


def get_document_names(family_entity_id: str) -> Dict[str, str]:
    return get_document_repository().get_document_names(family_entity_id)


# --- Audit Logging ---

def log_audit_event(
    action: str,
    user_id: Optional[str] = None,
    family_entity_id: Optional[str] = None,
    resource_id: Optional[str] = None,
    details: Optional[str] = None,
) -> None:
    get_audit_repository().log_audit_event(
        action=action,
        user_id=user_id,
        family_entity_id=family_entity_id,
        resource_id=resource_id,
        details=details,
    )


def get_audit_events_for_entities(entity_ids: List[str], limit: int = 50) -> List[Dict[str, Any]]:
    return get_audit_repository().get_audit_events_for_entities(entity_ids, limit=limit)


def get_audit_events_for_user(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    return get_audit_repository().get_audit_events_for_user(user_id, limit=limit)


def get_audit_events(limit: int = 50, family_entity_id: Optional[str] = None) -> List[Dict[str, Any]]:
    return get_audit_repository().get_audit_events(limit=limit, family_entity_id=family_entity_id)


# --- Token Revocation & User Lifecycle ---

def revoke_token(jti: str, user_id: str, expires_at: Optional[str] = None) -> None:
    get_token_repository().revoke_token(jti, user_id, expires_at)


def is_token_revoked(jti: str) -> bool:
    return get_token_repository().is_token_revoked(jti)


def cleanup_expired_tokens() -> int:
    return get_token_repository().cleanup_expired_tokens()


# --- Local vector index & document display metadata (Audit I-09) ---

def upsert_chunk_vectors(rows: List[Dict[str, Any]]) -> int:
    return get_local_index_repository().upsert_chunk_vectors(rows)


def get_chunk_vectors(family_entity_id: str) -> List[Dict[str, Any]]:
    return get_local_index_repository().get_chunk_vectors(family_entity_id)


def delete_chunk_vectors(document_id: str, family_entity_id: str) -> int:
    return get_local_index_repository().delete_chunk_vectors(document_id, family_entity_id)


def get_chunks_without_vectors(family_entity_id: str) -> List[Dict[str, Any]]:
    return get_local_index_repository().get_chunks_without_vectors(family_entity_id)


def upsert_document_meta(document_id: str, family_entity_id: str, meta: Dict[str, Any]) -> None:
    get_local_index_repository().upsert_document_meta(document_id, family_entity_id, meta)


def get_document_meta(document_id: str) -> Optional[Dict[str, Any]]:
    return get_local_index_repository().get_document_meta(document_id)


def list_document_meta(family_entity_id: str) -> Dict[str, Dict[str, Any]]:
    return get_local_index_repository().list_document_meta(family_entity_id)


# --- Conversations & Messages (Tenant & User scoped) ---

def create_conversation(tenant_id: str, user_id: str, title: str = "Financial Inquiry") -> Dict[str, Any]:
    import uuid
    conv_id = str(uuid.uuid4())
    with get_db_connection() as conn:
        conn.execute(
            "INSERT INTO conversations (id, tenant_id, user_id, title) VALUES (?, ?, ?, ?);",
            (conv_id, tenant_id, user_id, title)
        )
        conn.commit()
    return {"id": conv_id, "tenant_id": tenant_id, "user_id": user_id, "title": title}


def get_conversation(conversation_id: str, tenant_id: str, user_id: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, tenant_id, user_id, title, created_at FROM conversations WHERE id = ? AND tenant_id = ? AND user_id = ?;",
            (conversation_id, tenant_id, user_id)
        )
        row = cur.fetchone()
        return dict(row) if row else None


def list_conversations(tenant_id: str, user_id: str) -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, tenant_id, user_id, title, created_at FROM conversations WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC;",
            (tenant_id, user_id)
        )
        return [dict(r) for r in cur.fetchall()]


def delete_conversation(conversation_id: str, tenant_id: str, user_id: str) -> bool:
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM conversations WHERE id = ? AND tenant_id = ? AND user_id = ?;",
            (conversation_id, tenant_id, user_id)
        )
        conn.commit()
        return cur.rowcount > 0


def add_message(
    conversation_id: str,
    role: str,
    content: str,
    citations_json: Optional[str] = None,
    metadata_json: Optional[str] = None
) -> Dict[str, Any]:
    import uuid
    msg_id = str(uuid.uuid4())
    with get_db_connection() as conn:
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, citations_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?);",
            (msg_id, conversation_id, role, content, citations_json, metadata_json)
        )
        conn.commit()
    return {"id": msg_id, "conversation_id": conversation_id, "role": role, "content": content}


def list_messages(conversation_id: str) -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, conversation_id, role, content, citations_json, metadata_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC;",
            (conversation_id,)
        )
        return [dict(r) for r in cur.fetchall()]
