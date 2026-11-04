import logging
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.schemas.document import BatchDocumentUploadResponse, DocumentResponse, DocumentTableResponse, DocumentUploadResponse
# chunker, embeddings, extractor and pinecone_service stay importable from here: tests patch them via this module
from app.services import auth, authorization, chunker, embeddings, extractor, pinecone_service, vector_index  # noqa: F401
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
# Optional explicit sensitivity tier; when omitted it follows the ACL choice (admin-only = restricted)
Classification = Literal["internal", "confidential", "restricted"]


def _upload_subject(family_entity_id: Optional[str], current_user: Dict[str, Any],
                    allowed_role: str, classification: Optional[str]) -> Tuple[authorization.Subject, str, str]:
    """RBAC document.upload AND ABAC (own tenant, classification within the uploader's clearance).
    The family comes from the caller's memberships; the owner is the authenticated user."""
    subject = authorization.resolve_subject(current_user, family_entity_id, action=authorization.DOCUMENT_UPLOAD)
    cls = (classification or authorization.classification_for_acl(allowed_role)).lower()
    resource = authorization.Resource("document", None, subject.family_entity_id, subject.user_id, cls)
    authorization.authorize(subject, authorization.DOCUMENT_UPLOAD, resource)
    return subject, cls, authorization.acl_role_for(cls)


def _read_scope(family_entity_id: Optional[str], current_user: Dict[str, Any]) -> authorization.AccessScope:
    subject = authorization.resolve_subject(current_user, family_entity_id, action=authorization.DOCUMENT_READ)
    return authorization.build_access_scope(subject, authorization.DOCUMENT_READ)


def _list_entity_documents(scope: authorization.AccessScope) -> List[Dict[str, Any]]:
    """
    Documents the scope may read, decided in SQL (tenant + classification, Audit I-05). Registry
    records (richer display metadata) are merged in only for ids the scope already allows, so a
    vector store being off, empty or capped never hides or adds documents (Audit I-04, I-08).
    """
    allowed = scope.allowed_document_ids
    tenant_sql_docs = sqlite.get_documents_by_entity(scope.family_entity_id, authorization.FAMILY_ADMIN)
    sql_ids = {d["id"] for d in tenant_sql_docs}
    sql_docs = [d for d in tenant_sql_docs if d["id"] in allowed]
    # Legacy registry-only records (no SQL row, no ACL) count as restricted: admins only
    legacy_ok = authorization.RESTRICTED in scope.allowed_classifications
    try:
        cloud_docs = [
            d for d in vector_index.list_documents(scope.family_entity_id)
            if d.get("id") in allowed or (legacy_ok and d.get("id") not in sql_ids)
        ]
    except Exception as e:
        logger.debug(f"Vector registry listing unavailable: {e}")
        cloud_docs = []
    cloud_ids = {d.get("id") for d in cloud_docs}
    return cloud_docs + [d for d in sql_docs if d["id"] not in cloud_ids]


def _authorized_document(document_id: str, current_user: Dict[str, Any], action: str) -> Dict[str, Any]:
    """
    Loads one document and authorizes `action` on it (RBAC AND ABAC). SQL decides tenancy and
    classification; a legacy registry-only record is treated as restricted (admins only, fail closed).
    """
    sql_doc = sqlite.get_document_by_id(document_id)
    cloud_doc = vector_index.get_document(document_id)
    if sql_doc:
        authorization.authorize_document(current_user, document_id, action)
    elif cloud_doc:
        legacy = {**cloud_doc, "classification": authorization.RESTRICTED}
        resource = authorization.document_resource(legacy)
        subject = authorization.resolve_subject(current_user, resource.family_entity_id, action=action)
        authorization.authorize(subject, action, resource)
    else:
        raise authorization.deny_unknown_resource(current_user, action, "document", document_id)
    # SQL fields win on overlap so tenancy/status always reflect the system of record
    return {**(cloud_doc or {}), **(sql_doc or {})}


def _load_authorized_document(document_id: str, current_user: Dict[str, Any]) -> Dict[str, Any]:
    doc = _authorized_document(document_id, current_user, authorization.DOCUMENT_READ)
    try:
        sqlite.log_audit_event(action="DOCUMENT_READ", user_id=current_user.get("id"),
                               family_entity_id=doc.get("family_entity_id"), resource_id=document_id)
    except Exception as e:  # auditing a read must never block it
        logger.warning("Could not record DOCUMENT_READ audit event: %s", type(e).__name__)
    return doc


@router.post("/upload", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    family_entity_id: Optional[str] = Form(None),
    allowed_role: UploadAclRole = Form("family_member"),
    classification: Optional[Classification] = Form(None),
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    subject, cls, acl_role = _upload_subject(family_entity_id, current_user, allowed_role, classification)
    return await process_single_upload(
        file=file,
        family_entity_id=subject.family_entity_id,
        allowed_role=acl_role,
        user_id=subject.user_id,
        classification=cls,
    )


@router.post("/upload-batch", response_model=BatchDocumentUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_documents_batch(
    files: List[UploadFile] = File(...),
    family_entity_id: Optional[str] = Form(None),
    allowed_role: UploadAclRole = Form("family_member"),
    classification: Optional[Classification] = Form(None),
    current_user: Dict[str, Any] = Depends(auth.get_current_user)
):
    """
    Multi-file batch upload:
    Ingests multiple files with independent 100MB validation per file. Authorization is decided
    once for the batch, before any file is read.
    """
    subject, cls, acl_role = _upload_subject(family_entity_id, current_user, allowed_role, classification)
    successful_docs = []
    errors = []
    for f in files:
        try:
            res = await process_single_upload(
                file=f,
                family_entity_id=subject.family_entity_id,
                allowed_role=acl_role,
                user_id=subject.user_id,
                classification=cls,
            )
            successful_docs.append(res.document)
        except HTTPException as he:
            errors.append(f"{f.filename}: {he.detail}")
        except Exception as e:
            ref = log_with_reference(f"Batch upload of {f.filename!r} failed", e)
            errors.append(f"{f.filename}: {safe_message('Upload failed', ref)}")

    return BatchDocumentUploadResponse(
        message=f"Processed {len(successful_docs)} of {len(files)} file(s).",
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
    if not current_user.get("memberships"):
        return []
    scope = _read_scope(family_entity_id, current_user)
    return [DocumentResponse(**d) for d in _list_entity_documents(scope)]


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

    docs = _list_entity_documents(_read_scope(family_entity_id, current_user))

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
    # RBAC document.delete (family admins only) AND ABAC (same tenant, classification in clearance)
    doc = _authorized_document(document_id, current_user, authorization.DOCUMENT_DELETE)
    sql_doc = sqlite.get_document_by_id(document_id)
    doc_entity = doc.get("family_entity_id")

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
