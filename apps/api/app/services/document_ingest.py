"""
Document ingestion: validation, extraction, chunking, storage and indexing for one uploaded file.
Moved out of app/routers/documents.py to keep modules under the size limit (Audit I-22); the router
re-exports the public names, so existing imports keep working.
"""
import asyncio
import hashlib
import logging
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, UploadFile, status

from app.config import settings
from app.db import sqlite
from app.db.repositories.base import DuplicateDocumentError
from app.schemas.document import DocumentResponse, DocumentUploadResponse
from app.services import chunker, embeddings, extractor, pdf_visual, pinecone_service, vector_index
from app.services.lexical_index import lexical_index
from app.services.safe_errors import log_with_reference, safe_message
from app.services.storage import storage_service
from app.services.upload_security import (
    check_zip_decompression_bomb,
    sanitize_filename,
    validate_file_magic_bytes,
)

logger = logging.getLogger(__name__)

ALLOWED_MIME_TYPES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/csv": ".csv",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/tiff": ".tiff",
    "image/tif": ".tiff",
    "image/webp": ".webp",
}

MAX_FILE_SIZE = settings.MAX_FILE_SIZE_MB * 1024 * 1024


def _visual_meta(summary: Optional[Dict[str, Any]], doc_id: str) -> Optional[Dict[str, Any]]:
    """Counts plus page-cited metrics from visual analysis, kept with the document's display metadata."""
    if not summary:
        return None
    meta = {k: v for k, v in summary.items() if k != "metrics"}
    meta["metrics"] = [{"document_id": doc_id, **m} for m in summary.get("metrics", [])][:500]
    return meta


