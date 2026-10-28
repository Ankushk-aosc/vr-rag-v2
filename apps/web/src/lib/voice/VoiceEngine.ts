/**
 * Hands-free voice conversation engine (ChatGPT / Claude voice-mode style turn taking):
 *
 *   listening ──(user stops talking)──▶ transcribing ──▶ thinking
 *       ▲                                                   │ answer tokens stream in
 *       └────(playback finished, mic re-opens)── speaking ◀─┘ (sentence-by-sentence TTS)
 *
 * Speech-to-text: the utterance is always recorded. The browser's SpeechRecognition supplies live
 * words (Chrome / Edge / Android); if it returns nothing - it often fails silently when Google's
 * service is blocked or unreachable - the recording is transcribed by Whisper on the API.
 * Text-to-speech: the API's neural en-AU voice, falling back to the browser's speechSynthesis.
 * Barge-in (optional): talking over the assistant stops it - only while its audio is actually
 * playing, and only when the mic level clearly exceeds the assistant's own echo.
 *
 * The audio loop runs on setInterval, not requestAnimationFrame, because window rAF stops firing
 * during immersive WebXR sessions and in background tabs.
 */
import { synthesizeSpeech, transcribeAudio } from "../api";
import { AdaptiveVad, rmsOf } from "../vad";
import { liveLevels, voiceStore } from "./voiceStore";
import { SentenceChunker, toSpeakable } from "./speechText";
import { vlog } from "./voiceLog";
import { matchWakeWord, playWakeChime, stripWakeWord } from "./wakeWord";

export interface VoiceEngineHandlers {
  /** A finished user utterance. The page should run the query and feed the answer back. */
  onUtterance: (text: string) => void;
  /** The user stopped the assistant mid-answer; the page should abort the in-flight answer. */
  onInterrupt?: () => void;
}

type SpeechRecognitionCtor = new () => any;

const TICK_MS = 33;
const MAX_UTTERANCE_MS = 30000;
const NO_SPEECH_RESTART_MS = 15000;
/** Silence after the recogniser's last words that ends the turn even if the VAD still hears noise. */
const RECOGNISER_QUIET_MS = 1600;
const BARGE_IN_HOLD_MS = 450;
const BARGE_IN_GRACE_MS = 800;
const BARGE_IN_MIN_RMS = 0.06;
const TTS_PREFETCH = 2;
const TTS_TIMEOUT_MS = 12000;
const SETTINGS_KEY = "aether_voice_settings_v1";

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

interface QueuedSpeech {
  text: string;
  /** Started lazily, at most TTS_PREFETCH sentences ahead of playback. */
  audio: Promise<AudioBuffer | null> | null;
}

interface StoredSettings {
  bargeIn?: boolean;
  sttMode?: "auto" | "server";
  wakeWordEnabled?: boolean;
}

function readSettings(): StoredSettings {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeSettings(s: StoredSettings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked */
  }
}

export class VoiceEngine {
  private handlers: VoiceEngineHandlers;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private outGain: GainNode | null = null;
  private micBuffer = new Float32Array(1024);
  private outBuffer = new Float32Array(1024);
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private vad = new AdaptiveVad();

  // listening state
  private recognition: any = null;
  private recognitionFailed = false;
  private finalText = "";
  private interimText = "";
  private lastResultAt = 0;
  private recorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private listenStartedAt = 0;
  private heardSpeech = false;
  private finishing = false;
  private standby = false;
  private wakeWordTriggered = false;
  private wakeWordTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastStandbyCheck = 0;

  // speaking state
  private queue: QueuedSpeech[] = [];
  private chunker = new SentenceChunker();
  private responseOpen = false;
  private playing = false;
  /** Assistant audio is audible right now (a buffer is playing or the browser voice is talking). */
  private audible = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private audibleSince = 0;
  private bargeInVoicedMs = 0;
  /** Upper envelope of mic level per unit of assistant output (speaker → mic echo). */
  private echoEnvelope = 0;
  private generation = 0;
  private syntheticLevelUntil = 0;
  private abort: AbortController | null = null;
  /** After repeated API TTS failures, speak with the browser voice instead of retrying each sentence. */
  private serverTtsFailures = 0;
  private settingsExplicit: StoredSettings = {};

  ttsVoice: string | undefined;

  constructor(handlers: VoiceEngineHandlers) {
    this.handlers = handlers;
    if (typeof window !== "undefined") {
      this.settingsExplicit = readSettings();
      voiceStore.set({
        bargeIn: this.settingsExplicit.bargeIn ?? false,
        sttMode: this.settingsExplicit.sttMode ?? "auto",
        wakeWordEnabled: this.settingsExplicit.wakeWordEnabled ?? true,
      });
    }
  }

