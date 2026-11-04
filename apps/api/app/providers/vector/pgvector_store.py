"""PostgreSQL pgvector VectorStore adapter.

Provides tenant-isolated vector indexing and retrieval using PostgreSQL pgvector
behind the VECTOR_STORE=pgvector configuration flag.
"""

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import delete, select, text

from app.config import Settings, settings
from app.db.session import get_db_session
from app.providers.base import Capability, ProviderInfo
from app.providers.vector.base import VectorHit, VectorMeta, VectorStore

logger = logging.getLogger(__name__)


class PgVectorStore(VectorStore):
    info = ProviderInfo(
        name="pgvector",
        capability=Capability.VECTOR,
        requires_key=False,
        supports_streaming=False,
        supports_usage=False,
    )

    def __init__(self, cfg: Settings) -> None:
        self.settings = cfg
        self._db_url = cfg.DATABASE_URL or ""

    def is_configured(self) -> bool:
        return bool(self._db_url and not self._db_url.startswith("sqlite"))

    async def upsert(self, vectors: List[Tuple[str, List[float], VectorMeta]]) -> int:
        if not vectors:
            return 0
        if not self.is_configured():
            logger.info("PgVectorStore not configured with PostgreSQL URL, skipping upsert.")
            return 0

        with get_db_session() as session:
            # Ensure pgvector extension and table exist if on PostgreSQL
            engine = session.get_bind()
            if engine and engine.dialect.name == "postgresql":
                session.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
                session.execute(text("""
                    CREATE TABLE IF NOT EXISTS document_vectors (
                        id VARCHAR(255) PRIMARY KEY,
                        family_entity_id VARCHAR(36) NOT NULL,
                        document_id VARCHAR(36) NOT NULL,
                        allowed_role VARCHAR(50) NOT NULL,
                        page_no INT,
                        chunk_id VARCHAR(255),
                        metadata_json TEXT,
                        embedding vector(384)
                    );
                    CREATE INDEX IF NOT EXISTS idx_document_vectors_hnsw
                    ON document_vectors USING hnsw (embedding vector_cosine_ops);
                """))
                for vid, vec, meta in vectors:
                    meta_json = json.dumps({
                        "ocr_engine": meta.ocr_engine,
                        "embedder_model": meta.embedder_model,
                        "embedder_dim": meta.embedder_dim,
                        **meta.extra,
                    })
                    vec_str = f"[{','.join(str(x) for x in vec)}]"
                    session.execute(text("""
                        INSERT INTO document_vectors (id, family_entity_id, document_id, allowed_role, page_no, chunk_id, metadata_json, embedding)
                        VALUES (:id, :family_id, :doc_id, :role, :page_no, :chunk_id, :meta_json, :vec::vector)
                        ON CONFLICT (id) DO UPDATE SET
                            family_entity_id = EXCLUDED.family_entity_id,
                            document_id = EXCLUDED.document_id,
                            allowed_role = EXCLUDED.allowed_role,
                            page_no = EXCLUDED.page_no,
                            chunk_id = EXCLUDED.chunk_id,
                            metadata_json = EXCLUDED.metadata_json,
                            embedding = EXCLUDED.embedding;
                    """), {
                        "id": vid,
                        "family_id": meta.family_entity_id,
                        "doc_id": meta.document_id,
                        "role": meta.allowed_role,
                        "page_no": meta.page_no,
                        "chunk_id": meta.chunk_id,
                        "meta_json": meta_json,
                        "vec": vec_str,
                    })
            return len(vectors)

    async def query(
        self,
        vector: List[float],
        *,
        family_entity_id: str,
        top_k: int = 8,
        allowed_roles: Optional[List[str]] = None,
        document_id: Optional[str] = None,
    ) -> List[VectorHit]:
        if not self.is_configured():
            return []

        roles = allowed_roles or ["family_member", "family_admin"]
        with get_db_session(family_ids=[family_entity_id]) as session:
            engine = session.get_bind()
            if not engine or engine.dialect.name != "postgresql":
                return []

            vec_str = f"[{','.join(str(x) for x in vector)}]"
            query_str = """
                SELECT id, (1 - (embedding <=> :vec::vector)) as score, family_entity_id, document_id, allowed_role, page_no, chunk_id, metadata_json
                FROM document_vectors
                WHERE family_entity_id = :family_id
                  AND allowed_role = ANY(:roles)
            """
            params: Dict[str, Any] = {
                "vec": vec_str,
                "family_id": family_entity_id,
                "roles": roles,
                "top_k": top_k,
            }
            if document_id:
                query_str += " AND document_id = :doc_id"
                params["doc_id"] = document_id

            query_str += " ORDER BY embedding <=> :vec::vector LIMIT :top_k"
            res = session.execute(text(query_str), params).all()
            hits = []
            for row in res:
                meta = {
                    "family_entity_id": row.family_entity_id,
                    "document_id": row.document_id,
                    "allowed_role": row.allowed_role,
                    "page_no": row.page_no,
                    "chunk_id": row.chunk_id,
                }
                if row.metadata_json:
                    try:
                        meta.update(json.loads(row.metadata_json))
                    except Exception:
                        pass
                hits.append(VectorHit(id=row.id, score=float(row.score), metadata=meta))
            return hits

    async def delete_by_document(self, document_id: str, family_entity_id: str) -> bool:
        if not self.is_configured():
            return False
        with get_db_session(family_ids=[family_entity_id]) as session:
            engine = session.get_bind()
            if engine and engine.dialect.name == "postgresql":
                session.execute(text("""
                    DELETE FROM document_vectors
                    WHERE document_id = :doc_id AND family_entity_id = :family_id
                """), {"doc_id": document_id, "family_id": family_entity_id})
                return True
        return False

    async def delete_by_family(self, family_entity_id: str) -> bool:
        if not self.is_configured():
            return False
        with get_db_session(family_ids=[family_entity_id]) as session:
            engine = session.get_bind()
            if engine and engine.dialect.name == "postgresql":
                session.execute(text("""
                    DELETE FROM document_vectors WHERE family_entity_id = :family_id
                """), {"family_id": family_entity_id})
                return True
        return False

    async def get_index_meta(self) -> dict:
        if not self.is_configured():
            return {"embedder_model": "pgvector", "embedder_dim": 1536, "count": 0}
        with get_db_session() as session:
            engine = session.get_bind()
            if engine and engine.dialect.name == "postgresql":
                res = session.execute(text("SELECT count(*) FROM document_vectors")).scalar()
                return {"embedder_model": "pgvector", "embedder_dim": 1536, "count": res or 0}
        return {"embedder_model": "pgvector", "embedder_dim": 1536, "count": 0}
