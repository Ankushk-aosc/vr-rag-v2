import socket
import pytest
from app.config import Settings
from app.providers.vector.base import VectorMeta
from app.providers.vector.memory import InMemoryVectorStore
from app.providers.vector.pinecone_store import PineconeVectorStore


@pytest.fixture
def unconfigured_pinecone_settings():
    return Settings(
        PINECONE_API_KEY=None,
        PINECONE_INDEX_NAME="unconfigured-test-index",
        PROVIDERS_STRICT=False,
    )


@pytest.mark.asyncio
async def test_in_memory_vector_store_contract():
    store = InMemoryVectorStore(embedder_model="fake-embed-8", embedder_dim=8)
    assert store.is_configured() is True

    # 1. Upsert 3 vectors across two family entities
    v1 = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    meta1 = VectorMeta(
        family_entity_id="fam_alpha",
        document_id="doc_1",
        allowed_role="family_admin",
        page_no=1,
        chunk_id="c1",
        extra={"text": "Alpha distribution details"}
    )

    v2 = [0.95, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    meta2 = VectorMeta(
        family_entity_id="fam_alpha",
        document_id="doc_2",
        allowed_role="family_member",
        page_no=2,
        chunk_id="c2",
        extra={"text": "Alpha general balance"}
    )

    v3 = [0.99, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    meta3 = VectorMeta(
        family_entity_id="fam_beta",
        document_id="doc_3",
        allowed_role="family_admin",
        page_no=1,
        chunk_id="c3",
        extra={"text": "Beta secret statements"}
    )

    count = await store.upsert([("c1", v1, meta1), ("c2", v2, meta2), ("c3", v3, meta3)])
    assert count == 3

    # 2. Query tenant A: must never see Beta
    hits_a = await store.query(v1, family_entity_id="fam_alpha", top_k=5)
    assert len(hits_a) == 2
    assert all(h.metadata["family_entity_id"] == "fam_alpha" for h in hits_a)
    assert not any(h.id == "c3" for h in hits_a)

    # 3. RBAC filtering: family_member cannot see family_admin chunks
    hits_member = await store.query(v1, family_entity_id="fam_alpha", allowed_roles=["family_member"], top_k=5)
    assert len(hits_member) == 1
    assert hits_member[0].id == "c2"

    # 4. Delete by document
    del_ok = await store.delete_by_document("doc_1", "fam_alpha")
    assert del_ok is True
    hits_after_doc_del = await store.query(v1, family_entity_id="fam_alpha", top_k=5)
    assert len(hits_after_doc_del) == 1
    assert hits_after_doc_del[0].id == "c2"

    # 5. Delete by family
    del_fam_ok = await store.delete_by_family("fam_alpha")
    assert del_fam_ok is True
    hits_after_fam_del = await store.query(v1, family_entity_id="fam_alpha", top_k=5)
    assert len(hits_after_fam_del) == 0


@pytest.mark.asyncio
async def test_unconfigured_pinecone_store_contract(monkeypatch, unconfigured_pinecone_settings):
    # Strictly forbid any network calls
    def guard_socket(*args, **kwargs):
        raise RuntimeError("CRITICAL: Network call attempted by unconfigured vector store!")

    monkeypatch.setattr(socket, "socket", guard_socket)

    store = PineconeVectorStore(unconfigured_pinecone_settings)
    assert store.is_configured() is False

    # query() MUST return [] (never raise)
    dummy_vec = [1.0] * 8
    hits = await store.query(dummy_vec, family_entity_id="fam_alpha", top_k=5)
    assert hits == []

    # delete_* MUST return False (never raise)
    del_doc = await store.delete_by_document("doc_1", "fam_alpha")
    assert del_doc is False

    del_fam = await store.delete_by_family("fam_alpha")
    assert del_fam is False

    # get_index_meta returns safe metadata
    meta = await store.get_index_meta()
    assert meta["count"] == 0
    assert meta["untagged"] is True