  get phase() {
    return voiceStore.get().phase;
  }

  get inConversation() {
    return voiceStore.get().conversation;
  }

  get isStandby() {
    return this.standby;
  }

  get wakeWordEnabled() {
    return voiceStore.get().wakeWordEnabled;
  }

  // ------------------------------------------------------------------ settings

  setBargeIn(on: boolean) {
    this.settingsExplicit = { ...this.settingsExplicit, bargeIn: on };
    writeSettings(this.settingsExplicit);
    voiceStore.set({ bargeIn: on });
    vlog("setting", { bargeIn: on });
  }

  setSttMode(mode: "auto" | "server") {
    this.settingsExplicit = { ...this.settingsExplicit, sttMode: mode };
    writeSettings(this.settingsExplicit);
    this.recognitionFailed = false;
    voiceStore.set({ sttMode: mode });
    vlog("setting", { sttMode: mode });
  }

  setWakeWordEnabled(on: boolean) {
    this.settingsExplicit = { ...this.settingsExplicit, wakeWordEnabled: on };
    writeSettings(this.settingsExplicit);
    voiceStore.set({ wakeWordEnabled: on });
    vlog("setting", { wakeWordEnabled: on });
    if (on) {
      if (!this.inConversation && !this.standby) {
        this.startStandby().catch(() => {});
      }
    } else {
      if (this.standby && !this.inConversation) {
        this.endConversation("wake-word-disabled", true);
      }
    }
  }

