import { DocumentRecord, CitationItem, StructuredData, ThinkingStage, HistoryTurn, Dashboard } from "../types";

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
  structured_data?: StructuredData;
  thinking_trace?: ThinkingStage[];
  citations: CitationItem[];
  grounded: boolean;
  currency?: string;
  total_latency_ms?: number;
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

/** Events emitted by POST /api/query/stream (Server-Sent Events, one JSON object per `data:` line). */
export type StreamEvent =
  | { type: "stage"; id: string; title: string; status: "active" | "done"; detail: string; duration_ms: number }
  | { type: "sources"; citations: CitationItem[] }
  | { type: "reasoning"; delta: string }
  | { type: "answer"; delta: string }
  | {
      type: "done";
      answer: string;
      reasoning: string;
      structured_data: StructuredData | null;
      thinking_trace: ThinkingStage[];
      citations: CitationItem[];
      grounded: boolean;
      total_latency_ms: number;
    }
  | { type: "error"; message: string };

/**
 * Stream a RAG answer: pipeline stages, live model reasoning and answer tokens arrive as they are produced.
 * Resolves when the stream ends; abort with the signal to stop generation.
 */
export async function streamQuery(
  params: { question: string; entityId?: string; history?: HistoryTurn[]; mode?: "text" | "voice" },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      question: params.question,
      family_entity_id: params.entityId || "default_family",
      history: params.history || [],
      mode: params.mode || "text",
      top_k: 6,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Query failed with status ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as StreamEvent);
      } catch (err) {
        console.warn("Malformed stream frame:", err);
      }
    }
  }
}

/** Server-side speech-to-text (Groq Whisper, falling back to local faster-whisper). */
export async function transcribeAudio(audioBlob: Blob, signal?: AbortSignal): Promise<string> {
  const formData = new FormData();
  const ext = audioBlob.type.includes("mp4") ? "m4a" : audioBlob.type.includes("ogg") ? "ogg" : "webm";
  formData.append("file", audioBlob, `utterance.${ext}`);
  const res = await fetch(`${API_BASE_URL}/api/voice/transcribe`, { method: "POST", body: formData, signal });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Transcription failed with status ${res.status}`);
  }
  const data = await res.json();
  return (data.transcript || "").trim();
}

/** Server-side neural text-to-speech (edge-tts en-AU). Returns playable audio. */
export async function synthesizeSpeech(text: string, signal?: AbortSignal, voice?: string): Promise<Blob> {
  const res = await fetch(`${API_BASE_URL}/api/voice/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Speech synthesis failed with status ${res.status}`);
  }
  return await res.blob();
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

/** Build a dashboard (KPI tiles + charts computed from the user's indexed tables) for a question. */
export async function createDashboard(params: { question: string; answer?: string; entityId?: string }): Promise<Dashboard> {
  const res = await fetch(`${API_BASE_URL}/api/dashboards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: params.question,
      answer: (params.answer || "").slice(0, 8000),
      family_entity_id: params.entityId || "default_family",
    }),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Dashboard request failed with status ${res.status}`);
  }
  return await res.json();
}
