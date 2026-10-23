from typing import List, Optional
from pydantic import BaseModel, Field


class CitationItem(BaseModel):
    chunk_id: str
    document_id: str
    document_name: str
    page_number: int
    section_title: Optional[str] = None
    is_table: bool = False
    snippet: str


class QueryRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=1000, description="Natural language financial question")
    family_entity_id: str = Field("default_family", description="Active family trust or personal entity ID")
    top_k: int = Field(4, ge=1, le=10, description="Number of source passages to retrieve")


class QueryResponse(BaseModel):
    answer: str
    citations: List[CitationItem]
    grounded: bool
    currency: str = "AUD"
    disclaimer: str = (
        "General Information Only: Outputs are factual summaries from uploaded records and "
        "do not constitute financial product advice under ASIC Regulatory Guide 244."
    )
