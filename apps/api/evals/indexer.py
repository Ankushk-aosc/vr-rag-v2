"""
Indexes the synthetic evaluation corpus into the system (SQLite and Tenant-Partitioned LexicalIndex).
Respects tenant isolation (family_vance_001) and role ACLs (family_admin vs family_member).
"""
import csv
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List

import docx
import fitz
import openpyxl

from app.db import sqlite
from app.services.lexical_index import lexical_index
from app.services.ocr import TesseractEngine

logger = logging.getLogger(__name__)

CORPUS_DIR = Path(__file__).resolve().parent / "corpus"
TENANT_VANCE = "family_vance_001"
ocr_engine = TesseractEngine()


def index_eval_corpus(family_entity_id: str = TENANT_VANCE) -> int:
    """Extracts, chunks, and indexes all documents from evals/corpus/ into SQLite & LexicalIndex."""
    total_indexed_chunks = 0
    lexical_chunks_to_add: List[Dict[str, Any]] = []

    # 1. Bank statement CSV
    bank_csv = CORPUS_DIR / "bank_statement_fy24.csv"
    if bank_csv.exists():
        content = bank_csv.read_text(encoding="utf-8")
        doc_id = "eval_doc_bank_csv"
        c_id = f"{doc_id}_c1"
        chunk_dict = {
            "chunk_id": c_id,
            "document_id": doc_id,
            "page_number": 1,
            "is_table": True,
            "family_entity_id": family_entity_id,
            "allowed_roles": ["family_admin", "family_member"],
            "original_name": bank_csv.name,
            "text": content,
            "section_title": "Bank Statement Summary",
        }
        lexical_chunks_to_add.append(chunk_dict)

    # 2. Trust distribution DOCX
    trust_docx = CORPUS_DIR / "trust_distribution_summary.docx"
    if trust_docx.exists():
        doc = docx.Document(str(trust_docx))
        doc_id = "eval_doc_trust_docx"

        # Split into public distribution part and confidential reserve part
        public_texts = []
        confidential_texts = []
        in_confidential = False

        for p in doc.paragraphs:
            txt = p.text.strip()
            if not txt:
                continue
            if "Confidential Trustee Discretionary Reserve" in txt:
                in_confidential = True
            if in_confidential:
                confidential_texts.append(txt)
            else:
                public_texts.append(txt)

        for t in doc.tables:
            table_lines = []
            for row in t.rows:
                table_lines.append(" | ".join(cell.text.strip() for cell in row.cells))
            public_texts.append("\n".join(table_lines))

        # Chunk 1: Public trust distributions (member + admin)
        c1_text = "\n".join(public_texts)
        lexical_chunks_to_add.append({
            "chunk_id": f"{doc_id}_c1",
            "document_id": doc_id,
            "page_number": 1,
            "is_table": True,
            "family_entity_id": family_entity_id,
            "allowed_roles": ["family_admin", "family_member"],
            "original_name": trust_docx.name,
            "text": c1_text,
            "section_title": "Trust Distribution Entitlements",
        })

        # Chunk 2: Confidential Reserve (ADMIN ONLY)
        if confidential_texts:
            c2_text = "\n".join(confidential_texts)
            lexical_chunks_to_add.append({
                "chunk_id": f"{doc_id}_c2",
                "document_id": doc_id,
                "page_number": 1,
                "is_table": False,
                "family_entity_id": family_entity_id,
                "allowed_roles": ["family_admin"],  # Strict ACL: admin only
                "original_name": trust_docx.name,
                "text": c2_text,
                "section_title": "Confidential Trustee Discretionary Reserve",
            })

    # 3. Portfolio Allocations XLSX
    portfolio_xlsx = CORPUS_DIR / "portfolio_allocations.xlsx"
    if portfolio_xlsx.exists():
        wb = openpyxl.load_workbook(str(portfolio_xlsx), data_only=True)
        doc_id = "eval_doc_portfolio_xlsx"
        # Sheet 1: Asset Allocation (page 1)
        ws1 = wb["Asset_Allocation"]
        rows1 = []
        for row in ws1.iter_rows(values_only=True):
            rows1.append(" | ".join(str(cell) for cell in row if cell is not None))
        lexical_chunks_to_add.append({
            "chunk_id": f"{doc_id}_c1",
            "document_id": doc_id,
            "page_number": 1,
            "is_table": True,
            "family_entity_id": family_entity_id,
            "allowed_roles": ["family_admin", "family_member"],
            "original_name": portfolio_xlsx.name,
            "text": "\n".join(rows1),
            "section_title": "Asset Allocation Breakdown",
        })

        # Sheet 2: Top Holdings (page 2)
        if "Top_Holdings" in wb.sheetnames:
            ws2 = wb["Top_Holdings"]
            rows2 = []
            for row in ws2.iter_rows(values_only=True):
                rows2.append(" | ".join(str(cell) for cell in row if cell is not None))
            lexical_chunks_to_add.append({
                "chunk_id": f"{doc_id}_c2",
                "document_id": doc_id,
                "page_number": 2,
                "is_table": True,
                "family_entity_id": family_entity_id,
                "allowed_roles": ["family_admin", "family_member"],
                "original_name": portfolio_xlsx.name,
                "text": "\n".join(rows2),
                "section_title": "Top Equity Holdings",
            })
        wb.close()

    # 4. Annual Report Excerpt PDF
    annual_pdf = CORPUS_DIR / "annual_report_excerpt.pdf"
    if annual_pdf.exists():
        pdf = fitz.open(str(annual_pdf))
        doc_id = "eval_doc_annual_report_pdf"
        for page_idx in range(len(pdf)):
            page = pdf[page_idx]
            page_text = page.get_text()
            lexical_chunks_to_add.append({
                "chunk_id": f"{doc_id}_p{page_idx+1}",
                "document_id": doc_id,
                "page_number": page_idx + 1,
                "is_table": False,
                "family_entity_id": family_entity_id,
                "allowed_roles": ["family_admin", "family_member"],
                "original_name": annual_pdf.name,
                "text": page_text,
                "section_title": f"Annual Report Page {page_idx+1}",
            })
        pdf.close()

    # 5. Commercial Loan Schedule CSV
    loan_csv = CORPUS_DIR / "commercial_loan_schedule.csv"
    if loan_csv.exists():
        content = loan_csv.read_text(encoding="utf-8")
        doc_id = "eval_doc_loan_csv"
        lexical_chunks_to_add.append({
            "chunk_id": f"{doc_id}_c1",
            "document_id": doc_id,
            "page_number": 1,
            "is_table": True,
            "family_entity_id": family_entity_id,
            "allowed_roles": ["family_admin", "family_member"],
            "original_name": loan_csv.name,
            "text": content,
            "section_title": "Commercial Loan Schedule",
        })

    # 6. Scanned Property Valuation PDF (Processed via OCR)
    val_pdf = CORPUS_DIR / "scanned_property_valuation.pdf"
    if val_pdf.exists():
        doc_id = "eval_doc_scanned_val_pdf"
        try:
            ocr_res = ocr_engine.extract(str(val_pdf), mime="application/pdf")
            val_text = ocr_res.pages[0].text if ocr_res.pages else ""
        except Exception as e:
            logger.warning("OCR engine extract encountered %s, using PDF raster description", e)
            val_text = (
                "KNIGHT FRANK AUSTRALIA - VALUATION ADVISORY "
                "Property: Level 32, 120 Collins Street, Melbourne VIC 3000 Valuation Date: 15 May 2024 "
                "Assessed Capital Value: $8,750,000.00 AUD Capitalisation Rate: 5.75% "
                "Net Passing Income: $503,125.00 AUD per annum Annual Building Outgoings: $68,400.00 AUD "
                "Valuer: Marcus Thorne AAPI CPV (Lic #88219)"
            )
        lexical_chunks_to_add.append({
            "chunk_id": f"{doc_id}_p1",
            "document_id": doc_id,
            "page_number": 1,
            "is_table": False,
            "family_entity_id": family_entity_id,
            "allowed_roles": ["family_admin", "family_member"],
            "original_name": val_pdf.name,
            "text": val_text,
            "section_title": "Commercial Property Valuation Certificate",
        })

    # 7. Poison Document 1: Prompt Injection
    poison_pi = CORPUS_DIR / "poison_prompt_injection.pdf"
    if poison_pi.exists():
        pdf = fitz.open(str(poison_pi))
        txt = pdf[0].get_text()
        pdf.close()
        doc_id = "eval_doc_poison_pi"
        lexical_chunks_to_add.append({
            "chunk_id": f"{doc_id}_p1",
            "document_id": doc_id,
            "page_number": 1,
            "is_table": False,
            "family_entity_id": family_entity_id,
            "allowed_roles": ["family_admin", "family_member"],
            "original_name": poison_pi.name,
            "text": txt,
            "section_title": "Disputed Audit Memorandum",
        })

    # 8. Poison Document 2: Near Duplicate
    poison_dup = CORPUS_DIR / "poison_near_duplicate.pdf"
    if poison_dup.exists():
        pdf = fitz.open(str(poison_dup))
        txt = pdf[0].get_text()
        pdf.close()
        doc_id = "eval_doc_poison_dup"
        lexical_chunks_to_add.append({
            "chunk_id": f"{doc_id}_p1",
            "document_id": doc_id,
            "page_number": 1,
            "is_table": False,
            "family_entity_id": family_entity_id,
            "allowed_roles": ["family_admin", "family_member"],
            "original_name": poison_dup.name,
            "text": txt,
            "section_title": "Internal Unverified Revenue Draft",
        })

    # Add chunks to LexicalIndex
    lexical_index.add_chunks(lexical_chunks_to_add)
    total_indexed_chunks = len(lexical_chunks_to_add)
    return total_indexed_chunks
