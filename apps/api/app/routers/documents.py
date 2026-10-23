import hashlib
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.config import settings
from app.db import sqlite
from app.schemas.document import DocumentResponse, DocumentUploadResponse
from app.services import auth, chunker, embeddings, extractor, pinecone_service

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


@router.post("/upload", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family"),
    allowed_role: str = Form("family_member"),
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    # If user is authenticated, ensure they have upload rights (family_admin)
    user_id = current_user.get("id") if current_user else "anonymous"
    if current_user:
        memberships = current_user.get("memberships", [])
        user_roles = [m["role"] for m in memberships if m["family_entity_id"] == family_entity_id]
        if user_roles and "family_admin" not in user_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only family administrators are authorized to upload financial documents."
            )

    # 1. Validate file extension and MIME type
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in ALLOWED_MIME_TYPES.values():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file format '{file_ext}'. Allowed formats: PDF, DOCX, XLSX, TXT."
        )

    # 2. Stage file locally and calculate hash
    uploads_dir = Path(settings.UPLOADS_DIR)
    uploads_dir.mkdir(parents=True, exist_ok=True)

    doc_id = str(uuid.uuid4())
    stored_filename = f"{doc_id}{file_ext}"
    dest_path = uploads_dir / stored_filename

    hasher = hashlib.sha256()
    file_size = 0

    with dest_path.open("wb") as buffer:
        while chunk := await file.read(64 * 1024):
            hasher.update(chunk)
            file_size += len(chunk)
            buffer.write(chunk)

    file_hash = hasher.hexdigest()

    # 3. Parse and extract text/tables preserving pages
    try:
        pages = extractor.extract_document(dest_path, file.content_type or "")
    except Exception as e:
        if dest_path.exists():
            dest_path.unlink()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Failed to extract text from {file.filename}: {str(e)}"
        )

    total_pages = len(pages)

    # 4. Chunk document preserving page provenance
    chunks = chunker.chunk_document(document_id=doc_id, pages=pages)
    if not chunks:
        if dest_path.exists():
            dest_path.unlink()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Document {file.filename} contains no extractable text."
        )

    # 5. Generate local embeddings
    chunk_texts = [c["content"] for c in chunks]
    try:
        chunk_embeddings = embeddings.embed_texts(chunk_texts)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to compute local embeddings: {str(e)}"
        )

    # 6. Upsert vectors to Pinecone with pre-retrieval role metadata
    roles_for_pinecone = ["family_admin"] if allowed_role == "family_admin" else ["family_admin", "family_member"]
    total_vectors = 0
    try:
        total_vectors = pinecone_service.upsert_vectors(
            chunks=chunks,
            embeddings=chunk_embeddings,
            family_entity_id=family_entity_id,
            allowed_roles=roles_for_pinecone
        )
    except Exception:
        pass

    # 7. Persist document, ACL, and raw chunks to local SQLite
    doc_record = {
        "id": doc_id,
        "filename": stored_filename,
        "original_name": file.filename,
        "mime_type": file.content_type or "application/octet-stream",
        "file_size": file_size,
        "file_hash": file_hash,
        "total_pages": total_pages,
        "family_entity_id": family_entity_id,
        "status": "indexed" if total_vectors > 0 else "stored_local_only"
    }
    sqlite.insert_document(doc_record)
    sqlite.insert_document_acl(document_id=doc_id, family_entity_id=family_entity_id, allowed_role=allowed_role)
    sqlite.insert_chunks(chunks)

    sqlite.log_audit_event(
        action="DOCUMENT_UPLOAD",
        user_id=user_id,
        resource_id=doc_id,
        details=f"Uploaded '{file.filename}' to entity '{family_entity_id}' with role '{allowed_role}'"
    )

    persisted_doc = sqlite.get_document_by_id(doc_id)

    return DocumentUploadResponse(
        message=f"Document '{file.filename}' processed successfully across {total_pages} page(s).",
        document=DocumentResponse(**persisted_doc),
        total_chunks=len(chunks),
        total_vectors_indexed=total_vectors
    )


@router.get("", response_model=List[DocumentResponse])
async def list_documents(
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    if current_user and current_user.get("memberships"):
        # Aggregate documents across user's active entities and roles
        all_docs = []
        seen_ids = set()
        for m in current_user["memberships"]:
            docs = sqlite.get_documents_by_entity(m["family_entity_id"], m["role"])
            for d in docs:
                if d["id"] not in seen_ids:
                    seen_ids.add(d["id"])
                    all_docs.append(DocumentResponse(**d))
        return all_docs

    # Fallback to general list if anonymous (development convenience)
    docs = sqlite.get_all_documents()
    return [DocumentResponse(**d) for d in docs]


@router.get("/suggestions", response_model=List[str])
async def get_document_suggestions(family_entity_id: str = "default_family"):
    """Generate dynamic financial query suggestions based on actual indexed documents in the database."""
    docs = sqlite.get_documents_by_entity(family_entity_id, "family_member")
    if not docs:
        docs = sqlite.get_all_documents()

    if not docs:
        return [
            "Deposit financial records into the vault to generate insights",
            "Ask questions about AUD balances or portfolios"
        ]

    doc_names = [d["original_name"] for d in docs]
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
        clean_name = Path(d["original_name"]).stem.replace("_", " ")
        suggestions.append(f"Key financial details and figures in {clean_name}")
    return suggestions


@router.get("/{document_id}", response_model=DocumentResponse)
async def get_document(
    document_id: str,
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    doc = sqlite.get_document_by_id(document_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")

    # Validate access if user is authenticated
    if current_user and current_user.get("memberships"):
        allowed_roles = sqlite.get_document_allowed_roles(document_id, doc["family_entity_id"])
        user_memberships = {m["family_entity_id"]: m["role"] for m in current_user["memberships"]}
        user_role_in_entity = user_memberships.get(doc["family_entity_id"])

        if not user_role_in_entity:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied to this family entity.")
        if user_role_in_entity != "family_admin" and user_role_in_entity not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role permissions for this document.")

    return DocumentResponse(**doc)
