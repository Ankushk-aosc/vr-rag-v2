/**
 * Voice diagnostics: every important voice event (phase changes, which recogniser was used,
 * transcripts, TTS failures, why speech was stopped) is batched to the API's log, so a failure in
 * a real browser can be diagnosed from the server log. Event names and short text only - no audio.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface VoiceEvent {
  t: number;
  event: string;
  [key: string]: unknown;
}

const buffer: VoiceEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  if (!buffer.length) return;
  const events = buffer.splice(0, buffer.length);
  fetch(`${API_BASE_URL}/api/voice/client-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events, userAgent: navigator.userAgent.slice(0, 160) }),
  }).catch(() => {
    /* logging must never break voice */
  });
}

export function vlog(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  const entry: VoiceEvent = { t: Math.round(performance.now()), event, ...data };
  if (process.env.NODE_ENV !== "production") console.debug("[voice]", event, data);
  buffer.push(entry);
  if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
  if (!timer) timer = setTimeout(flush, 1500);
}
