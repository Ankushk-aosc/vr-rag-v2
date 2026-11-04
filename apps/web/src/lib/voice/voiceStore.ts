import { useSyncExternalStore } from "react";
import type { VoicePhase } from "../../types";

export interface VoiceSnapshot {
  phase: VoicePhase;
  /** Continuous hands-free conversation (re-opens the mic after each answer). */
  conversation: boolean;
  /** Live words recognised so far in the current utterance. */
  interim: string;
  error: string | null;
  sttEngine: "browser" | "server" | null;
  /** True while a standalone "read aloud" is playing outside a conversation. */
  readingAloud: boolean;
  /** Talking over the assistant interrupts it (off by default on laptop speakers, on with headphones). */
  bargeIn: boolean;
  /** Which speech-to-text to use: browser recogniser with Whisper fallback, or Whisper only. */
  sttMode: "auto" | "server";
  /** Always-on microphone listening passively for wake word ("Hey Aether" / "Hi Aether"). */
  wakeWordEnabled: boolean;
  /** True when the microphone is active in passive standby waiting for wake word. */
  standby: boolean;
  /** True briefly when "Hey Aether" or "Hi Aether" has just been heard. */
  wakeWordDetected: boolean;
  /**
   * Backend privacy mode (Audit I-26). Browser speech services that can send audio or text to a cloud
   * (Chrome SpeechRecognition → Google, remote speechSynthesis voices) are used only when this is "cloud".
   */
  privacyMode: "local" | "cloud" | "unknown";
  /** Explicit client-side opt-in allowing browser SpeechRecognition even in local privacy mode. */
  serverAllowsBrowserSpeech: boolean;
  browserSpeechOptIn: boolean;
  /** Transient status/fallback message displayed in voice HUD (e.g. "Switching to Whisper..."). */
  statusText?: string;
}

function getInitialBrowserSpeechOptIn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const s = JSON.parse(window.localStorage.getItem("aether_voice_settings_v1") || "{}");
    return !!s.browserSpeechOptIn;
  } catch {
    return false;
  }
}

const initial: VoiceSnapshot = {
  phase: "idle",
  conversation: false,
  interim: "",
  error: null,
  sttEngine: null,
  readingAloud: false,
  bargeIn: false,
  sttMode: "auto",
  wakeWordEnabled: true,
  standby: false,
  wakeWordDetected: false,
  privacyMode: "unknown",
  serverAllowsBrowserSpeech: true,
  browserSpeechOptIn: getInitialBrowserSpeechOptIn(),
  statusText: "",
};

/** Fail closed: cloud browser speech only after the API has confirmed PRIVACY_MODE=cloud. */
export function cloudSpeechAllowed(): boolean {
  return snapshot.privacyMode === "cloud";
}

/**
 * Browser SpeechRecognition may send audio to the browser vendor's speech service, so it is used only
 * after the user explicitly opts in, and never when the server forbids it. Whisper is the default.
 */
export function canUseBrowserSpeech(): boolean {
  if (snapshot.serverAllowsBrowserSpeech === false) return false;
  return snapshot.browserSpeechOptIn;
}

let snapshot: VoiceSnapshot = initial;
const listeners = new Set<() => void>();

export const voiceStore = {
  get: (): VoiceSnapshot => snapshot,
  set(partial: Partial<VoiceSnapshot>) {
    const next = { ...snapshot, ...partial };
    const changed = (Object.keys(partial) as (keyof VoiceSnapshot)[]).some((k) => next[k] !== snapshot[k]);
    if (!changed) return;
    snapshot = next;
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/**
 * Audio levels (0..1) mutated ~30x per second by the voice engine and read directly by
 * render loops (3D orb, waveform bars). Kept outside React state so it never triggers re-renders.
 */
export const liveLevels = { mic: 0, output: 0 };

export function useVoiceSnapshot(): VoiceSnapshot {
  return useSyncExternalStore(voiceStore.subscribe, voiceStore.get, () => initial);
}
