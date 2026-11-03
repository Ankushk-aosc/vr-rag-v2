"""
I-02 regression: semantic retrieval must embed queries with the same embedder that ingestion used
to write the Pinecone index (services.embeddings, EMBEDDING_DIMENSION), regardless of EMBEDDER_PROVIDER.
Previously the registry embedder (default `fake`, 8 dims) was used, so every Pinecone query failed
and retrieval silently degraded to keyword-only.
"""
import asyncio

import pytest

from app.config import settings
from app.services import embeddings, pinecone_service, rag_engine

pytestmark = pytest.mark.usefixtures("cloud_mode")  # Pinecone-path tests (Audit I-09: local is the default)


@pytest.fixture
def captured(monkeypatch):
    calls = []

    def fake_query(query_vector, top_k, family_entity_id, user_roles):
        calls.append({"vector": query_vector, "family": family_entity_id, "roles": user_roles, "k": top_k})
        return []

    monkeypatch.setattr(pinecone_service, "query_similar_chunks", fake_query)
    return calls


def test_query_uses_ingestion_embedder_not_registry(monkeypatch, captured):
    monkeypatch.setattr(settings, "EMBEDDER_PROVIDER", "fake")
    monkeypatch.setattr(settings, "EMBEDDER_DIM", 8)

    def registry_must_not_be_used(*_args, **_kwargs):
        raise AssertionError("registry embedder must not feed the Pinecone query")

    monkeypatch.setattr("app.providers.factory.get_embedder", registry_must_not_be_used)

    ingestion_vectors = []

    def fake_embed_query(text, allow_fallback=False):
        vec = [0.01] * settings.EMBEDDING_DIMENSION
        ingestion_vectors.append(vec)
        return vec

    monkeypatch.setattr(embeddings, "embed_query", fake_embed_query)

    asyncio.run(rag_engine._semantic_search("franking credits FY24", "fam_a", ["family_member"], 20))

    assert len(captured) == 1
    assert captured[0]["vector"] is ingestion_vectors[0]
    assert len(captured[0]["vector"]) == settings.EMBEDDING_DIMENSION
    assert captured[0]["family"] == "fam_a"
    assert captured[0]["roles"] == ["family_member"]


def test_dimension_mismatch_fails_before_querying_pinecone(monkeypatch, captured):
    monkeypatch.setattr(embeddings, "embed_query", lambda text, allow_fallback=False: [0.1] * 8)

    with pytest.raises(RuntimeError, match="dims"):
        asyncio.run(rag_engine._semantic_search("question", "fam_a", ["family_admin"], 20))
    assert captured == []


def test_embedding_failure_fails_closed(monkeypatch, captured):
    def unavailable(text, allow_fallback=False):
        raise RuntimeError("Embedding model is unavailable.")

    monkeypatch.setattr(embeddings, "embed_query", unavailable)

    with pytest.raises(RuntimeError, match="unavailable"):
        asyncio.run(rag_engine._semantic_search("question", "fam_a", ["family_admin"], 20))
    assert captured == []
