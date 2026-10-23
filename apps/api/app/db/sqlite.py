import sqlite3
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from app.config import settings


def get_db_connection() -> sqlite3.Connection:
    db_path = Path(settings.SQLITE_DB_PATH)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Users table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                hashed_password TEXT NOT NULL,
                full_name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

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
                file_hash TEXT NOT NULL UNIQUE,
                total_pages INTEGER DEFAULT 1,
                family_entity_id TEXT NOT NULL,
                status TEXT DEFAULT 'indexed',
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (family_entity_id) REFERENCES family_entities(id) ON DELETE CASCADE
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
                action TEXT NOT NULL,
                resource_id TEXT,
                details TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        # Performance and lookup indexes
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON document_chunks(document_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_page ON document_chunks(page_number);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_doc_acl ON document_acl(document_id, family_entity_id);")

        # Seed default family entity
        cursor.execute("""
            INSERT OR IGNORE INTO family_entities (id, name, entity_type)
            VALUES ('default_family', 'Default Family Trust', 'Family Trust');
        """)

        conn.commit()


# --- User & Family Operations ---

def create_user(user: Dict[str, Any]) -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO users (id, email, hashed_password, full_name)
            VALUES (?, ?, ?, ?)
        """, (user["id"], user["email"], user["hashed_password"], user["full_name"]))
        conn.commit()


def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE email = ?", (email.lower().strip(),))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def create_family_entity(entity: Dict[str, Any]) -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR IGNORE INTO family_entities (id, name, entity_type)
            VALUES (?, ?, ?)
        """, (entity["id"], entity["name"], entity.get("entity_type", "Family Trust")))
        conn.commit()


def get_family_entity(entity_id: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM family_entities WHERE id = ?", (entity_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def create_membership(membership: Dict[str, Any]) -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO memberships (id, user_id, family_entity_id, role)
            VALUES (?, ?, ?, ?)
        """, (membership["id"], membership["user_id"], membership["family_entity_id"], membership["role"]))
        conn.commit()


def get_user_memberships(user_id: str) -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT m.*, e.name as entity_name, e.entity_type
            FROM memberships m
            JOIN family_entities e ON m.family_entity_id = e.id
            WHERE m.user_id = ?
        """, (user_id,))
        return [dict(r) for r in cursor.fetchall()]


# --- Document & ACL Operations ---

def insert_document(doc: Dict[str, Any]) -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO documents 
            (id, filename, original_name, mime_type, file_size, file_hash, total_pages, family_entity_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            doc["id"],
            doc["filename"],
            doc["original_name"],
            doc["mime_type"],
            doc["file_size"],
            doc["file_hash"],
            doc.get("total_pages", 1),
            doc["family_entity_id"],
            doc.get("status", "indexed")
        ))
        conn.commit()


def insert_document_acl(document_id: str, family_entity_id: str, allowed_role: str) -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        acl_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO document_acl (id, document_id, family_entity_id, allowed_role)
            VALUES (?, ?, ?, ?)
        """, (acl_id, document_id, family_entity_id, allowed_role))
        conn.commit()


def get_document_allowed_roles(document_id: str, family_entity_id: str) -> List[str]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT allowed_role FROM document_acl 
            WHERE document_id = ? AND family_entity_id = ?
        """, (document_id, family_entity_id))
        return [r["allowed_role"] for r in cursor.fetchall()]


def insert_chunks(chunks: List[Dict[str, Any]]) -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.executemany("""
            INSERT OR REPLACE INTO document_chunks 
            (id, document_id, chunk_index, page_number, section_title, content, is_table)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, [
            (
                c["id"],
                c["document_id"],
                c["chunk_index"],
                c["page_number"],
                c.get("section_title"),
                c["content"],
                c.get("is_table", False)
            )
            for c in chunks
        ])
        conn.commit()


def get_chunks_by_ids(chunk_ids: List[str]) -> List[Dict[str, Any]]:
    if not chunk_ids:
        return []
    with get_db_connection() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in chunk_ids)
        query = f"""
            SELECT c.*, d.original_name as document_name, d.family_entity_id
            FROM document_chunks c
            JOIN documents d ON c.document_id = d.id
            WHERE c.id IN ({placeholders})
        """
        cursor.execute(query, chunk_ids)
        rows = cursor.fetchall()
        results_map = {row["id"]: dict(row) for row in rows}
        return [results_map[cid] for cid in chunk_ids if cid in results_map]


def get_documents_by_entity(entity_id: str, user_role: str) -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        query = """
            SELECT DISTINCT d.* 
            FROM documents d
            JOIN document_acl acl ON d.id = acl.document_id
            WHERE d.family_entity_id = ? 
              AND (acl.allowed_role = ? OR acl.allowed_role = 'family_member' OR ? = 'family_admin')
            ORDER BY d.uploaded_at DESC
        """
        cursor.execute(query, (entity_id, user_role, user_role))
        return [dict(row) for row in cursor.fetchall()]


def get_all_documents() -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM documents ORDER BY uploaded_at DESC")
        return [dict(row) for row in cursor.fetchall()]


def get_document_by_id(doc_id: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM documents WHERE id = ?", (doc_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


# --- Audit Logging ---

def log_audit_event(action: str, user_id: Optional[str] = None, resource_id: Optional[str] = None, details: Optional[str] = None) -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO audit_events (id, user_id, action, resource_id, details)
            VALUES (?, ?, ?, ?, ?)
        """, (str(uuid.uuid4()), user_id, action, resource_id, details))
        conn.commit()


def get_audit_events(limit: int = 50) -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT ?", (limit,))
        return [dict(r) for r in cursor.fetchall()]
