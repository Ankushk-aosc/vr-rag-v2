"""
Vector index backend switch (Audit I-09).

PRIVACY_MODE=local uses services/local_vector_index (app database, nothing leaves the deployment).
PRIVACY_MODE=cloud uses services/pinecone_service (disclosed cloud flow). The backend is chosen per
call so tests and operators can switch modes without re-importing.
"""
from typing import Any, Dict, Iterable, List, Optional

from app.config import is_dev_environment, settings
from app.db import sqlite
from app.services import local_vector_index, pinecone_service


def is_local() -> bool:
    return settings.is_local_mode


def upsert_vectors(chunks: List[Dict[str, Any]], embeddings: List[List[float]],
                   family_entity_id: str, allowed_roles: Optional[List[str]] = None) -> int:
    if uses_app_database():
        return local_vector_index.upsert_vectors(chunks, embeddings, family_entity_id, allowed_roles)
    return pinecone_service.upsert_vectors(
        chunks=chunks, embeddings=embeddings, family_entity_id=family_entity_id, allowed_roles=allowed_roles
    )


class LegacyVectorStoreDisabled(RuntimeError):
    pass


def uses_app_database() -> bool:
    """PostgreSQL (pgvector) is the primary store whenever DATABASE_URL points at it, in either privacy
    mode; otherwise local mode uses the SQLite index. Pinecone is only a development fallback, or an
    explicit ALLOW_LEGACY_VECTOR_STORE opt-in; anywhere else this refuses (fail closed)."""
    if is_local() or sqlite.is_postgres():
        return True
    if is_dev_environment(settings.ENVIRONMENT) or settings.ALLOW_LEGACY_VECTOR_STORE:
        return False
    raise LegacyVectorStoreDisabled(
        "Retrieval requires PostgreSQL + pgvector (set DATABASE_URL). The legacy Pinecone index is disabled "
        "outside development unless ALLOW_LEGACY_VECTOR_STORE=true."
    )


def assert_production_vector_store() -> None:
    """Startup check: outside development the API must run on PostgreSQL with the pgvector column."""
    if is_dev_environment(settings.ENVIRONMENT) or settings.ALLOW_LEGACY_VECTOR_STORE:
        return
    if not sqlite.is_postgres():
        raise LegacyVectorStoreDisabled("DATABASE_URL must point at PostgreSQL with pgvector outside development.")
    repo = sqlite.get_local_index_repository()
    if not getattr(repo, "pgvector_enabled", lambda: False)():
        raise LegacyVectorStoreDisabled("pgvector is not available: install the extension and run migrations to head.")


def query_similar_chunks(query_vector: List[float], top_k: int, family_entity_id: str,
                         user_roles: List[str], allowed_document_ids: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
    if uses_app_database():
        return local_vector_index.query_similar_chunks(
            query_vector, top_k, family_entity_id, user_roles, allowed_document_ids=allowed_document_ids
        )
    return pinecone_service.query_similar_chunks(
        query_vector=query_vector, top_k=top_k, family_entity_id=family_entity_id, user_roles=user_roles,
        allowed_document_ids=allowed_document_ids,
    )


def delete_document(doc_id: str, family_entity_id: str, chunk_ids: Optional[List[str]] = None) -> bool:
    if uses_app_database():
        return local_vector_index.delete_document(doc_id, family_entity_id, chunk_ids)
    return pinecone_service.delete_document_from_pinecone(doc_id, family_entity_id, chunk_ids=chunk_ids)


def save_document(doc: Dict[str, Any]) -> None:
    if uses_app_database():
        local_vector_index.save_document(doc)
    else:
        pinecone_service.save_document_to_pinecone(doc)


def list_documents(family_entity_id: str) -> List[Dict[str, Any]]:
    if uses_app_database():
        return local_vector_index.list_documents(family_entity_id)
    return pinecone_service.list_documents_from_pinecone(family_entity_id=family_entity_id)


def get_document(doc_id: str) -> Optional[Dict[str, Any]]:
    if uses_app_database():
        return local_vector_index.get_document(doc_id)
    return pinecone_service.get_document_from_pinecone(doc_id)
