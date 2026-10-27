import logging
import time
from typing import Any, Dict, List, Optional
from app.config import settings

logger = logging.getLogger(__name__)

_pinecone_client: Optional[Any] = None
_index: Optional[Any] = None


def _field(obj: Any, key: str, default: Any = None) -> Any:
    """Read a field from either a dict-style or object-style Pinecone SDK response."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def get_pinecone_client() -> Optional[Any]:
    global _pinecone_client
    if not settings.PINECONE_API_KEY or settings.PINECONE_API_KEY == "your-pinecone-api-key-here":
        return None
    if _pinecone_client is None:
        try:
            from pinecone import Pinecone
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
        from pinecone import ServerlessSpec
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
    global _index
    pc = get_pinecone_client()
    if not pc:
        raise ValueError(
            "Pinecone API key is not configured. Please set PINECONE_API_KEY in your .env file."
        )
    if _index is None:
        _index = ensure_index_exists()
    return _index


def upsert_vectors(
    chunks: List[Dict[str, Any]],
    embeddings: List[List[float]],
    family_entity_id: str = "default_family",
    allowed_roles: List[str] = None
) -> int:
    """
    Cloud-Native Pinecone Upsert:
    Stores vector coordinates along with full chunk text and metadata directly in Pinecone.
    Eliminates reliance on local disk or SQLite for chunk hydration.
    """
    index = get_index()
    allowed_roles = allowed_roles or ["family_admin", "family_member"]
    
    records = []
    for chunk, emb in zip(chunks, embeddings):
        text_content = chunk.get("content") or chunk.get("content_text") or chunk.get("text", "")
        records.append({
            "id": chunk["id"],
            "values": emb,
            "metadata": {
                "chunk_id": chunk["id"],
                "document_id": chunk["document_id"],
                "page_number": chunk["page_number"],
                "is_table": chunk.get("is_table", False),
                "family_entity_id": family_entity_id,
                "allowed_roles": allowed_roles,
                "text": text_content,
                "original_name": chunk.get("original_name", "")
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
    Returns matched chunks along with their full text content directly from Pinecone metadata.
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
    for m in _field(results, "matches", []) or []:
        meta = dict(_field(m, "metadata", {}) or {})
        matches.append({
            "chunk_id": _field(m, "id"),
            "score": float(_field(m, "score", 0.0) or 0.0),
            "metadata": meta,
            "text": meta.get("text", "")
        })
    return matches


# --- Cloud-Native Document Registry in Pinecone (Zero Local Storage) ---

DOCUMENTS_REGISTRY_NAMESPACE = "documents_registry"


def save_document_to_pinecone(doc: Dict[str, Any]) -> None:
    """
    Stores document metadata records directly in Pinecone's documents_registry namespace.
    Uses a normalized unit vector to satisfy cosine metric requirements.
    """
    index = get_index()
    unit_vec = [1.0] + [0.0] * (settings.EMBEDDING_DIMENSION - 1)
    
    metadata = {
        "id": str(doc["id"]),
        "filename": str(doc["filename"]),
        "original_name": str(doc.get("original_name") or doc["filename"]),
        "mime_type": str(doc.get("mime_type", "application/octet-stream")),
        "file_size": int(doc.get("file_size", 0)),
        "file_hash": str(doc.get("file_hash", "")),
        "total_pages": int(doc.get("total_pages", 1)),
        "family_entity_id": str(doc.get("family_entity_id", "default_family")),
        "status": str(doc.get("status", "indexed")),
        "uploaded_at": str(doc.get("uploaded_at", ""))
    }
    
    index.upsert(
        vectors=[{"id": str(doc["id"]), "values": unit_vec, "metadata": metadata}],
        namespace=DOCUMENTS_REGISTRY_NAMESPACE
    )


def list_documents_from_pinecone(family_entity_id: str = "default_family") -> List[Dict[str, Any]]:
    """
    Retrieves all registered documents from Pinecone cloud storage.
    """
    index = get_index()
    unit_vec = [1.0] + [0.0] * (settings.EMBEDDING_DIMENSION - 1)
    try:
        res = index.query(
            vector=unit_vec,
            top_k=100,
            namespace=DOCUMENTS_REGISTRY_NAMESPACE,
            include_metadata=True
        )
        docs = []
        for match in _field(res, "matches", []) or []:
            meta = dict(_field(match, "metadata", {}) or {})
            if meta.get("family_entity_id") == family_entity_id or family_entity_id == "*":
                docs.append(meta)
        return docs
    except Exception as e:
        logger.error(f"Error querying documents from Pinecone: {e}")
        return []


def get_document_from_pinecone(doc_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetches a specific document metadata record from Pinecone cloud storage.
    """
    index = get_index()
    try:
        res = index.fetch(ids=[doc_id], namespace=DOCUMENTS_REGISTRY_NAMESPACE)
        vectors = _field(res, "vectors", {}) or {}
        meta = _field(vectors.get(doc_id), "metadata")
        return dict(meta) if meta else None
    except Exception as e:
        logger.error(f"Error fetching document from Pinecone: {e}")
        return None


_doc_name_cache: Dict[str, str] = {}
_doc_name_cache_at = 0.0


def get_document_names(force: bool = False) -> Dict[str, str]:
    """document_id -> original filename, cached for 5 minutes (chunk metadata often lacks names)."""
    global _doc_name_cache, _doc_name_cache_at
    if force or not _doc_name_cache or time.time() - _doc_name_cache_at > 300:
        try:
            docs = list_documents_from_pinecone("*")
            _doc_name_cache = {
                str(d.get("id")): str(d.get("original_name") or d.get("filename") or "")
                for d in docs if d.get("id")
            }
            _doc_name_cache_at = time.time()
        except Exception as e:
            logger.warning("Could not refresh document name cache: %s", e)
    return _doc_name_cache


# --- Cloud-Native Users Registry in Pinecone ---

USERS_REGISTRY_NAMESPACE = "users_registry"


def save_user_to_pinecone(user: Dict[str, Any]) -> None:
    """
    Stores user credentials and roles directly in Pinecone's users_registry namespace.
    Zero local database dependence.
    """
    index = get_index()
    unit_vec = [1.0] + [0.0] * (settings.EMBEDDING_DIMENSION - 1)
    user_id = str(user["id"])
    email = str(user.get("email", "")).lower()
    
    metadata = {
        "id": user_id,
        "email": email,
        "hashed_password": str(user.get("hashed_password", "")),
        "full_name": str(user.get("full_name", "")),
        "role": str(user.get("role", "family_admin")),
        "family_entity_id": str(user.get("family_entity_id", "default_family"))
    }
    
    records = [{"id": user_id, "values": unit_vec, "metadata": metadata}]
    if email:
        records.append({"id": f"email_{email}", "values": unit_vec, "metadata": metadata})
        
    index.upsert(vectors=records, namespace=USERS_REGISTRY_NAMESPACE)


def get_user_from_pinecone(user_id_or_email: str) -> Optional[Dict[str, Any]]:
    """
    Fetches a user account record from Pinecone users_registry by user ID or email address.
    """
    index = get_index()
    key = user_id_or_email.lower()
    lookup_id = f"email_{key}" if "@" in key else user_id_or_email
    try:
        res = index.fetch(ids=[lookup_id], namespace=USERS_REGISTRY_NAMESPACE)
        vectors = _field(res, "vectors", {}) or {}
        meta = _field(vectors.get(lookup_id), "metadata")
        return dict(meta) if meta else None
    except Exception as e:
        logger.error(f"Error fetching user from Pinecone: {e}")
        return None


