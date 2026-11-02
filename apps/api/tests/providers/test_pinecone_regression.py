import pytest
from app.config import Settings
from app.providers.vector.pinecone_store import PineconeVectorStore
from app.services import pinecone_service


@pytest.fixture
def unconfigured_settings():
    return Settings(
        PINECONE_API_KEY=None,
        PINECONE_INDEX_NAME="test-regress-index",
        PROVIDERS_STRICT=False,
    )


def test_pinecone_service_unconfigured_regression():
    """
    Guarantees that commit 034baf4 behaviour is preserved directly on pinecone_service:
    Calling get_document_from_pinecone, delete_document_from_pinecone, list_documents_from_pinecone
    with no PINECONE_API_KEY returns None/[] and does not raise ValueError.
    """
    doc = pinecone_service.get_document_from_pinecone("non_existent_doc_id")
    assert doc is None

    # Deletion should safely no-op
    pinecone_service.delete_document_from_pinecone("some_doc_id", "default_family")

    # List should safely return []
    docs = pinecone_service.list_documents_from_pinecone("default_family")
    assert docs == []


@pytest.mark.asyncio
async def test_pinecone_store_wrapper_unconfigured_regression(unconfigured_settings):
    """
    Guarantees that PineconeVectorStore wrapper preserves the safe 034baf4 contract:
    Unconfigured store must be safe, return empty hits, and no-op on deletions without raising.
    """
    store = PineconeVectorStore(unconfigured_settings)
    assert store.is_configured() is False

    # 1. Querying an unconfigured store returns empty list
    hits = await store.query([0.1] * 8, family_entity_id="fam_test", top_k=5)
    assert hits == []

    # 2. Deleting an unconfigured store returns False safely
    del_doc_res = await store.delete_by_document("doc_xyz", "fam_test")
    assert del_doc_res is False

    del_fam_res = await store.delete_by_family("fam_test")
    assert del_fam_res is False
