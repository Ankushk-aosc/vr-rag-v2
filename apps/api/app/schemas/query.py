from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class CitationItem(BaseModel):
    ref: Optional[int] = None
    score: Optional[float] = None
    chunk_id: str
    document_id: str
    document_name: str
    page_number: int
    section_title: Optional[str] = None
    is_table: bool = False
    snippet: str


class FinancialMetricItem(BaseModel):
    label: str
    value: str
    currency: str = ""
    period: Optional[str] = None
    change: Optional[str] = None


class ThinkingStageItem(BaseModel):
    title: str
    duration_ms: int
    status: str = "done"
    details: Optional[str] = None


class StructuredAnswer(BaseModel):
    summary: str
    key_findings: List[str] = Field(default_factory=list)
    metrics: List[FinancialMetricItem] = Field(default_factory=list)
    risk_factors: List[str] = Field(default_factory=list)
    disclaimer: str


class HistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., max_length=8000)


class QueryRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000, description="Natural language financial question")
    family_entity_id: str = Field("default_family", description="Active family trust or personal entity ID")
    top_k: int = Field(6, ge=1, le=12, description="Number of source passages to retrieve")
    history: List[HistoryTurn] = Field(default_factory=list, max_length=20, description="Prior turns for follow-up questions")
    mode: Literal["text", "voice"] = Field("text", description="'voice' returns a short spoken-style answer")


class QueryResponse(BaseModel):
    answer: str
    reasoning: str = ""
    structured_data: Optional[StructuredAnswer] = None
    thinking_trace: List[ThinkingStageItem] = Field(default_factory=list)
    citations: List[CitationItem] = Field(default_factory=list)
    grounded: bool = True
    unverified_numeric_claims: List[str] = Field(default_factory=list)
    numeric_claim_accuracy: float = 1.0
    grounding_warning: Optional[str] = None
    currency: str = "AUD"
    total_latency_ms: int = 0
    disclaimer: str = (
        "General Information Only: Outputs are factual summaries from uploaded records and "
        "do not constitute financial product advice under ASIC Regulatory Guide 244."
    )
