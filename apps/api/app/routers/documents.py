import asyncio
import hashlib
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.schemas.document import BatchDocumentUploadResponse, DocumentResponse, DocumentTableResponse, DocumentUploadResponse
from app.services import auth, chunker, embeddings, extractor, pinecone_service
from app.services.lexical_index import lexical_index
from app.services.table_reader import read_document_table_data
from app.db import sqlite

router = APIRouter(prefix="/api/documents", tags=["Documents"])

ALLOWED_MIME_TYPES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/csv": ".csv"
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
            detail=f"Unsupported file format '{file_ext}'. Allowed formats: PDF, DOCX, XLSX, TXT, CSV, MD."
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

        # Check for duplicate document in this entity (Finding F1 fix)
        existing_doc = sqlite.get_document_by_hash(family_entity_id, file_hash)
        if existing_doc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A document with identical content '{existing_doc.get('original_name')}' already exists in this family vault."
            )

        # 3. Offload document parsing off the event loop (Audit F3)
        try:
            pages = await asyncio.to_thread(extractor.extract_document, tmp_path, file.content_type or "")
        except HTTPException:
            raise
        except ValueError as ve:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(ve))
        except Exception as e:
            logger.error("Document extraction error: %s", e)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Failed to extract document contents: {str(e)[:120]}"
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
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Document '{safe_filename}' contains no extractable text."
        )

    # Add original sanitized filename to each chunk metadata
    for c in chunks:
        c["original_name"] = safe_filename

    # 5. Generate embeddings with all-MiniLM-L6-v2
    chunk_texts = [c["content"] for c in chunks]
    try:
        chunk_embeddings = embeddings.embed_texts(chunk_texts)
    except Exception as e:
        logger.error("Embedding computation error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to compute embeddings. Vector ingestion halted."
        )

    # 6. Upsert vectors into Pinecone Cloud
    roles_for_pinecone = ["family_admin"] if allowed_role == "family_admin" else ["family_admin", "family_member"]
    total_vectors = 0
    try:
        total_vectors = pinecone_service.upsert_vectors(
            chunks=chunks,
            embeddings=chunk_embeddings,
            family_entity_id=family_entity_id,
            allowed_roles=roles_for_pinecone
        )
    except Exception as e:
        logger.error("Pinecone vector upsert error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Vector database upsert failed. Please try again."
        )

    # 7. Extract real table headers, sample data rows, or text preview
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

    # 8. Persist document record into SQLite System of Record & Pinecone Cloud Registry
    doc_record = {
        "id": doc_id,
        "filename": stored_filename,
        "original_name": safe_filename,
        "mime_type": file.content_type or "application/octet-stream",
        "file_size": file_size,
        "file_hash": file_hash,
        "total_pages": total_pages,
        "family_entity_id": family_entity_id,
        "status": "indexed" if total_vectors > 0 else "unindexed",
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "columns": extracted_columns,
        "sample_rows": extracted_sample_rows,
        "preview_text": extracted_preview_text,
        "is_table": is_table_doc or file_ext in [".csv", ".xlsx", ".xls"]
    }
    sqlite.insert_document(doc_record)
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

    pinecone_service.save_document_to_pinecone(doc_record)
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


@router.post("/upload", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family"),
    allowed_role: str = Form("family_member"),
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
    allowed_role: str = Form("family_member"),
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
        except Exception as e:
            err_msg = getattr(e, "detail", str(e))
            errors.append(f"{f.filename}: {err_msg}")

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
    if not any(m["family_entity_id"] == target_entity for m in user_memberships):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: You do not hold active membership in family entity '{target_entity}'."
        )

    try:
        cloud_docs = pinecone_service.list_documents_from_pinecone(family_entity_id=target_entity)
        return [DocumentResponse(**d) for d in cloud_docs]
    except Exception as e:
        logger.error(f"Error fetching documents from Pinecone: {e}")
        return []


@router.get("/suggestions", response_model=List[str])
async def get_document_suggestions(
    family_entity_id: Optional[str] = None,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Generate dynamic financial query suggestions based on actual indexed documents in Pinecone.
    """
    user_memberships = current_user.get("memberships") or []
    if not user_memberships:
        return [
            "Deposit financial records into the vault to generate insights",
            "Ask questions about AUD balances or portfolios"
        ]

    target_entity = family_entity_id or user_memberships[0]["family_entity_id"]
    if not any(m["family_entity_id"] == target_entity for m in user_memberships):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: You do not hold active membership in family entity '{target_entity}'."
        )

    docs = []
    try:
        docs = pinecone_service.list_documents_from_pinecone(target_entity)
    except Exception as e:
        logger.error(f"Error fetching suggestions from Pinecone: {e}")
        docs = []

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
    Retrieve document metadata directly from Pinecone Cloud Registry.
    """
    doc = pinecone_service.get_document_from_pinecone(document_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found in Pinecone registry.")

    doc_entity = doc.get("family_entity_id")
    user_entities = {m["family_entity_id"] for m in (current_user.get("memberships") or [])}
    if doc_entity not in user_entities:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: You are not authorized to view this document."
        )

    return DocumentResponse(**doc)


@router.get("/{document_id}/table", response_model=DocumentTableResponse)
async def get_document_table(
    document_id: str,
    page: int = 1,
    page_size: int = 50,
    search: Optional[str] = None,
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Retrieve full tabular records directly from Pinecone Cloud.
    Supports horizontal/vertical pagination across all rows and real-time search.
    """
    doc = pinecone_service.get_document_from_pinecone(document_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found in Pinecone registry.")

    doc_entity = doc.get("family_entity_id")
    user_entities = {m["family_entity_id"] for m in (current_user.get("memberships") or [])}
    if doc_entity not in user_entities:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: You are not authorized to view tables for this document."
        )

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
    Atomically deletes document metadata, chunks, and vector embeddings across SQLite, Pinecone, and BM25 index.
    """
    doc = pinecone_service.get_document_from_pinecone(document_id)
    if not doc:
        doc = sqlite.get_document_by_id(document_id)
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

    # 1. Delete from SQLite System of Record (cascades to chunks & ACL)
    sqlite.delete_document(document_id)

    # 2. Delete from Pinecone Cloud (vectors & document registry)
    pinecone_service.delete_document_from_pinecone(document_id, doc_entity)

    # 3. Delete from in-memory / cached BM25 lexical index
    lexical_index.delete_document_chunks(document_id)

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
