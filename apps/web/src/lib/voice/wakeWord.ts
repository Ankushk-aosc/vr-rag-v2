/**
 * Wake-word detection and acoustic activation cues for Aether.
 * Supports natural invocations:
 *   "Hey Aether", "Hi Aether", "Hello Aether", "OK Aether", "Aether"
 * Also matches phonetic variations common in browser SpeechRecognition:
 *   "ether", "ather", "ayther", "eather"
 *   "heather", "either" (only when preceded by a greeting prefix like "hey/hi")
 */

export interface WakeWordMatch {
  matched: boolean;
  wakePhrase: string;
  query: string;
}

/**
 * Regex matching wake word at the start of a transcript or following punctuation/filler words.
 */
const GREETING_PATTERN = /^(hey|hi|hello|ok|okay|yo|he)(?:[\s,.:;!?-]+(.*)|$)/i;

const WAKE_PATTERN =
  /(?:^|[\s,.:;!?-]+)(?:(hey|hi|hello|ok|okay|yo|he|ha|hai)[\s,.:;!?-]+)?(aether|ether|ather|ayther|eather|heather|either|author|whether|weather|feather|there|other|edha|eda|eva|ava|et|at|actor|editor|edgar|e|ai|a)(?:[\s,.:;!?-]+(.*)|$)/i;

/**
 * Common English words that can be phonetically similar but must be preceded by a greeting
 * ("hey", "hi", etc.) so we never trigger accidentally on general room conversation.
 */
const WORDS_REQUIRING_PREFIX = new Set([
  "either",
  "whether",
  "weather",
  "heather",
  "feather",
  "author",
  "there",
  "other",
  "eva",
  "ava",
  "eda",
  "edha",
  "et",
  "at",
  "actor",
  "editor",
  "edgar",
  "e",
  "ai",
  "a",
]);

/**
 * Analyze a spoken transcript for the Aether wake word or conversational greeting.
 * Returns whether it matched, the exact wake phrase, and any trailing query.
 */
export function matchWakeWord(raw: string): WakeWordMatch {
  if (!raw || typeof raw !== "string") {
    return { matched: false, wakePhrase: "", query: "" };
  }

  const text = raw.trim();

  // 1. Explicit wake word / phonetic variations ("Hey Aether", "Hey e", "he ET", "Hi Aether", "Aether")
  const match = text.match(WAKE_PATTERN);
  if (match) {
    const prefix = (match[1] || "").trim();
    const name = (match[2] || "").trim();
    const remainder = match[3] || "";

    const nameLower = name.toLowerCase();

    // Safety filter: common words must be preceded by a greeting
    if (!WORDS_REQUIRING_PREFIX.has(nameLower) || prefix) {
      const wakePhrase = prefix ? `${prefix} ${name}` : name;
      const query = remainder
        .replace(/^[\s,.:;!?-]+/, "")
        .replace(/[\s,.:;!?-]+$/, "")
        .trim();

      return {
        matched: true,
        wakePhrase,
        query,
      };
    }
  }

  // 2. Direct conversational greeting ("Hey", "Hi", "Hello" or "Hey can you...")
  const gMatch = text.match(GREETING_PATTERN);
  if (gMatch) {
    const greeting = (gMatch[1] || "").trim().toLowerCase();
    const remainder = (gMatch[2] || "").trim();
    if (greeting !== "he") {
      return {
        matched: true,
        wakePhrase: greeting,
        query: remainder.replace(/^[\s,.:;!?-]+/, "").replace(/[\s,.:;!?-]+$/, "").trim(),
      };
    }
  }

  return { matched: false, wakePhrase: "", query: "" };
}

/**
 * Strips the wake word prefix from text if present, returning the clean query.
 */
export function stripWakeWord(text: string): string {
  const res = matchWakeWord(text);
  return res.matched ? res.query : text.trim();
}

/**
 * Synthesizes a futuristic, crystalline 3-note ascending activation chime
 * directly using the Web Audio API. Requires zero external audio assets.
 */
export function playWakeChime(ctx: AudioContext): void {
  try {
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = "sine";
    osc2.type = "triangle";

    // Pleasant sci-fi ascending chord: E5 (659.25Hz) -> A5 (880Hz) -> C#6 (1108.73Hz)
    osc1.frequency.setValueAtTime(659.25, now);
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.08);
    osc1.frequency.exponentialRampToValueAtTime(1108.73, now + 0.16);

    osc2.frequency.setValueAtTime(440, now);
    osc2.frequency.exponentialRampToValueAtTime(880, now + 0.16);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.03);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.16);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now + 0.03);
    osc1.stop(now + 0.45);
    osc2.stop(now + 0.45);
  } catch {
    /* ignore audio error if context closed */
  }
}
