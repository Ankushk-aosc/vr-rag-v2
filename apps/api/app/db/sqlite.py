import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional
from app.config import settings


def get_db_connection() -> sqlite3.Connection:
    db_path = Path(settings.SQLITE_DB_PATH)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    # Enable WAL mode for high concurrency and immediate write durability
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    with get_db_connection() as conn:
        cursor = conn.cursor()

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
                family_entity_id TEXT DEFAULT 'default_family',
                status TEXT DEFAULT 'indexed',
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

        # Indexes for fast lookup
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON document_chunks(document_id);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_page ON document_chunks(page_number);")
        conn.commit()


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
            doc.get("family_entity_id", "default_family"),
            doc.get("status", "indexed")
        ))
        conn.commit()


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
        # Return preserving input order where possible
        results_map = {row["id"]: dict(row) for row in rows}
        return [results_map[cid] for cid in chunk_ids if cid in results_map]


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
