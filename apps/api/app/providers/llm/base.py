from abc import ABC, abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Dict, List, Optional
from app.providers.base import ProviderInfo


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost_usd: Optional[Decimal] = None


@dataclass
class LLMResponse:
    text: str
    model: str
    provider: str
    usage: Usage
    raw: Optional[dict] = None


class LLMProvider(ABC):
    info: ProviderInfo

    @abstractmethod
    async def chat(
        self,
        messages: List[Dict[str, Any]],
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        **opts
    ) -> LLMResponse:
        """Executes a chat completion request and returns an LLMResponse."""
        ...

    async def close(self) -> None:
        """Closes any underlying network client or session."""
        return None

    def is_configured(self) -> bool:
        """Indicates whether this provider has all required keys/configuration to run."""
        return True
