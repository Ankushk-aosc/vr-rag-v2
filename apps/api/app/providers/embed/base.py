from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Optional
from app.providers.base import ProviderInfo
from app.providers.llm.base import Usage


@dataclass
class EmbedResult:
    vectors: List[List[float]]
    dim: int
    model: str
    provider: str
    usage: Optional[Usage] = None


class Embedder(ABC):
    info: ProviderInfo

    @abstractmethod
    async def embed(self, texts: List[str]) -> EmbedResult:
        """Embeds a list of text strings into vector coordinates."""
        ...

    async def close(self) -> None:
        """Closes any underlying network client or session."""
        return None

    def is_configured(self) -> bool:
        """Indicates whether this embedder has all required keys/configuration to run."""
        return True
