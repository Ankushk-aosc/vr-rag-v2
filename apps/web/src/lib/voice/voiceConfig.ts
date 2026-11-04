/** Voice engine constants and persisted settings (split from VoiceEngine.ts, Audit I-22). */
import { cloudSpeechAllowed, canUseBrowserSpeech, voiceStore } from "./voiceStore";

export type SpeechRecognitionCtor = new () => any;

export const DEFAULT_LOCALE = "en-AU";

export const TICK_MS = 33;
export const MAX_UTTERANCE_MS = 30000;
export const NO_SPEECH_RESTART_MS = 15000;
/** Silence after the recogniser's last words that ends the turn even if the VAD still hears noise. */
export const RECOGNISER_QUIET_MS = 1600;
export const BARGE_IN_HOLD_MS = 450;
export const BARGE_IN_GRACE_MS = 800;
export const BARGE_IN_MIN_RMS = 0.06;
export const TTS_PREFETCH = 2;
export const TTS_TIMEOUT_MS = 12000;
export const SETTINGS_KEY = "aether_voice_settings_v1";

export function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const browserSpeechOptIn = voiceStore.get().browserSpeechOptIn;
  // Browser recognition gated by cloud mode or explicit client-side opt-in
  if (!canUseBrowserSpeech()) {
    return null;
  }
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export interface QueuedSpeech {
  text: string;
  /** Started lazily, at most TTS_PREFETCH sentences ahead of playback. */
  audio: Promise<AudioBuffer | null> | null;
}

export interface StoredSettings {
  bargeIn?: boolean;
  sttMode?: "auto" | "server";
  wakeWordEnabled?: boolean;
  browserSpeechOptIn?: boolean;
}

export function readSettings(): StoredSettings {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function writeSettings(s: StoredSettings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked */
  }
}
