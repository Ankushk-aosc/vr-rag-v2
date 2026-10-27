import { useSyncExternalStore } from "react";
import { VoicePhase } from "../../types";

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
};

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
