/**
 * Voice diagnostics: every important voice event (phase changes, which recogniser was used,
 * TTS failures, why speech was stopped) is batched to the API's log, so a failure in a real browser
 * can be diagnosed from the server log. Event names and metadata only - no audio, and transcript
 * text is reduced to its length before it leaves this module.
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
  const token = typeof window !== "undefined" ? localStorage.getItem("aether_auth_token") : null;
  if (!token) {
    // Drop diagnostics before authentication to prevent 401 request spam
    buffer.length = 0;
    return;
  }
  const events = buffer.splice(0, buffer.length);
  fetch(`${API_BASE_URL}/api/voice/client-log`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ events, userAgent: navigator.userAgent.slice(0, 160) }),
  }).catch(() => {
    /* logging must never break voice */
  });
}

/** Fields that can carry what the user said; only their length is ever logged or sent. */
const PRIVATE_TEXT_KEYS = new Set(["text", "transcript", "query", "interim", "heard", "utterance", "final"]);

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = PRIVATE_TEXT_KEYS.has(k) && typeof v === "string" ? `[${v.length} chars]` : v;
  }
  return out;
}

export function vlog(event: string, raw: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  const data = redact(raw);
  const entry: VoiceEvent = { t: Math.round(performance.now()), event, ...data };
  if (process.env.NODE_ENV !== "production") console.debug("[voice]", event, data);
  buffer.push(entry);
  if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
  if (!timer) timer = setTimeout(flush, 1500);
}