  /**
   * Voice interruption is only safe when the assistant's audio can't leak back into the mic.
   * Unless the user chose explicitly, enable it when the output device looks like headphones.
   */
  private async detectHeadphones() {
    if (this.settingsExplicit.bargeIn !== undefined) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const out = devices.find((d) => d.kind === "audiooutput" && d.deviceId === "default") ||
        devices.find((d) => d.kind === "audiooutput");
      const headphones = !!out && /head(phone|set)|earphone|earbud|airpod|buds|hands-free/i.test(out.label);
      voiceStore.set({ bargeIn: headphones });
      vlog("output-device", { label: out?.label?.slice(0, 60) || "unknown", bargeIn: headphones });
    } catch {
      /* keep the default (off) */
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Always-on standby microphone mode.
   * Keeps the mic open and listens passively for the wake word ("Hey Aether", "Hi Aether", etc.).
   * Activates only when called by name.
   */
  async startStandby(): Promise<void> {
    if (this.inConversation) return;
    vlog("standby-start", { sttMode: voiceStore.get().sttMode });
    this.standby = true;
    this.recognitionFailed = false;
    voiceStore.set({ standby: true, phase: "idle", error: null });

    // 1. Immediately start passive SpeechRecognition in standby mode
    this.listenStandby();

    // 2. Also prepare microphone stream & AudioContext if browser already granted permission
    try {
      await this.ensureMic();
      this.detectHeadphones();
    } catch (err: any) {
      vlog("standby-audio-deferred", { message: String(err?.message || err).slice(0, 160) });
    }
  }

  /** Unlock suspended AudioContext upon user gesture. */
  async unlockAudio(): Promise<void> {
    try {
      if (this.ctx && this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
    } catch {}
  }

  /** Start a hands-free conversation immediately (e.g. user clicked mic / tapped orb). */
  async startConversation(): Promise<void> {
    if (this.inConversation) return;
    this.standby = false;
    this.recognitionFailed = false;
    this.setPhase("listening");
    voiceStore.set({ conversation: true, standby: false, phase: "listening", error: null, interim: "" });
    vlog("conversation-start", { sttMode: voiceStore.get().sttMode, hasRecognition: !!getRecognitionCtor() });
    try {
      await this.ensureMic();
      this.detectHeadphones();
      this.listen();
    } catch (err: any) {
      const msg =
        err?.name === "NotAllowedError"
          ? "Microphone permission was denied. Click the camera/mic icon in the address bar and allow the microphone."
          : err?.name === "NotFoundError"
          ? "No microphone was found. Plug one in or check your system sound settings."
          : `Microphone unavailable: ${err?.message || err}`;
      vlog("mic-error", { name: err?.name, message: String(err?.message || err).slice(0, 160) });
      voiceStore.set({ error: msg });
      this.endConversation("mic-error", true);
    }
  }

  /**
   * Called when user awakened Aether by name ("Hey Aether" or "Hi Aether") without an inline query.
   * Transitions immediately to active listening.
   */
  startConversationFromWake(): void {
    this.standby = false;
    this.recognitionFailed = false;
    this.setPhase("listening");
    voiceStore.set({ conversation: true, standby: false, phase: "listening", interim: "", error: null });
    this.ensureMic()
      .then(() => {
        this.listen();
      })
      .catch((err) => {
        console.warn("[Aether Voice] Mic error on wake:", err);
      });
  }

  /**
   * Stop active conversation. If wake-word is enabled, seamlessly returns to standby
   * always-on listening rather than completely closing the mic stream.
   */
  endConversation(reason = "user", forceStop = false): void {
    if (this.inConversation) vlog("conversation-end", { reason });
    if (this.wakeWordTimeout) {
      clearTimeout(this.wakeWordTimeout);
      this.wakeWordTimeout = null;
    }
    voiceStore.set({ conversation: false, interim: "", wakeWordDetected: false });
    this.stopListening(true);
    this.stopSpeaking("conversation-end");

    if (this.wakeWordEnabled && !forceStop) {
      this.listenStandby();
      return;
    }

    this.standby = false;
    voiceStore.set({ standby: false, phase: "idle" });
    this.releaseMic();
    this.stopTickingIfIdle();
  }

  toggleConversation(): Promise<void> | void {
    if (this.inConversation) {
      return this.endConversation("toggle");
    }
    return this.startConversation();
  }

  dispose(): void {
    if (this.wakeWordTimeout) clearTimeout(this.wakeWordTimeout);
    this.endConversation("dispose", true);
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.ctx || this.ctx.state === "closed") {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      this.outGain = this.ctx.createGain();
      this.outAnalyser = this.ctx.createAnalyser();
      this.outAnalyser.fftSize = 1024;
      this.outGain.connect(this.outAnalyser);
      this.outAnalyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    this.startTicking();
    return this.ctx;
  }

  private async ensureMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "this page is not on a secure origin. Open it at http://localhost:3000 (or over https) to use the microphone"
      );
    }
    const ctx = await this.ensureAudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (!this.ctx || this.ctx.state === "closed" || ctx.state === "closed") {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    // keep a reference to the source node: an unreferenced node can be garbage-collected
    this.micSource = ctx.createMediaStreamSource(this.stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.micAnalyser.smoothingTimeConstant = 0.2;
    this.micSource.connect(this.micAnalyser);
    const track = this.stream.getAudioTracks()[0];
    vlog("mic-open", { label: track?.label?.slice(0, 60), sampleRate: ctx.sampleRate });
  }

  private releaseMic(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micSource?.disconnect();
    this.stream = null;
    this.micSource = null;
    this.micAnalyser = null;
    liveLevels.mic = 0;
  }

  private startTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTickingIfIdle(): void {
    if (!this.inConversation && !this.playing && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
      liveLevels.mic = 0;
      liveLevels.output = 0;
    }
  }

  private setPhase(phase: ReturnType<typeof voiceStore.get>["phase"]) {
    if (this.phase !== phase) vlog("phase", { phase });
    voiceStore.set({ phase });
  }

  // ------------------------------------------------------------------ audio loop

  private tick(): void {
    const now = performance.now();
    const phase = this.phase;

    // Output level for the orb while the assistant speaks
    let outRms = 0;
    if (this.outAnalyser && this.currentSource) {
      this.outAnalyser.getFloatTimeDomainData(this.outBuffer);
      outRms = rmsOf(this.outBuffer);
      const target = Math.min(1, outRms / 0.16);
      liveLevels.output += (target - liveLevels.output) * (target > liveLevels.output ? 0.6 : 0.2);
    } else if (now < this.syntheticLevelUntil) {
      liveLevels.output = 0.35 + 0.3 * Math.abs(Math.sin(now / 90)) * Math.abs(Math.sin(now / 370));
    } else {
      liveLevels.output *= 0.8;
    }

    if (process.env.NODE_ENV !== "production") {
      (window as any).__voiceOut = liveLevels.output;
      if (!this.micAnalyser) (window as any).__voiceDebug = { phase, playing: this.playing, queued: this.queue.length };
    }
    if (!this.micAnalyser) return;
    this.micAnalyser.getFloatTimeDomainData(this.micBuffer);
    const rms = rmsOf(this.micBuffer);
    const frame = this.vad.update(rms, now);
    liveLevels.mic = phase === "listening" ? frame.level : liveLevels.mic * 0.8;
    if (process.env.NODE_ENV !== "production") {
      (window as any).__voiceDebug = {
        phase,
        rms: +rms.toFixed(4),
        floor: +this.vad.noiseFloor.toFixed(4),
        start: +this.vad.startThreshold.toFixed(4),
        voiced: frame.voiced,
        inUtterance: frame.inUtterance,
        ctx: this.ctx?.state,
        recognition: !!this.recognition,
        recorder: this.recorder?.state,
        words: `${this.finalText} ${this.interimText}`.trim(),
        echo: +this.echoEnvelope.toFixed(3),
      };
    }

    // Standby watchdog: If in standby mode and recognition died for any reason, re-start it!
    if (this.standby && !this.inConversation && !this.finishing && !this.recognition) {
      if (!this.lastStandbyCheck || now - this.lastStandbyCheck > 2000) {
        this.lastStandbyCheck = now;
        const Ctor = getRecognitionCtor();
        if (Ctor) this.startRecognition(Ctor);
      }
    }
    // In standby mode, discard stale transcript fragments after 4 seconds of silence
    if (this.standby && !this.inConversation && (this.finalText || this.interimText) && this.lastResultAt && now - this.lastResultAt > 4000) {
      this.finalText = "";
      this.interimText = "";
    }

    const isListeningTurn = phase === "listening" && !this.finishing;
    if (isListeningTurn) {
      if (frame.inUtterance) this.heardSpeech = true;
      const sinceListen = now - this.listenStartedAt;
      const haveWords = (this.finalText + this.interimText).trim().length > 0;
      const resultQuiet = this.lastResultAt ? now - this.lastResultAt : Infinity;
      // the recogniser's words can lag the audio; while a phrase is still "interim" wait a bit longer
      const pendingInterim = this.interimText.length > 0 && resultQuiet < 700;

      // 1. The VAD heard a complete utterance followed by silence - works for every STT backend.
      if (frame.endOfUtterance && !pendingInterim && (haveWords || this.heardSpeech)) {
        this.finishUtterance("vad-silence");
      }
      // 2. The recogniser has words and has been quiet for a while, even if the VAD still hears
      //    noise (fan, AGC-boosted room) - the recogniser is the better judge of speech.
      else if (haveWords && resultQuiet >= RECOGNISER_QUIET_MS && (!frame.voiced || resultQuiet >= 2600)) {
        this.finishUtterance("recogniser-quiet");
      }
      // 3. Safety limits.
      else if (sinceListen > MAX_UTTERANCE_MS && (haveWords || this.heardSpeech)) {
        this.finishUtterance("max-length");
      }
      else if (!this.heardSpeech && !haveWords && sinceListen > NO_SPEECH_RESTART_MS) {
        this.restartListening();
      }
    }

    // Barge-in: only while the assistant's (measurable) audio is playing, and only when the mic is
    // clearly louder than the assistant's own voice leaking back from the speakers.
    if (phase === "speaking" && this.audible && this.currentSource && voiceStore.get().bargeIn) {
      const sinceAudible = now - this.audibleSince;
      if (outRms > 0.005) {
        const ratio = rms / outRms;
        if (sinceAudible < BARGE_IN_GRACE_MS) {
          // learn how loud the echo gets while the user is (presumably) quiet
          this.echoEnvelope = Math.max(this.echoEnvelope, ratio);
        } else if (ratio < this.echoEnvelope * 1.3) {
          // keep following the echo envelope, decaying slowly
          this.echoEnvelope = Math.max(ratio, this.echoEnvelope * 0.999);
        }
      }
      if (sinceAudible > BARGE_IN_GRACE_MS) {
        const threshold = Math.max(BARGE_IN_MIN_RMS, this.vad.noiseFloor * 6, this.echoEnvelope * outRms * 2);
        const loud = rms > threshold;
        this.bargeInVoicedMs = loud ? this.bargeInVoicedMs + TICK_MS : Math.max(0, this.bargeInVoicedMs - TICK_MS);
        if (this.bargeInVoicedMs >= BARGE_IN_HOLD_MS) {
          vlog("barge-in", { rms: +rms.toFixed(3), threshold: +threshold.toFixed(3), outRms: +outRms.toFixed(3) });
          this.bargeInVoicedMs = 0;
          this.interrupt("barge-in");
        }
      }
    }
  }

  // ------------------------------------------------------------------ listening

  /**
   * Passive standby listening loop.
   * Keeps the mic open and runs speech recognition to detect the wake word.
   */
  listenStandby(): void {
    this.vad.reset();
    this.finalText = "";
    this.interimText = "";
    this.lastResultAt = 0;
    this.heardSpeech = false;
    this.finishing = false;
    this.wakeWordTriggered = false;
    this.standby = true;
    this.recognitionFailed = false;
    this.listenStartedAt = performance.now();
    this.setPhase("idle");
    voiceStore.set({ standby: true, conversation: false, interim: "", phase: "idle" });

    // Standby mode requires SpeechRecognition to detect the wake word.
    const Ctor = getRecognitionCtor();
    if (Ctor && !this.recognition) {
      this.startRecognition(Ctor);
    }
    voiceStore.set({ sttEngine: this.recognition ? "browser" : "server" });
  }

  private listen(): void {
    if (!this.inConversation) return;
    this.standby = false;
    this.vad.reset();
    this.finalText = "";
    this.interimText = "";
    this.lastResultAt = 0;
    this.heardSpeech = false;
    this.finishing = false;
    this.wakeWordTriggered = false;
    this.listenStartedAt = performance.now();
    voiceStore.set({ interim: "", standby: false });
    this.setPhase("listening");

    // Always record: if the browser recogniser returns nothing the recording goes to Whisper.
    this.startRecorder();
    const allowBrowser = voiceStore.get().sttMode === "auto" && !this.recognitionFailed;
    const Ctor = allowBrowser ? getRecognitionCtor() : null;
    if (Ctor && !this.recognition) this.startRecognition(Ctor);
    voiceStore.set({ sttEngine: this.recognition ? "browser" : "server" });
  }

  private restartListening(): void {
    if (this.phase === "listening") this.listen();
  }

  private startRecognition(Ctor: SpeechRecognitionCtor): void {
    if (this.recognition) {
      try {
        const old = this.recognition;
        this.recognition = null;
        old.abort();
      } catch {}
    }
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      rec.maxAlternatives = 1;
      rec.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            if (this.standby && !this.inConversation) {
              // In standby mode, keep only the latest speech segment
              this.finalText = piece.trim();
            } else {
              this.finalText = `${this.finalText} ${piece}`.trim();
            }
          } else {
            interim += piece;
          }
        }
        this.interimText = interim.trim();
        this.lastResultAt = performance.now();
        const full = `${this.finalText} ${this.interimText}`.trim();

