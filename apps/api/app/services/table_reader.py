import logging
from typing import Any, Dict, List, Optional, Tuple
from app.services import pinecone_service
from app.services.lexical_index import lexical_index

logger = logging.getLogger(__name__)


def _page_table_text(chunk_id: str) -> str:
    """
    Text of one table chunk: Pinecone metadata first, then the SQL system of record, which stores
    the same chunk ids and content (Audit I-05). Callers must have authorized the document already.
    """
    try:
        index = pinecone_service.get_index()
        fetch_res = index.fetch(ids=[chunk_id]) if index else None
        chunk = (getattr(fetch_res, "vectors", {}) or {}).get(chunk_id)
        if chunk and getattr(chunk, "metadata", None):
            text = chunk.metadata.get("text", "")
            if text:
                return text
    except Exception as e:
        logger.debug(f"Pinecone table chunk unavailable for {chunk_id}: {e}")

    try:
        from app.db import sqlite
        sql_chunks = sqlite.get_chunks_by_ids([chunk_id])
        if sql_chunks:
            return sql_chunks[0].get("content") or ""
    except Exception as e:
        logger.warning(f"SQL table chunk lookup failed for {chunk_id}: {e}")
    return ""


def read_document_table_data(
    doc: Dict[str, Any],
    document_id: str,
    page: int = 1,
    page_size: int = 50,
    search: Optional[str] = None
) -> Tuple[List[str], List[List[str]], int, int]:
    """
    Reads tabular records for a document from Pinecone cloud storage.
    Returns: (columns, rows, total_rows, total_pages)
    """
    columns = doc.get("columns") or []
    total_pages = int(doc.get("total_pages", 1) or 1)
    page = max(1, page)

    # 1. Search matching rows if query provided
    if search and search.strip():
        s_term = search.strip().lower()
        family_id = doc.get("family_entity_id", "default_family")
        matched_chunks = lexical_index.search(
            query=search,
            family_entity_id=family_id,
            user_roles=["family_member", "family_admin"],
            top_k=30,
            # The caller was authorized for this one document; search nothing else
            allowed_document_ids={document_id},
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
            return columns, rows, total_rows, calc_pages

    # 2. Standard pagination: direct fetch chunk for requested page
    rows: List[List[str]] = []
    total_rows = 0
    target_chunk_id = f"{document_id}_p{page}_t0"

    try:
        text = _page_table_text(target_chunk_id)

        if text:
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            for i in range(len(lines) - 1):
                if "|" in lines[i] and "---" in lines[i + 1]:
                    # Each page/sheet carries its own header; it is authoritative for the rows below it
                    columns = [c.strip() for c in lines[i].strip("|").split("|")]
                    for j in range(i + 2, len(lines)):
                        if "|" in lines[j]:
                            r = [c.strip() for c in lines[j].strip("|").split("|")]
                            if len(r) == len(columns):
                                rows.append(r)
                    break
            if lines and "of " in lines[0] and ")" in lines[0]:
                try:
                    tot_part = lines[0].split("of ")[1].split(")")[0].strip()
                    total_rows = int(tot_part)
                except Exception:
                    total_rows = len(rows)
            else:
                # No stated total: report only what was actually read, never an estimate
                total_rows = len(rows)
        else:
            rows = doc.get("sample_rows") or []
            total_rows = len(rows)
    except Exception as e:
        logger.error(f"Error parsing table page chunk: {e}")
        rows = doc.get("sample_rows") or []
        total_rows = len(rows)

    if total_rows == 0:
        total_rows = len(rows)
    # Pages here are the document's own table pages (one per sheet or PDF page), so never report fewer
    calc_pages = max(total_pages, (total_rows + page_size - 1) // page_size if total_rows > 0 else 1)
    return columns, rows, total_rows, calc_pages

