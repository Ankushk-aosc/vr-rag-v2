import { Platform } from "react-native";
import { AuthSession, DocumentRecord, QueryResponse, VoiceQueryResponse } from "../types";

// Default backend host (configured via EXPO_PUBLIC_API_URL or platform standard localhost)
const DEFAULT_HOST =
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "android" ? "http://10.0.2.2:8000" : "http://localhost:8000");
let activeBaseUrl = DEFAULT_HOST;
// The JWT lives in memory only (Audit I-12): nothing is written to device storage, so closing the app
// signs the user out. Tokens expire after 24 h server-side.
let activeAuthToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

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

/** Called once when any request comes back 401 (expired, revoked or missing token). */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

/** Throws the API's error detail for non-2xx responses; a 401 also ends the session. */
async function ensureOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  const err = await res.json().catch(() => ({}));
  if (res.status === 401) {
    activeAuthToken = null;
    unauthorizedHandler?.();
    throw new Error("Your session has ended. Please sign in again.");
  }
  const detail = typeof err.detail === "string" ? err.detail : err.detail?.error;
  throw new Error(detail || fallback);
}

export function getAuthHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers = { ...extraHeaders };
  if (activeAuthToken) {
    headers["Authorization"] = `Bearer ${activeAuthToken}`;
  }
  return headers;
}

export async function loginUser(email: string, password: string): Promise<AuthSession> {
  let res: Response;
  try {
    res = await fetch(`${activeBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
    });
  } catch {
    throw new Error(`Cannot reach the server at ${activeBaseUrl}. Check EXPO_PUBLIC_API_URL and your network.`);
  }
  if (!res.ok) {
    // A 401 here means wrong credentials, not an expired session, so don't route through ensureOk
    const err = await res.json().catch(() => ({}));
    throw new Error((typeof err.detail === "string" && err.detail) || "Sign-in failed.");
  }
  const data: AuthSession = await res.json();
  if (!data.access_token || !data.user?.memberships?.length) {
    throw new Error("This account has no family office memberships.");
  }
  setAuthToken(data.access_token);
  return data;
}

/** Revokes the token server-side (best effort), then forgets it locally. */
export async function logoutUser(): Promise<void> {
  const headers = getAuthHeaders();
  activeAuthToken = null;
  if (!headers["Authorization"]) return;
  try {
    await fetch(`${activeBaseUrl}/api/auth/logout`, { method: "POST", headers });
  } catch {
    /* offline: the token still expires server-side */
  }
}

export async function fetchDocuments(entityId?: string): Promise<DocumentRecord[]> {
  try {
    const url = entityId
      ? `${activeBaseUrl}/api/documents?family_entity_id=${encodeURIComponent(entityId)}`
      : `${activeBaseUrl}/api/documents`;
    const res = await fetch(url, {
      headers: getAuthHeaders(),
    });
    await ensureOk(res, `HTTP ${res.status}: Failed to fetch documents`);
    const data = await res.json();
    return Array.isArray(data) ? data : (data.documents || []);
  } catch (err) {
    console.warn("fetchDocuments network error:", err);
    return [];
  }
}

export async function queryAssistant(
  question: string,
  entityId: string
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

  await ensureOk(res, "Query failed");

  return await res.json();
}

export async function voiceAskAssistant(
  audioUri: string,
  entityId: string
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

  await ensureOk(res, "Voice request failed");

  return await res.json();
}

export async function uploadDocument(
  fileUri: string,
  fileName: string,
  mimeType: string,
  entityId: string,
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

  await ensureOk(res, "Upload failed");

  return await res.json();
}

export async function deleteDocument(documentId: string): Promise<{ message: string; document_id: string }> {
  const res = await fetch(`${activeBaseUrl}/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });

  await ensureOk(res, "Document deletion failed");

  return await res.json();
}
