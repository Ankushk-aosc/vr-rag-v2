import logging
from typing import Any, Dict, List, Optional, Tuple

from app.config import Settings
from app.providers.base import Capability, ProviderInfo
from app.providers.errors import ProviderNotConfigured
from app.providers.vector.base import VectorHit, VectorMeta, VectorStore
from app.services import pinecone_service

logger = logging.getLogger(__name__)


class PineconeVectorStore(VectorStore):
    def __init__(self, settings: Settings):
        self.settings = settings
        self.info = ProviderInfo(
            name="pinecone",
            capability=Capability.VECTOR,
            requires_key=True,
            default_model=settings.EMBEDDING_MODEL,
            region=settings.PINECONE_REGION,
        )
        self._configured: Optional[bool] = None
        self._check_configured()

    def _check_configured(self) -> bool:
        if self._configured is not None:
            return self._configured

        key = self.settings.PINECONE_API_KEY
        if not key or key == "your-pinecone-api-key-here":
            self._configured = False
            return False

        try:
            client = pinecone_service.get_pinecone_client()
            self._configured = bool(client is not None)
        except Exception as e:
            logger.debug("Pinecone initialization failed: %s", e)
            self._configured = False

        return self._configured

    def is_configured(self) -> bool:
        return self._check_configured()

    async def upsert(self, vectors: List[Tuple[str, List[float], VectorMeta]]) -> int:
        if not self.is_configured():
            raise ProviderNotConfigured("Pinecone vector store is not configured.")

        if not vectors:
            return 0

        chunks = []
        embeddings = []
        family_entity_id = vectors[0][2].family_entity_id

        for vid, emb, meta in vectors:
            chunks.append({
                "id": vid,
                "document_id": meta.document_id,
                "page_number": meta.page_no or 1,
                "is_table": bool(meta.extra.get("is_table", False)),
                "content": meta.extra.get("text", ""),
                "original_name": meta.extra.get("original_name", ""),
            })
            embeddings.append(emb)

        allowed_roles = list({meta.allowed_role for _, _, meta in vectors})
        return pinecone_service.upsert_vectors(
            chunks=chunks,
            embeddings=embeddings,
            family_entity_id=family_entity_id,
            allowed_roles=allowed_roles,
        )

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

        roles = allowed_roles or []  # no role, no results (fail closed)
        try:
            matches = pinecone_service.query_similar_chunks(
                query_vector=vector,
                top_k=top_k,
                family_entity_id=family_entity_id,
                user_roles=roles,
            )
        except Exception as e:
            logger.warning("Pinecone query error: %s", e)
            return []

        hits: List[VectorHit] = []
        for m in matches:
            meta = m.get("metadata") or {}
            if document_id and meta.get("document_id") != document_id:
                continue
            hits.append(
                VectorHit(
                    id=m.get("chunk_id", ""),
                    score=float(m.get("score", 0.0)),
                    metadata=meta,
                )
            )
        return hits

    async def delete_by_document(self, document_id: str, family_entity_id: str) -> bool:
        if not self.is_configured():
            return False
        try:
            return pinecone_service.delete_document_from_pinecone(document_id, family_entity_id)
        except Exception as e:
            logger.warning("Pinecone delete_by_document error: %s", e)
            return False

    async def delete_by_family(self, family_entity_id: str) -> bool:
        if not self.is_configured():
            return False
        try:
            # Call pinecone delete with namespace or filter
            client = pinecone_service.get_pinecone_client()
            if not client:
                return False
            index = pinecone_service.get_index()
            index.delete(filter={"family_entity_id": family_entity_id})
            return True
        except Exception as e:
            logger.warning("Pinecone delete_by_family error: %s", e)
            return False

    async def get_index_meta(self) -> dict:
        if not self.is_configured():
            return {
                "embedder_model": None,
                "embedder_dim": None,
                "count": 0,
                "untagged": True,
            }

        try:
            index = pinecone_service.get_index()
            stats = index.describe_index_stats()
            total_count = stats.get("total_vector_count", 0) if isinstance(stats, dict) else getattr(stats, "total_vector_count", 0)
            return {
                "embedder_model": self.settings.EMBEDDING_MODEL,
                "embedder_dim": self.settings.EMBEDDING_DIMENSION,
                "count": total_count,
                "untagged": True,
            }
        except Exception as e:
            logger.warning("Could not read Pinecone index stats: %s", e)
            return {
                "embedder_model": self.settings.EMBEDDING_MODEL,
                "embedder_dim": self.settings.EMBEDDING_DIMENSION,
                "count": 0,
                "untagged": True,
            }
