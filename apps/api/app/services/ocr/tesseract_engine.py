import io
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from PIL import Image

from app.config import settings
from app.services.ocr.base import OcrBlock, OcrEngine, OcrPage, OcrResult
from app.services.ocr.preprocess import preprocess_image

logger = logging.getLogger(__name__)


class TesseractEngine(OcrEngine):
    """
    Default OCR engine using pytesseract + PyMuPDF.
    Extracts text, per-page blocks with bounding boxes and confidence scores.
    """

    def __init__(self, language: Optional[str] = None):
        self.language = language or settings.OCR_LANG

    def extract(self, path: Union[str, Path], mime: str = "") -> OcrResult:
        file_path = Path(path)
        ext = file_path.suffix.lower()

        if ext == ".pdf" or "pdf" in mime:
            return self._extract_pdf(file_path)
        else:
            return self._extract_image(file_path)

    def _extract_pdf(self, file_path: Path) -> OcrResult:
        import pymupdf as fitz

        pages: List[OcrPage] = []
        doc = fitz.open(str(file_path))

        try:
            for page_idx in range(len(doc)):
                page = doc[page_idx]
                page_no = page_idx + 1

                # Render page at 300 DPI (72 pt * 300 / 72 = 300 dpi)
                zoom = 300.0 / 72.0
                mat = fitz.Matrix(zoom, zoom)
                pix = page.get_pixmap(matrix=mat)
                img = Image.open(io.BytesIO(pix.tobytes("png")))
                img._pdf_doc_metadata = doc.metadata or {}

                # Preprocess temp copy
                processed_img = preprocess_image(img)

                # Extract using pytesseract
                page_text, page_conf, blocks = self._ocr_image(processed_img)

                # If tesseract wasn't available and page_text is empty, fallback to digital text layer if available
                if not page_text and page.get_text("text").strip():
                    digital_text = page.get_text("text").strip()
                    page_text = digital_text
                    page_conf = 1.0
                    blocks = [{"text": digital_text, "bbox": [0, 0, pix.width, pix.height], "confidence": 1.0}]

                pages.append(
                    OcrPage(
                        page_no=page_no,
                        text=page_text,
                        confidence=page_conf,
                        blocks=blocks,
                        engine="tesseract",
                        is_scanned=True,
                    )
                )
        finally:
            doc.close()

        return OcrResult(pages=pages, engine="tesseract", language=self.language)

    def _extract_image(self, file_path: Path) -> OcrResult:
        img = Image.open(str(file_path))
        processed_img = preprocess_image(img)

        page_text, page_conf, blocks = self._ocr_image(processed_img)

        pages = [
            OcrPage(
                page_no=1,
                text=page_text,
                confidence=page_conf,
                blocks=blocks,
                engine="tesseract",
                is_scanned=True,
            )
        ]
        return OcrResult(pages=pages, engine="tesseract", language=self.language)

    def _ocr_image(self, img: Image.Image) -> tuple[str, float, List[Dict[str, Any]]]:
        try:
            import pytesseract
            from pytesseract import Output

            data = pytesseract.image_to_data(
                img,
                lang=self.language,
                output_type=Output.DICT,
            )

            blocks: List[Dict[str, Any]] = []
            text_parts: List[str] = []
            confidences: List[float] = []

            n_boxes = len(data["text"])
            for i in range(n_boxes):
                word = (data["text"][i] or "").strip()
                if not word:
                    continue

                raw_conf = data["conf"][i]
                conf = float(raw_conf) / 100.0 if float(raw_conf) >= 0 else 0.5
                confidences.append(conf)
                text_parts.append(word)

                bbox = [
                    float(data["left"][i]),
                    float(data["top"][i]),
                    float(data["width"][i]),
                    float(data["height"][i]),
                ]
                blocks.append(
                    OcrBlock(text=word, bbox=bbox, confidence=conf).to_dict()
                )

            full_text = " ".join(text_parts).strip()
            avg_conf = (sum(confidences) / len(confidences)) if confidences else 1.0
            return full_text, avg_conf, blocks

        except Exception as e:
            # No OCR means no text. This used to substitute a canned "distribution statement" with dollar
            # figures at 0.95 confidence, which put fabricated financial data into real documents.
            logger.warning("Tesseract OCR unavailable or failed (%s); page left without OCR text.", type(e).__name__)
            return "", 0.0, []
