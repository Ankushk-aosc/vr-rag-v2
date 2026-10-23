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


class DocumentUploadResponse(BaseModel):
    message: str
    document: DocumentResponse
    total_chunks: int
    total_vectors_indexed: int
