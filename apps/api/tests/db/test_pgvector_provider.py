"""Tests pgvector VectorStore and tsvector LexicalIndex flag."""

import pytest
from app.config import Settings
from app.providers.vector.registry import VECTOR_REGISTRY, get_vector_store_provider
from app.providers.vector.base import VectorHit, VectorMeta
from app.services.lexical_index import lexical_index


@pytest.mark.asyncio
async def test_pgvector_registered_and_contract():
    assert "pgvector" in VECTOR_REGISTRY
    cfg = Settings(VECTOR_STORE="pgvector", DATABASE_URL="")
    store = get_vector_store_provider(cfg)
    assert store.info.name == "pgvector"
    assert store.is_configured() is False

    # Unconfigured behaviour must not raise but return empty / False
    res = await store.query([0.1, 0.2], family_entity_id="default_family")
    assert res == []

    del_res = await store.delete_by_document("doc1", "default_family")
    assert del_res is False

    meta = await store.get_index_meta()
    assert meta["embedder_model"] == "pgvector"
    assert meta["count"] == 0


def test_tsvector_lexical_flag_default():
    from app.config import settings
    # Default must be False
    assert getattr(settings, "USE_POSTGRES_LEXICAL", False) is False

    # Calling search with default flag runs in-memory BM25
    res = lexical_index.search("invoice", "default_family", ["family_member"])
    assert isinstance(res, list)
