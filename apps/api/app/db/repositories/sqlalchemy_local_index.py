import json
import logging
from typing import Any, Dict, List, Optional

import numpy as np
from sqlalchemy import delete, select, text

from app.db.models import ChunkVectorModel, DocumentAclModel, DocumentChunkModel, DocumentMetaModel, DocumentModel
from app.db.repositories.base import BaseLocalIndexRepository
from app.db.session import get_db_session


logger = logging.getLogger(__name__)


def _vector_literal(values) -> str:
    """pgvector text form. Values are floats produced by our embedder, never user input."""
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


class SqlAlchemyLocalIndexRepository(BaseLocalIndexRepository):
    """Queries run with the tenant context set, so Postgres RLS applies (migration 003).

    On PostgreSQL with migration 008 applied, every vector is also stored in the pgvector column
    `chunk_vectors.embedding_vec` (HNSW, cosine) and similarity search runs in SQL with the tenant and
    authorized-document filters inside the same query."""

    _pgvector: Optional[bool] = None

    def pgvector_enabled(self) -> bool:
        if self._pgvector is None:
            try:
                with get_db_session(system=True) as session:
                    if session.get_bind().dialect.name != "postgresql":
                        SqlAlchemyLocalIndexRepository._pgvector = False
                    else:
                        found = session.execute(text(
                            "SELECT 1 FROM information_schema.columns "
                            "WHERE table_name = 'chunk_vectors' AND column_name = 'embedding_vec'"
                        )).first()
                        SqlAlchemyLocalIndexRepository._pgvector = bool(found)
            except Exception as e:
                logger.warning("pgvector detection failed, using in-process scoring: %s", type(e).__name__)
                SqlAlchemyLocalIndexRepository._pgvector = False
        return bool(self._pgvector)

    def search_chunk_vectors_pgvector(self, query_vector: List[float], family_entity_id: str,
                                      document_ids: Optional[List[str]], top_k: int) -> List[Dict[str, Any]]:
        """Cosine similarity in PostgreSQL. All values are bound parameters; RLS also scopes the rows."""
        if top_k <= 0 or (document_ids is not None and not document_ids):
            return []
        sql = (
            "SELECT chunk_id, document_id, allowed_roles, "
            "1 - (embedding_vec <=> CAST(:q AS vector)) AS score "
            "FROM chunk_vectors "
            "WHERE family_entity_id = :fam AND embedding_vec IS NOT NULL "
        )
        params: Dict[str, Any] = {"q": _vector_literal(query_vector), "fam": family_entity_id, "k": int(top_k)}
        if document_ids is not None:
            sql += "AND document_id = ANY(:docs) "
            params["docs"] = list(document_ids)
        sql += "ORDER BY embedding_vec <=> CAST(:q AS vector) LIMIT :k"
        with get_db_session(family_ids=[family_entity_id]) as session:
            rows = session.execute(text(sql), params).all()
        return [
            {"chunk_id": r.chunk_id, "document_id": r.document_id,
             "allowed_roles": json.loads(r.allowed_roles), "score": float(r.score)}
            for r in rows
        ]

    def upsert_chunk_vectors(self, rows: List[Dict[str, Any]]) -> int:
        if not rows:
            return 0
        family_ids = sorted({r["family_entity_id"] for r in rows})
        with get_db_session(family_ids=family_ids) as session:
            for r in rows:
                session.merge(ChunkVectorModel(
                    chunk_id=r["chunk_id"], document_id=r["document_id"], family_entity_id=r["family_entity_id"],
                    allowed_roles=json.dumps(r["allowed_roles"]), embedder_model=r.get("embedder_model"),
                    embedding_dim=r["embedding_dim"], embedding=r["embedding"],
                ))
            if self.pgvector_enabled():
                session.flush()
                for r in rows:
                    vec = np.frombuffer(r["embedding"], dtype=np.float32)
                    session.execute(
                        text("UPDATE chunk_vectors SET embedding_vec = CAST(:v AS vector) WHERE chunk_id = :id"),
                        {"v": _vector_literal(vec), "id": r["chunk_id"]},
                    )
        return len(rows)

    def get_chunk_vectors(self, family_entity_id: str) -> List[Dict[str, Any]]:
        with get_db_session(family_ids=[family_entity_id]) as session:
            stmt = select(ChunkVectorModel).where(ChunkVectorModel.family_entity_id == family_entity_id)
            return [
                {
                    "chunk_id": v.chunk_id, "document_id": v.document_id,
                    "allowed_roles": json.loads(v.allowed_roles), "embedding": bytes(v.embedding),
                }
                for v in session.scalars(stmt).all()
            ]

    def delete_chunk_vectors(self, document_id: str, family_entity_id: str) -> int:
        with get_db_session(family_ids=[family_entity_id]) as session:
            res = session.execute(delete(ChunkVectorModel).where(
                ChunkVectorModel.document_id == document_id,
                ChunkVectorModel.family_entity_id == family_entity_id,
            ))
            return res.rowcount or 0

    def get_chunks_without_vectors(self, family_entity_id: str) -> List[Dict[str, Any]]:
        with get_db_session(family_ids=[family_entity_id]) as session:
            acl_role = (
                select(DocumentAclModel.allowed_role)
                .where(DocumentAclModel.document_id == DocumentModel.id,
                       DocumentAclModel.family_entity_id == DocumentModel.family_entity_id)
                .limit(1)
                .scalar_subquery()
            )
            stmt = (
                select(DocumentChunkModel.id, DocumentChunkModel.document_id, DocumentChunkModel.content,
                       acl_role.label("allowed_role"))
                .join(DocumentModel, DocumentChunkModel.document_id == DocumentModel.id)
                .outerjoin(ChunkVectorModel, ChunkVectorModel.chunk_id == DocumentChunkModel.id)
                .where(DocumentModel.family_entity_id == family_entity_id,
                       DocumentModel.status != "failed",
                       ChunkVectorModel.chunk_id.is_(None))
            )
            return [dict(r._mapping) for r in session.execute(stmt).all()]

    def upsert_document_meta(self, document_id: str, family_entity_id: str, meta: Dict[str, Any]) -> None:
        with get_db_session(family_ids=[family_entity_id]) as session:
            session.merge(DocumentMetaModel(
                document_id=document_id, family_entity_id=family_entity_id, meta_json=json.dumps(meta),
            ))

    def get_document_meta(self, document_id: str) -> Optional[Dict[str, Any]]:
        with get_db_session(system=True) as session:  # id lookup, authorized by the caller (Audit I-16)
            row = session.get(DocumentMetaModel, document_id)
            return json.loads(row.meta_json) if row else None

    def list_document_meta(self, family_entity_id: str) -> Dict[str, Dict[str, Any]]:
        with get_db_session(family_ids=[family_entity_id]) as session:
            stmt = select(DocumentMetaModel).where(DocumentMetaModel.family_entity_id == family_entity_id)
            return {m.document_id: json.loads(m.meta_json) for m in session.scalars(stmt).all()}
