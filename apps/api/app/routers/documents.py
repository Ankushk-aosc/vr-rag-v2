import logging
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.schemas.document import BatchDocumentUploadResponse, DocumentResponse, DocumentTableResponse, DocumentUploadResponse
# chunker, embeddings, extractor and pinecone_service stay importable from here: tests patch them via this module
from app.services import auth, chunker, embeddings, extractor, pinecone_service, vector_index  # noqa: F401
from app.services.storage import storage_service
from app.services.lexical_index import lexical_index
from app.services.safe_errors import log_with_reference, safe_message
from app.services.table_reader import read_document_table_data
from app.db import sqlite
# Ingestion lives in app/services/document_ingest.py (Audit I-22); these names are re-exported for existing imports
from app.services.document_ingest import ALLOWED_MIME_TYPES, MAX_FILE_SIZE, process_single_upload  # noqa: F401
from app.services.upload_security import validate_file_magic_bytes  # noqa: F401

router = APIRouter(prefix="/api/documents", tags=["Documents"])

logger = logging.getLogger(__name__)

# Document ACL values an uploader may choose (Audit I-07): family-wide, or restricted to admins.
# Advisers read family-wide documents via the member tag, so they are not a separate ACL value.
UploadAclRole = Literal["family_member", "family_admin"]


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
    return await process_single_upload(
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
            res = await process_single_upload(
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
