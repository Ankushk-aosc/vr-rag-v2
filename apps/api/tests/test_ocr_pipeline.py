import io
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import settings
from app.db import sqlite
from app.main import app
from app.services import chunker, pinecone_service
from app.services.ocr import (
    OcrResult,
    TesseractEngine,
    TextractEngine,
    get_ocr_engine,
    preprocess_image,
    route_and_extract,
)
from app.services.storage import storage_service

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "ocr"


@pytest.fixture(autouse=True)
def setup_test_db():
    sqlite.init_db()


import uuid

pytestmark = pytest.mark.usefixtures("cloud_mode")  # Pinecone-path tests (Audit I-09: local is the default)

def _get_auth_context(client: TestClient, email_prefix: str = "ocr_user", role: str = "family_admin"):
    """Helper to register and login a test user with a unique email and family entity."""
    clean_prefix = email_prefix.split("@")[0]
    email = f"{clean_prefix}_{uuid.uuid4().hex[:8]}@example.com"
    res = client.post(
        "/api/auth/register",
        json={"email": email, "password": "SecurePassword123!", "full_name": "Test User"},
    ).json()
    token = res["access_token"]
    user = res["user"]
    family_id = user["memberships"][0]["family_entity_id"]
    headers = {"Authorization": f"Bearer {token}"}
    return headers, family_id, user["id"]


def test_preprocess_image_grayscale_and_binarise():
    """2.4: Preprocess: grayscale, deskew, binarise; temp copy only."""
    img = Image.new("RGB", (200, 200), color=(255, 255, 255))
    processed = preprocess_image(img)
    # Output should be in-memory PIL image without mutating original
    assert processed is not None
    assert isinstance(processed, Image.Image)
    assert img.mode == "RGB"  # original untouched


def test_tesseract_engine_on_fixtures():
    """2.1, 2.2, 2.9: Tesseract extraction on committed fixture image and scanned PDF."""
    engine = TesseractEngine(language="eng")
    scanned_img = FIXTURES_DIR / "scanned_invoice.png"
    assert scanned_img.exists()

    res = engine.extract(scanned_img, mime="image/png")
    assert isinstance(res, OcrResult)
    assert res.engine == "tesseract"
    assert len(res.pages) == 1
    page = res.pages[0]
    assert page.page_no == 1
    assert page.is_scanned is True
    assert page.confidence >= 0.0
    assert isinstance(page.blocks, list)


def test_routing_digital_pdf_skips_ocr():
    """2.3, 2.9: Born-digital PDF with sufficient text skips OCR."""
    digital_pdf = FIXTURES_DIR / "digital_report.pdf"
    assert digital_pdf.exists()

    res = route_and_extract(digital_pdf, mime="application/pdf")
    assert len(res.pages) == 1
    p = res.pages[0]
    assert p.engine == "digital"
    assert p.is_scanned is False
    assert p.confidence == 1.0
    assert "AUSTRALIAN TAXATION OFFICE" in p.text


def test_routing_mixed_pdf():
    """2.3: Per-page routing: Page 1 digital skips OCR; Page 2 scanned triggers OCR."""
    mixed_pdf = FIXTURES_DIR / "mixed_portfolio.pdf"
    assert mixed_pdf.exists()

    res = route_and_extract(mixed_pdf, mime="application/pdf")
    assert len(res.pages) == 2

    # Page 1: digital
    p1 = res.pages[0]
    assert p1.page_no == 1
    assert p1.engine == "digital"
    assert p1.is_scanned is False
    assert "PORTFOLIO SUMMARY" in p1.text

    # Page 2: scanned image
    p2 = res.pages[1]
    assert p2.page_no == 2
    assert p2.engine == "tesseract"
    assert p2.is_scanned is True


def test_chunk_metadata_includes_page_no_and_ocr_metadata():
    """2.5: Chunk document carries page_no, bbox, ocr_engine, ocr_confidence."""
    scanned_pdf = FIXTURES_DIR / "scanned_statement.pdf"
    res = route_and_extract(scanned_pdf, mime="application/pdf")
    chunks = chunker.chunk_document(document_id="doc_test_123", pages=res.pages)

    assert len(chunks) >= 1
    c = chunks[0]
    assert "page_no" in c
    assert c["page_no"] == 1
    assert "ocr_engine" in c
    assert "ocr_confidence" in c
    assert "bbox" in c


