import hashlib
import math
from typing import List
from app.providers.base import Capability, ProviderInfo
from app.providers.embed.base import Embedder, EmbedResult


class FakeEmbedder(Embedder):
    def __init__(self, model: str = "fake-embed-8", dim: int = 8):
        self.dim = dim
        self.model = model
        self.info = ProviderInfo(
            name="fake",
            capability=Capability.EMBED,
            requires_key=False,
            default_model=model,
            region="local",
        )
        self.calls: List[List[str]] = []

    def is_configured(self) -> bool:
        return True

    def _hash_to_vector(self, text: str) -> List[float]:
        # Deterministic hashing to unit vector
        raw: List[float] = []
        for i in range(self.dim):
            h = hashlib.sha256(f"{text}::{i}".encode("utf-8")).digest()
            val = int.from_bytes(h[:4], "big", signed=True) / (2**31)
            raw.append(val)
        norm = math.sqrt(sum(x * x for x in raw))
        if norm == 0:
            return [1.0] + [0.0] * (self.dim - 1)
        return [round(x / norm, 6) for x in raw]

    async def embed(self, texts: List[str]) -> EmbedResult:
        self.calls.append(texts)
        vectors = [self._hash_to_vector(t) for t in texts]
        return EmbedResult(
            vectors=vectors,
            dim=self.dim,
            model=self.model,
            provider="fake",
        )
