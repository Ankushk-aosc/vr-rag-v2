from pathlib import Path
from typing import Any, Dict, List
import pymupdf as fitz
import docx
import openpyxl


class ExtractedPage:
    def __init__(self, page_number: int, text: str, tables: List[str] = None):
        self.page_number = page_number
        self.text = text
        self.tables = tables or []

    def to_dict(self) -> Dict[str, Any]:
        return {
            "page_number": self.page_number,
            "text": self.text,
            "tables": self.tables
        }


def extract_pdf(file_path: Path) -> List[ExtractedPage]:
    doc = fitz.open(str(file_path))
    pages: List[ExtractedPage] = []
    
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        text = page.get_text("text").strip()
        
        # Extract tables if present using PyMuPDF table finder
        extracted_tables = []
        try:
            tabs = page.find_tables()
            for tab in tabs:
                df_table = tab.extract()
                if df_table and len(df_table) > 1:
                    header = [str(cell or "").strip() for cell in df_table[0]]
                    md_rows = [" | ".join(header), " | ".join(["---"] * len(header))]
                    for row in df_table[1:]:
                        md_rows.append(" | ".join([str(c or "").strip() for c in row]))
                    extracted_tables.append("\n".join(md_rows))
        except Exception:
            pass  # Fallback gracefully to raw text extraction if table finder encounters unstructured layout

        pages.append(ExtractedPage(page_number=page_idx + 1, text=text, tables=extracted_tables))
        
    doc.close()
    return pages


def extract_docx(file_path: Path) -> List[ExtractedPage]:
    doc = docx.Document(str(file_path))
    full_text_parts = []
    
    for para in doc.paragraphs:
        if para.text.strip():
            full_text_parts.append(para.text.strip())
            
    tables = []
    for table in doc.tables:
        rows_data = []
        for row in table.rows:
            rows_data.append([cell.text.strip() for cell in row.cells])
        if rows_data:
            header = rows_data[0]
            md_table = [" | ".join(header), " | ".join(["---"] * len(header))]
            for r in rows_data[1:]:
                md_table.append(" | ".join(r))
            tables.append("\n".join(md_table))
            
    # DOCX doesn't have hard page boundaries without a renderer; treat as sequential flow
    return [ExtractedPage(page_number=1, text="\n\n".join(full_text_parts), tables=tables)]


def extract_xlsx(file_path: Path) -> List[ExtractedPage]:
    wb = openpyxl.load_workbook(str(file_path), data_only=True)
    pages: List[ExtractedPage] = []
    
    for idx, sheetname in enumerate(wb.sheetnames):
        ws = wb[sheetname]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
            
        md_lines = [f"### Sheet: {sheetname}"]
        # Find header and non-empty rows
        valid_rows = [[str(cell if cell is not None else "").strip() for cell in r] for r in rows if any(r)]
        if valid_rows:
            header = valid_rows[0]
            md_lines.append(" | ".join(header))
            md_lines.append(" | ".join(["---"] * len(header)))
            for r in valid_rows[1:]:
                md_lines.append(" | ".join(r))
                
        table_str = "\n".join(md_lines)
        pages.append(ExtractedPage(page_number=idx + 1, text=f"Sheet: {sheetname}", tables=[table_str]))
        
    return pages


def extract_document(file_path: Path, mime_type: str) -> List[ExtractedPage]:
    suffix = file_path.suffix.lower()
    if suffix == ".pdf" or "pdf" in mime_type:
        return extract_pdf(file_path)
    elif suffix in [".docx", ".doc"] or "word" in mime_type:
        return extract_docx(file_path)
    elif suffix in [".xlsx", ".xls"] or "spreadsheet" in mime_type:
        return extract_xlsx(file_path)
    elif suffix in [".txt", ".md"]:
        text = file_path.read_text(encoding="utf-8", errors="replace")
        return [ExtractedPage(page_number=1, text=text)]
    else:
        raise ValueError(f"Unsupported file format: {suffix} (MIME: {mime_type})")
