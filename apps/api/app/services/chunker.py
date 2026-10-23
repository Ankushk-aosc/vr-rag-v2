from typing import Any, Dict, List
from app.services.extractor import ExtractedPage


def chunk_document(
    document_id: str,
    pages: List[ExtractedPage],
    chunk_size: int = 600,
    chunk_overlap: int = 100
) -> List[Dict[str, Any]]:
    chunks: List[Dict[str, Any]] = []
    global_index = 0

    for page in pages:
        # First, preserve extracted tables as discrete, atomic chunks
        for t_idx, table_md in enumerate(page.tables):
            chunk_id = f"{document_id}_p{page.page_number}_t{t_idx}"
            chunks.append({
                "id": chunk_id,
                "document_id": document_id,
                "chunk_index": global_index,
                "page_number": page.page_number,
                "section_title": f"Page {page.page_number} Table",
                "content": table_md,
                "is_table": True
            })
            global_index += 1

        # Now chunk raw body text using recursive paragraph / sentence slicing
        text = page.text.strip()
        if not text:
            continue

        # Break text into paragraphs or line-groups that don't exceed chunk_size
        raw_paras = [p.strip() for p in text.split("\n\n") if p.strip()]
        atomic_units = []
        for p in raw_paras:
            if len(p) <= chunk_size:
                atomic_units.append(p)
            else:
                # Break large blocks (like financial data tables) by lines
                lines = [l.strip() for l in p.split("\n") if l.strip()]
                cur_group = []
                cur_group_len = 0
                for l in lines:
                    if cur_group_len + len(l) > chunk_size and cur_group:
                        atomic_units.append("\n".join(cur_group))
                        cur_group = [l]
                        cur_group_len = len(l)
                    else:
                        cur_group.append(l)
                        cur_group_len += len(l)
                if cur_group:
                    atomic_units.append("\n".join(cur_group))

        current_chunk_paras = []
        current_len = 0

        for unit in atomic_units:
            unit_len = len(unit)
            if current_len + unit_len > chunk_size and current_chunk_paras:
                # Flush current chunk
                chunk_text = "\n\n".join(current_chunk_paras)
                chunk_id = f"{document_id}_p{page.page_number}_c{global_index}"
                chunks.append({
                    "id": chunk_id,
                    "document_id": document_id,
                    "chunk_index": global_index,
                    "page_number": page.page_number,
                    "section_title": f"Page {page.page_number}",
                    "content": chunk_text,
                    "is_table": False
                })
                global_index += 1
                
                # Overlap: keep the last unit if small enough, or reset
                if len(current_chunk_paras[-1]) < chunk_overlap:
                    current_chunk_paras = [current_chunk_paras[-1], unit]
                    current_len = len(current_chunk_paras[0]) + unit_len
                else:
                    current_chunk_paras = [unit]
                    current_len = unit_len
            else:
                current_chunk_paras.append(unit)
                current_len += unit_len

        # Flush any trailing paragraph text
        if current_chunk_paras:
            chunk_text = "\n\n".join(current_chunk_paras)
            chunk_id = f"{document_id}_p{page.page_number}_c{global_index}"
            chunks.append({
                "id": chunk_id,
                "document_id": document_id,
                "chunk_index": global_index,
                "page_number": page.page_number,
                "section_title": f"Page {page.page_number}",
                "content": chunk_text,
                "is_table": False
            })
            global_index += 1

    return chunks
