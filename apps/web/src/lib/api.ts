import { DocumentRecord, DocumentTableData, CitationItem, StructuredData, ThinkingStage, HistoryTurn, Dashboard, AuditEvent, UserInvite } from "../types";
import { getAuthHeaders } from "./auth";
import { ApiError, toApiError } from "./apiErrors";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/**
 * Fetch paginated tabular records for a document with optional search filtering.
 */
export async function fetchDocumentTable(
  documentId: string,
  page: number = 1,
  pageSize: number = 50,
  search?: string
): Promise<DocumentTableData | null> {
  try {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (search && search.trim()) {
      params.set("search", search.trim());
    }
    const url = `${API_BASE_URL}/api/documents/${encodeURIComponent(documentId)}/table?${params}`;
    const res = await fetch(url, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Failed to fetch document table`);
    }
    return await res.json();
  } catch (err) {
    console.warn("fetchDocumentTable error:", err);
    return null;
  }
}

/**
 * Fetch list of indexed documents for the selected family entity.
 */
export async function fetchDocuments(entityId?: string, signal?: AbortSignal): Promise<DocumentRecord[]> {
  const url = entityId
    ? `${API_BASE_URL}/api/documents?family_entity_id=${encodeURIComponent(entityId)}`
    : `${API_BASE_URL}/api/documents`;
  const res = await fetch(url, { headers: getAuthHeaders(), signal });
  if (!res.ok) throw await toApiError(res);
  const data = await res.json();
  return Array.isArray(data) ? data : data.documents || [];
}

/**
 * Fetch dynamic suggested questions grounded in the current entity's documents.
 */
export async function fetchDocumentSuggestions(entityId?: string): Promise<string[]> {
  try {
    const url = entityId
      ? `${API_BASE_URL}/api/documents/suggestions?family_entity_id=${encodeURIComponent(entityId)}`
      : `${API_BASE_URL}/api/documents/suggestions`;
    const res = await fetch(url, {
      headers: getAuthHeaders(),
    });
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
    headers: getAuthHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({
      question,
      family_entity_id: entityId,
      top_k: 4,
    }),
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  return await res.json();
}

/**
 * Events emitted by POST /api/query/stream (Server-Sent Events, one JSON object per `data:` line).
 * The model's private reasoning is never streamed (Audit I-10); progress is shown through `stage` events.
 */
export type StreamEvent =
  | { type: "stage"; id?: string; stage?: string; title: string; status: "active" | "running" | "done"; detail: string; duration_ms: number }
  | { type: "sources"; citations: CitationItem[] }
  | { type: "answer"; delta: string }
  | {
      type: "done";
      answer: string;
      structured_data: StructuredData | null;
      thinking_trace: ThinkingStage[];
      citations: CitationItem[];
      grounded: boolean;
      total_latency_ms: number;
    }
  | { type: "error"; message: string };

/**
 * Stream a RAG answer: pipeline stages, sources and answer tokens arrive as they are produced.
 * Resolves when the stream ends; abort with the signal to stop generation.
 */
export async function streamQuery(
  params: { question: string; entityId?: string; history?: HistoryTurn[]; mode?: "text" | "voice" },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/query/stream`, {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
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
    throw await toApiError(res);
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

export type PrivacyMode = "local" | "cloud" | "unknown";

/**
 * The backend's privacy mode from /api/health (Audit I-09/I-26). Anything but an explicit "cloud"
 * answer, including an unreachable API, is reported as "local" or "unknown" so callers fail closed.
 */
export interface HealthPolicy {
  privacyMode: PrivacyMode;
  allowBrowserSpeech: boolean;
}

export async function fetchHealthPolicy(signal?: AbortSignal): Promise<HealthPolicy> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/health`, { signal });
    if (!res.ok) return { privacyMode: "unknown", allowBrowserSpeech: false };
    const data = await res.json();
    const mode: PrivacyMode = data.privacy_mode === "cloud" ? "cloud" : data.privacy_mode === "local" ? "local" : "unknown";
    return { privacyMode: mode, allowBrowserSpeech: data.allow_browser_speech ?? true };
  } catch {
    return { privacyMode: "unknown", allowBrowserSpeech: false };
  }
}

export async function fetchPrivacyMode(signal?: AbortSignal): Promise<PrivacyMode> {
  const policy = await fetchHealthPolicy(signal);
  return policy.privacyMode;
}

/** Server-side speech-to-text (local faster-whisper; Groq Whisper first in cloud mode). */
export async function transcribeAudio(audioBlob: Blob, signal?: AbortSignal): Promise<string> {
  const formData = new FormData();
  const ext = audioBlob.type.includes("mp4") ? "m4a" : audioBlob.type.includes("ogg") ? "ogg" : "webm";
  formData.append("file", audioBlob, `utterance.${ext}`);
  const res = await fetch(`${API_BASE_URL}/api/voice/transcribe`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: formData,
    signal,
  });
  if (!res.ok) {
    throw await toApiError(res);
  }
  const data = await res.json();
  return (data.transcript || "").trim();
}

/** Server-side text-to-speech (on-device engine; edge-tts en-AU in cloud mode). Returns playable audio. */
export async function synthesizeSpeech(text: string, signal?: AbortSignal, voice?: string): Promise<Blob> {
  const res = await fetch(`${API_BASE_URL}/api/voice/synthesize`, {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text, voice }),
    signal,
  });
  if (!res.ok) {
    throw await toApiError(res);
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
    headers: getAuthHeaders(),
    body: formData,
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  return await res.json();
}

export interface UploadDocumentResult {
  message: string;
  document: DocumentRecord;
  total_chunks?: number;
  total_vectors_indexed?: number;
}

export interface BatchUploadResult {
  message: string;
  total_files: number;
  successful_files: number;
  documents: DocumentRecord[];
  errors: string[];
}

/**
 * Upload and index a financial document into the configured vector index.
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
    headers: getAuthHeaders(),
    body: formData,
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  return await res.json();
}

/**
 * Batch upload multiple financial documents (up to 100 MB per file).
 */
export async function uploadDocumentsBatch(
  files: File[],
  entityId: string = "default_family",
  allowedRole: string = "family_member"
): Promise<BatchUploadResult> {
  const formData = new FormData();
  for (const f of files) {
    formData.append("files", f);
  }
  formData.append("family_entity_id", entityId);
  formData.append("allowed_role", allowedRole);

  const res = await fetch(`${API_BASE_URL}/api/documents/upload-batch`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: formData,
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  return await res.json();
}

/**
 * Batch upload with byte-level progress and cancellation (fetch cannot report upload progress).
 * Cancelling stops the transfer; files the server already finished receiving may still be indexed.
 */
export function uploadDocumentsWithProgress(
  files: File[],
  entityId: string,
  allowedRole: string,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<BatchUploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    form.append("family_entity_id", entityId);
    form.append("allowed_role", allowedRole);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/documents/upload-batch`);
    for (const [k, v] of Object.entries(getAuthHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON body */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as BatchUploadResult);
      else reject(new ApiError(xhr.status, typeof body?.detail === "string" ? body.detail : ""));
    };
    xhr.onerror = () => reject(new ApiError(0, ""));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    if (opts.signal) {
      if (opts.signal.aborted) return xhr.abort();
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

/** Build a dashboard (KPI tiles + charts computed from the user's indexed tables) for a question. */
export async function createDashboard(params: { question: string; answer?: string; entityId?: string }): Promise<Dashboard> {
  const res = await fetch(`${API_BASE_URL}/api/dashboards`, {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      question: params.question,
      answer: (params.answer || "").slice(0, 8000),
      family_entity_id: params.entityId || "default_family",
    }),
  });
  if (!res.ok) {
    throw await toApiError(res);
  }
  return await res.json();
}

/**
 * Delete a document and its indexed vectors across all storage tiers.
 */
export async function deleteDocument(documentId: string): Promise<{ message: string; document_id: string }> {
  const res = await fetch(`${API_BASE_URL}/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  return await res.json();
}

/**
 * Fetch sovereign audit trail events for an entity (or admin entities).
 */
export async function fetchAuditEvents(entityId?: string, signal?: AbortSignal): Promise<AuditEvent[]> {
  const url = entityId
    ? `${API_BASE_URL}/api/auth/audit?family_entity_id=${encodeURIComponent(entityId)}`
    : `${API_BASE_URL}/api/auth/audit`;
  const res = await fetch(url, { headers: getAuthHeaders(), signal });
  if (!res.ok) throw await toApiError(res);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Create a single-use expiring invite token for a new family member or read-only adviser.
 */
export async function createInvite(params: {
  family_entity_id: string;
  role: "family_member" | "read_only_adviser";
  expires_in_hours?: number;
}): Promise<UserInvite> {
  const res = await fetch(`${API_BASE_URL}/api/auth/invites`, {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      family_entity_id: params.family_entity_id,
      role: params.role,
      expires_in_hours: params.expires_in_hours ?? 72,
    }),
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  return await res.json();
}

/**
 * Retrieve active provider configuration (family_admin only).
 */
export async function fetchProvidersInfo(): Promise<any> {
  const res = await fetch(`${API_BASE_URL}/api/providers`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    throw await toApiError(res);
  }
  return await res.json();
}

