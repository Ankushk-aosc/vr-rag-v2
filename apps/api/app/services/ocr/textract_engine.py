import io
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from app.config import settings
from app.services.ocr.base import OcrBlock, OcrEngine, OcrPage, OcrResult

logger = logging.getLogger(__name__)


class TextractEngine(OcrEngine):
    """
    AWS Textract OCR engine using boto3.
    Extracts text, per-page lines/words with bounding boxes and confidence.
    Produces identical OcrResult structure as TesseractEngine.
    """

    def __init__(self, region_name: Optional[str] = None):
        self.region_name = region_name or settings.AWS_REGION
        self._client = None

    def _get_client(self):
        if self._client is None:
            import boto3
            self._client = boto3.client("textract", region_name=self.region_name)
        return self._client

    def extract(self, path: Union[str, Path], mime: str = "") -> OcrResult:
        file_path = Path(path)
        content_bytes = file_path.read_bytes()

        client = self._get_client()
        response = client.detect_document_text(Document={"Bytes": content_bytes})

        pages_map: Dict[int, List[Dict[str, Any]]] = {}
        text_lines_map: Dict[int, List[str]] = {}
        confidences_map: Dict[int, List[float]] = {}

        raw_blocks = response.get("Blocks", [])
        for block in raw_blocks:
            b_type = block.get("BlockType")
            page_no = block.get("Page", 1)

            if b_type == "WORD":
                text = block.get("Text", "").strip()
                if not text:
                    continue
                raw_conf = float(block.get("Confidence", 100.0))
                conf = raw_conf / 100.0

                geom = block.get("Geometry", {}).get("BoundingBox", {})
                bbox = [
                    float(geom.get("Left", 0.0)),
                    float(geom.get("Top", 0.0)),
                    float(geom.get("Width", 0.0)),
                    float(geom.get("Height", 0.0)),
                ]

                pages_map.setdefault(page_no, []).append(
                    OcrBlock(text=text, bbox=bbox, confidence=conf).to_dict()
                )
                confidences_map.setdefault(page_no, []).append(conf)

            elif b_type == "LINE":
                text = block.get("Text", "").strip()
                if text:
                    text_lines_map.setdefault(page_no, []).append(text)

        ocr_pages: List[OcrPage] = []
        all_pages = sorted(set(list(pages_map.keys()) + list(text_lines_map.keys())) or [1])

        for page_no in all_pages:
            lines = text_lines_map.get(page_no, [])
            words = pages_map.get(page_no, [])
            page_text = " ".join(lines) if lines else " ".join(w["text"] for w in words)

            conf_list = confidences_map.get(page_no, [])
            avg_conf = (sum(conf_list) / len(conf_list)) if conf_list else 1.0

            ocr_pages.append(
                OcrPage(
                    page_no=page_no,
                    text=page_text,
                    confidence=avg_conf,
                    blocks=words,
                    engine="textract",
                    is_scanned=True,
                )
            )

        return OcrResult(pages=ocr_pages, engine="textract", language="eng")

