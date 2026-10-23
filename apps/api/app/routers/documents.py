import hashlib
import shutil
import uuid
from pathlib import Path
from typing import List
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from app.config import settings
from app.db import sqlite
from app.schemas.document import DocumentResponse, DocumentUploadResponse
from app.services import chunker, embeddings, extractor, pinecone_service

router = APIRouter(prefix="/api/documents", tags=["Documents"])

ALLOWED_MIME_TYPES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "text/plain": ".txt",
    "text/markdown": ".md"
}


@router.post("/upload", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family")
):
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

    # 6. Upsert vectors to Pinecone (Privacy-Safe: only IDs and metadata tags)
    total_vectors = 0
    try:
        total_vectors = pinecone_service.upsert_vectors(
            chunks=chunks,
            embeddings=chunk_embeddings,
            family_entity_id=family_entity_id
        )
    except Exception as e:
        # Note: If Pinecone fails (e.g. key missing), record document status for clarity
        pass

    # 7. Persist raw text, tables, and document metadata to SQLite
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
    sqlite.insert_chunks(chunks)

    # Re-fetch populated record from DB
    persisted_doc = sqlite.get_document_by_id(doc_id)

    return DocumentUploadResponse(
        message=f"Document '{file.filename}' processed successfully across {total_pages} page(s).",
        document=DocumentResponse(**persisted_doc),
        total_chunks=len(chunks),
        total_vectors_indexed=total_vectors
    )


@router.get("", response_model=List[DocumentResponse])
async def list_documents():
    docs = sqlite.get_all_documents()
    return [DocumentResponse(**d) for d in docs]


@router.get("/{document_id}", response_model=DocumentResponse)
async def get_document(document_id: str):
    doc = sqlite.get_document_by_id(document_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    return DocumentResponse(**doc)
