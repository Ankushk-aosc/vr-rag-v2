from typing import Callable, Dict
from app.config import Settings
from app.providers.embed.base import Embedder
from app.providers.embed.fake import FakeEmbedder
from app.providers.embed.local_st import LocalSentenceTransformerEmbedder
from app.providers.embed.openai_compatible import OpenAICompatibleEmbedder
from app.providers.errors import ProviderNotConfigured

EMBEDDER_REGISTRY: Dict[str, Callable[[Settings], Embedder]] = {}


def register_embedder(name: str):
    def decorator(fn: Callable[[Settings], Embedder]):
        EMBEDDER_REGISTRY[name.lower()] = fn
        return fn
    return decorator


@register_embedder("fake")
def _create_fake_embedder(settings: Settings) -> Embedder:
    return FakeEmbedder(
        model=settings.EMBEDDER_MODEL or "fake-embed-8",
        dim=settings.EMBEDDER_DIM or 8,
    )


@register_embedder("local_st")
def _create_local_st_embedder(settings: Settings) -> Embedder:
    return LocalSentenceTransformerEmbedder(
        model_name=settings.EMBEDDER_MODEL or settings.EMBEDDING_MODEL or "all-MiniLM-L6-v2",
        dim=settings.EMBEDDER_DIM or settings.EMBEDDING_DIMENSION or 384,
    )


@register_embedder("openai_compatible")
def _create_openai_compatible_embedder(settings: Settings) -> Embedder:
    if settings.PROVIDERS_STRICT and not settings.EMBEDDER_API_KEY:
        raise ProviderNotConfigured(
            "Embedder provider 'openai_compatible' requires EMBEDDER_API_KEY when PROVIDERS_STRICT=True."
        )
    return OpenAICompatibleEmbedder(
        base_url=settings.EMBEDDER_BASE_URL,
        api_key=settings.EMBEDDER_API_KEY,
        model=settings.EMBEDDER_MODEL or "text-embedding-3-small",
        dim=settings.EMBEDDER_DIM or 1536,
        name="openai_compatible",
    )


def get_embedder_provider(settings: Settings) -> Embedder:
    provider_name = (settings.EMBEDDER_PROVIDER or "fake").strip().lower()
    factory_fn = EMBEDDER_REGISTRY.get(provider_name)
    if not factory_fn:
        raise ProviderNotConfigured(
            f"Unknown embedder provider '{settings.EMBEDDER_PROVIDER}'. Registered: {list(EMBEDDER_REGISTRY.keys())}"
        )
    return factory_fn(settings)
