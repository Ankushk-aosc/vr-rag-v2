import logging
from typing import Callable, Dict
from app.config import Settings, is_private_endpoint
from app.providers.errors import ProviderNotConfigured
from app.providers.llm.base import LLMProvider
from app.providers.llm.fake import FakeLLM
from app.providers.llm.openai_compatible import OpenAICompatibleLLM

logger = logging.getLogger(__name__)

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


@register_llm("local")
def _create_local_llm(settings: Settings) -> LLMProvider:
    # Fail closed: a "local" provider that resolves to a public host would leak prompts (Audit I-09)
    if not is_private_endpoint(settings.LOCAL_LLM_BASE_URL):
        raise ProviderNotConfigured(
            f"Local LLM base URL '{settings.LOCAL_LLM_BASE_URL}' is not on this machine or a private network."
        )
    return OpenAICompatibleLLM(
        base_url=settings.LOCAL_LLM_BASE_URL,
        api_key=settings.LOCAL_LLM_API_KEY or "local-no-auth",
        model=settings.LOCAL_LLM_MODEL,
        name="local",
    )


def _stays_local(provider_name: str, settings: Settings) -> bool:
    if provider_name in ("fake", "local"):
        return True
    return provider_name == "openai_compatible" and is_private_endpoint(settings.LLM_BASE_URL)


def get_llm_provider(settings: Settings) -> LLMProvider:
    provider_name = (settings.LLM_PROVIDER or "fake").strip().lower()
    factory_fn = LLM_REGISTRY.get(provider_name)
    if not factory_fn:
        raise ProviderNotConfigured(
            f"Unknown LLM provider '{settings.LLM_PROVIDER}'. Registered: {list(LLM_REGISTRY.keys())}"
        )
    # In local privacy mode a provider that would send prompts off the deployment is replaced by the
    # local server (Audit I-09); offline/private providers are kept.
    if getattr(settings, "is_local_mode", False) and not _stays_local(provider_name, settings):
        logger.warning(
            "LLM_PROVIDER=%s is ignored in PRIVACY_MODE=local; using the local LLM at %s.",
            provider_name, settings.LOCAL_LLM_BASE_URL,
        )
        factory_fn = LLM_REGISTRY["local"]
    return factory_fn(settings)
