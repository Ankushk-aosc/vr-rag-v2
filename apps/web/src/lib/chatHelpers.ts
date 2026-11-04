import { ChatMessage, HistoryTurn } from "../types";

export const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const HISTORY_MESSAGES = 6;

export function buildHistory(messages: ChatMessage[]): HistoryTurn[] {
  return messages
    .filter((m) => (m.sender === "user" || m.sender === "assistant") && m.content && !m.streaming)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.sender === "user" ? "user" : "assistant", content: m.content }));
}