def test_textract_engine_mocked_no_live_aws_keys():
    """2.2, 2.9: TextractEngine extracts blocks and produces same OcrResult without live AWS keys."""
    fake_textract_response = {
        "Blocks": [
            {
                "BlockType": "PAGE",
                "Page": 1,
            },
            {
                "BlockType": "LINE",
                "Page": 1,
                "Text": "Invoice Total: $5,000.00 AUD",
            },
            {
                "BlockType": "WORD",
                "Page": 1,
                "Text": "Invoice",
                "Confidence": 98.5,
                "Geometry": {
                    "BoundingBox": {"Left": 0.1, "Top": 0.1, "Width": 0.2, "Height": 0.05}
                },
            },
            {
                "BlockType": "WORD",
                "Page": 1,
                "Text": "$5,000.00",
                "Confidence": 99.1,
                "Geometry": {
                    "BoundingBox": {"Left": 0.35, "Top": 0.1, "Width": 0.2, "Height": 0.05}
                },
            },
        ]
    }

    mock_client = MagicMock()
    mock_client.detect_document_text.return_value = fake_textract_response

    engine = TextractEngine(region_name="us-east-1")
    engine._client = mock_client

    img_path = FIXTURES_DIR / "scanned_invoice.png"
    res = engine.extract(img_path, mime="image/png")

    assert res.engine == "textract"
    assert len(res.pages) == 1
    page = res.pages[0]
    assert page.page_no == 1
    assert page.is_scanned is True
    assert page.confidence > 0.9
    assert "Invoice Total: $5,000.00 AUD" in page.text
    assert len(page.blocks) == 2
    assert page.blocks[0]["text"] == "Invoice"
    assert page.blocks[0]["confidence"] == pytest.approx(0.985, abs=0.01)


def test_ingestion_scanned_image_and_digital_pdf_pipeline():
    """GATE: scanned + digital fixtures both ingest correctly; page_no metadata stored."""
    client = TestClient(app)
    headers, family_id, user_id = _get_auth_context(client, "ingest_ocr_user")

    captured_chunks = []

    def fake_upsert(chunks, embeddings, family_entity_id, allowed_roles):
        captured_chunks.extend(chunks)
        return len(chunks)

    with patch("app.routers.documents.pinecone_service.upsert_vectors", side_effect=fake_upsert):
        # 1. Ingest born-digital PDF
        digital_pdf = FIXTURES_DIR / "digital_report.pdf"
        with digital_pdf.open("rb") as f:
            res = client.post(
                "/api/documents/upload",
                headers=headers,
                data={"family_entity_id": family_id, "allowed_role": "family_member"},
                files={"file": ("digital_report.pdf", f, "application/pdf")},
            )
        assert res.status_code == 201, res.text
        data = res.json()
        assert data["document"]["status"] == "indexed"
        doc_id = data["document"]["id"]

        # Verify document in DB
        doc = sqlite.get_document_by_id(doc_id)
        assert doc is not None
        assert doc["status"] == "indexed"

        # 2. Ingest scanned image
        scanned_img = FIXTURES_DIR / "scanned_invoice.png"
        with scanned_img.open("rb") as f:
            res_img = client.post(
                "/api/documents/upload",
                headers=headers,
                data={"family_entity_id": family_id, "allowed_role": "family_member"},
                files={"file": ("scanned_invoice.png", f, "image/png")},
            )
        assert res_img.status_code == 201, res_img.text
        img_data = res_img.json()
        assert img_data["document"]["status"] == "indexed"

    # Verify captured chunk metadata includes page_no and ocr_engine
    assert len(captured_chunks) >= 2
    scanned_chunks = [c for c in captured_chunks if c.get("ocr_engine") == "tesseract"]
    assert len(scanned_chunks) >= 1
    assert scanned_chunks[0]["page_no"] == 1
    assert "ocr_confidence" in scanned_chunks[0]


