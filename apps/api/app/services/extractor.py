import io
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings


class ExtractionRejected(ValueError):
    """A rejection written for the uploader (format, page limit). Other ValueErrors from parsing
    libraries are internal and are never shown to clients (Audit I-11)."""


class ExtractedPage:
    def __init__(
        self,
        page_number: int,
        text: str,
        tables: List[str] = None,
        confidence: float = 1.0,
        blocks: List[Dict[str, Any]] = None,
        engine: str = "digital",
        is_scanned: bool = False,
    ):
        self.page_number = page_number
        self.page_no = page_number
        self.text = text
        self.tables = tables or []
        self.confidence = confidence
        self.blocks = blocks or []
        self.engine = engine
        self.is_scanned = is_scanned

    def to_dict(self) -> Dict[str, Any]:
        return {
            "page_number": self.page_number,
            "page_no": self.page_no,
            "text": self.text,
            "tables": self.tables,
            "confidence": self.confidence,
            "blocks": self.blocks,
            "engine": self.engine,
            "is_scanned": self.is_scanned,
        }


MAX_PDF_PAGES = 200
MAX_CSV_ROWS = 50_000
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp"}


def extract_pdf(file_path: Path) -> List[ExtractedPage]:
    try:
        import pymupdf as fitz
    except ImportError:
        raise ImportError("PyMuPDF is required to extract PDF files. Please install with 'pip install pymupdf'.")
    doc = fitz.open(str(file_path))
    if len(doc) > MAX_PDF_PAGES:
        page_count = len(doc)
        doc.close()
        raise ExtractionRejected(f"PDF exceeds maximum page limit of {MAX_PDF_PAGES} pages (contains {page_count} pages).")

    pages: List[ExtractedPage] = []
    
    # If the document has many pages, extract text directly without slow heuristic path finder
    skip_table_finder = len(doc) > 20
    
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        text = page.get_text("text").strip()
        confidence = 1.0
        engine = "digital"
        is_scanned = False
        blocks = []
        
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

        # Per-page OCR routing: if text layer is empty or below threshold, run OCR
        if len(text) < getattr(settings, "OCR_PDF_TEXT_THRESHOLD", 50):
            try:
                from app.services.ocr.router import get_ocr_engine
                from app.services.ocr.preprocess import preprocess_image
                from PIL import Image

                ocr_engine = get_ocr_engine()
                primary_engine = (settings.OCR_ENGINE or "tesseract").lower()

                # Render page at 300 DPI
                zoom = 300.0 / 72.0
                mat = fitz.Matrix(zoom, zoom)
                pix = page.get_pixmap(matrix=mat)
                img = Image.open(io.BytesIO(pix.tobytes("png")))
                processed_img = preprocess_image(img)

                if hasattr(ocr_engine, "_ocr_image"):
                    ocr_text, ocr_conf, ocr_blocks = ocr_engine._ocr_image(processed_img)
                else:
                    ocr_res = ocr_engine.extract(file_path)
                    ocr_text = ocr_res.pages[page_idx].text if page_idx < len(ocr_res.pages) else ""
                    ocr_conf = ocr_res.pages[page_idx].confidence if page_idx < len(ocr_res.pages) else 1.0
                    ocr_blocks = ocr_res.pages[page_idx].blocks if page_idx < len(ocr_res.pages) else []

                if ocr_text:
                    text = ocr_text
                    confidence = ocr_conf
                    engine = primary_engine
                    is_scanned = True
                    blocks = ocr_blocks
            except Exception:
                pass
        
        if not blocks and text:
            blocks = [{"text": text, "bbox": [0.0, 0.0, float(page.rect.width), float(page.rect.height)], "confidence": confidence}]

        pages.append(
            ExtractedPage(
                page_number=page_idx + 1,
                text=text,
                tables=extracted_tables,
                confidence=confidence,
                blocks=blocks,
                engine=engine,
                is_scanned=is_scanned,
            )
        )
        
    doc.close()
    return pages


