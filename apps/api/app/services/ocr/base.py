from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Union


@dataclass
class OcrBlock:
    text: str
    bbox: List[float] = field(default_factory=list)  # [x0, y0, x1, y1] or [left, top, width, height]
    confidence: float = 1.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "bbox": self.bbox,
            "confidence": self.confidence,
        }


@dataclass
class OcrPage:
    page_no: int
    text: str
    confidence: float = 1.0
    blocks: List[Dict[str, Any]] = field(default_factory=list)
    engine: Optional[str] = None
    is_scanned: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "page_no": self.page_no,
            "text": self.text,
            "confidence": self.confidence,
            "blocks": self.blocks,
            "engine": self.engine,
            "is_scanned": self.is_scanned,
        }

    # Dict-like item access for backwards-compatibility
    def __getitem__(self, item: str) -> Any:
        return getattr(self, item)


@dataclass
class OcrResult:
    pages: List[OcrPage]
    engine: str
    language: str = "eng"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pages": [p.to_dict() if hasattr(p, "to_dict") else p for p in self.pages],
            "engine": self.engine,
            "language": self.language,
        }

    @property
    def avg_confidence(self) -> float:
        if not self.pages:
            return 1.0
        return sum(p.confidence for p in self.pages) / len(self.pages)


class OcrEngine(ABC):
    """Abstract base class for OCR engines."""

    @abstractmethod
    def extract(self, path: Union[str, Path], mime: str = "") -> OcrResult:
        """Extract text, per-page blocks, and confidence from a document or image."""
        pass

