from dataclasses import dataclass
from enum import Enum
from typing import Optional
from app.providers.errors import ProviderError, ProviderNotConfigured, ProviderCallError


class Capability(str, Enum):
    CHAT = "chat"
    EMBED = "embed"
    STT = "stt"
    TTS = "tts"
    VECTOR = "vector"


@dataclass(frozen=True)
class ProviderInfo:
    name: str
    capability: Capability
    requires_key: bool
    supports_streaming: bool = False
    supports_usage: bool = False
    default_model: Optional[str] = None
    region: Optional[str] = None
