"""
Local vector index for PRIVACY_MODE=local (Audit I-09).

Embeddings live in the app's own database (`chunk_vectors`) and are scored in-process with numpy, so
no document text, vector or filename leaves the deployment. Chunk text is never duplicated: results
are hydrated from `document_chunks`, the system of record. Display metadata (columns, sample rows,
preview) that the Pinecone registry used to hold lives in `document_meta`.

Function names and result shapes mirror services/pinecone_service so callers can switch through
services/vector_index without other changes.
"""
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from app.config import settings
from app.db import sqlite

logger = logging.getLogger(__name__)

# Per-tenant matrix cache. Writes in this process invalidate it immediately; other workers pick up
# changes within the TTL. Deleted chunks can never be returned: hits are hydrated from SQL.
CACHE_TTL_SECONDS = 30.0
_cache: Dict[str, Tuple[float, List[Dict[str, Any]], Optional[np.ndarray]]] = {}
_cache_lock = threading.Lock()

# Display metadata kept per document (everything else comes from the SQL documents row)
DISPLAY_META_FIELDS = ("columns", "sample_rows", "preview_text", "is_table", "low_confidence", "ocr_confidence")


def _invalidate(family_entity_id: str) -> None:
    with _cache_lock:
        _cache.pop(family_entity_id, None)


def _normalise(vector: List[float]) -> np.ndarray:
    arr = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    return arr / norm if norm > 0 else arr


def upsert_vectors(
    chunks: List[Dict[str, Any]],
    embeddings: List[List[float]],
    family_entity_id: str = "default_family",
    allowed_roles: Optional[List[str]] = None,
) -> int:
    """Stores one L2-normalised float32 embedding per chunk. Returns the number stored."""
    allowed_roles = allowed_roles or ["family_admin", "family_member"]
    rows = []
    for chunk, emb in zip(chunks, embeddings):
        vec = _normalise(emb)
        rows.append({
            "chunk_id": chunk["id"],
            "document_id": chunk["document_id"],
            "family_entity_id": family_entity_id,
            "allowed_roles": list(allowed_roles),
            "embedder_model": chunk.get("embedder_model") or settings.EMBEDDING_MODEL,
            "embedding_dim": int(vec.shape[0]),
            "embedding": vec.tobytes(),
        })
    written = sqlite.upsert_chunk_vectors(rows)
    _invalidate(family_entity_id)
    return written


def _tenant_matrix(family_entity_id: str) -> Tuple[List[Dict[str, Any]], Optional[np.ndarray]]:
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(family_entity_id)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            return cached[1], cached[2]

    dim = settings.EMBEDDING_DIMENSION
    entries, vectors = [], []
    for row in sqlite.get_chunk_vectors(family_entity_id):
        vec = np.frombuffer(row["embedding"], dtype=np.float32)
        if vec.shape[0] != dim:
            continue  # written by a different embedder; never compare across vector spaces
        entries.append({"chunk_id": row["chunk_id"], "document_id": row["document_id"],
                        "allowed_roles": set(row["allowed_roles"] or [])})
        vectors.append(vec)
    matrix = np.vstack(vectors) if vectors else None
    with _cache_lock:
        _cache[family_entity_id] = (now, entries, matrix)
    return entries, matrix


def query_similar_chunks(
    query_vector: List[float],
    top_k: int = 5,
    family_entity_id: str = "default_family",
    user_roles: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Tenant and role filters are applied before scoring; unknown roles see nothing (fail closed)."""
    roles = set(user_roles or [])
    if not family_entity_id or not roles or top_k <= 0:
        return []
    entries, matrix = _tenant_matrix(family_entity_id)
    if matrix is None:
        return []
    allowed = np.array([bool(roles & e["allowed_roles"]) for e in entries])
    if not allowed.any():
        return []
    candidate_idx = np.nonzero(allowed)[0]
    scores = matrix[candidate_idx] @ _normalise(query_vector)
    order = np.argsort(-scores)[:top_k]
    picked = [(entries[candidate_idx[i]], float(scores[i])) for i in order]

    chunks = {c["id"]: c for c in sqlite.get_chunks_by_ids([e["chunk_id"] for e, _ in picked])}
    results = []
    for entry, score in picked:
        chunk = chunks.get(entry["chunk_id"])
        if not chunk or chunk.get("family_entity_id") != family_entity_id:
            continue  # deleted since the cache was built, or not this tenant's
        page = int(chunk.get("page_number") or 1)
        results.append({
            "chunk_id": entry["chunk_id"],
            "score": score,
            "metadata": {
                "chunk_id": entry["chunk_id"],
                "document_id": chunk["document_id"],
                "page_number": page,
                "page_no": page,
                "is_table": bool(chunk.get("is_table")),
                "section_title": chunk.get("section_title"),
                "original_name": chunk.get("document_name") or "",
                "family_entity_id": family_entity_id,
                "allowed_roles": sorted(entry["allowed_roles"]),
            },
            "text": chunk.get("content") or "",
        })
    return results


def delete_document(doc_id: str, family_entity_id: str = "default_family",
                    chunk_ids: Optional[List[str]] = None) -> bool:
    """Removes the document's vectors. Returns False if the delete could not be confirmed."""
    try:
        sqlite.delete_chunk_vectors(doc_id, family_entity_id)
        return True
    except Exception as e:
        logger.warning("Local vector delete failed for document %s: %s", doc_id, e)
        return False
    finally:
        _invalidate(family_entity_id)


# --- Document display metadata (replaces the Pinecone documents_registry namespace) ---

def save_document(doc: Dict[str, Any]) -> None:
    meta = {k: doc[k] for k in DISPLAY_META_FIELDS if k in doc}
    sqlite.upsert_document_meta(doc["id"], doc.get("family_entity_id", "default_family"), meta)


def list_documents(family_entity_id: str) -> List[Dict[str, Any]]:
    """Documents of one tenant that finished ingestion, with display metadata. No ACL: callers filter."""
    if not family_entity_id:
        return []
    metas = sqlite.list_document_meta(family_entity_id)
    if not metas:
        return []
    return [
        {**doc, **metas[doc["id"]]}
        for doc in sqlite.get_documents_by_entity(family_entity_id, "family_admin")
        if doc["id"] in metas and doc.get("status") != "failed"
    ]


def get_document(doc_id: str) -> Optional[Dict[str, Any]]:
    meta = sqlite.get_document_meta(doc_id)
    if meta is None:
        return None
    doc = sqlite.get_document_by_id(doc_id)
    return {**doc, **meta} if doc else None
