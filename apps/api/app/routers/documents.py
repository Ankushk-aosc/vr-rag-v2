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


import logging
from app.config import settings

logger = logging.getLogger(__name__)

MAX_FILE_SIZE = settings.MAX_FILE_SIZE_MB * 1024 * 1024


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


async def _process_single_upload(
    file: UploadFile,
    family_entity_id: str = "default_family",
    allowed_role: str = "family_member"
) -> DocumentUploadResponse:
    """
    Sovereign Document Ingestion:
    1. Validates MIME type and binary magic-bytes.
    2. Enforces strict file size bounds (<{settings.MAX_FILE_SIZE_MB}MB).
    3. Persists document provenance, chunks, and metadata exclusively in Pinecone Cloud.
    4. Upserts vector embeddings directly to Pinecone.
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
                    detail=f"File exceeds maximum allowed upload size of {settings.MAX_FILE_SIZE_MB}MB."
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

    # 8. Persist document record exclusively into Pinecone Cloud Registry
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
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "columns": extracted_columns,
        "sample_rows": extracted_sample_rows,
        "preview_text": extracted_preview_text,
        "is_table": is_table_doc or file_ext in [".csv", ".xlsx", ".xls"]
    }
    pinecone_service.save_document_to_pinecone(doc_record)
    pinecone_service.get_document_names(force=True)

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

    return DocumentUploadResponse(
        message=f"Document '{file.filename}' processed successfully across {total_pages} page(s).",
        document=DocumentResponse(**doc_record),
        total_chunks=len(chunks),
        total_vectors_indexed=total_vectors
    )


@router.post("/upload", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    family_entity_id: str = Form("default_family"),
    allowed_role: str = Form("family_member"),
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    return await _process_single_upload(file=file, family_entity_id=family_entity_id, allowed_role=allowed_role)


@router.post("/upload-batch", response_model=BatchDocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_documents_batch(
    files: List[UploadFile] = File(...),
    family_entity_id: str = Form("default_family"),
    allowed_role: str = Form("family_member"),
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    Multi-file batch upload:
    Ingests multiple files into Pinecone Cloud with independent 100MB validation per file.
    """
    successful_docs = []
    errors = []
    for f in files:
        try:
            res = await _process_single_upload(file=f, family_entity_id=family_entity_id, allowed_role=allowed_role)
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
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    List documents directly from Pinecone Cloud Registry (pure Pinecone storage).
    """
    try:
        cloud_docs = pinecone_service.list_documents_from_pinecone(family_entity_id="*")
        return [DocumentResponse(**d) for d in cloud_docs]
    except Exception as e:
        logger.error(f"Error fetching documents from Pinecone: {e}")
        return []


@router.get("/suggestions", response_model=List[str])
async def get_document_suggestions(family_entity_id: str = "default_family"):
    """
    Generate dynamic financial query suggestions based on actual indexed documents in Pinecone.
    """
    docs = []
    try:
        docs = pinecone_service.list_documents_from_pinecone(family_entity_id)
        if not docs:
            docs = pinecone_service.list_documents_from_pinecone("*")
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
        elif "aapl" in stem.lower():
            suggestions.append("AAPL closing price & volume on 2020-04-01")
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
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    Retrieve document metadata directly from Pinecone Cloud Registry.
    """
    doc = pinecone_service.get_document_from_pinecone(document_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found in Pinecone registry.")

    return DocumentResponse(**doc)


@router.get("/{document_id}/table", response_model=DocumentTableResponse)
async def get_document_table(
    document_id: str,
    page: int = 1,
    page_size: int = 50,
    search: Optional[str] = None,
    current_user: Optional[Dict[str, Any]] = Depends(auth.get_current_user_optional)
):
    """
    Retrieve full tabular records directly from Pinecone Cloud.
    Supports horizontal/vertical pagination across all rows and real-time search.
    """
    doc = pinecone_service.get_document_from_pinecone(document_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found in Pinecone registry.")

    filename = doc.get("original_name") or doc.get("filename") or "Document"
    columns = doc.get("columns") or []
    total_pages = int(doc.get("total_pages", 1) or 1)
    page = max(1, page)

    index = pinecone_service.get_index()
    rows: List[List[str]] = []
    total_rows = 0

    # 1. If search is requested, query matching chunks across the document
    if search and search.strip():
        s_term = search.strip().lower()
        family_id = doc.get("family_entity_id", "default_family")
        matched_chunks = lexical_index.search(
            query=search,
            family_entity_id=family_id,
            user_roles=["family_member", "family_admin"],
            top_k=30
        )
        doc_matched = [c for c in matched_chunks if c.get("document_id") == document_id]
        filtered_rows: List[List[str]] = []
        for c in doc_matched:
            c_text = c.get("text", "")
            for line in c_text.splitlines():
                if "|" in line and "---" not in line and not line.strip().startswith("###"):
                    r = [cell.strip() for cell in line.strip("|").split("|")]
                    if len(r) == len(columns) and any(s_term in cell.lower() for cell in r):
                        if r not in filtered_rows:
                            filtered_rows.append(r)
        if filtered_rows:
            total_rows = len(filtered_rows)
            start_i = (page - 1) * page_size
            rows = filtered_rows[start_i:start_i + page_size]
            calc_pages = max(1, (total_rows + page_size - 1) // page_size)
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

    # 2. Standard pagination: direct fetch chunk for requested page
    target_chunk_id = f"{document_id}_p{page}_t0"
    try:
        fetch_res = index.fetch(ids=[target_chunk_id])
        vectors = getattr(fetch_res, "vectors", {}) or {}
        chunk = vectors.get(target_chunk_id)

        if chunk and getattr(chunk, "metadata", None):
            text = chunk.metadata.get("text", "")
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            for i in range(len(lines) - 1):
                if "|" in lines[i] and "---" in lines[i + 1]:
                    header = [c.strip() for c in lines[i].strip("|").split("|")]
                    if not columns:
                        columns = header
                    for j in range(i + 2, len(lines)):
                        if "|" in lines[j]:
                            r = [c.strip() for c in lines[j].strip("|").split("|")]
                            if len(r) == len(columns):
                                rows.append(r)
                    break
            # Parse total rows from header if available
            if lines and "of " in lines[0] and ")" in lines[0]:
                try:
                    tot_part = lines[0].split("of ")[1].split(")")[0].strip()
                    total_rows = int(tot_part)
                except Exception:
                    total_rows = total_pages * 50
            else:
                total_rows = total_pages * 50
        else:
            rows = doc.get("sample_rows") or []
            total_rows = len(rows)
    except Exception as e:
        logger.error(f"Error fetching table page chunk from Pinecone: {e}")
        rows = doc.get("sample_rows") or []
        total_rows = len(rows)

    if total_rows == 0:
        total_rows = len(rows)
    calc_pages = max(1, (total_rows + page_size - 1) // page_size) if total_rows > 0 else total_pages

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
