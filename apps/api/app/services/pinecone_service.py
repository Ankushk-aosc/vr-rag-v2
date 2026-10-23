import logging
from typing import Any, Dict, List, Optional
from pinecone import Pinecone, ServerlessSpec
from app.config import settings

logger = logging.getLogger(__name__)

_pinecone_client: Optional[Pinecone] = None


def get_pinecone_client() -> Optional[Pinecone]:
    global _pinecone_client
    if not settings.PINECONE_API_KEY or settings.PINECONE_API_KEY == "your-pinecone-api-key-here":
        return None
    if _pinecone_client is None:
        try:
            _pinecone_client = Pinecone(api_key=settings.PINECONE_API_KEY)
        except Exception as e:
            logger.error(f"Failed to initialize Pinecone client: {e}")
            return None
    return _pinecone_client


def ensure_index_exists():
    pc = get_pinecone_client()
    if not pc:
        return None
    
    index_name = settings.PINECONE_INDEX_NAME
    existing_indexes = [idx.name for idx in pc.list_indexes()]
    
    if index_name not in existing_indexes:
        logger.info(f"Creating Pinecone serverless index '{index_name}'...")
        pc.create_index(
            name=index_name,
            dimension=settings.EMBEDDING_DIMENSION,
            metric="cosine",
            spec=ServerlessSpec(
                cloud=settings.PINECONE_CLOUD,
                region=settings.PINECONE_REGION
            )
        )
    return pc.Index(index_name)


def get_index():
    pc = get_pinecone_client()
    if not pc:
        raise ValueError(
            "Pinecone API key is not configured. Please set PINECONE_API_KEY in your .env file."
        )
    return ensure_index_exists()


def upsert_vectors(
    chunks: List[Dict[str, Any]],
    embeddings: List[List[float]],
    family_entity_id: str = "default_family",
    allowed_roles: List[str] = None
) -> int:
    """
    Privacy-Safe Upsert:
    Only anonymized vector coordinates and chunk ID pointers are uploaded to Pinecone.
    Raw financial text and personal names are NOT stored in cloud metadata.
    """
    index = get_index()
    allowed_roles = allowed_roles or ["family_admin", "family_member"]
    
    records = []
    for chunk, emb in zip(chunks, embeddings):
        records.append({
            "id": chunk["id"],
            "values": emb,
            "metadata": {
                "chunk_id": chunk["id"],
                "document_id": chunk["document_id"],
                "page_number": chunk["page_number"],
                "is_table": chunk.get("is_table", False),
                "family_entity_id": family_entity_id,
                "allowed_roles": allowed_roles
            }
        })
        
    # Upsert in batches of 100
    batch_size = 100
    total_upserted = 0
    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        index.upsert(vectors=batch)
        total_upserted += len(batch)
        
    return total_upserted


def query_similar_chunks(
    query_vector: List[float],
    top_k: int = 5,
    family_entity_id: str = "default_family",
    user_roles: List[str] = None
) -> List[Dict[str, Any]]:
    """
    Pre-Retrieval Filtered Search:
    Applies family entity and role filters directly inside Pinecone prior to similarity ranking.
    """
    index = get_index()
    user_roles = user_roles or ["family_admin", "family_member"]
    
    # Metadata filter to guarantee zero cross-family or unauthorized leakage
    query_filter = {
        "family_entity_id": {"$eq": family_entity_id},
        "allowed_roles": {"$in": user_roles}
    }
    
    results = index.query(
        vector=query_vector,
        top_k=top_k,
        filter=query_filter,
        include_metadata=True
    )
    
    matches = []
    for m in results.get("matches", []):
        matches.append({
            "chunk_id": m["id"],
            "score": m["score"],
            "metadata": m.get("metadata", {})
        })
    return matches
