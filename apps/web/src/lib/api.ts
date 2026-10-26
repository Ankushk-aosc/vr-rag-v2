import { DocumentRecord, CitationItem } from "../types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/**
 * Fetch list of indexed documents for the selected family entity.
 */
export async function fetchDocuments(entityId: string = "default_family"): Promise<DocumentRecord[]> {
  try {
    const url = `${API_BASE_URL}/api/documents`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Failed to fetch documents`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.documents || []);
  } catch (err) {
    console.warn("fetchDocuments error:", err);
    return [];
  }
}

/**
 * Fetch dynamic suggested questions grounded in the current entity's documents.
 */
export async function fetchDocumentSuggestions(entityId: string = "default_family"): Promise<string[]> {
  try {
    const url = `${API_BASE_URL}/api/documents/suggestions?family_entity_id=${encodeURIComponent(entityId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn("fetchDocumentSuggestions error:", err);
    return [];
  }
}

export interface QueryAssistantResult {
  answer: string;
  citations: CitationItem[];
  grounded: boolean;
  currency?: string;
}

/**
 * Send a natural language financial question to the RAG engine.
 */
export async function queryAssistant(
  question: string,
  entityId: string = "default_family"
): Promise<QueryAssistantResult> {
  const res = await fetch(`${API_BASE_URL}/api/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question,
      family_entity_id: entityId,
      top_k: 4,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Query failed with status ${res.status}`);
  }

  return await res.json();
}

export interface VoiceAskResult {
  user_transcript: string;
  answer: string;
  audio_base64?: string | null;
  citations: CitationItem[];
  grounded: boolean;
  currency?: string;
}

/**
 * Send recorded microphone audio to the end-to-end voice pipeline.
 */
export async function voiceAskAssistant(
  audioBlob: Blob,
  entityId: string = "default_family"
): Promise<VoiceAskResult> {
  const formData = new FormData();
  const fileExt = audioBlob.type.includes("mp4") || audioBlob.type.includes("m4a") ? "m4a" : "webm";
  formData.append("file", audioBlob, `voice_query.${fileExt}`);
  formData.append("family_entity_id", entityId);

  const res = await fetch(`${API_BASE_URL}/api/voice/ask`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Voice request failed with status ${res.status}`);
  }

  return await res.json();
}

export interface UploadDocumentResult {
  message: string;
  document: DocumentRecord;
  total_chunks?: number;
  total_vectors_indexed?: number;
}

/**
 * Upload and index a financial document into local SQLite and Pinecone.
 */
export async function uploadDocument(
  file: File,
  entityId: string = "default_family",
  allowedRole: string = "family_member"
): Promise<UploadDocumentResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("family_entity_id", entityId);
  formData.append("allowed_role", allowedRole);

  const res = await fetch(`${API_BASE_URL}/api/documents/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Document upload failed with status ${res.status}`);
  }

  return await res.json();
}
