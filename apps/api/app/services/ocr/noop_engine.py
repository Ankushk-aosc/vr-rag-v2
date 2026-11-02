import logging
from pathlib import Path
from typing import List, Union

from app.services.ocr.base import OcrEngine, OcrPage, OcrResult

logger = logging.getLogger(__name__)


class NoOpEngine(OcrEngine):
    """
    No-op / born-digital engine.
    Extracts embedded digital text directly without running optical recognition.
    """

    def extract(self, path: Union[str, Path], mime: str = "") -> OcrResult:
        file_path = Path(path)
        ext = file_path.suffix.lower()

        if ext == ".pdf" or "pdf" in mime:
            import pymupdf as fitz

            doc = fitz.open(str(file_path))
            pages: List[OcrPage] = []
            try:
                for idx in range(len(doc)):
                    p = doc[idx]
                    text = p.get_text("text").strip()
                    pages.append(
                        OcrPage(
                            page_no=idx + 1,
                            text=text,
                            confidence=1.0,
                            blocks=[{"text": text, "bbox": [0.0, 0.0, float(p.rect.width), float(p.rect.height)], "confidence": 1.0}],
                            engine="noop",
                            is_scanned=False,
                        )
                    )
            finally:
                doc.close()
            return OcrResult(pages=pages, engine="noop", language="eng")

        # For text files
        text = file_path.read_text(encoding="utf-8", errors="replace").strip()
        pages = [
            OcrPage(
                page_no=1,
                text=text,
                confidence=1.0,
                blocks=[{"text": text, "bbox": [0.0, 0.0, 1.0, 1.0], "confidence": 1.0}],
                engine="noop",
                is_scanned=False,
            )
        ]
        return OcrResult(pages=pages, engine="noop", language="eng")