        if (full) {
          console.log("[Aether Voice Heard]:", full);
        }

        // 1. Passive Standby Mode: Looking for wake word ("Hey Aether", "Hey e", "he ET", "Hi", etc.)
        if (this.standby && !this.inConversation) {
          const match = matchWakeWord(full).matched
            ? matchWakeWord(full)
            : matchWakeWord(this.interimText);
          if (match.matched) {
            console.log("[Aether Wake Word Activated!]:", match.wakePhrase, match.query ? `(query: ${match.query})` : "");
            vlog("wake-word-detected", { phrase: match.wakePhrase, query: match.query });

            // Activate immediately!
            this.standby = false;
            this.wakeWordTriggered = true;
            this.setPhase("listening");
            voiceStore.set({ wakeWordDetected: true, conversation: true, standby: false, phase: "listening", error: null });

            // Play the activation chime
            this.ensureAudioContext()
              .then((ctx) => playWakeChime(ctx))
              .catch(() => {});

            // Prepare recorder and audio analysis
            this.ensureMic().then(() => this.startRecorder()).catch(() => {});

            if (this.wakeWordTimeout) clearTimeout(this.wakeWordTimeout);
            this.wakeWordTimeout = setTimeout(() => {
              voiceStore.set({ wakeWordDetected: false });
            }, 2500);

            // If user already included their query with the wake word:
            if (match.query && match.query.length >= 2) {
              voiceStore.set({ interim: match.query });
              this.stopListening(true);
              this.deliver(match.query, this.generation);
              return;
            }

            // User said wake word alone ("Hey Aether" or "Hi Aether"):
            // Reset transcript buffers so upcoming query is clean, but KEEP recognition active!
            this.finalText = "";
            this.interimText = "";
            this.lastResultAt = performance.now();
            this.listenStartedAt = performance.now();
            this.heardSpeech = false;
            return;
          }
          return;
        }

