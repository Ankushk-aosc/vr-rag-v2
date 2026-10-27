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
      });
    }
  }

  get phase() {
    return voiceStore.get().phase;
  }

  get inConversation() {
    return voiceStore.get().conversation;
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

  /** Start a hands-free conversation. Must be called from a user gesture (click / XR select). */
  async startConversation(): Promise<void> {
    if (this.inConversation) return;
    voiceStore.set({ conversation: true, error: null, interim: "" });
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
      this.endConversation("mic-error");
    }
  }

  /** Stop everything: mic, recognition, playback. */
  endConversation(reason = "user"): void {
    if (this.inConversation) vlog("conversation-end", { reason });
    voiceStore.set({ conversation: false, interim: "" });
    this.stopListening(true);
    this.stopSpeaking("conversation-end");
    this.releaseMic();
    voiceStore.set({ phase: "idle" });
    this.stopTickingIfIdle();
  }

  toggleConversation(): Promise<void> | void {
    return this.inConversation ? this.endConversation("toggle") : this.startConversation();
  }

  dispose(): void {
    this.endConversation("dispose");
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
    if (this.stream && this.stream.getAudioTracks().some((t) => t.readyState === "live")) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
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
        audible: this.audible,
        echo: +this.echoEnvelope.toFixed(3),
      };
    }

    if (phase === "listening" && !this.finishing) {
      if (frame.inUtterance) this.heardSpeech = true;
      const sinceListen = now - this.listenStartedAt;
      const haveWords = (this.finalText + this.interimText).trim().length > 0;
      const resultQuiet = this.lastResultAt ? now - this.lastResultAt : Infinity;
      // the recogniser's words can lag the audio; while a phrase is still "interim" wait a bit longer
      const pendingInterim = this.interimText.length > 0 && resultQuiet < 700;

      // 1. The VAD heard a complete utterance followed by silence - works for every STT backend.
      if (frame.endOfUtterance && !pendingInterim) this.finishUtterance("vad-silence");
      // 2. The recogniser has words and has been quiet for a while, even if the VAD still hears
      //    noise (fan, AGC-boosted room) - the recogniser is the better judge of speech.
      else if (haveWords && resultQuiet >= RECOGNISER_QUIET_MS && (!frame.voiced || resultQuiet >= 2600))
        this.finishUtterance("recogniser-quiet");
      // 3. Safety limits.
      else if (sinceListen > MAX_UTTERANCE_MS && (haveWords || this.heardSpeech)) this.finishUtterance("max-length");
      else if (!this.heardSpeech && !haveWords && sinceListen > NO_SPEECH_RESTART_MS) this.restartListening();
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

  private listen(): void {
    if (!this.inConversation) return;
    this.stopListening(true);
    this.vad.reset();
    this.finalText = "";
    this.interimText = "";
    this.lastResultAt = 0;
    this.heardSpeech = false;
    this.finishing = false;
    this.listenStartedAt = performance.now();
    voiceStore.set({ interim: "" });
    this.setPhase("listening");

    // Always record: if the browser recogniser returns nothing the recording goes to Whisper.
    this.startRecorder();
    const allowBrowser = voiceStore.get().sttMode === "auto" && !this.recognitionFailed;
    const Ctor = allowBrowser ? getRecognitionCtor() : null;
    if (Ctor) this.startRecognition(Ctor);
    voiceStore.set({ sttEngine: this.recognition ? "browser" : "server" });
  }

  private restartListening(): void {
    if (this.phase === "listening") this.listen();
  }

  private startRecognition(Ctor: SpeechRecognitionCtor): void {
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-AU";
      rec.maxAlternatives = 1;
      rec.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0].transcript;
          if (event.results[i].isFinal) this.finalText = `${this.finalText} ${piece}`.trim();
          else interim += piece;
        }
        this.interimText = interim.trim();
        this.lastResultAt = performance.now();
        voiceStore.set({ interim: `${this.finalText} ${this.interimText}`.trim() });
      };
      rec.onerror = (e: any) => {
        if (e.error === "no-speech" || e.error === "aborted") return;
        vlog("recogniser-error", { error: e.error });
        // network / not-allowed / service-not-allowed / audio-capture: the recorder keeps running,
        // so this turn (and later ones) are transcribed by Whisper on the API
        this.recognitionFailed = true;
        if (this.recognition === rec) {
          this.recognition = null;
          voiceStore.set({ sttEngine: "server" });
        }
      };
      rec.onend = () => {
        // Chrome ends sessions on its own after long pauses; keep listening while it's our turn
        if (this.recognition === rec && this.phase === "listening" && !this.finishing) {
          try {
            rec.start();
          } catch {
            /* already restarting */
          }
        }
      };
      rec.start();
      this.recognition = rec;
    } catch (err) {
      vlog("recogniser-error", { error: String(err).slice(0, 120) });
      this.recognitionFailed = true;
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
    if (this.phase !== "listening" || this.finishing) return;
    this.finishing = true;
    const gen = this.generation;

    // Browser recognition produced words: use them immediately (no upload, no extra latency)
    const browserText = `${this.finalText} ${this.interimText}`.trim();
    if (browserText) {
      vlog("turn-end", { reason, stt: "browser", text: browserText.slice(0, 80) });
      this.stopListening(true);
      this.deliver(browserText, gen);
      return;
    }
    if (this.recognition && this.heardSpeech) {
      // speech was clearly heard but the recogniser returned nothing: stop relying on it
      vlog("recogniser-silent", { note: "speech heard but no words; switching to Whisper" });
      this.recognitionFailed = true;
      voiceStore.set({ sttEngine: "server" });
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
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.outGain);
      this.currentSource = src;
      src.onended = () => {
        if (this.currentSource === src) this.currentSource = null;
        this.playNext(gen);
      };
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
      const voices = synth.getVoices();
      utter.voice =
        voices.find((v) => v.lang === "en-AU") || voices.find((v) => v.lang.startsWith("en")) || null;
      utter.rate = 1.03;
      utter.onstart = () => {
        this.syntheticLevelUntil = performance.now() + 60000;
        if (gen === this.generation) this.markAudible();
      };
      const done = () => {
        this.syntheticLevelUntil = 0;
        resolve();
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
    voiceStore.set({ readingAloud: false });
    if (this.inConversation) {
      // hand the turn back to the user, like ChatGPT / Claude voice mode
      this.listen();
    } else {
      this.setPhase("idle");
      this.stopTickingIfIdle();
    }
  }

  /** The answer failed; say so briefly and go back to listening. */
  failResponse(message: string): void {
    this.responseOpen = false;
    if (!this.inConversation) return;
    this.say(message);
  }
}
