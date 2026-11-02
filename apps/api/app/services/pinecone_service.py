import json
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
    try:
        index = get_index()
    except Exception as e:
        logger.warning(f"Pinecone index unavailable for upsert: {e}")
        return 0
    allowed_roles = allowed_roles or ["family_admin", "family_member"]
    
    records = []
    for chunk, emb in zip(chunks, embeddings):
        text_content = chunk.get("content") or chunk.get("content_text") or chunk.get("text", "")
        page_no = chunk.get("page_no") or chunk.get("page_number", 1)
        role = chunk.get("allowed_role") or (allowed_roles[0] if allowed_roles else "family_member")
        engine = chunk.get("ocr_engine", "digital")
        conf = float(chunk.get("ocr_confidence", 1.0))
        emb_model = chunk.get("embedder_model") or getattr(settings, "EMBEDDER_MODEL", None) or getattr(settings, "EMBEDDING_MODEL", "all-MiniLM-L6-v2")
        emb_dim = chunk.get("embedder_dim") or (len(emb) if emb else getattr(settings, "EMBEDDER_DIM", 384))
        bbox = chunk.get("bbox") or [0.0, 0.0, 0.0, 0.0]

        records.append({
            "id": chunk["id"],
            "values": emb,
            "metadata": {
                "chunk_id": chunk["id"],
                "document_id": chunk["document_id"],
                "page_number": page_no,
                "page_no": page_no,
                "is_table": chunk.get("is_table", False),
                "family_entity_id": family_entity_id,
                "allowed_roles": allowed_roles,
                "allowed_role": role,
                "ocr_engine": engine,
                "ocr_confidence": conf,
                "embedder_model": emb_model,
                "embedder_dim": emb_dim,
                "bbox": bbox,
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
    try:
        index = get_index()
    except Exception as e:
        logger.debug(f"Pinecone unavailable for similarity search: {e}")
        return []
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


def _hydrate_doc_meta(meta: Dict[str, Any]) -> Dict[str, Any]:
    doc = dict(meta)
    if "sample_rows" in doc and isinstance(doc["sample_rows"], str):
        try:
            doc["sample_rows"] = json.loads(doc["sample_rows"])
        except Exception:
            doc["sample_rows"] = []
    if "columns" in doc and isinstance(doc["columns"], str):
        try:
            doc["columns"] = json.loads(doc["columns"])
        except Exception:
            doc["columns"] = []

    # Self-healing fallback: If columns or sample_rows are missing, hydrate from first table chunk
    if not doc.get("sample_rows") and doc.get("id"):
        try:
            index = get_index()
            t0 = index.fetch(ids=[f"{doc['id']}_p1_t0"])
            vecs = _field(t0, "vectors", {}) or {}
            c0 = vecs.get(f"{doc['id']}_p1_t0")
            if c0 and _field(c0, "metadata"):
                cmeta = dict(_field(c0, "metadata"))
                text = cmeta.get("text", "")
                orig = cmeta.get("original_name")
                if orig:
                    doc["original_name"] = orig
                    doc["filename"] = orig
                lines = [l.strip() for l in text.splitlines() if l.strip()]
                for i in range(len(lines) - 1):
                    if "|" in lines[i] and "---" in lines[i + 1]:
                        cols = [c.strip() for c in lines[i].strip("|").split("|")]
                        rows = []
                        for j in range(i + 2, min(i + 12, len(lines))):
                            if "|" in lines[j]:
                                r = [c.strip() for c in lines[j].strip("|").split("|")]
                                if len(r) == len(cols):
                                    rows.append(r)
                        if cols and rows:
                            doc["columns"] = cols
                            doc["sample_rows"] = rows
                            doc["is_table"] = True
                            save_document_to_pinecone(doc)
                        break
        except Exception as e:
            logger.debug(f"Dynamic chunk hydration skipped: {e}")

    return doc


def save_document_to_pinecone(doc: Dict[str, Any]) -> None:
    """
    Stores document metadata records directly in Pinecone's documents_registry namespace.
    Uses a normalized unit vector to satisfy cosine metric requirements.
    """
    try:
        index = get_index()
    except Exception as e:
        logger.warning(f"Could not save document metadata to Pinecone (index unavailable): {e}")
        return
    unit_vec = [1.0] + [0.0] * (settings.EMBEDDING_DIMENSION - 1)

    columns = [str(c) for c in doc.get("columns") or []]
    sample_rows = doc.get("sample_rows") or []
    sample_rows_json = json.dumps(sample_rows) if sample_rows else ""
    preview_text = str(doc.get("preview_text") or "")[:500]
    is_table = bool(doc.get("is_table", False))

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
        "uploaded_at": str(doc.get("uploaded_at", "")),
        "columns": columns,
        "sample_rows": sample_rows_json,
        "preview_text": preview_text,
        "is_table": is_table
    }

    index.upsert(
        vectors=[{"id": str(doc["id"]), "values": unit_vec, "metadata": metadata}],
        namespace=DOCUMENTS_REGISTRY_NAMESPACE
    )


def list_documents_from_pinecone(family_entity_id: str = "default_family") -> List[Dict[str, Any]]:
    """
    Retrieves registered documents from Pinecone cloud storage strictly scoped to family entity.
    """
    try:
        index = get_index()
    except Exception as e:
        logger.debug(f"Pinecone index unavailable: {e}")
        return []
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
            if family_entity_id and meta.get("family_entity_id") == family_entity_id:
                docs.append(_hydrate_doc_meta(meta))
        return docs
    except Exception as e:
        logger.error(f"Error querying documents from Pinecone: {e}")
        return []


def get_document_from_pinecone(doc_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetches a specific document metadata record from Pinecone cloud storage.
    """
    try:
        index = get_index()
    except Exception as e:
        logger.debug(f"Pinecone index unavailable: {e}")
        return None
    try:
        res = index.fetch(ids=[doc_id], namespace=DOCUMENTS_REGISTRY_NAMESPACE)
        vectors = _field(res, "vectors", {}) or {}
        meta = _field(vectors.get(doc_id), "metadata")
        return _hydrate_doc_meta(dict(meta)) if meta else None
    except Exception as e:
        logger.error(f"Error fetching document from Pinecone: {e}")
        return None


def delete_document_from_pinecone(doc_id: str, family_entity_id: str = "default_family") -> None:
    """
    Deletes document registry record and all associated vector chunks from Pinecone.
    """
    try:
        index = get_index()
    except Exception as e:
        logger.debug(f"Pinecone index unavailable: {e}")
        return
    # 1. Delete document metadata record from registry namespace
    try:
        index.delete(ids=[doc_id], namespace=DOCUMENTS_REGISTRY_NAMESPACE)
    except Exception as e:
        logger.warning(f"Error deleting doc metadata {doc_id} from Pinecone registry: {e}")

    # 2. Delete chunk vectors from default namespace
    try:
        index.delete(filter={"document_id": doc_id})
    except Exception as e:
        logger.warning(f"Error deleting vectors for document {doc_id} from Pinecone: {e}")

    # 3. Invalidate document name cache
    global _doc_name_cache, _doc_name_cache_at
    _doc_name_cache.pop(doc_id, None)


_doc_name_cache: Dict[str, str] = {}
_doc_name_cache_at = 0.0


def get_document_names(family_entity_id: Optional[str] = None, force: bool = False) -> Dict[str, str]:
    """
    Retrieves document_id -> original filename mapping from transactional system of record.
    Prevents truncation and cross-tenant leakage.
    """
    from app.db import sqlite
    try:
        return sqlite.get_document_names(family_entity_id=family_entity_id)
    except Exception as e:
        logger.warning("Could not fetch document names from SQLite: %s", e)
        return {}