async def process_single_upload(
    file: UploadFile,
    family_entity_id: str = "default_family",
    allowed_role: str = "family_member",
    user_id: Optional[str] = None,
    classification: Optional[str] = None,
) -> DocumentUploadResponse:
    """
    Sovereign Document Ingestion:
    1. Validates MIME type, binary magic-bytes, and decompression bomb safety.
    2. Enforces strict file size bounds (<{settings.MAX_FILE_SIZE_MB}MB).
    3. Offloads parsing to worker threads to protect the event loop.
    4. Persists document provenance, chunks, and metadata in Pinecone & SQLite.
    """
    safe_filename = sanitize_filename(file.filename)
    file_ext = Path(safe_filename).suffix.lower()

    if file_ext in [".doc", ".xls"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Legacy binary formats (.doc, .xls) are not supported. Please upload modern formats (.docx, .xlsx) or PDF/CSV."
        )

    if file_ext not in ALLOWED_MIME_TYPES.values():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file format '{file_ext}'. Allowed formats: PDF, DOCX, XLSX, TXT, CSV, MD, PNG, JPG, JPEG, TIFF."
        )

    doc_id = str(uuid.uuid4())
    stored_filename = f"{doc_id}{file_ext}"

    hasher = hashlib.sha256()
    file_size = 0
    header_bytes = b""

    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=file_ext)
    tmp_path = Path(tmp_file.name)

    try:
        while chunk := await file.read(64 * 1024):
            if not header_bytes:
                header_bytes = chunk[:16]
            hasher.update(chunk)
            file_size += len(chunk)
            if file_size > MAX_FILE_SIZE:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=f"File exceeds maximum allowed upload size of {settings.MAX_FILE_SIZE_MB}MB."
                )
            tmp_file.write(chunk)
        tmp_file.close()

        if not validate_file_magic_bytes(header_bytes, file_ext):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Security rejection: file contents do not match extension '{file_ext}'."
            )

        # Guard against decompression zip bombs (Audit F3)
        check_zip_decompression_bomb(tmp_path)

        file_hash = hasher.hexdigest()

        # Early duplicate check (Finding F1) saves the parsing work; the UNIQUE constraint at insert time
        # is what actually decides, so two concurrent uploads cannot both get through (Audit I-24).
        existing_doc = sqlite.get_document_by_hash(family_entity_id, file_hash)
        if existing_doc and existing_doc.get("status") == "failed":
            # A failed ingestion is hidden from the vault; let the user upload the file again
            sqlite.delete_document(existing_doc["id"])
        elif existing_doc:
            raise duplicate_conflict(existing_doc)

        # Persist original document to S3 or sovereign local storage
        try:
            storage_service.persist_original(tmp_path, doc_id, stored_filename)
        except Exception as se:
            logger.warning("Storage persistence warning: %s", se)

        # 3. Offload document parsing off the event loop (Audit F3)
        try:
            pages = await asyncio.to_thread(extractor.extract_document, tmp_path, file.content_type or "")
        except HTTPException:
            storage_service.delete_stored(doc_id, stored_filename)
            raise
        except extractor.ExtractionRejected as ve:
            storage_service.delete_stored(doc_id, stored_filename)
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(ve))
        except Exception as e:
            storage_service.delete_stored(doc_id, stored_filename)
            ref = log_with_reference("Document extraction failed", e)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=safe_message("Could not read this document. It may be damaged or in an unsupported layout.", ref),
            )

        # 3b. Charts, plots and image-only pages carry information the text layer does not. This runs on
        # the caller's own, already-authorized upload; results become part of each page's text.
        visual_summary = None
        if file_ext == ".pdf":
            visual_summary = await pdf_visual.enrich_pages(tmp_path, pages)
    finally:
        try:
            tmp_file.close()
        except Exception:
            pass
        if tmp_path.exists():
            tmp_path.unlink()

    total_pages = len(pages)

    # 4. Chunk document preserving page provenance
    chunks = chunker.chunk_document(document_id=doc_id, pages=pages)
    if not chunks:
        storage_service.delete_stored(doc_id, stored_filename)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Document '{safe_filename}' contains no extractable text."
        )

    # Add original sanitized filename and OCR/tenant metadata to each chunk
    conf_values = []
    for p in pages:
        val = getattr(p, "confidence", 1.0)
        if isinstance(val, (int, float)):
            conf_values.append(float(val))
        else:
            conf_values.append(1.0)
    avg_conf = (sum(conf_values) / len(conf_values)) if conf_values else 1.0
    is_low_conf = avg_conf < getattr(settings, "OCR_MIN_CONFIDENCE", 0.6)

    for c in chunks:
        c["original_name"] = safe_filename
        c["allowed_role"] = allowed_role
        c["family_entity_id"] = family_entity_id
        c["embedder_model"] = getattr(settings, "EMBEDDER_MODEL", None) or getattr(settings, "EMBEDDING_MODEL", "all-MiniLM-L6-v2")
        c["embedder_dim"] = getattr(settings, "EMBEDDER_DIM", None) or getattr(settings, "EMBEDDING_DIMENSION", 384)

    # 5. Extract real table headers, sample data rows, or text preview
    extracted_columns: List[str] = []
    extracted_sample_rows: List[List[str]] = []
    extracted_preview_text: str = ""
    is_table_doc = False

    for p in pages:
        if getattr(p, "tables", None):
            for t in p.tables:
                lines = [l.strip() for l in t.splitlines() if l.strip()]
                for i in range(len(lines) - 1):
                    if "|" in lines[i] and "---" in lines[i + 1]:
                        header = [c.strip() for c in lines[i].strip("|").split("|")]
                        if len(header) >= 2 and not extracted_columns:
                            extracted_columns = header
                            is_table_doc = True
                            for j in range(i + 2, min(i + 12, len(lines))):
                                if "|" in lines[j]:
                                    row = [c.strip() for c in lines[j].strip("|").split("|")]
                                    if len(row) == len(header):
                                        extracted_sample_rows.append(row)
                            break
                if extracted_columns:
                    break
        if extracted_columns:
            break

    text_snippets = [p.text.strip() for p in pages if getattr(p, "text", "").strip()]
    if text_snippets:
        extracted_preview_text = " ".join(text_snippets)[:500]

    # 6. Transactional Ingestion Step 1: Insert document as 'pending'
    doc_record = {
        "id": doc_id,
        "filename": stored_filename,
        "original_name": safe_filename,
        "mime_type": file.content_type or "application/octet-stream",
        "file_size": file_size,
        "file_hash": file_hash,
        "total_pages": total_pages,
        "family_entity_id": family_entity_id,
        "status": "pending",
        # Set server-side from the authenticated caller and the authorized classification
        "owner_user_id": user_id,
        "classification": classification or ("restricted" if allowed_role == "family_admin" else "confidential"),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "columns": extracted_columns,
        "sample_rows": extracted_sample_rows,
        "preview_text": extracted_preview_text,
        "is_table": is_table_doc or file_ext in [".csv", ".xlsx", ".xls"],
        "low_confidence": is_low_conf,
        "ocr_confidence": avg_conf,
        "visual_extraction": _visual_meta(visual_summary, doc_id),
    }
    try:
        sqlite.insert_document(doc_record)
    except DuplicateDocumentError:
        # Lost the race against a concurrent upload of the same file: report it and leave nothing behind
        storage_service.delete_stored(doc_id, stored_filename)
        raise duplicate_conflict(sqlite.get_document_by_hash(family_entity_id, file_hash))
    sqlite.insert_document_acl(document_id=doc_id, family_entity_id=family_entity_id, allowed_role=allowed_role)
    sqlite.insert_chunks([
        {
            "id": c["id"],
            "document_id": doc_id,
            "chunk_index": c.get("chunk_index", 0),
            "page_number": c.get("page_number", 1),
            "section_title": c.get("section_title"),
            "content": c["content"],
            "is_table": bool(c.get("is_table", False))
        }
        for c in chunks
    ])

    # 7. Transactional Ingestion Step 2: Embed & Upsert Vectors
    roles_for_pinecone = ["family_admin"] if allowed_role == "family_admin" else ["family_admin", "family_member"]
    total_vectors = 0
    try:
        chunk_texts = [c["content"] for c in chunks]
        chunk_embeddings = embeddings.embed_texts(chunk_texts)
        total_vectors = vector_index.upsert_vectors(
            chunks=chunks,
            embeddings=chunk_embeddings,
            family_entity_id=family_entity_id,
            allowed_roles=roles_for_pinecone
        )
        # Step 3: Set status='indexed'
        final_status = "indexed" if total_vectors > 0 else "unindexed"
        sqlite.update_document_status(doc_id, final_status)
        doc_record["status"] = final_status
    except Exception as e:
        logger.error("Vector ingestion failed for document %s: %s", doc_id, e)
        try:
            vector_index.delete_document(doc_id, family_entity_id)
        except Exception:
            pass
        try:
            storage_service.delete_stored(doc_id, stored_filename)
        except Exception:
            pass
        sqlite.update_document_status(doc_id, "failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Vector database upsert failed. Please try again."
        )

    vector_index.save_document(doc_record)
    pinecone_service.get_document_names(family_entity_id=family_entity_id, force=True)

    # Log document upload audit event
    sqlite.log_audit_event(
        action="DOCUMENT_UPLOADED",
        user_id=user_id,
        family_entity_id=family_entity_id,
        resource_id=doc_id,
        details=f"Document '{safe_filename}' uploaded ({total_pages} page(s), {total_vectors} vectors)."
    )

    # Make the new chunks immediately searchable by the keyword half of hybrid retrieval
    lexical_index.add_chunks([
        {
            "chunk_id": c["id"],
            "document_id": doc_id,
            "page_number": c.get("page_number", 1),
            "is_table": bool(c.get("is_table", False)),
            "family_entity_id": family_entity_id,
            "allowed_roles": roles_for_pinecone,
            "original_name": safe_filename,
            "text": c["content"],
        }
        for c in chunks
    ])

    return DocumentUploadResponse(
        message=f"Document '{safe_filename}' processed successfully across {total_pages} page(s).",
        document=DocumentResponse(**doc_record),
        total_chunks=len(chunks),
        total_vectors_indexed=total_vectors
    )


def duplicate_conflict(existing: Optional[Dict[str, Any]]) -> HTTPException:
    name = (existing or {}).get("original_name") or "this file"
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"A document with identical content '{name}' already exists in this family vault.",
    )