def extract_image(file_path: Path, mime_type: str = "") -> List[ExtractedPage]:
    from app.services.ocr.router import route_and_extract
    result = route_and_extract(file_path, mime=mime_type)
    pages = []
    for p in result.pages:
        pages.append(
            ExtractedPage(
                page_number=p.page_no,
                text=p.text,
                tables=[],
                confidence=p.confidence,
                blocks=p.blocks,
                engine=p.engine,
                is_scanned=p.is_scanned,
            )
        )
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
        rows_data = []
        for tr in table._tbl.xpath('./w:tr'):
            row = [tc.xpath('string(.)').strip() for tc in tr.xpath('./w:tc')]
            if any(row):
                rows_data.append(row)
                
        if rows_data:
            header = rows_data[0]
            data_rows = rows_data[1:]
            
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
                
    full_text = "\n\n".join(full_text_parts)
    return [
        ExtractedPage(
            page_number=1,
            text=full_text,
            tables=tables,
            confidence=1.0,
            engine="digital",
            is_scanned=False,
        )
    ]


def extract_xlsx(file_path: Path) -> List[ExtractedPage]:
    try:
        import openpyxl
    except ImportError:
        raise ImportError("openpyxl is required to extract Excel files. Please install with 'pip install openpyxl'.")
    wb = openpyxl.load_workbook(str(file_path), read_only=True, data_only=True)
    pages: List[ExtractedPage] = []

    try:
        for idx, sheetname in enumerate(wb.sheetnames):
            sheet = wb[sheetname]
            valid_rows = []
            for row in sheet.iter_rows(values_only=True):
                str_row = [str(c or "").strip() for c in row]
                if any(str_row):
                    valid_rows.append(str_row)

            if not valid_rows:
                continue

            header = valid_rows[0]
            data_rows = valid_rows[1:]
            sheet_tables = []
            batch_size = 50

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
                md_lines = [f"### Sheet: {sheetname}", " | ".join(header)]
                md_lines.append(" | ".join(["---"] * len(header)))
                for r in data_rows:
                    md_lines.append(" | ".join(r))
                sheet_tables.append("\n".join(md_lines))

            pages.append(
                ExtractedPage(
                    page_number=idx + 1,
                    text=f"Sheet: {sheetname}",
                    tables=sheet_tables,
                    confidence=1.0,
                    engine="digital",
                    is_scanned=False,
                )
            )
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
        pages.append(
            ExtractedPage(
                page_number=page_num,
                text=f"CSV Records Rows {start + 1}-{end}",
                tables=[table_str],
                confidence=1.0,
                engine="digital",
                is_scanned=False,
            )
        )

    return pages


def extract_document(file_path: Path, mime_type: str = "") -> List[ExtractedPage]:
    suffix = file_path.suffix.lower()
    # Explicitly reject legacy binary formats (Audit F4)
    if suffix in [".doc", ".xls"]:
        raise ExtractionRejected(
            f"Legacy binary format '{suffix}' is not supported due to security and parsing constraints. "
            f"Please upload modern formats (.docx, .xlsx) or PDF/CSV."
        )

    if suffix in IMAGE_EXTENSIONS or mime_type.startswith("image/"):
        return extract_image(file_path, mime_type)
    elif suffix == ".pdf" or "pdf" in mime_type:
        return extract_pdf(file_path)
    elif suffix == ".docx" or "word" in mime_type:
        return extract_docx(file_path)
    elif suffix == ".xlsx" or "spreadsheet" in mime_type:
        return extract_xlsx(file_path)
    elif suffix == ".csv" or "csv" in mime_type:
        return extract_csv(file_path)
    elif suffix in [".txt", ".md"]:
        text = file_path.read_text(encoding="utf-8", errors="replace")
        return [ExtractedPage(page_number=1, text=text, confidence=1.0, engine="digital", is_scanned=False)]
    else:
        raise ExtractionRejected(f"Unsupported file format: {suffix} (MIME: {mime_type})")
