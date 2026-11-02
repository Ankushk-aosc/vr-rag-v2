from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from app.providers.base import ProviderInfo


@dataclass
class VectorMeta:
    family_entity_id: str
    document_id: str
    allowed_role: str
    page_no: Optional[int] = None
    chunk_id: Optional[str] = None
    ocr_engine: Optional[str] = None
    ocr_confidence: Optional[float] = None
    embedder_model: Optional[str] = None
    embedder_dim: Optional[int] = None
    extra: dict = field(default_factory=dict)


@dataclass
class VectorHit:
    id: str
    score: float
    metadata: dict


class VectorStore(ABC):
    info: ProviderInfo

    @abstractmethod
    def is_configured(self) -> bool:
        """Returns True if the vector store has credentials/backing service configured."""
        ...

    @abstractmethod
    async def upsert(self, vectors: List[Tuple[str, List[float], VectorMeta]]) -> int:
        """
        Upserts (id, vector_coords, metadata) tuples into the vector store.
        Returns count of upserted records.
        """
        ...

    @abstractmethod
    async def query(
        self,
        vector: List[float],
        *,
        family_entity_id: str,
        top_k: int = 8,
        allowed_roles: Optional[List[str]] = None,
        document_id: Optional[str] = None,
    ) -> List[VectorHit]:
        """
        Executes tenant-isolated similarity query.
        MUST return [] when is_configured() is False or when the index is empty.
        """
        ...

    @abstractmethod
    async def delete_by_document(self, document_id: str, family_entity_id: str) -> bool:
        """
        Deletes all vector chunks belonging to document_id scoped to family_entity_id.
        MUST return False when unconfigured, True on successful execution or no-op.
        """
        ...

    @abstractmethod
    async def delete_by_family(self, family_entity_id: str) -> bool:
        """
        Deletes all vector chunks belonging to family_entity_id.
        MUST return False when unconfigured, True on successful execution or no-op.
        """
        ...

    @abstractmethod
    async def get_index_meta(self) -> dict:
        """Returns index metadata dict: {embedder_model, embedder_dim, count}."""
        ...
