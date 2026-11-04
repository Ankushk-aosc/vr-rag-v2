from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field


class DocumentResponse(BaseModel):
    id: str
    filename: str
    original_name: str
    mime_type: str
    file_size: int
    file_hash: str
    total_pages: int
    family_entity_id: str
    status: str
    uploaded_at: str
    columns: Optional[List[str]] = None
    sample_rows: Optional[List[List[str]]] = None
    preview_text: Optional[str] = None
    is_table: bool = False
    # Counts and page-cited metrics from visual analysis of chart/image pages (PDFs)
    visual_extraction: Optional[dict] = None


class DocumentUploadResponse(BaseModel):
    message: str
    document: DocumentResponse
    total_chunks: int
    total_vectors_indexed: int


class BatchDocumentUploadResponse(BaseModel):
    message: str
    total_files: int
    successful_files: int
    documents: List[DocumentResponse]
    errors: List[str] = Field(default_factory=list)


class DocumentTableResponse(BaseModel):
    document_id: str
    filename: str
    columns: List[str]
    rows: List[List[str]]
    total_rows: int
    page: int
    page_size: int
    total_pages: int