        // 2. While Speaking: Allow user to interrupt using wake word or greeting
        if (this.phase === "speaking") {
          const match = matchWakeWord(full).matched
            ? matchWakeWord(full)
            : matchWakeWord(this.interimText);
          if (match.matched) {
            console.log("[Aether Interrupted by Wake Word!]:", match.wakePhrase, match.query ? `(query: ${match.query})` : "");
            this.interrupt("wake-word");
            this.ensureAudioContext().then((ctx) => playWakeChime(ctx)).catch(() => {});
            this.finalText = "";
            this.interimText = "";
            this.lastResultAt = performance.now();
            this.listenStartedAt = performance.now();
            this.heardSpeech = false;
            if (match.query && match.query.length >= 2) {
              voiceStore.set({ interim: match.query });
              this.stopListening(true);
              this.deliver(match.query, this.generation);
            }
            return;
          }
        }

        // 3. Active Mode: Clean any wake word prefix so the query to the AI is pure
        const clean = stripWakeWord(full);
        voiceStore.set({ interim: clean });
      };
      rec.onerror = (e: any) => {
        if (e.error === "no-speech" || e.error === "aborted") return;
        vlog("recogniser-error", { error: e.error });
        console.warn("[Aether Voice] Speech recognition error:", e.error);

        if (this.recognition === rec) {
          this.recognition = null;
        }

        // In standby, wake-word mode, or active conversation, auto-recover from transient errors!
        if (this.standby || voiceStore.get().wakeWordEnabled || this.inConversation) {
          setTimeout(() => {
            if ((this.standby || this.phase === "listening") && !this.finishing && !this.recognition) {
              const Ctor = getRecognitionCtor();
              if (Ctor) this.startRecognition(Ctor);
            }
          }, 500);
          return;
        }

        this.recognitionFailed = true;
        voiceStore.set({ sttEngine: "server" });
      };
      rec.onend = () => {
        // Clear instance reference as this instance has ended
        if (this.recognition === rec) {
          this.recognition = null;
        }
        // In Chrome, Web Speech terminates after ~30-60s of silence or utterance end.
        // Always instantiate a FRESH recognizer instance rather than calling start() on an ended instance!
        if ((this.phase === "listening" || this.standby) && !this.finishing) {
          setTimeout(() => {
            if ((this.phase === "listening" || this.standby) && !this.finishing && !this.recognition) {
              const Ctor = getRecognitionCtor();
              if (Ctor) this.startRecognition(Ctor);
            }
          }, 150);
        }
      };
      rec.start();
      this.recognition = rec;
    } catch (err) {
      vlog("recogniser-error", { error: String(err).slice(0, 120) });
      console.warn("[Aether Voice] Recognition start error:", err);
      this.recognition = null;
      if (this.standby || this.phase === "listening") {
        setTimeout(() => {
          if ((this.standby || this.phase === "listening") && !this.recognition && !this.finishing) {
            const C = getRecognitionCtor();
            if (C) this.startRecognition(C);
          }
        }, 1000);
      }
    }
  }

  private startRecorder(): void {
    if (!this.stream) return;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find(
      (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)
    );
    try {
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      vlog("recorder-error", { error: String(err).slice(0, 120) });
      voiceStore.set({ error: `Recording is not supported in this browser: ${err}` });
      return;
    }
    this.recordedChunks = [];
    this.recorder.ondataavailable = (e) => e.data.size > 0 && this.recordedChunks.push(e.data);
    this.recorder.start(250);
  }

  private stopListening(discard: boolean): void {
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try {
        discard ? rec.abort() : rec.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.recorder && discard) {
      const r = this.recorder;
      this.recorder = null;
      r.ondataavailable = null;
      try {
        if (r.state !== "inactive") r.stop();
      } catch {
        /* ignore */
      }
    }
  }

  /** Ends the user's turn immediately (also used by the "send now" button). */
  finishUtterance(reason = "button"): void {
    if ((this.phase !== "listening" && !this.standby) || this.finishing) return;
    this.finishing = true;
    const gen = this.generation;

    const rawText = `${this.finalText} ${this.interimText}`.trim();

    // Standby mode handling:
    if (this.standby && !this.inConversation) {
      const match = matchWakeWord(rawText);
      if (!match.matched && !this.wakeWordTriggered) {
        // Unrelated speech during standby without wake word:
        // Quietly reset and continue standby listening
        this.finishing = false;
        this.stopListening(true);
        this.listenStandby();
        return;
      }

      // Wake word detected!
      const query = match.matched ? match.query : stripWakeWord(rawText);
      if (query.length >= 2) {
        // User asked their query with the wake word: "Hey Aether, tell me about revenue"
        vlog("turn-end", { reason, stt: "browser-wake", text: query.slice(0, 80) });
        this.standby = false;
        voiceStore.set({ conversation: true, standby: false });
        this.stopListening(true);
        this.deliver(query, gen);
        return;
      } else {
        // User only called the name: "Hey Aether" or "Hi Aether"
        // Activate conversation and start listening for their question!
        vlog("wake-word-ready", { reason, wakePhrase: match.wakePhrase });
        this.standby = false;
        this.finishing = false;
        this.stopListening(true);
        this.startConversationFromWake();
        return;
      }
    }

    // Active conversation mode:
    const cleanText = stripWakeWord(rawText);
    if (cleanText) {
      vlog("turn-end", { reason, stt: "browser", text: cleanText.slice(0, 80) });
      this.stopListening(true);
      this.deliver(cleanText, gen);
      return;
    }
    if (this.recognition && this.heardSpeech) {
      vlog("recogniser-silent", { note: "speech heard but no words; transcribing turn with Whisper" });
    }
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }

    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder) {
      this.finishing = false;
      return this.listen();
    }
    vlog("turn-end", { reason, stt: "server" });
    this.setPhase("transcribing");
    recorder.onstop = async () => {
      const blob = new Blob(this.recordedChunks, { type: recorder.mimeType || "audio/webm" });
      this.recordedChunks = [];
      if (blob.size < 1500) return this.deliver("", gen);
      try {
        this.abort = new AbortController();
        const started = performance.now();
        const text = await transcribeAudio(blob, this.abort.signal);
        vlog("transcribed", { ms: Math.round(performance.now() - started), bytes: blob.size, text: text.slice(0, 80) });
        this.deliver(text, gen);
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        vlog("transcribe-error", { error: String(err?.message || err).slice(0, 160) });
        voiceStore.set({ error: err?.message || "Transcription failed." });
        this.deliver("", gen);
      }
    };
    try {
      recorder.stop();
    } catch {
      this.deliver("", gen);
    }
  }

  private deliver(text: string, gen: number): void {
    if (gen !== this.generation || !this.inConversation) return;
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length < 2) {
      this.finishing = false;
      return this.listen(); // nothing intelligible - keep listening
    }
    voiceStore.set({ interim: clean, error: null });
    this.setPhase("thinking");
    this.handlers.onUtterance(clean);
  }

  // ------------------------------------------------------------------ speaking

  /** The assistant has started generating an answer for the current turn. */
  beginResponse(): void {
    this.stopSpeaking("new-response");
    this.chunker = new SentenceChunker();
    this.responseOpen = true;
    if (this.inConversation) this.setPhase("thinking");
  }

  /** Stream answer text in; complete sentences are synthesised and queued immediately. */
  pushResponseText(delta: string): void {
    if (!this.responseOpen) return;
    this.chunker.push(delta).forEach((s) => this.enqueue(s));
  }

  /** No more text for this answer. Mic re-opens once everything queued has been spoken. */
  endResponse(): void {
    if (!this.responseOpen) return;
    this.chunker.flush().forEach((s) => this.enqueue(s));
    this.responseOpen = false;
    this.maybeFinishSpeaking();
  }

  /** Speak one short message as a complete response (e.g. "Here is your dashboard"). */
  say(text: string): void {
    this.beginResponse();
    this.pushResponseText(text);
    this.endResponse();
  }

  /** Read arbitrary text aloud (the speaker button on a message). */
  speakText(markdown: string): void {
    // create/resume the AudioContext synchronously inside the click so autoplay rules allow it
    const ready = this.ensureAudioContext();
    this.stopListening(true); // never transcribe our own voice
    this.stopSpeaking("read-aloud");
    voiceStore.set({ readingAloud: true });
    vlog("read-aloud", { chars: markdown.length });
    const gen = this.generation;
    ready.then(() => {
      if (gen !== this.generation) return; // stopped before the audio context was ready
      this.chunker = new SentenceChunker();
      this.responseOpen = true;
      this.pushResponseText(toSpeakable(markdown));
      this.endResponse();
    });
  }

  /** Quick check for the settings menu: plays a short sentence through the normal TTS path. */
  testSpeaker(): void {
    this.speakText("This is a test of the Aether voice. If you can hear this, speech output is working.");
  }

  stopSpeaking(reason = "stop"): void {
    if (this.playing || this.queue.length) vlog("speech-stopped", { reason, queued: this.queue.length });
    this.generation++;
    this.queue = [];
    this.responseOpen = false;
    this.abort?.abort();
    this.abort = null;
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch {
        /* ignore */
      }
      this.currentSource = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
    this.playing = false;
    this.audible = false;
    this.syntheticLevelUntil = 0;
    voiceStore.set({ readingAloud: false });
    if (this.phase === "speaking") this.setPhase(this.inConversation ? "thinking" : "idle");
  }

  /** Stop the assistant and hand the turn back to the user. */
  interrupt(reason = "button"): void {
    this.stopSpeaking(`interrupt:${reason}`);
    this.handlers.onInterrupt?.();
    if (this.inConversation) this.listen();
    else this.setPhase("idle");
  }

  private enqueue(raw: string): void {
    const text = toSpeakable(raw);
    if (!text || !/[a-z0-9]/i.test(text)) return;
    this.queue.push({ text, audio: null });
    this.prefetch();
    if (!this.playing) this.playNext(this.generation);
  }

  /** Synthesise one sentence on the API; null means "use the browser voice instead". */
  private fetchAudio(text: string): Promise<AudioBuffer | null> {
    if (this.serverTtsFailures >= 2) return Promise.resolve(null);
    const gen = this.generation;
    const shared = this.abort || (this.abort = new AbortController());
    return (async () => {
      // per-request timeout so a stalled TTS request can never freeze the conversation
      const own = new AbortController();
      const onShared = () => own.abort();
      shared.signal.addEventListener("abort", onShared);
      const timeout = setTimeout(() => own.abort(), TTS_TIMEOUT_MS);
      const started = performance.now();
      try {
        const ctx = await this.ensureAudioContext();
        const blob = await synthesizeSpeech(text, own.signal, this.ttsVoice);
        const buf = await blob.arrayBuffer();
        if (gen !== this.generation) return null;
        const decoded = await ctx.decodeAudioData(buf);
        this.serverTtsFailures = 0;
        vlog("tts-ready", { ms: Math.round(performance.now() - started), chars: text.length });
        return decoded;
      } catch (err: any) {
        if (shared.signal.aborted) return null; // stopped on purpose
        this.serverTtsFailures++;
        const timedOut = err?.name === "AbortError";
        vlog("tts-failed", { timedOut, error: String(err?.message || err).slice(0, 120) });
        return null;
      } finally {
        clearTimeout(timeout);
        shared.signal.removeEventListener("abort", onShared);
      }
    })();
  }

  /**
   * Keep only the next couple of sentences in flight. Firing every sentence at once makes them
   * compete on the TTS server and delays the first one by several seconds.
   */
  private prefetch(): void {
    for (const item of this.queue.slice(0, TTS_PREFETCH)) {
      if (!item.audio) item.audio = this.fetchAudio(item.text);
    }
  }

  private markAudible() {
    if (!this.audible) {
      this.audible = true;
      this.audibleSince = performance.now();
      this.bargeInVoicedMs = 0;
      this.echoEnvelope = 0;
    }
    // "speaking" only once sound is actually coming out - not while waiting for the first audio
    this.setPhase("speaking");
  }

  private async playNext(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      this.audible = false;
      this.maybeFinishSpeaking();
      return;
    }
    if (!item.audio) item.audio = this.fetchAudio(item.text);
    this.prefetch();
    this.playing = true;
    const buffer = await item.audio;
    if (gen !== this.generation) return;

    if (buffer && this.ctx && this.outGain) {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume().catch(() => {});
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.outGain);
      this.currentSource = src;
      let finished = false;
      const onDone = () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (this.currentSource === src) this.currentSource = null;
        this.playNext(gen);
      };
      src.onended = onDone;
      const maxMs = Math.max(1000, buffer.duration * 1000 + 1200);
      const watchdog = setTimeout(onDone, maxMs);
      src.start();
      this.markAudible();
    } else {
      await this.speakWithBrowser(item.text, gen);
      this.playNext(gen);
    }
  }

  private speakWithBrowser(text: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
      if (!synth || gen !== this.generation) return resolve();
      const utter = new SpeechSynthesisUtterance(text);
      if (typeof window !== "undefined") (window as any).__aetherUtterance = utter;
      const voices = synth.getVoices();
      utter.voice =
        voices.find((v) => v.lang === "en-AU") || voices.find((v) => v.lang.startsWith("en")) || null;
      utter.rate = 1.03;
      let doneCalled = false;
      const done = () => {
        if (doneCalled) return;
        doneCalled = true;
        clearTimeout(watchdog);
        this.syntheticLevelUntil = 0;
        resolve();
      };
      const maxMs = Math.max(2000, text.length * 90 + 2500);
      const watchdog = setTimeout(done, maxMs);

      utter.onstart = () => {
        this.syntheticLevelUntil = performance.now() + 60000;
        if (gen === this.generation) this.markAudible();
      };
      utter.onend = done;
      utter.onerror = done;
      vlog("tts-browser-voice", { chars: text.length });
      synth.speak(utter);
    });
  }

  private maybeFinishSpeaking(): void {
    if (this.playing || this.queue.length || this.responseOpen) return;
    this.audible = false;
    this.currentSource = null;
    voiceStore.set({ readingAloud: false });
    console.log("[Aether Finished Speaking -> Returning to Standby]");
    this.listenStandby();
  }

  /** The answer failed; say so briefly and go back to listening. */
  failResponse(message: string): void {
    this.responseOpen = false;
    if (!this.inConversation) return;
    this.say(message);
  }
}
