from typing import Callable, Dict
from app.config import Settings
from app.providers.errors import ProviderNotConfigured
from app.providers.speech.base import STT, TTS
from app.providers.speech.fake import FakeSTT, FakeTTS

STT_REGISTRY: Dict[str, Callable[[Settings], STT]] = {}
TTS_REGISTRY: Dict[str, Callable[[Settings], TTS]] = {}


def register_stt(name: str):
    def decorator(fn: Callable[[Settings], STT]):
        STT_REGISTRY[name.lower()] = fn
        return fn
    return decorator


def register_tts(name: str):
    def decorator(fn: Callable[[Settings], TTS]):
        TTS_REGISTRY[name.lower()] = fn
        return fn
    return decorator


@register_stt("fake")
def _create_fake_stt(settings: Settings) -> STT:
    return FakeSTT()


@register_stt("browser")
def _create_browser_stt(settings: Settings) -> STT:
    # Client-side browser transcription
    return FakeSTT("Browser transcription placeholder")


@register_tts("fake")
def _create_fake_tts(settings: Settings) -> TTS:
    return FakeTTS()


@register_tts("browser")
def _create_browser_tts(settings: Settings) -> TTS:
    # Client-side browser speech synthesis
    return FakeTTS(b"")


def get_stt_provider(settings: Settings) -> STT:
    provider_name = (settings.STT_PROVIDER or "fake").strip().lower()
    factory_fn = STT_REGISTRY.get(provider_name)
    if not factory_fn:
        raise ProviderNotConfigured(
            f"Unknown STT provider '{settings.STT_PROVIDER}'. Registered: {list(STT_REGISTRY.keys())}"
        )
    return factory_fn(settings)


def get_tts_provider(settings: Settings) -> TTS:
    provider_name = (settings.TTS_PROVIDER or "fake").strip().lower()
    factory_fn = TTS_REGISTRY.get(provider_name)
    if not factory_fn:
        raise ProviderNotConfigured(
            f"Unknown TTS provider '{settings.TTS_PROVIDER}'. Registered: {list(TTS_REGISTRY.keys())}"
        )
    return factory_fn(settings)
