"""
Re-run PDF extraction with visual analysis for a document that is already in the vault (for example
one uploaded before visual analysis existed). The caller must have authorized the action on this
exact document first (routers/documents.py: authorize_document(..., DOCUMENT_UPLOAD)).

Everything is computed before anything is replaced: extraction, visual analysis, chunking and
embeddings. Only then are the document's old chunks, vectors and keyword entries swapped for the
new set, all within the document's own family.
"""
import asyncio
import logging
from pathlib import Path
from typing import Any, Dict

from fastapi import HTTPException, status

from app.config import settings
from app.db import sqlite
from app.services import chunker, embeddings, extractor, pdf_visual, vector_index
from app.services.document_ingest import _visual_meta
from app.services.lexical_index import lexical_index
from app.services.storage import storage_service

logger = logging.getLogger(__name__)


async def reprocess_document_visuals(doc: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    doc_id, family = doc["id"], doc["family_entity_id"]
    if not str(doc.get("original_name", "")).lower().endswith(".pdf"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Visual analysis applies to PDF documents only.")
    path = storage_service.fetch_to_temp(doc_id, doc.get("filename") or "")
    if path is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="The original file is no longer stored, so it cannot be re-analysed. Upload it again.")
    try:
        pages = await asyncio.to_thread(extractor.extract_document, path, "application/pdf")
        summary = await pdf_visual.enrich_pages(path, pages)
    finally:
        Path(path).unlink(missing_ok=True)

    chunks = chunker.chunk_document(document_id=doc_id, pages=pages)
    if not chunks:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="No content could be extracted.")
    restricted = doc.get("classification") == "restricted"
    roles = ["family_admin"] if restricted else ["family_admin", "family_member"]
    for c in chunks:
        c.update({"original_name": doc.get("original_name", ""), "family_entity_id": family,
                  "allowed_role": "family_admin" if restricted else "family_member"})
    vectors = await asyncio.to_thread(embeddings.embed_texts, [c["content"] for c in chunks])
    if len(vectors) != len(chunks) or any(len(v) != settings.EMBEDDING_DIMENSION for v in vectors):
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Embedding failed; nothing was changed.")

    # Swap: old entries out, new entries in (same family only)
    vector_index.delete_document(doc_id, family)
    lexical_index.delete_document_chunks(doc_id)
    sqlite.delete_document_chunks(doc_id, family)
    sqlite.insert_chunks([
        {"id": c["id"], "document_id": doc_id, "chunk_index": c.get("chunk_index", 0),
         "page_number": c.get("page_number", 1), "section_title": c.get("section_title"),
         "content": c["content"], "is_table": bool(c.get("is_table", False))}
        for c in chunks
    ])
    written = vector_index.upsert_vectors(chunks=chunks, embeddings=vectors, family_entity_id=family, allowed_roles=roles)
    lexical_index.add_chunks([
        {"chunk_id": c["id"], "document_id": doc_id, "page_number": c.get("page_number", 1),
         "is_table": bool(c.get("is_table", False)), "family_entity_id": family, "allowed_roles": roles,
         "original_name": doc.get("original_name", ""), "text": c["content"]}
        for c in chunks
    ])
    meta = _visual_meta(summary, doc_id)
    vector_index.save_document({**doc, "visual_extraction": meta})
    sqlite.log_audit_event(
        action="DOCUMENT_VISUAL_ANALYSED", user_id=user_id, family_entity_id=family, resource_id=doc_id,
        details=(f"pages_analysed={summary['analysed']}; charts={summary['charts']}; "
                 f"readable={summary['readable_charts']}; failed_pages={len(summary['failed_pages'])}"),
    )
    return {"document_id": doc_id, "chunks": len(chunks), "vectors": written, **(meta or {})}
