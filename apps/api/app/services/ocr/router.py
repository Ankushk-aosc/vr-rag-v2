import io
import logging
from pathlib import Path
from typing import List, Optional, Union

from PIL import Image

from app.config import settings
from app.services.ocr.base import OcrEngine, OcrPage, OcrResult
from app.services.ocr.noop_engine import NoOpEngine
from app.services.ocr.preprocess import preprocess_image
from app.services.ocr.tesseract_engine import TesseractEngine
from app.services.ocr.textract_engine import TextractEngine

logger = logging.getLogger(__name__)


def get_ocr_engine(engine_name: Optional[str] = None) -> OcrEngine:
    name = (engine_name or settings.OCR_ENGINE).lower()
    if name == "textract" and settings.is_local_mode:
        logger.warning("OCR_ENGINE=textract is ignored in PRIVACY_MODE=local; using Tesseract.")
        name = "tesseract"
    if name == "textract":
        return TextractEngine()
    elif name == "noop":
        return NoOpEngine()
    else:
        return TesseractEngine()


def route_and_extract(
    path: Union[str, Path],
    mime: str = "",
    engine_name: Optional[str] = None,
) -> OcrResult:
    """
    Per-page routing:
    - PDF pages with extractable text layer >= OCR_PDF_TEXT_THRESHOLD -> skip OCR (engine="digital").
    - PDF pages below threshold -> route to OCR (engine="tesseract" or "textract").
    - Images -> always route to OCR.
    - Plain text / Office formats -> born-digital extraction (engine="digital").
    Records exact engine and scanned status per page.
    """
    file_path = Path(path)
    suffix = file_path.suffix.lower()
    ocr_engine = get_ocr_engine(engine_name)
    primary_engine = (engine_name or settings.OCR_ENGINE).lower()

    IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp"}

    # 1. Image documents: Always OCR
    if suffix in IMAGE_EXTENSIONS or mime.startswith("image/"):
        result = ocr_engine.extract(file_path, mime=mime)
        return result

    # 2. PDF documents: Per-page evaluation
    if suffix == ".pdf" or "pdf" in mime:
        import pymupdf as fitz

        doc = fitz.open(str(file_path))
        pages: List[OcrPage] = []

        try:
            for page_idx in range(len(doc)):
                page = doc[page_idx]
                page_no = page_idx + 1

                # Check extractable digital text layer
                digital_text = page.get_text("text").strip()

                if len(digital_text) >= settings.OCR_PDF_TEXT_THRESHOLD:
                    # Page has sufficient born-digital text; skip OCR
                    blocks = [
                        {
                            "text": digital_text,
                            "bbox": [0.0, 0.0, float(page.rect.width), float(page.rect.height)],
                            "confidence": 1.0,
                        }
                    ]
                    pages.append(
                        OcrPage(
                            page_no=page_no,
                            text=digital_text,
                            confidence=1.0,
                            blocks=blocks,
                            engine="digital",
                            is_scanned=False,
                        )
                    )
                else:
                    # Low or absent digital text; route page to OCR
                    logger.info("PDF page %d has %d chars (< %d); routing to OCR engine '%s'",
                                page_no, len(digital_text), settings.OCR_PDF_TEXT_THRESHOLD, primary_engine)
                    zoom = 300.0 / 72.0
                    mat = fitz.Matrix(zoom, zoom)
                    pix = page.get_pixmap(matrix=mat)
                    img = Image.open(io.BytesIO(pix.tobytes("png")))
                    processed_img = preprocess_image(img)

                    if isinstance(ocr_engine, TesseractEngine):
                        ocr_text, ocr_conf, ocr_blocks = ocr_engine._ocr_image(processed_img)
                    else:
                        # For Textract or others, save page image to temp buffer and run
                        with io.BytesIO() as bio:
                            processed_img.save(bio, format="PNG")
                            bio.seek(0)
                            sub_res = ocr_engine._extract_image_bytes(bio.getvalue()) if hasattr(ocr_engine, "_extract_image_bytes") else ocr_engine.extract(file_path, mime)
                            ocr_text = sub_res.pages[0].text if sub_res.pages else ""
                            ocr_conf = sub_res.pages[0].confidence if sub_res.pages else 1.0
                            ocr_blocks = sub_res.pages[0].blocks if sub_res.pages else []

                    # If OCR produced nothing but digital text had a little text, keep digital
                    if not ocr_text and digital_text:
                        ocr_text = digital_text
                        ocr_conf = 1.0

                    pages.append(
                        OcrPage(
                            page_no=page_no,
                            text=ocr_text,
                            confidence=ocr_conf,
                            blocks=ocr_blocks,
                            engine=primary_engine,
                            is_scanned=True,
                        )
                    )
        finally:
            doc.close()

        has_ocr = any(p.is_scanned for p in pages)
        overall_engine = primary_engine if has_ocr else "digital"
        return OcrResult(pages=pages, engine=overall_engine, language=settings.OCR_LANG)

    # 3. Plain text / fallback
    text = file_path.read_text(encoding="utf-8", errors="replace").strip()
    return OcrResult(
        pages=[
            OcrPage(
                page_no=1,
                text=text,
                confidence=1.0,
                blocks=[{"text": text, "bbox": [0.0, 0.0, 1.0, 1.0], "confidence": 1.0}],
                engine="digital",
                is_scanned=False,
            )
        ],
        engine="digital",
        language=settings.OCR_LANG,
    )

