import asyncio
import hashlib
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.schemas.document import BatchDocumentUploadResponse, DocumentResponse, DocumentTableResponse, DocumentUploadResponse
from app.services import auth, chunker, embeddings, extractor, pinecone_service, vector_index
from app.services.storage import storage_service
from app.services.lexical_index import lexical_index
from app.services.safe_errors import log_with_reference, safe_message
from app.services.table_reader import read_document_table_data
from app.db import sqlite
from app.db.repositories.base import DuplicateDocumentError

router = APIRouter(prefix="/api/documents", tags=["Documents"])

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

import logging
from app.config import settings
from app.services.upload_security import (
    sanitize_filename,
    validate_file_magic_bytes,
    check_zip_decompression_bomb,
)

logger = logging.getLogger(__name__)

MAX_FILE_SIZE = settings.MAX_FILE_SIZE_MB * 1024 * 1024

# Document ACL values an uploader may choose (Audit I-07): family-wide, or restricted to admins.
# Advisers read family-wide documents via the member tag, so they are not a separate ACL value.
UploadAclRole = Literal["family_member", "family_admin"]


async def _process_single_upload(
    file: UploadFile,
    family_entity_id: str = "default_family",
    allowed_role: str = "family_member",
    user_id: Optional[str] = None
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
            raise _duplicate_conflict(existing_doc)

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
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "columns": extracted_columns,
        "sample_rows": extracted_sample_rows,
        "preview_text": extracted_preview_text,
        "is_table": is_table_doc or file_ext in [".csv", ".xlsx", ".xls"],
        "low_confidence": is_low_conf,
        "ocr_confidence": avg_conf
    }
    try:
        sqlite.insert_document(doc_record)
    except DuplicateDocumentError:
        # Lost the race against a concurrent upload of the same file: report it and leave nothing behind
        storage_service.delete_stored(doc_id, stored_filename)
        raise _duplicate_conflict(sqlite.get_document_by_hash(family_entity_id, file_hash))
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


def _duplicate_conflict(existing: Optional[Dict[str, Any]]) -> HTTPException:
    name = (existing or {}).get("original_name") or "this file"
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"A document with identical content '{name}' already exists in this family vault.",
    )


def _validate_uploader(family_entity_id: str, current_user: Dict[str, Any]) -> str:
    user_memberships = current_user.get("memberships") or []
    if not user_memberships:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User has no family memberships."
        )
    target_membership = next((m for m in user_memberships if m["family_entity_id"] == family_entity_id), None)
    if not target_membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: You do not hold active membership in family entity '{family_entity_id}'."
        )
    if target_membership.get("role") == "read_only_adviser":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Read-only advisers are not permitted to upload documents."
        )
    return target_membership.get("role", "family_member")


def _membership_role(family_entity_id: str, current_user: Dict[str, Any]) -> str:
    """Returns the caller's role in the entity, or raises 403 if they are not a member."""
    membership = next(
        (m for m in (current_user.get("memberships") or []) if m["family_entity_id"] == family_entity_id),
        None,
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: You do not hold active membership in family entity '{family_entity_id}'."
        )
    return membership.get("role", "family_member")


def _role_can_view(acl_roles: List[str], role: str) -> bool:
    """Same rule as the SQL listing query: admins see everything, others need a matching or member-wide ACL."""
    if role == "family_admin":
        return True
    return any(r in (role, "family_member") for r in acl_roles)


def _list_entity_documents(family_entity_id: str, role: str) -> List[Dict[str, Any]]:
    """
    Documents for one entity, ACL-filtered for the caller's role against SQL (Audit I-05).
    Pinecone registry records (richer display metadata) come first; every SQL-visible document the
    registry did not return is appended, so Pinecone being off, empty, capped or missing unindexed
    uploads never hides documents (Audit I-04, I-08).
    """
    # Failed ingestions keep their SQL row for reconciliation but are not usable documents
    sql_docs = [
        d for d in sqlite.get_documents_by_entity(family_entity_id, role)
        if d.get("status") != "failed"
    ]

    try:
        cloud_docs = vector_index.list_documents(family_entity_id)
    except Exception as e:
        logger.debug(f"Pinecone document listing unavailable: {e}")
        cloud_docs = []

    if cloud_docs and role != "family_admin":
        # Registry records carry no ACL; non-admins only see documents the SQL ACL grants them
        visible_ids = {d["id"] for d in sql_docs}
        cloud_docs = [d for d in cloud_docs if d.get("id") in visible_ids]

    cloud_ids = {d.get("id") for d in cloud_docs}
    return cloud_docs + [d for d in sql_docs if d["id"] not in cloud_ids]


