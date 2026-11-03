import json
from typing import Any, Dict, List, Optional

from sqlalchemy import delete, select

from app.db.models import ChunkVectorModel, DocumentAclModel, DocumentChunkModel, DocumentMetaModel, DocumentModel
from app.db.repositories.base import BaseLocalIndexRepository
from app.db.session import get_db_session


class SqlAlchemyLocalIndexRepository(BaseLocalIndexRepository):
    """Queries run with the tenant context set, so Postgres RLS applies (migration 003)."""

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
