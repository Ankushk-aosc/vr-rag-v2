import logging
from typing import List, Optional
import httpx

from app.providers.base import Capability, ProviderInfo
from app.providers.errors import ProviderCallError, ProviderNotConfigured
from app.providers.embed.base import Embedder, EmbedResult

logger = logging.getLogger(__name__)


class OpenAICompatibleEmbedder(Embedder):
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        dim: int = 1536,
        name: str = "openai_compatible",
        client: Optional[httpx.AsyncClient] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model or "text-embedding-3-small"
        self.dim = dim
        self.info = ProviderInfo(
            name=name,
            capability=Capability.EMBED,
            requires_key=True,
            default_model=self.model,
        )

        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5.0, read=60.0, write=30.0, pool=10.0),
                transport=transport,
            )
            self._owns_client = True

    def is_configured(self) -> bool:
        return bool(self.api_key and self.base_url)

    async def embed(self, texts: List[str]) -> EmbedResult:
        if not self.is_configured():
            raise ProviderNotConfigured(
                f"Embedder provider '{self.info.name}' is not configured (missing base_url or api_key)."
            )

        endpoint = f"{self.base_url}/embeddings"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "input": texts,
        }

        try:
            resp = await self._client.post(endpoint, json=payload, headers=headers)
        except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.TimeoutException) as e:
            raise ProviderCallError(f"Embedder provider '{self.info.name}' request timed out") from e
        except httpx.RequestError as e:
            safe_err = str(e).replace(self.api_key, "[REDACTED]") if self.api_key else str(e)
            raise ProviderCallError(f"Embedder provider '{self.info.name}' network error: {safe_err}") from e

        if resp.status_code in (401, 403):
            raise ProviderCallError(f"Embedder provider '{self.info.name}' auth failed (status {resp.status_code})")
        elif resp.status_code == 429:
            raise ProviderCallError(f"Embedder provider '{self.info.name}' rate limited (status 429)")
        elif resp.status_code >= 500:
            raise ProviderCallError(f"Embedder provider '{self.info.name}' server error (status {resp.status_code})")
        elif resp.status_code != 200:
            raise ProviderCallError(f"Embedder provider '{self.info.name}' unexpected response (status {resp.status_code})")

        data = resp.json()
        items = data.get("data") or []
        vectors = [item["embedding"] for item in items if "embedding" in item]
        actual_dim = len(vectors[0]) if vectors else self.dim

        return EmbedResult(
            vectors=vectors,
            dim=actual_dim,
            model=data.get("model", self.model),
            provider=self.info.name,
        )

    async def close(self) -> None:
        if self._owns_client and not self._client.is_closed:
            await self._client.aclose()
