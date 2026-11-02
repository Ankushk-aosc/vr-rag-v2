import asyncio
from typing import List, Optional
from app.providers.base import Capability, ProviderInfo
from app.providers.embed.base import Embedder, EmbedResult
from app.providers.errors import ProviderCallError


class LocalSentenceTransformerEmbedder(Embedder):
    def __init__(self, model_name: str = "all-MiniLM-L6-v2", dim: int = 384):
        self.model_name = model_name
        self.dim = dim
        self.info = ProviderInfo(
            name="local_st",
            capability=Capability.EMBED,
            requires_key=False,
            default_model=model_name,
            region="local",
        )
        self._model = None

    def is_configured(self) -> bool:
        return True

    def _get_model(self):
        if self._model is None:
            try:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer(self.model_name)
            except Exception as e:
                raise ProviderCallError(f"Failed to load sentence-transformers model '{self.model_name}': {e}") from e
        return self._model

    async def embed(self, texts: List[str]) -> EmbedResult:
        model = self._get_model()
        # Offload encoding to worker thread
        def _encode():
            embeddings = model.encode(texts, convert_to_numpy=True)
            return embeddings.tolist()

        vectors = await asyncio.to_thread(_encode)
        actual_dim = len(vectors[0]) if vectors else self.dim
        return EmbedResult(
            vectors=vectors,
            dim=actual_dim,
            model=self.model_name,
            provider="local_st",
        )
