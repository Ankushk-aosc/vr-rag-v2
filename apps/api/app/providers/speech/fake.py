from typing import Optional
from app.providers.base import Capability, ProviderInfo
from app.providers.speech.base import STT, TTS, Transcription


class FakeSTT(STT):
    def __init__(self, transcript: str = "FAKE TRANSCRIPT"):
        self.transcript = transcript
        self.info = ProviderInfo(
            name="fake",
            capability=Capability.STT,
            requires_key=False,
            region="local",
        )

    def is_configured(self) -> bool:
        return True

    async def transcribe(self, audio: bytes, *, mime: str = "audio/webm") -> Transcription:
        return Transcription(text=self.transcript, lang="en", confidence=1.0)


class FakeTTS(TTS):
    def __init__(self, audio_bytes: bytes = b"FAKE_AUDIO"):
        self.audio_bytes = audio_bytes
        self.info = ProviderInfo(
            name="fake",
            capability=Capability.TTS,
            requires_key=False,
            region="local",
        )

    def is_configured(self) -> bool:
        return True

    async def synthesize(self, text: str, *, voice: Optional[str] = None) -> bytes:
        return self.audio_bytes