def _load_authorized_document(document_id: str, current_user: Dict[str, Any]) -> Dict[str, Any]:
    """
    Loads one document for reading after tenant and ACL checks (Audit I-05).
    The SQL system of record decides tenancy and access; the Pinecone registry only contributes
    display metadata (columns, sample rows, preview). Works with Pinecone unconfigured.
    """
    sql_doc = sqlite.get_document_by_id(document_id)
    cloud_doc = vector_index.get_document(document_id)
    if not sql_doc and not cloud_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    if sql_doc and sql_doc.get("status") == "failed":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")

    doc_entity = (sql_doc or cloud_doc).get("family_entity_id")
    membership = next(
        (m for m in (current_user.get("memberships") or []) if m["family_entity_id"] == doc_entity),
        None,
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: You are not authorized to view this document."
        )

    role = membership.get("role", "family_member")
    if sql_doc:
        allowed = _role_can_view(sqlite.get_document_allowed_roles(document_id, doc_entity), role)
    else:
        # Legacy registry-only record with no ACL row: fail closed to admins
        allowed = role == "family_admin"
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied: Your role is not permitted to view this document."
        )

    # SQL fields win on overlap so tenancy/status always reflect the system of record
    return {**(cloud_doc or {}), **(sql_doc or {})}


@router.post("/upload", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family"),
    allowed_role: UploadAclRole = Form("family_member"),
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    _validate_uploader(family_entity_id, current_user)
    return await _process_single_upload(
        file=file,
        family_entity_id=family_entity_id,
        allowed_role=allowed_role,
        user_id=current_user.get("id")
    )


@router.post("/upload-batch", response_model=BatchDocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_documents_batch(
    files: List[UploadFile] = File(...),
    family_entity_id: str = Form("default_family"),
    allowed_role: UploadAclRole = Form("family_member"),
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Multi-file batch upload:
    Ingests multiple files into Pinecone Cloud with independent 100MB validation per file.
    """
    _validate_uploader(family_entity_id, current_user)
    successful_docs = []
    errors = []
    for f in files:
        try:
            res = await _process_single_upload(
                file=f,
                family_entity_id=family_entity_id,
                allowed_role=allowed_role,
                user_id=current_user.get("id")
            )
            successful_docs.append(res.document)
        except HTTPException as he:
            errors.append(f"{f.filename}: {he.detail}")
        except Exception as e:
            ref = log_with_reference(f"Batch upload of {f.filename!r} failed", e)
            errors.append(f"{f.filename}: {safe_message('Upload failed', ref)}")

    return BatchDocumentUploadResponse(
        message=f"Processed {len(successful_docs)} of {len(files)} file(s) into Pinecone.",
        total_files=len(files),
        successful_files=len(successful_docs),
        documents=successful_docs,
        errors=errors
    )


@router.get("", response_model=List[DocumentResponse])
async def list_documents(
    family_entity_id: Optional[str] = None,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    List documents directly from Pinecone Cloud Registry filtered strictly by authorized family entity.
    """
    user_memberships = current_user.get("memberships") or []
    if not user_memberships:
        return []

    target_entity = family_entity_id or user_memberships[0]["family_entity_id"]
    role = _membership_role(target_entity, current_user)
    return [DocumentResponse(**d) for d in _list_entity_documents(target_entity, role)]


@router.get("/suggestions", response_model=List[str])
async def get_document_suggestions(
    family_entity_id: Optional[str] = None,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Generate dynamic financial query suggestions based on actual indexed documents in Pinecone or SQLite.
    """
    user_memberships = current_user.get("memberships") or []
    if not user_memberships:
        return [
            "Deposit financial records into the vault to generate insights",
            "Ask questions about AUD balances or portfolios"
        ]

    target_entity = family_entity_id or user_memberships[0]["family_entity_id"]
    role = _membership_role(target_entity, current_user)
    docs = _list_entity_documents(target_entity, role)

    if not docs:
        return [
            "Deposit financial records into the vault to generate insights",
            "Ask questions about AUD balances or portfolios"
        ]

    suggestions = []
    for d in docs:
        name = d.get("original_name", "")
        stem = Path(name).stem.replace("_", " ")
        cols = d.get("columns") or []

        amount_col = next((c for c in cols if any(k in c.lower() for k in ["amount", "balance", "price", "val", "cost", "total", "spend"])), None)
        date_col = next((c for c in cols if any(k in c.lower() for k in ["date", "time", "year", "month", "day"])), None)
        cat_col = next((c for c in cols if any(k in c.lower() for k in ["category", "merchant", "description", "type", "vendor"])), None)

        if amount_col and (date_col or cat_col):
            suggestions.append(f"Chart {amount_col} breakdown in {stem}")
            if date_col:
                suggestions.append(f"Trend of {amount_col} over {date_col} in {stem}")
        elif "credit card" in stem.lower() or "transaction" in stem.lower():
            suggestions.append(f"Monthly spending and total amounts in {stem}")
            suggestions.append(f"Category breakdown of transactions in {stem}")
        elif any(k in stem.lower() for k in ["equity", "share", "stock", "holding", "portfolio"]):
            suggestions.append(f"Portfolio holdings and valuation summary in {stem}")
        else:
            suggestions.append(f"Key financial figures and summary of {stem}")

        if len(suggestions) >= 4:
            break

    if len(suggestions) < 2:
        suggestions.append("Deposit financial records to plot 3D charts")
        suggestions.append("Ask questions about AUD portfolios or transactions")

    return suggestions[:4]


@router.get("/{document_id}", response_model=DocumentResponse)
async def get_document(
    document_id: str,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Retrieve document metadata (tenant- and ACL-checked against the SQL system of record).
    """
    return DocumentResponse(**_load_authorized_document(document_id, current_user))


@router.get("/{document_id}/table", response_model=DocumentTableResponse)
async def get_document_table(
    document_id: str,
    page: int = 1,
    page_size: int = 50,
    search: Optional[str] = None,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Retrieve full tabular records (Pinecone chunks, or SQL chunks when Pinecone is unavailable).
    Supports horizontal/vertical pagination across all rows and real-time search.
    """
    doc = _load_authorized_document(document_id, current_user)

    filename = doc.get("original_name") or doc.get("filename") or "Document"
    columns, rows, total_rows, calc_pages = read_document_table_data(
        doc=doc,
        document_id=document_id,
        page=page,
        page_size=page_size,
        search=search
    )

    return DocumentTableResponse(
        document_id=document_id,
        filename=filename,
        columns=columns,
        rows=rows,
        total_rows=total_rows,
        page=page,
        page_size=page_size,
        total_pages=calc_pages
    )


@router.delete("/{document_id}")
async def delete_document(
    document_id: str,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Sovereign Document Deletion (APP 11 / right to erasure):
    Erases the document from Pinecone (vectors + registry), original-file storage (local / S3),
    the BM25 index and the SQL system of record (cascading chunks & ACL).

    Remote tiers are erased first and the SQL row last (Audit I-06): if Pinecone or file storage
    cannot confirm deletion, the request fails with 502 and the SQL record is kept, so the
    document stays visible and the (idempotent) delete can simply be retried. Erasure is never
    reported for data that may still exist.
    """
    sql_doc = sqlite.get_document_by_id(document_id)
    # SQL is authoritative for tenancy; the registry only covers legacy registry-only records
    doc = sql_doc or vector_index.get_document(document_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")

    doc_entity = doc.get("family_entity_id")
    user_memberships = current_user.get("memberships") or []
    target_membership = next((m for m in user_memberships if m["family_entity_id"] == doc_entity), None)
    if not target_membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: You are not authorized to delete documents in this entity."
        )
    if target_membership.get("role") != "family_admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied: Only family_admin can delete documents from the vault."
        )

    # 1. Remote tiers first: Pinecone vectors + registry, then the stored original file
    chunk_ids = sqlite.get_chunk_ids_for_document(document_id, doc_entity) if sql_doc else []
    vectors_deleted = vector_index.delete_document(document_id, doc_entity, chunk_ids=chunk_ids)
    stored_filename = doc.get("filename")
    file_deleted = storage_service.delete_stored(document_id, stored_filename) if stored_filename else True

    if not (vectors_deleted and file_deleted):
        incomplete = [t for t, done in (("vector index", vectors_deleted), ("file storage", file_deleted)) if not done]
        sqlite.log_audit_event(
            action="DOCUMENT_DELETE_INCOMPLETE",
            user_id=current_user.get("id"),
            family_entity_id=doc_entity,
            resource_id=document_id,
            details=f"Deletion not confirmed in: {', '.join(incomplete)}. SQL record retained for retry."
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Document could not be fully erased from all storage tiers. It has been kept; please retry the deletion."
        )

    # 2. Delete from in-memory / cached BM25 lexical index
    lexical_index.delete_document_chunks(document_id)

    # 3. Delete from SQL System of Record last (cascades to chunks & ACL)
    sqlite.delete_document(document_id)

    # 4. Audit log event
    sqlite.log_audit_event(
        action="DOCUMENT_DELETED",
        user_id=current_user.get("id"),
        family_entity_id=doc_entity,
        resource_id=document_id,
        details=f"Document '{doc.get('original_name')}' deleted by user."
    )

    return {
        "message": f"Document '{doc.get('original_name')}' successfully deleted across all storage tiers.",
        "document_id": document_id
    }
