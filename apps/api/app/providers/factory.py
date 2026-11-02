from typing import Optional
from app.config import Settings, settings as default_settings
from app.providers.embed.base import Embedder
from app.providers.embed.registry import get_embedder_provider
from app.providers.llm.base import LLMProvider
from app.providers.llm.registry import get_llm_provider
from app.providers.speech.base import STT, TTS
from app.providers.speech.registry import get_stt_provider, get_tts_provider
from app.providers.vector.base import VectorStore
from app.providers.vector.registry import get_vector_store_provider


def get_llm(settings: Optional[Settings] = None) -> LLMProvider:
    return get_llm_provider(settings or default_settings)


def get_embedder(settings: Optional[Settings] = None) -> Embedder:
    return get_embedder_provider(settings or default_settings)


def get_vector_store(settings: Optional[Settings] = None) -> VectorStore:
    return get_vector_store_provider(settings or default_settings)


def get_stt(settings: Optional[Settings] = None) -> STT:
    return get_stt_provider(settings or default_settings)


def get_tts(settings: Optional[Settings] = None) -> TTS:
    return get_tts_provider(settings or default_settings)
