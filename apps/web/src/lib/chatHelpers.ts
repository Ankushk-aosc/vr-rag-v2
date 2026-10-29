import { ChatMessage, CitationItem, DocumentRecord, HistoryTurn } from "../types";

export const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const HISTORY_MESSAGES = 6;

export function buildHistory(messages: ChatMessage[]): HistoryTurn[] {
  return messages
    .filter((m) => (m.sender === "user" || m.sender === "assistant") && m.content && !m.streaming)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.sender === "user" ? "user" : "assistant", content: m.content }));
}

export function docCitation(doc: DocumentRecord): CitationItem {
  const ext = doc.original_name.split(".").pop()?.toUpperCase() || "FILE";
  return {
    chunk_id: doc.file_hash,
    document_id: doc.id,
    document_name: doc.original_name,
    page_number: 1,
    is_table: /\.(xlsx|xls|csv)$/i.test(doc.original_name),
    snippet:
      `${ext} document • ${doc.total_pages} page(s) • ${(doc.file_size / 1024).toFixed(1)} KB\n` +
      `Status: ${doc.status} • Uploaded: ${doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleString() : "unknown"}\n` +
      `SHA-256: ${doc.file_hash}\n\nAsk a question to retrieve cited passages from this document.`,
  };
}