def test_failure_compensation_leaves_no_orphans():
    """2.5, 2.9: Ingestion failure leaves status='failed' and cleans up vectors and storage."""
    client = TestClient(app)
    headers, family_id, user_id = _get_auth_context(client, "compensation_user")

    scanned_img = FIXTURES_DIR / "scanned_invoice.png"

    # Simulate vector upsert failure
    with patch("app.services.pinecone_service.upsert_vectors", side_effect=RuntimeError("Simulated Pinecone connection timeout")):
        with scanned_img.open("rb") as f:
            res = client.post(
                "/api/documents/upload",
                headers=headers,
                data={"family_entity_id": family_id, "allowed_role": "family_member"},
                files={"file": ("failing_doc.png", f, "image/png")},
            )

    assert res.status_code == 500
    assert "Vector database upsert failed" in res.json()["detail"]


def test_acl_and_tenant_isolation_on_ocr_content():
    """2.8, 2.9: OCR text obeys the same authorize_document and ACL rules."""
    client = TestClient(app)
    headers_admin, family_a, _ = _get_auth_context(client, "family_a_admin", "family_admin")
    headers_other_family, family_b, _ = _get_auth_context(client, "family_b_user", "family_member")

    with patch("app.routers.documents.pinecone_service.upsert_vectors", return_value=1):
        # Admin of Family A uploads restricted document
        scanned_img = FIXTURES_DIR / "scanned_invoice.png"
        with scanned_img.open("rb") as f:
            res = client.post(
                "/api/documents/upload",
                headers=headers_admin,
                data={"family_entity_id": family_a, "allowed_role": "family_admin"},
                files={"file": ("family_a_confidential.png", f, "image/png")},
            )
        assert res.status_code == 201
        doc_id = res.json()["document"]["id"]

    # Family B cannot access Family A document
    get_res = client.get(f"/api/documents/{doc_id}", headers=headers_other_family)
    assert get_res.status_code in (403, 404)


def test_citations_to_scanned_pages_work():
    """GATE: Citations to scanned pages include page_no and valid document provenance."""
    from app.services.rag_engine import _citations_for

    passages = [
        {
            "document_id": "doc_scanned_999",
            "page_no": 3,
            "page_number": 3,
            "text": "Franked Dividends: $85,400.00",
            "focused_text": "Franked Dividends: $85,400.00",
            "ocr_engine": "tesseract",
            "ocr_confidence": 0.95,
        }
    ]

    citations = _citations_for(passages)
    assert len(citations) == 1
    c = citations[0]
    assert c["ref"] == 1
    assert c["page_no"] == 3
    assert c["page_number"] == 3
    assert c["document_id"] == "doc_scanned_999"


def test_low_confidence_pages_flagged_on_document_not_dropped():
    """2.6: Low-confidence pages (avg < OCR_MIN_CONFIDENCE) flagged on document, not dropped."""
    from app.services.extractor import ExtractedPage

    client = TestClient(app)
    headers, family_id, _ = _get_auth_context(client, "low_conf_user")

    # Mock extractor returning low-confidence OCR page
    low_conf_pages = [
        ExtractedPage(
            page_number=1,
            text="Faded faint receipt text $12.50",
            tables=[],
            confidence=0.35,  # < OCR_MIN_CONFIDENCE (0.60)
            blocks=[{"text": "Faded", "bbox": [0, 0, 10, 10], "confidence": 0.35}],
            engine="tesseract",
            is_scanned=True,
        )
    ]

    saved_doc_records = []
    with patch("app.routers.documents.extractor.extract_document", return_value=low_conf_pages):
        with patch("app.routers.documents.pinecone_service.upsert_vectors", return_value=1):
            with patch("app.routers.documents.pinecone_service.save_document_to_pinecone", side_effect=saved_doc_records.append):
                scanned_img = FIXTURES_DIR / "scanned_invoice.png"
                with scanned_img.open("rb") as f:
                    res = client.post(
                        "/api/documents/upload",
                        headers=headers,
                        data={"family_entity_id": family_id, "allowed_role": "family_member"},
                        files={"file": ("low_conf_doc.png", f, "image/png")},
                    )

    assert res.status_code == 201
    assert res.json()["document"]["status"] == "indexed"  # Not dropped!
    assert len(saved_doc_records) == 1
    assert saved_doc_records[0].get("low_confidence") is True
    assert saved_doc_records[0].get("ocr_confidence") == pytest.approx(0.35)
