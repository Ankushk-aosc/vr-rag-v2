export interface CitationItem {
  chunk_id: string;
  document_id: string;
  document_name: string;
  page_number: number;
  section_title?: string | null;
  is_table?: boolean;
  snippet: string;
}

export interface DocumentRecord {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  file_hash: string;
  total_pages: number;
  family_entity_id: string;
  status: string;
  uploaded_at: string;
}

export interface ChatMessage {
  id: string;
  sender: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  citations?: CitationItem[];
  grounded?: boolean;
  audioBase64?: string | null;
}

export interface FamilyEntity {
  id: string;
  name: string;
  entity_type: string;
}

export interface QueryResponse {
  answer: string;
  grounded: boolean;
  citations: CitationItem[];
  family_entity_id: string;
  aud_context?: boolean;
}

export interface VoiceQueryResponse extends QueryResponse {
  user_transcript: string;
  audio_base64: string | null;
}
