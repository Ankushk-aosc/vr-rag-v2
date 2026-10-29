import { Platform } from "react-native";
import { DocumentRecord, QueryResponse, VoiceQueryResponse } from "../types";

// Default backend host (configured via EXPO_PUBLIC_API_URL or platform standard localhost)
const DEFAULT_HOST =
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "android" ? "http://10.0.2.2:8000" : "http://localhost:8000");
let activeBaseUrl = DEFAULT_HOST;
let activeAuthToken: string | null = null;

export function getBaseUrl(): string {
  return activeBaseUrl;
}

export function setBaseUrl(url: string) {
  activeBaseUrl = url.replace(/\/+$/, "");
}

export function setAuthToken(token: string | null) {
  activeAuthToken = token;
}

export function getAuthToken(): string | null {
  return activeAuthToken;
}

export function getAuthHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers = { ...extraHeaders };
  if (activeAuthToken) {
    headers["Authorization"] = `Bearer ${activeAuthToken}`;
  }
  return headers;
}

export async function loginUser(email: string, password: string): Promise<any> {
  const res = await fetch(`${activeBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Login failed");
  }
  const data = await res.json();
  setAuthToken(data.access_token);
  return data;
}

export async function fetchDocuments(entityId?: string): Promise<DocumentRecord[]> {
  try {
    const url = entityId
      ? `${activeBaseUrl}/api/documents?family_entity_id=${encodeURIComponent(entityId)}`
      : `${activeBaseUrl}/api/documents`;
    const res = await fetch(url, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch documents`);
    const data = await res.json();
    return Array.isArray(data) ? data : (data.documents || []);
  } catch (err) {
    console.warn("fetchDocuments network error:", err);
    return [];
  }
}

export async function queryAssistant(
  question: string,
  entityId: string = "default_family"
): Promise<QueryResponse> {
  const res = await fetch(`${activeBaseUrl}/api/query`, {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      question,
      family_entity_id: entityId,
      top_k: 5,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Query failed");
  }

  return await res.json();
}

export async function voiceAskAssistant(
  audioUri: string,
  entityId: string = "default_family"
): Promise<VoiceQueryResponse> {
  const formData = new FormData();
  
  // Format for React Native fetch upload
  formData.append("file", {
    uri: audioUri,
    type: "audio/m4a",
    name: "voice_query.m4a",
  } as unknown as Blob);

  formData.append("family_entity_id", entityId);

  const res = await fetch(`${activeBaseUrl}/api/voice/ask`, {
    method: "POST",
    body: formData,
    headers: getAuthHeaders({
      "Content-Type": "multipart/form-data",
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Voice request failed");
  }

  return await res.json();
}

export async function uploadDocument(
  fileUri: string,
  fileName: string,
  mimeType: string,
  entityId: string = "default_family",
  allowedRole: string = "family_member"
): Promise<{ message: string; document: DocumentRecord }> {
  const formData = new FormData();

  formData.append("file", {
    uri: fileUri,
    type: mimeType || "application/pdf",
    name: fileName,
  } as unknown as Blob);

  formData.append("family_entity_id", entityId);
  formData.append("allowed_role", allowedRole);

  const res = await fetch(`${activeBaseUrl}/api/documents/upload`, {
    method: "POST",
    body: formData,
    headers: getAuthHeaders({
      "Content-Type": "multipart/form-data",
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Upload failed");
  }

  return await res.json();
}

export async function deleteDocument(documentId: string): Promise<{ message: string; document_id: string }> {
  const res = await fetch(`${activeBaseUrl}/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Document deletion failed");
  }

  return await res.json();
}
