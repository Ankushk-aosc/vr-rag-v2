from typing import Callable, Dict
from app.config import Settings
from app.providers.errors import ProviderNotConfigured
from app.providers.vector.base import VectorStore
from app.providers.vector.memory import InMemoryVectorStore
from app.providers.vector.pinecone_store import PineconeVectorStore
from app.providers.vector.pgvector_store import PgVectorStore

VECTOR_REGISTRY: Dict[str, Callable[[Settings], VectorStore]] = {}


def register_vector_store(name: str):
    def decorator(fn: Callable[[Settings], VectorStore]):
        VECTOR_REGISTRY[name.lower()] = fn
        return fn
    return decorator


@register_vector_store("memory")
def _create_memory_vector_store(settings: Settings) -> VectorStore:
    return InMemoryVectorStore(
        embedder_model=settings.EMBEDDER_MODEL or "fake-embed-8",
        embedder_dim=settings.EMBEDDER_DIM or 8,
    )


@register_vector_store("pinecone")
def _create_pinecone_vector_store(settings: Settings) -> VectorStore:
    store = PineconeVectorStore(settings)
    if settings.PROVIDERS_STRICT and not store.is_configured():
        raise ProviderNotConfigured(
            "Vector store 'pinecone' requires PINECONE_API_KEY when PROVIDERS_STRICT=True."
        )
    return store


@register_vector_store("pgvector")
def _create_pgvector_vector_store(settings: Settings) -> VectorStore:
    store = PgVectorStore(settings)
    if settings.PROVIDERS_STRICT and not store.is_configured():
        raise ProviderNotConfigured(
            "Vector store 'pgvector' requires DATABASE_URL pointing to PostgreSQL when PROVIDERS_STRICT=True."
        )
    return store


def get_vector_store_provider(settings: Settings) -> VectorStore:
    provider_name = (settings.VECTOR_STORE or "memory").strip().lower()
    factory_fn = VECTOR_REGISTRY.get(provider_name)
    if not factory_fn:
        raise ProviderNotConfigured(
            f"Unknown vector store '{settings.VECTOR_STORE}'. Registered: {list(VECTOR_REGISTRY.keys())}"
        )
    return factory_fn(settings)
