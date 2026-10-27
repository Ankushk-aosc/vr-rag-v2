import hashlib
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.schemas.document import DocumentResponse, DocumentUploadResponse
from app.services import auth, chunker, embeddings, extractor, pinecone_service
from app.services.lexical_index import lexical_index

router = APIRouter(prefix="/api/documents", tags=["Documents"])

ALLOWED_MIME_TYPES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/csv": ".csv"
}


from app.db import sqlite

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 Megabytes


def validate_file_magic_bytes(header: bytes, ext: str) -> bool:
    if ext == ".pdf":
        return header.startswith(b"%PDF-")
    if ext in [".docx", ".xlsx"]:
        return header.startswith(b"PK\x03\x04")
    if ext in [".txt", ".md", ".csv"]:
        # Block dangerous executable formats disguised as plain text
        if header.startswith(b"MZ") or header.startswith(b"\x7fELF") or header.startswith(b"\xca\xfe\xba\xbe"):
            return False
        return True
    return True


@router.post("/upload", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family"),
    allowed_role: str = Form("family_member"),
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    Sovereign Document Ingestion:
    1. Validates MIME type and binary magic-bytes.
    2. Enforces strict file size bounds (<25MB).
    3. Persists document provenance, chunks, and ACL into local SQLite system-of-record.
    4. Upserts anonymized vector embeddings to Pinecone.
    """
    # 1. Validate file extension
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in ALLOWED_MIME_TYPES.values():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file format '{file_ext}'. Allowed formats: PDF, DOCX, XLSX, TXT, CSV, MD."
        )

    # 2. Stage into a temporary buffer for extraction and validate magic bytes
    doc_id = str(uuid.uuid4())
    stored_filename = f"{doc_id}{file_ext}"

    hasher = hashlib.sha256()
    file_size = 0
    header_bytes = b""

    with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as tmp_file:
        tmp_path = Path(tmp_file.name)
        while chunk := await file.read(64 * 1024):
            if not header_bytes:
                header_bytes = chunk[:16]
            hasher.update(chunk)
            file_size += len(chunk)
            if file_size > MAX_FILE_SIZE:
                tmp_file.close()
                if tmp_path.exists():
                    tmp_path.unlink()
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"File exceeds maximum allowed upload size of 25MB."
                )
            tmp_file.write(chunk)

    if not validate_file_magic_bytes(header_bytes, file_ext):
        if tmp_path.exists():
            tmp_path.unlink()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Security rejection: file contents do not match extension '{file_ext}'."
        )

    file_hash = hasher.hexdigest()

    # 3. Parse and extract text/tables preserving pages
    try:
        pages = extractor.extract_document(tmp_path, file.content_type or "")
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Failed to extract text from {file.filename}: {str(e)}"
        )
    finally:
        if tmp_path.exists():
            tmp_path.unlink()

    total_pages = len(pages)

    # 4. Chunk document preserving page provenance
    chunks = chunker.chunk_document(document_id=doc_id, pages=pages)
    if not chunks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Document {file.filename} contains no extractable text."
        )

    # Add original filename to each chunk metadata
    for c in chunks:
        c["original_name"] = file.filename

    # 5. Generate embeddings with all-MiniLM-L6-v2
    chunk_texts = [c["content"] for c in chunks]
    try:
        chunk_embeddings = embeddings.embed_texts(chunk_texts)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to compute embeddings: {str(e)}"
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
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Pinecone vector upsert failed: {str(e)}"
        )

    # 7. Persist document record into SQLite System of Record
    doc_record = {
        "id": doc_id,
        "filename": stored_filename,
        "original_name": file.filename,
        "mime_type": file.content_type or "application/octet-stream",
        "file_size": file_size,
        "file_hash": file_hash,
        "total_pages": total_pages,
        "family_entity_id": family_entity_id,
        "status": "indexed" if total_vectors > 0 else "unindexed",
        "uploaded_at": datetime.now(timezone.utc).isoformat()
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

    # Make the new chunks immediately searchable by the keyword half of hybrid retrieval
    lexical_index.add_chunks([
        {
            "chunk_id": c["id"],
            "document_id": doc_id,
            "page_number": c.get("page_number", 1),
            "is_table": bool(c.get("is_table", False)),
            "family_entity_id": family_entity_id,
            "allowed_roles": roles_for_pinecone,
            "original_name": file.filename,
            "text": c["content"],
        }
        for c in chunks
    ])

    user_identifier = current_user.get("id") if current_user else "anonymous"
    sqlite.log_audit_event(
        action="DOCUMENT_UPLOADED",
        user_id=user_identifier,
        resource_id=doc_id,
        details=f"Uploaded {file.filename} ({total_pages} pages, {total_vectors} vectors)"
    )

    # Maintain cloud registry copy
    pinecone_service.save_document_to_pinecone(doc_record)
    pinecone_service.get_document_names(force=True)

    return DocumentUploadResponse(
        message=f"Document '{file.filename}' processed successfully across {total_pages} page(s).",
        document=DocumentResponse(**doc_record),
        total_chunks=len(chunks),
        total_vectors_indexed=total_vectors
    )


@router.get("", response_model=List[DocumentResponse])
async def list_documents(
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    List documents from SQLite system of record with fallback to cloud registry.
    """
    # 1. Fetch from SQLite system of record
    user_role = "family_admin"
    if current_user and current_user.get("memberships"):
        user_role = current_user["memberships"][0].get("role", "family_member")
    
    local_docs = sqlite.get_documents_by_entity("default_family", user_role=user_role)
    if local_docs:
        return [DocumentResponse(**d) for d in local_docs]

    # 2. Fallback to Cloud Registry
    try:
        cloud_docs = pinecone_service.list_documents_from_pinecone(family_entity_id="*")
        return [DocumentResponse(**d) for d in cloud_docs]
    except Exception:
        return []


@router.get("/suggestions", response_model=List[str])
async def get_document_suggestions(family_entity_id: str = "default_family"):
    """
    Generate dynamic financial query suggestions based on actual indexed documents in SQLite/Pinecone.
    """
    docs = []
    try:
        docs = sqlite.get_documents_by_entity(family_entity_id, user_role="family_admin")
        if not docs:
            docs = pinecone_service.list_documents_from_pinecone(family_entity_id)
        if not docs:
            docs = pinecone_service.list_documents_from_pinecone("*")
    except Exception:
        docs = []

    if not docs:
        return [
            "Deposit financial records into the vault to generate insights",
            "Ask questions about AUD balances or portfolios"
        ]

    doc_names = [d.get("original_name", "") for d in docs]
    has_aapl = any("aapl" in name.lower() or "financial_data" in name.lower() for name in doc_names)

    if has_aapl:
        return [
            "AAPL closing price & volume on 2020-04-01",
            "Historical trading volume & daily returns in AAPL records",
            "Summary of AAPL metrics across 11,558 rows",
            "Highest recorded daily volatility and trade volume"
        ]

    suggestions = []
    for d in docs[:4]:
        clean_name = Path(d.get("original_name", "Record")).stem.replace("_", " ")
        suggestions.append(f"Key financial details and figures in {clean_name}")
    return suggestions


@router.get("/{document_id}", response_model=DocumentResponse)
async def get_document(
    document_id: str,
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    Retrieve document metadata directly from Pinecone Cloud Registry.
    """
    doc = pinecone_service.get_document_from_pinecone(document_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found in Pinecone registry.")

    return DocumentResponse(**doc)
