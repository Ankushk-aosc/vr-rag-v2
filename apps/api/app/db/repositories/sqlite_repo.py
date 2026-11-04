import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings
from app.db.repositories.base import (
    BaseAuditRepository,
    BaseDocumentRepository,
    DuplicateDocumentError,
    BaseFamilyRepository,
    BaseTokenRepository,
    BaseUserRepository,
)


def get_db_connection() -> sqlite3.Connection:
    db_path = Path(settings.SQLITE_DB_PATH)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


class SqliteUserRepository(BaseUserRepository):
    def create_user(self, user: Dict[str, Any]) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO users (id, email, hashed_password, full_name)
                VALUES (?, ?, ?, ?)
            """,
                (user["id"], user["email"], user["hashed_password"], user["full_name"]),
            )
            conn.commit()

    def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE email = ?", (email.lower().strip(),))
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def update_user_password(self, user_id: str, hashed_password: str) -> int:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE users SET hashed_password = ?, token_version = token_version + 1 WHERE id = ?",
                (hashed_password, user_id),
            )
            row = cursor.execute("SELECT token_version FROM users WHERE id = ?", (user_id,)).fetchone()
            conn.commit()
            return int(row["token_version"]) if row else 0

    def delete_user_account(self, user_id: str) -> bool:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
            deleted = cursor.rowcount > 0
            conn.commit()
            return deleted

    def seed_default_demo_admin(self) -> None:
        demo_email = settings.DEMO_ADMIN_EMAIL
        demo_password = settings.DEMO_ADMIN_PASSWORD
        demo_entity_id = "default_family"
        user_id = "usr_demo_admin"

        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM users WHERE email = ?", (demo_email,))
            row = cursor.fetchone()
            if not row:
                from app.services.auth import hash_password

                hashed = hash_password(demo_password)
                cursor.execute(
                    "INSERT INTO users (id, email, hashed_password, full_name) VALUES (?, ?, ?, ?)",
                    (user_id, demo_email, hashed, "Sovereign Administrator"),
                )
                current_user_id = user_id
            else:
                current_user_id = row["id"]

            cursor.execute(
                """
                INSERT OR IGNORE INTO family_entities (id, name, entity_type)
                VALUES ('default_family', 'Default Family Trust', 'Family Trust');
            """
            )

            cursor.execute(
                "SELECT id FROM memberships WHERE user_id = ? AND family_entity_id = ?",
                (current_user_id, demo_entity_id),
            )
            if not cursor.fetchone():
                cursor.execute(
                    "INSERT INTO memberships (id, user_id, family_entity_id, role) VALUES (?, ?, ?, ?)",
                    ("mem_demo_admin", current_user_id, demo_entity_id, "family_admin"),
                )

            conn.commit()


class SqliteFamilyRepository(BaseFamilyRepository):
    def create_family_entity(self, entity: Dict[str, Any]) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR IGNORE INTO family_entities (id, name, entity_type)
                VALUES (?, ?, ?)
            """,
                (entity["id"], entity["name"], entity.get("entity_type", "Family Trust")),
            )
            conn.commit()

    def get_family_entity(self, entity_id: str) -> Optional[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM family_entities WHERE id = ?", (entity_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def create_membership(self, membership: Dict[str, Any]) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO memberships (id, user_id, family_entity_id, role)
                VALUES (?, ?, ?, ?)
            """,
                (
                    membership["id"],
                    membership["user_id"],
                    membership["family_entity_id"],
                    membership["role"],
                ),
            )
            conn.commit()

    def get_user_memberships(self, user_id: str) -> List[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT m.*, e.name as entity_name, e.entity_type
                FROM memberships m
                JOIN family_entities e ON m.family_entity_id = e.id
                WHERE m.user_id = ?
            """,
                (user_id,),
            )
            return [dict(r) for r in cursor.fetchall()]


