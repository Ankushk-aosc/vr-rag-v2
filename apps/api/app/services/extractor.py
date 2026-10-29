from pathlib import Path
from typing import Any, Dict, List


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


MAX_PDF_PAGES = 200
MAX_CSV_ROWS = 50_000


def extract_pdf(file_path: Path) -> List[ExtractedPage]:
    try:
        import pymupdf as fitz
    except ImportError:
        raise ImportError("PyMuPDF is required to extract PDF files. Please install with 'pip install pymupdf'.")
    doc = fitz.open(str(file_path))
    if len(doc) > MAX_PDF_PAGES:
        page_count = len(doc)
        doc.close()
        raise ValueError(f"PDF exceeds maximum page limit of {MAX_PDF_PAGES} pages (contains {page_count} pages).")

    pages: List[ExtractedPage] = []
    
    # If the document has many pages, extract text directly without slow heuristic path finder
    skip_table_finder = len(doc) > 20
    
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        text = page.get_text("text").strip()
        
        extracted_tables = []
        if not skip_table_finder:
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
                pass
        
        pages.append(ExtractedPage(page_number=page_idx + 1, text=text, tables=extracted_tables))
        
    doc.close()
    return pages


def extract_docx(file_path: Path) -> List[ExtractedPage]:
    try:
        import docx
    except ImportError:
        raise ImportError("python-docx is required to extract Word files. Please install with 'pip install python-docx'.")
    doc = docx.Document(str(file_path))
    full_text_parts = []
    
    for para in doc.paragraphs:
        if para.text.strip():
            full_text_parts.append(para.text.strip())
            
    tables = []
    for table in doc.tables:
        # Fast XML extraction across rows
        rows_data = []
        for tr in table._tbl.xpath('./w:tr'):
            row = [tc.xpath('string(.)').strip() for tc in tr.xpath('./w:tc')]
            if any(row):
                rows_data.append(row)
                
        if rows_data:
            header = rows_data[0]
            data_rows = rows_data[1:]
            
            # Batch large tables into blocks of 50 rows preserving column headers
            batch_size = 50
            if len(data_rows) > batch_size:
                for b_idx in range(0, len(data_rows), batch_size):
                    batch = data_rows[b_idx:b_idx + batch_size]
                    md_table = [
                        f"### Table Rows {b_idx + 1} to {b_idx + len(batch)}",
                        " | ".join(header),
                        " | ".join(["---"] * len(header))
                    ]
                    for r in batch:
                        md_table.append(" | ".join(r))
                    tables.append("\n".join(md_table))
            else:
                md_table = [" | ".join(header), " | ".join(["---"] * len(header))]
                for r in data_rows:
                    md_table.append(" | ".join(r))
                tables.append("\n".join(md_table))
            
    return [ExtractedPage(page_number=1, text="\n\n".join(full_text_parts), tables=tables)]


def extract_xlsx(file_path: Path) -> List[ExtractedPage]:
    try:
        import openpyxl
    except ImportError:
        raise ImportError("openpyxl is required to extract Excel files. Please install with 'pip install openpyxl'.")
    # Use read_only=True to prevent memory exhaustion on large spreadsheets (Audit F3)
    wb = openpyxl.load_workbook(str(file_path), read_only=True, data_only=True)
    pages: List[ExtractedPage] = []

    try:
        for idx, sheetname in enumerate(wb.sheetnames):
            ws = wb[sheetname]
            rows = list(ws.iter_rows(values_only=True))
            if not rows:
                continue

            valid_rows = [[str(cell if cell is not None else "").strip() for cell in r] for r in rows if any(r)]
            if not valid_rows:
                continue

            header = valid_rows[0]
            data_rows = valid_rows[1:]

            batch_size = 50
            sheet_tables = []
            if len(data_rows) > batch_size:
                for b_idx in range(0, len(data_rows), batch_size):
                    batch = data_rows[b_idx:b_idx + batch_size]
                    md_lines = [
                        f"### Sheet: {sheetname} (Rows {b_idx + 1} to {b_idx + len(batch)})",
                        " | ".join(header),
                        " | ".join(["---"] * len(header))
                    ]
                    for r in batch:
                        md_lines.append(" | ".join(r))
                    sheet_tables.append("\n".join(md_lines))
            else:
                md_lines = [f"### Sheet: {sheetname}"]
                md_lines.append(" | ".join(header))
                md_lines.append(" | ".join(["---"] * len(header)))
                for r in data_rows:
                    md_lines.append(" | ".join(r))
                sheet_tables.append("\n".join(md_lines))

            pages.append(ExtractedPage(page_number=idx + 1, text=f"Sheet: {sheetname}", tables=sheet_tables))
    finally:
        wb.close()

    return pages


def extract_csv(file_path: Path) -> List[ExtractedPage]:
    import csv
    with file_path.open("r", encoding="utf-8", errors="replace") as f:
        reader = []
        for i, row in enumerate(csv.reader(f)):
            if i >= MAX_CSV_ROWS:
                break
            reader.append(row)
    if not reader:
        return [ExtractedPage(page_number=1, text="")]

    header = reader[0]
    pages = []
    chunk_size = 50
    data_rows = reader[1:]
    total_pages = max(1, (len(data_rows) + chunk_size - 1) // chunk_size)

    for page_num in range(1, total_pages + 1):
        start = (page_num - 1) * chunk_size
        end = min(start + chunk_size, len(data_rows))
        batch = data_rows[start:end]
        md_lines = [f"### CSV Data Table (Rows {start + 1} to {end} of {len(data_rows)})"]
        md_lines.append(" | ".join(header))
        md_lines.append(" | ".join(["---"] * len(header)))
        for r in batch:
            md_lines.append(" | ".join(r))
        table_str = "\n".join(md_lines)
        pages.append(ExtractedPage(page_number=page_num, text=f"CSV Records Rows {start + 1}-{end}", tables=[table_str]))

    return pages


def extract_document(file_path: Path, mime_type: str = "") -> List[ExtractedPage]:
    suffix = file_path.suffix.lower()
    # Explicitly reject legacy binary formats (Audit F4)
    if suffix in [".doc", ".xls"]:
        raise ValueError(
            f"Legacy binary format '{suffix}' is not supported due to security and parsing constraints. "
            f"Please upload modern formats (.docx, .xlsx) or PDF/CSV."
        )

    if suffix == ".pdf" or "pdf" in mime_type:
        return extract_pdf(file_path)
    elif suffix == ".docx" or "word" in mime_type:
        return extract_docx(file_path)
    elif suffix == ".xlsx" or "spreadsheet" in mime_type:
        return extract_xlsx(file_path)
    elif suffix == ".csv" or "csv" in mime_type:
        return extract_csv(file_path)
    elif suffix in [".txt", ".md"]:
        text = file_path.read_text(encoding="utf-8", errors="replace")
        return [ExtractedPage(page_number=1, text=text)]
    else:
        raise ValueError(f"Unsupported file format: {suffix} (MIME: {mime_type})")
