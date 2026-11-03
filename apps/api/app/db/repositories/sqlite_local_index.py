import json
from typing import Any, Dict, List, Optional

from app.db.repositories.base import BaseLocalIndexRepository
from app.db.repositories.sqlite_repo import get_db_connection


class SqliteLocalIndexRepository(BaseLocalIndexRepository):
    def upsert_chunk_vectors(self, rows: List[Dict[str, Any]]) -> int:
        if not rows:
            return 0
        with get_db_connection() as conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO chunk_vectors
                (chunk_id, document_id, family_entity_id, allowed_roles, embedder_model, embedding_dim, embedding)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                [
                    (
                        r["chunk_id"], r["document_id"], r["family_entity_id"], json.dumps(r["allowed_roles"]),
                        r.get("embedder_model"), r["embedding_dim"], r["embedding"],
                    )
                    for r in rows
                ],
            )
            conn.commit()
        return len(rows)

    def get_chunk_vectors(self, family_entity_id: str) -> List[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.execute(
                "SELECT chunk_id, document_id, allowed_roles, embedding FROM chunk_vectors WHERE family_entity_id = ?",
                (family_entity_id,),
            )
            return [
                {
                    "chunk_id": r["chunk_id"], "document_id": r["document_id"],
                    "allowed_roles": json.loads(r["allowed_roles"]), "embedding": r["embedding"],
                }
                for r in cursor.fetchall()
            ]

    def delete_chunk_vectors(self, document_id: str, family_entity_id: str) -> int:
        with get_db_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM chunk_vectors WHERE document_id = ? AND family_entity_id = ?",
                (document_id, family_entity_id),
            )
            conn.commit()
            return cursor.rowcount

    def get_chunks_without_vectors(self, family_entity_id: str) -> List[Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.execute(
                """
                SELECT c.id, c.document_id, c.content,
                       (SELECT a.allowed_role FROM document_acl a
                        WHERE a.document_id = d.id AND a.family_entity_id = d.family_entity_id LIMIT 1) AS allowed_role
                FROM document_chunks c
                JOIN documents d ON c.document_id = d.id
                LEFT JOIN chunk_vectors v ON v.chunk_id = c.id
                WHERE d.family_entity_id = ? AND d.status != 'failed' AND v.chunk_id IS NULL
            """,
                (family_entity_id,),
            )
            return [dict(r) for r in cursor.fetchall()]

    def upsert_document_meta(self, document_id: str, family_entity_id: str, meta: Dict[str, Any]) -> None:
        with get_db_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO document_meta (document_id, family_entity_id, meta_json) VALUES (?, ?, ?)",
                (document_id, family_entity_id, json.dumps(meta)),
            )
            conn.commit()

    def get_document_meta(self, document_id: str) -> Optional[Dict[str, Any]]:
        with get_db_connection() as conn:
            row = conn.execute("SELECT meta_json FROM document_meta WHERE document_id = ?", (document_id,)).fetchone()
            return json.loads(row["meta_json"]) if row else None

    def list_document_meta(self, family_entity_id: str) -> Dict[str, Dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.execute(
                "SELECT document_id, meta_json FROM document_meta WHERE family_entity_id = ?", (family_entity_id,)
            )
            return {r["document_id"]: json.loads(r["meta_json"]) for r in cursor.fetchall()}