class SqliteDocumentRepository(BaseDocumentRepository):
    def get_document_by_hash(self, family_entity_id: str, file_hash: str) -> Optional[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT * FROM documents WHERE family_entity_id = ? AND file_hash = ?
            """,
                (family_entity_id, file_hash),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def insert_document(self, doc: Dict[str, Any]) -> None:
        try:
            self._insert_document(doc)
        except sqlite3.IntegrityError as e:
            if "file_hash" in str(e):
                raise DuplicateDocumentError(doc["file_hash"]) from e
            raise

    def _insert_document(self, doc: Dict[str, Any]) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO documents 
                (id, filename, original_name, mime_type, file_size, file_hash, total_pages, family_entity_id, status,
                 owner_user_id, classification)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    doc["id"],
                    doc["filename"],
                    doc["original_name"],
                    doc["mime_type"],
                    doc["file_size"],
                    doc["file_hash"],
                    doc.get("total_pages", 1),
                    doc["family_entity_id"],
                    doc.get("status", "indexed"),
                    doc.get("owner_user_id"),
                    doc.get("classification", "confidential"),
                ),
            )
            conn.commit()

    def update_document_status(self, document_id: str, status: str) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE documents SET status = ? WHERE id = ?",
                (status, document_id),
            )
            conn.commit()

    def delete_document(self, document_id: str) -> bool:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM documents WHERE id = ?", (document_id,))
            deleted = cursor.rowcount > 0
            conn.commit()
            return deleted

    def insert_document_acl(self, document_id: str, family_entity_id: str, allowed_role: str) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            acl_id = str(uuid.uuid4())
            cursor.execute(
                """
                INSERT INTO document_acl (id, document_id, family_entity_id, allowed_role)
                VALUES (?, ?, ?, ?)
            """,
                (acl_id, document_id, family_entity_id, allowed_role),
            )
            conn.commit()

    def get_document_allowed_roles(self, document_id: str, family_entity_id: str) -> List[str]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT allowed_role FROM document_acl 
                WHERE document_id = ? AND family_entity_id = ?
            """,
                (document_id, family_entity_id),
            )
            return [r["allowed_role"] for r in cursor.fetchall()]

    def set_document_classification(self, document_id: str, classification: str) -> None:
        with get_db_connection() as conn:
            conn.execute("UPDATE documents SET classification = ? WHERE id = ?", (classification, document_id))
            conn.commit()

    def get_authorized_document_ids(self, family_entity_id: str, classifications: List[str]) -> List[str]:
        if not family_entity_id or not classifications:
            return []
        with get_db_connection() as conn:
            placeholders = ",".join("?" for _ in classifications)
            rows = conn.execute(
                f"""
                SELECT id FROM documents
                WHERE family_entity_id = ? AND status != 'failed' AND classification IN ({placeholders})
                """,
                (family_entity_id, *classifications),
            ).fetchall()
            return [r["id"] for r in rows]

    def insert_chunks(self, chunks: List[Dict[str, Any]]) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.executemany(
                """
                INSERT OR REPLACE INTO document_chunks 
                (id, document_id, chunk_index, page_number, section_title, content, is_table)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                [
                    (
                        c["id"],
                        c["document_id"],
                        c["chunk_index"],
                        c["page_number"],
                        c.get("section_title"),
                        c["content"],
                        c.get("is_table", False),
                    )
                    for c in chunks
                ],
            )
            conn.commit()

    def get_chunks_by_ids(self, chunk_ids: List[str]) -> List[Dict[str, Any]]:
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

    def get_chunk_ids_for_document(self, document_id: str, family_entity_id: str) -> List[str]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT c.id FROM document_chunks c
                JOIN documents d ON c.document_id = d.id
                WHERE c.document_id = ? AND d.family_entity_id = ?
            """,
                (document_id, family_entity_id),
            )
            return [row["id"] for row in cursor.fetchall()]

    def get_documents_by_entity(self, entity_id: str, user_role: str) -> List[Dict[str, Any]]:
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

    def get_all_documents(self) -> List[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM documents ORDER BY uploaded_at DESC")
            return [dict(row) for row in cursor.fetchall()]

    def get_lexical_chunks(self) -> List[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT c.id, c.document_id, c.page_number, c.is_table, c.content, d.family_entity_id, d.original_name, a.allowed_role
                FROM document_chunks c
                JOIN documents d ON c.document_id = d.id
                LEFT JOIN document_acl a ON c.document_id = a.document_id AND d.family_entity_id = a.family_entity_id
            """)
            return [dict(row) for row in cursor.fetchall()]

    def get_document_by_id(self, doc_id: str) -> Optional[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM documents WHERE id = ?", (doc_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_document_names(self, family_entity_id: str) -> Dict[str, str]:
        if not family_entity_id:
            return {}  # never a cross-tenant name map (Audit I-20)
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id, original_name, filename FROM documents WHERE family_entity_id = ?",
                (family_entity_id,),
            )
            return {
                row["id"]: row["original_name"] or row["filename"]
                for row in cursor.fetchall()
            }


class SqliteAuditRepository(BaseAuditRepository):
    def log_audit_event(
        self,
        action: str,
        user_id: Optional[str] = None,
        family_entity_id: Optional[str] = None,
        resource_id: Optional[str] = None,
        details: Optional[str] = None,
    ) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO audit_events (id, user_id, family_entity_id, action, resource_id, details)
                VALUES (?, ?, ?, ?, ?, ?)
            """,
                (str(uuid.uuid4()), user_id, family_entity_id, action, resource_id, details),
            )
            conn.commit()

    def get_audit_events_for_entities(self, entity_ids: List[str], limit: int = 50) -> List[Dict[str, Any]]:
        if not entity_ids:
            return []
        placeholders = ",".join("?" for _ in entity_ids)
        query = f"""
            SELECT * FROM audit_events 
            WHERE family_entity_id IN ({placeholders})
            ORDER BY timestamp DESC LIMIT ?
        """
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (*entity_ids, limit))
            return [dict(r) for r in cursor.fetchall()]

    def get_audit_events_for_user(self, user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM audit_events WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
                (user_id, limit),
            )
            return [dict(r) for r in cursor.fetchall()]

    def get_audit_events(self, limit: int = 50, family_entity_id: Optional[str] = None) -> List[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            if family_entity_id:
                cursor.execute(
                    "SELECT * FROM audit_events WHERE family_entity_id = ? ORDER BY timestamp DESC LIMIT ?",
                    (family_entity_id, limit),
                )
            else:
                cursor.execute(
                    "SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT ?", (limit,)
                )
            return [dict(r) for r in cursor.fetchall()]


class SqliteTokenRepository(BaseTokenRepository):
    def revoke_token(self, jti: str, user_id: str, expires_at: Optional[str] = None) -> None:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO revoked_tokens (jti, user_id, expires_at)
                VALUES (?, ?, ?)
            """,
                (jti, user_id, expires_at),
            )
            conn.commit()

    def is_token_revoked(self, jti: str) -> bool:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT 1 FROM revoked_tokens WHERE jti = ?", (jti,))
            return cursor.fetchone() is not None

    def cleanup_expired_tokens(self) -> int:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            now_iso = datetime.now(timezone.utc).isoformat()
            cursor.execute(
                "DELETE FROM revoked_tokens WHERE expires_at IS NOT NULL AND expires_at < ?",
                (now_iso,),
            )
            deleted = cursor.rowcount
            conn.commit()
            return deleted
