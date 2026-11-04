/**
 * Push-to-talk dictation: click to record, click to stop, the transcript is returned for the user to
 * edit before sending. Nothing is submitted automatically.
 *
 * Capture is explicit and bounded: the microphone is requested only from a user action, one recording
 * at a time, tracks are always stopped afterwards, the format is negotiated with
 * MediaRecorder.isTypeSupported, and the recording is validated (non-empty, sensible length, real
 * MIME type) before it is sent to POST /api/voice/transcribe. Diagnostics carry format, size and
 * duration only, never audio or words.
 */
import { ApiError } from "../apiErrors";

export type DictationState = "ready" | "requesting" | "recording" | "processing" | "transcribing" | "error" | "completed";

export const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
export const MIN_RECORDING_MS = 400;
export const MAX_RECORDING_MS = 120_000;

type RecorderCtor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported?: (type: string) => boolean;
};

export interface DictationDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder?: RecorderCtor;
  transcribe: (blob: Blob, signal: AbortSignal) => Promise<string>;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface DictationSnapshot {
  state: DictationState;
  message: string | null;
  transcript: string;
  startedAt: number | null;
}

/** First preferred type the browser supports; "" lets the browser choose; null means none will work. */
export function pickMimeType(Rec: RecorderCtor | undefined): string | null {
  if (!Rec) return null;
  if (typeof Rec.isTypeSupported !== "function") return "";
  return PREFERRED_MIME_TYPES.find((t) => Rec.isTypeSupported!(t)) ?? "";
}

export function describeMicError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Microphone access is blocked. Please allow microphone access in your browser settings and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Connect a microphone or check your system sound settings, then try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The microphone is in use by another application. Close it and try again.";
  }
  return "The microphone could not be started. Please try again.";
}

export function describeTranscribeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Your session has ended. Please sign in again to use voice input.";
    if (err.status === 403) return "Voice input is not available for your account.";
    if (err.status === 413) return "That recording is too long. Please keep it under two minutes.";
    if (err.status === 400 && err.message) return err.message;
    if (err.status === 429) return "Too many voice requests. Please wait a moment and try again.";
  }
  return "We couldn't transcribe that recording. The speech service is temporarily unavailable; please try again or type your question.";
}

/** Returns a user-facing problem with the recording, or null when it is fit to send. */
export function validateRecording(blob: Blob | null | undefined, durationMs: number): string | null {
  if (!blob || blob.size === 0) return "Nothing was recorded. Check that your microphone is not muted and try again.";
  if (durationMs < MIN_RECORDING_MS) return "That recording was too short. Hold on a moment longer before stopping.";
  if (durationMs > MAX_RECORDING_MS + 5_000) return "That recording is too long. Please keep it under two minutes.";
  if (!/^audio\/[a-z0-9.+-]+/i.test(blob.type || "")) return "The browser produced an unsupported audio format.";
  return null;
}

export class Dictation {
  private snap: DictationSnapshot = { state: "ready", message: null, transcript: "", startedAt: null };
  private listeners = new Set<(s: DictationSnapshot) => void>();
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = "";
  private abort: AbortController | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private deps: DictationDeps;

  constructor(deps: DictationDeps) {
    this.deps = deps;
  }

  get snapshot(): DictationSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: DictationSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(partial: Partial<DictationSnapshot>) {
    this.snap = { ...this.snap, ...partial };
    this.listeners.forEach((fn) => fn(this.snap));
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  get busy(): boolean {
    return ["requesting", "recording", "processing", "transcribing"].includes(this.snap.state);
  }

  /** Must be called from a user action (click). Returns false if a recording is already in progress. */
  async start(): Promise<boolean> {
    if (this.busy) return false;
    const gum =
      this.deps.getUserMedia ??
      (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia
        ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        : undefined);
    const Rec = this.deps.MediaRecorder ?? (typeof MediaRecorder !== "undefined" ? (MediaRecorder as RecorderCtor) : undefined);
    if (!gum || !Rec) {
      this.set({
        state: "error",
        message: !gum
          ? "Microphone access needs a secure connection (https or localhost) and a supported browser."
          : "Voice recording is not supported in this browser. Please type your question instead.",
      });
      return false;
    }
    const mime = pickMimeType(Rec);
    if (mime === null) {
      this.set({ state: "error", message: "Voice recording is not supported in this browser. Please type your question instead." });
      return false;
    }
    this.cancelled = false;
    this.set({ state: "requesting", message: "Requesting microphone permission…", transcript: "", startedAt: null });
    try {
      this.stream = await gum({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (err) {
      this.deps.log?.("dictation-mic-error", { name: (err as { name?: string })?.name ?? "unknown" });
      this.set({ state: "error", message: describeMicError(err) });
      return false;
    }
    if (this.cancelled) {
      this.release();
      this.set({ state: "ready", message: null });
      return false;
    }
    try {
      this.recorder = new Rec(this.stream, mime ? { mimeType: mime } : undefined);
    } catch {
      this.release();
      this.set({ state: "error", message: "Voice recording is not supported in this browser. Please type your question instead." });
      return false;
    }
    this.mime = this.recorder.mimeType || mime || "";
    this.chunks = [];
    this.recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    this.limitTimer = setTimeout(() => void this.stop(), MAX_RECORDING_MS);
    this.set({ state: "recording", message: null, startedAt: this.now() });
    return true;
  }

  /** Stops recording and transcribes. Resolves to the transcript ("" on failure; see snapshot.message). */
  async stop(): Promise<string> {
    if (this.snap.state !== "recording" || !this.recorder) return "";
    const recorder = this.recorder;
    const durationMs = this.now() - (this.snap.startedAt ?? this.now());
    this.set({ state: "processing", message: "Processing voice…" });
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
    this.release();
    // The Blob is labelled with the format the recorder actually produced
    const blob = new Blob(this.chunks, { type: recorder.mimeType || this.mime || "audio/webm" });
    this.chunks = [];
    this.deps.log?.("dictation-recording", { mimeType: blob.type, bytes: blob.size, durationMs: Math.round(durationMs) });
    const problem = validateRecording(blob, durationMs);
    if (problem) {
      this.set({ state: "error", message: problem });
      return "";
    }
    this.abort = new AbortController();
    this.set({ state: "transcribing", message: "Transcribing…" });
    try {
      const text = (await this.deps.transcribe(blob, this.abort.signal)).replace(/\s+/g, " ").trim();
      if (!text) {
        this.set({ state: "error", message: "No words were recognised. Please try again a little closer to the microphone." });
        return "";
      }
      this.set({ state: "completed", message: null, transcript: text });
      return text;
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        this.set({ state: "ready", message: null });
        return "";
      }
      this.deps.log?.("dictation-transcribe-error", { status: (err as { status?: number })?.status ?? null });
      this.set({ state: "error", message: describeTranscribeError(err) });
      return "";
    } finally {
      this.abort = null;
    }
  }

  /** Abandons the recording or transcription; nothing is sent or kept. */
  cancel(): void {
    this.cancelled = true;
    this.abort?.abort();
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    this.chunks = [];
    this.release();
    this.set({ state: "ready", message: null, startedAt: null });
  }

  /** Clears an error or completed state so a new recording can start. */
  reset(): void {
    if (!this.busy) this.set({ state: "ready", message: null, transcript: "", startedAt: null });
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  private release(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}
