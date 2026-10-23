import pytest
from app.services.extractor import ExtractedPage
from app.services.chunker import chunk_document


def test_chunker_preserves_page_numbers_and_tables():
    pages = [
        ExtractedPage(
            page_number=1,
            text="AUSTRALIAN TAXATION OFFICE\nNotice of Assessment\nTax Year: 2023-2024\nTaxable Income: $125,000 AUD.",
            tables=["Description | Amount\n--- | ---\nGross Salary | $120,000\nBank Interest | $5,000"]
        ),
        ExtractedPage(
            page_number=2,
            text="Medicare Levy: $2,500 AUD.\nTotal Tax Payable: $32,450 AUD.\nRefund Due: $1,200 AUD.",
            tables=[]
        )
    ]

    chunks = chunk_document(document_id="test_doc_01", pages=pages, chunk_size=200, chunk_overlap=50)

    # Must contain at least table chunk + text chunks
    assert len(chunks) >= 3

    # Check table chunk
    table_chunk = next(c for c in chunks if c["is_table"])
    assert table_chunk["page_number"] == 1
    assert "Gross Salary" in table_chunk["content"]
    assert table_chunk["id"] == "test_doc_01_p1_t0"

    # Check page 2 chunk
    page_2_chunk = next(c for c in chunks if c["page_number"] == 2)
    assert "Medicare Levy" in page_2_chunk["content"]
    assert page_2_chunk["page_number"] == 2
