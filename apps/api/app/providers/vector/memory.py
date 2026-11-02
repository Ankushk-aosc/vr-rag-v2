import math
from typing import Any, Dict, List, Optional, Tuple
from app.providers.base import Capability, ProviderInfo
from app.providers.errors import ProviderCallError
from app.providers.vector.base import VectorHit, VectorMeta, VectorStore


class InMemoryVectorStore(VectorStore):
    def __init__(
        self,
        embedder_model: str = "fake-embed-8",
        embedder_dim: int = 8,
    ):
        self.info = ProviderInfo(
            name="memory",
            capability=Capability.VECTOR,
            requires_key=False,
            default_model=embedder_model,
            region="local",
        )
        self.embedder_model = embedder_model
        self.embedder_dim = embedder_dim
        # id -> (vector, metadata)
        self._records: Dict[str, Tuple[List[float], VectorMeta]] = {}

    def is_configured(self) -> bool:
        return True

    async def upsert(self, vectors: List[Tuple[str, List[float], VectorMeta]]) -> int:
        for vid, vec, meta in vectors:
            if len(vec) != self.embedder_dim:
                raise ProviderCallError(
                    f"Vector dimension mismatch: expected {self.embedder_dim}, got {len(vec)}"
                )
            self._records[vid] = (vec, meta)
        return len(vectors)

    def _cosine_similarity(self, a: List[float], b: List[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(y * y for y in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    async def query(
        self,
        vector: List[float],
        *,
        family_entity_id: str,
        top_k: int = 8,
        allowed_roles: Optional[List[str]] = None,
        document_id: Optional[str] = None,
    ) -> List[VectorHit]:
        if not self.is_configured() or not self._records:
            return []

        hits: List[Tuple[float, str, dict]] = []
        for vid, (stored_vec, meta) in self._records.items():
            # 1. Tenant boundary invariant
            if meta.family_entity_id != family_entity_id:
                continue

            # 2. Document filter
            if document_id and meta.document_id != document_id:
                continue

            # 3. RBAC role filter
            if allowed_roles is not None and meta.allowed_role not in allowed_roles:
                continue

            score = self._cosine_similarity(vector, stored_vec)
            meta_dict = {
                "family_entity_id": meta.family_entity_id,
                "document_id": meta.document_id,
                "allowed_role": meta.allowed_role,
                "page_no": meta.page_no,
                "chunk_id": meta.chunk_id,
                "ocr_engine": meta.ocr_engine,
                "embedder_model": meta.embedder_model or self.embedder_model,
                "embedder_dim": meta.embedder_dim or self.embedder_dim,
                **meta.extra,
            }
            hits.append((score, vid, meta_dict))

        # Sort descending by similarity score
        hits.sort(key=lambda x: x[0], reverse=True)
        return [VectorHit(id=vid, score=score, metadata=m) for score, vid, m in hits[:top_k]]

    async def delete_by_document(self, document_id: str, family_entity_id: str) -> bool:
        if not self.is_configured():
            return False
        to_delete = [
            vid
            for vid, (_, meta) in self._records.items()
            if meta.document_id == document_id and meta.family_entity_id == family_entity_id
        ]
        for vid in to_delete:
            self._records.pop(vid, None)
        return True

    async def delete_by_family(self, family_entity_id: str) -> bool:
        if not self.is_configured():
            return False
        to_delete = [
            vid
            for vid, (_, meta) in self._records.items()
            if meta.family_entity_id == family_entity_id
        ]
        for vid in to_delete:
            self._records.pop(vid, None)
        return True

    async def get_index_meta(self) -> dict:
        return {
            "embedder_model": self.embedder_model,
            "embedder_dim": self.embedder_dim,
            "count": len(self._records),
        }
