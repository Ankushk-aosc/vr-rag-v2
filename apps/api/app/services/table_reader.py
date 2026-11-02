import logging
from typing import Any, Dict, List, Optional, Tuple
from app.services import pinecone_service
from app.services.lexical_index import lexical_index

logger = logging.getLogger(__name__)


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
            return columns, rows, total_rows, calc_pages

    # 2. Standard pagination: direct fetch chunk for requested page
    rows: List[List[str]] = []
    total_rows = 0
    target_chunk_id = f"{document_id}_p{page}_t0"

    try:
        index = pinecone_service.get_index()
    except Exception:
        index = None

    try:
        fetch_res = index.fetch(ids=[target_chunk_id]) if index else None
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
    return columns, rows, total_rows, calc_pages

