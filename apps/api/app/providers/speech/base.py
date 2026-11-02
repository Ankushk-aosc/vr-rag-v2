from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional
from app.providers.base import ProviderInfo


@dataclass
class Transcription:
    text: str
    lang: Optional[str] = "en"
    confidence: Optional[float] = 1.0


class STT(ABC):
    info: ProviderInfo

    @abstractmethod
    async def transcribe(self, audio: bytes, *, mime: str = "audio/webm") -> Transcription:
        """Transcribes incoming audio bytes to text."""
        ...

    def is_configured(self) -> bool:
        return True


class TTS(ABC):
    info: ProviderInfo

    @abstractmethod
    async def synthesize(self, text: str, *, voice: Optional[str] = None) -> bytes:
        """Synthesizes text into spoken audio bytes."""
        ...

    def is_configured(self) -> bool:
        return True
