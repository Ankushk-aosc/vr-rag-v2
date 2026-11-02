from typing import Callable, Dict
from app.config import Settings
from app.providers.errors import ProviderNotConfigured
from app.providers.llm.base import LLMProvider
from app.providers.llm.fake import FakeLLM
from app.providers.llm.openai_compatible import OpenAICompatibleLLM

LLM_REGISTRY: Dict[str, Callable[[Settings], LLMProvider]] = {}


def register_llm(name: str):
    def decorator(fn: Callable[[Settings], LLMProvider]):
        LLM_REGISTRY[name.lower()] = fn
        return fn
    return decorator


@register_llm("fake")
def _create_fake_llm(settings: Settings) -> LLMProvider:
    return FakeLLM(model=settings.LLM_MODEL or "fake-model")


@register_llm("openai_compatible")
def _create_openai_compatible_llm(settings: Settings) -> LLMProvider:
    if settings.PROVIDERS_STRICT and not settings.LLM_API_KEY:
        raise ProviderNotConfigured(
            "LLM provider 'openai_compatible' requires LLM_API_KEY when PROVIDERS_STRICT=True."
        )
    return OpenAICompatibleLLM(
        base_url=settings.LLM_BASE_URL,
        api_key=settings.LLM_API_KEY,
        model=settings.LLM_MODEL or "gpt-3.5-turbo",
        name="openai_compatible",
    )


@register_llm("groq")
def _create_groq_llm(settings: Settings) -> LLMProvider:
    api_key = settings.GROQ_API_KEY or settings.LLM_API_KEY or ""
    if settings.PROVIDERS_STRICT and not api_key:
        raise ProviderNotConfigured("LLM provider 'groq' requires GROQ_API_KEY when PROVIDERS_STRICT=True.")
    return OpenAICompatibleLLM(
        base_url=settings.LLM_BASE_URL or "https://api.groq.com/openai/v1",
        api_key=api_key,
        model=settings.GROQ_MODEL or settings.LLM_MODEL or "qwen/qwen3.8-27b",
        name="groq",
        region="us-east-1",
    )


def get_llm_provider(settings: Settings) -> LLMProvider:
    provider_name = (settings.LLM_PROVIDER or "fake").strip().lower()
    factory_fn = LLM_REGISTRY.get(provider_name)
    if not factory_fn:
        raise ProviderNotConfigured(
            f"Unknown LLM provider '{settings.LLM_PROVIDER}'. Registered: {list(LLM_REGISTRY.keys())}"
        )
    return factory_fn(settings)
